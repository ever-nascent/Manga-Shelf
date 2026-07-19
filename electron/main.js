const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { pathToFileURL } = require('url');

const mangadex = require('./mangadex');
const mangakatana = require('./mangakatana');
const { Library } = require('./library');
const { Downloader } = require('./downloader');
const { ApiCache } = require('./cache');
const exporter = require('./exporter');
const { checkForUpdates } = require('./updates');
const appUpdater = require('./appUpdater');

const DEV = process.argv.includes('--dev');

// mangafile:// serves images from the library folder to the renderer
protocol.registerSchemesAsPrivileged([
	{ scheme: 'mangafile', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }
]);

let win = null;
let splash = null;
let library = null;
let downloader = null;
let cache = null;
let quitConfirmed = false; // set once the user has answered the quit prompt
let quitPromptOpen = false;
let updateReadyVersion = null; // a downloaded update waiting to be installed
let installingUpdate = false;

// Standard-scheme URLs need a (dummy) host — Chromium rejects an empty
// authority, which silently broke every local cover/page image before.
function toMangaFileUrl(absPath) {
	return 'mangafile://local/' + encodeURI(absPath.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

function decorateLibraryManga(m) {
	if (!m) return m;
	return { ...m, coverUrl: m.coverPath ? toMangaFileUrl(m.coverPath) : null };
}

function createWindow() {
	// small frameless splash shown the instant the app launches, so there's
	// never a blank/white window while the real one loads its first screen
	splash = new BrowserWindow({
		width: 260,
		height: 260,
		frame: false,
		transparent: true,
		resizable: false,
		movable: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		backgroundColor: '#00000000',
		webPreferences: { contextIsolation: true }
	});
	splash.loadFile(path.join(__dirname, '..', 'renderer', 'splash.html'));

	win = new BrowserWindow({
		width: 1440,
		height: 920,
		minWidth: 980,
		minHeight: 640,
		backgroundColor: '#0e1015',
		autoHideMenuBar: true,
		title: 'MangaShelf',
		icon: path.join(__dirname, '..', 'build', 'icon.png'),
		show: false,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false
		}
	});
	win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

	// swap splash -> main window once the renderer says its first screen has
	// actually painted (not just DOM-ready) — with a hard timeout backstop so
	// a slow or broken load never leaves the user staring at the splash forever
	const reveal = () => {
		if (splash && !splash.isDestroyed()) splash.destroy();
		if (win && !win.isDestroyed()) { win.show(); win.focus(); }
	};
	const revealTimer = setTimeout(reveal, 8000);
	ipcMain.once('app:ready', () => { clearTimeout(revealTimer); reveal(); });

	// Downloads live in memory, so closing mid-queue would silently discard
	// them. Intercept the close and let the renderer ask what to do.
	win.on('close', (e) => {
		if (installingUpdate) return; // the installer is taking it from here
		if (!quitConfirmed && downloader?.hasActiveJobs()) {
			e.preventDefault();
			askBeforeQuit();
			return;
		}
		if (updateReadyVersion) {
			e.preventDefault();
			shutdown();
		}
	});

	if (DEV) {
		win.webContents.openDevTools({ mode: 'detach' });
		win.webContents.setBackgroundThrottling(false); // keep frames fresh for /shot even when occluded
		win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
			console.log(`[renderer:${level}] ${message} (${path.basename(sourceId || '')}:${line})`);
		});
		startDevControlServer();
	}
}

// Last step before the app goes away. If an update is waiting, hand off to the
// installer with its progress window visible rather than replacing the exe
// behind the user's back.
function shutdown() {
	if (updateReadyVersion && !installingUpdate && app.isPackaged) {
		installingUpdate = true;
		try {
			appUpdater.quitAndInstall({ relaunch: false });
			return;
		} catch (err) {
			// never let a failed install trap the user in a window that won't
			// close — fall through and quit normally
			console.error('Install on quit failed:', err.message);
		}
	}
	if (win && !win.isDestroyed()) win.destroy();
}

// Ask the renderer to show the "downloads in progress" prompt and act on the
// answer. Falls back to pausing if the renderer can't answer, so a wedged UI
// can never trap the user in an app that refuses to close.
function askBeforeQuit() {
	if (quitPromptOpen) return;
	quitPromptOpen = true;

	const active = downloader.pendingJobs().length;
	const finish = (choice) => {
		if (!quitPromptOpen) return;
		quitPromptOpen = false;
		clearTimeout(bailout);
		ipcMain.removeListener('quit:answer', onAnswer);
		ipcMain.removeListener('quit:shown', onShown);

		if (choice === 'stay') return;
		// 'pause' keeps the queue for next launch; 'cancel' just drops it
		library.savePendingQueue(choice === 'pause' ? downloader.pendingJobs() : []);
		quitConfirmed = true;
		shutdown();
	};

	const onAnswer = (_e, choice) => finish(choice);
	ipcMain.once('quit:answer', onAnswer);

	// The bailout is for a renderer that can't draw the prompt (hung, crashed,
	// paused in devtools) — never for a user taking their time. Once the
	// renderer confirms the dialog is up, we wait as long as it takes.
	const bailout = setTimeout(() => finish('pause'), 4000);
	const onShown = () => clearTimeout(bailout);
	ipcMain.once('quit:shown', onShown);

	if (win && !win.isDestroyed()) {
		win.webContents.send('quit:confirm', { active });
		if (win.isMinimized()) win.restore();
		win.focus();
	} else {
		finish('pause');
	}
}

// Dev-only control port (127.0.0.1): lets automated tests drive the real app —
// POST /eval runs JS in the renderer, GET /shot?file=... saves a screenshot.
function startDevControlServer() {
	const server = http.createServer(async (req, res) => {
		res.setHeader('Content-Type', 'application/json');
		try {
			const u = new URL(req.url, 'http://127.0.0.1');
			if (u.pathname === '/eval' && req.method === 'POST') {
				let body = '';
				req.on('data', (c) => { body += c; });
				req.on('end', async () => {
					try {
						const result = await win.webContents.executeJavaScript(body, true);
						res.end(JSON.stringify({ ok: true, result }));
					} catch (err) {
						res.end(JSON.stringify({ ok: false, error: String(err) }));
					}
				});
				return;
			}
			// exercises the same path as the titlebar X (renderer window.close()
			// does not, so quit-prompt tests need this)
			if (u.pathname === '/close') {
				res.end(JSON.stringify({ ok: true }));
				setTimeout(() => win.close(), 50);
				return;
			}
			if (u.pathname === '/shot') {
				win.webContents.invalidate();
				await new Promise((r) => setTimeout(r, 350));
				const image = await win.webContents.capturePage();
				const file = u.searchParams.get('file');
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, image.toPNG());
				res.end(JSON.stringify({ ok: true, file }));
				return;
			}
			res.end(JSON.stringify({ ok: false, error: 'unknown endpoint' }));
		} catch (err) {
			res.end(JSON.stringify({ ok: false, error: String(err) }));
		}
	});
	server.listen(9310, '127.0.0.1');
}

function settingsFor(lib) {
	const s = lib.getSettings();
	return { contentRating: s.contentRating, language: s.language };
}

function registerIpc() {
	const wrap = (fn) => async (_event, ...args) => fn(...args);

	// ----- discovery (cached: fresh hits skip the network, stale hits refresh in background) -----
	const cr = () => library.getSettings().contentRating;
	const MIN = 60_000;
	ipcMain.handle('md:home', wrap(() =>
		cache.wrap(`home:${cr().join()}`, 10 * MIN, () => mangadex.getHomeSections(cr()), { persist: true })));
	ipcMain.handle('md:tags', wrap(() =>
		cache.wrap('tags', 24 * 60 * MIN, () => mangadex.getTags(), { persist: true })));
	ipcMain.handle('md:search', wrap((opts) =>
		cache.wrap(`search:${JSON.stringify(opts)}:${cr().join()}`, 5 * MIN,
			() => mangadex.searchManga({ ...opts, contentRating: cr() }))));
	ipcMain.handle('md:manga', wrap((id) =>
		cache.wrap(`manga:${id}`, 30 * MIN,
			() => mangakatana.isMkId(id) ? mangakatana.getManga(id) : mangadex.getManga(id))));
	ipcMain.handle('md:stats', wrap((id) =>
		mangakatana.isMkId(id) ? null : cache.wrap(`stats:${id}`, 30 * MIN, () => mangadex.getStats(id))));
	ipcMain.handle('md:chapters', wrap((id) =>
		cache.wrap(`chapters:${id}:${JSON.stringify(settingsFor(library))}`, 10 * MIN,
			() => mangakatana.isMkId(id) ? mangakatana.getChapters(id) : mangadex.getChapters(id, settingsFor(library)))));
	ipcMain.handle('md:byIds', wrap((ids) =>
		cache.wrap(`byIds:${[...ids].sort().join()}`, 30 * MIN, () => mangadex.getMangaByIds(ids))));
	ipcMain.handle('md:similar', wrap((manga) =>
		mangakatana.isMkId(manga.id) ? [] : cache.wrap(`similar:${manga.id}:${cr().join()}`, 60 * MIN, () => mangadex.getSimilar(manga, cr()))));
	// image URLs expire server-side after a short while, so only a short TTL is safe
	ipcMain.handle('md:chapterImages', wrap((chapterId) =>
		cache.wrap(`pages:${chapterId}:${library.getSettings().quality}`, 5 * MIN,
			() => mangakatana.isMkId(chapterId)
				? mangakatana.getChapterImageUrls(chapterId)
				: mangadex.getChapterImageUrls(chapterId, library.getSettings().quality),
			{ maxStaleMs: 0 })));

	// ----- alternative source (manual fallback when MangaDex doesn't have it) -----
	ipcMain.handle('mk:search', wrap((query) =>
		cache.wrap(`mk:search:${query}`, 10 * MIN, () => mangakatana.searchManga(query))));

	// ----- downloads -----
	ipcMain.handle('dl:add', wrap((manga, chapters) => downloader.add(manga, chapters)));
	ipcMain.handle('dl:cancel', wrap((jobId) => downloader.cancel(jobId)));
	ipcMain.handle('dl:retry', wrap((jobId) => downloader.retry(jobId)));
	ipcMain.handle('dl:queue', wrap(() => downloader.snapshot()));
	ipcMain.handle('dl:clearFinished', wrap(() => downloader.clearFinished()));

	// ----- library -----
	ipcMain.handle('lib:all', wrap(() => library.getAll().map(decorateLibraryManga)));
	ipcMain.handle('lib:get', wrap((id) => decorateLibraryManga(library.get(id))));
	ipcMain.handle('lib:pages', wrap((mangaId, chapterId) => library.getChapterPages(mangaId, chapterId).map(toMangaFileUrl)));
	ipcMain.handle('lib:removeChapter', wrap((mangaId, chapterId) => library.removeChapter(mangaId, chapterId)));
	ipcMain.handle('lib:removeManga', wrap((mangaId) => library.removeManga(mangaId)));

	// ----- reading progress (any manga) -----
	// prefer the local cover when the manga is downloaded, else the stored URL
	const decorateReading = (r) => {
		if (!r) return r;
		const lib = library.get(r.manga.id);
		const coverUrl = lib?.coverPath ? toMangaFileUrl(lib.coverPath) : r.manga.coverUrl;
		return { ...r, manga: { ...r.manga, coverUrl } };
	};
	ipcMain.handle('reading:set', wrap((mangaSnap, progress) => library.setReading(mangaSnap, progress)));
	ipcMain.handle('reading:get', wrap((id) => decorateReading(library.getReading(id))));
	ipcMain.handle('reading:all', wrap(() => library.getReadingAll().map(decorateReading)));
	ipcMain.handle('reading:remove', wrap((id) => library.removeReading(id)));

	// ----- follows -----
	ipcMain.handle('follows:set', wrap((manga, status, lastSeenNum) => library.follow(manga, status, lastSeenNum)));
	ipcMain.handle('follows:remove', wrap((id) => library.unfollow(id)));
	ipcMain.handle('follows:get', wrap((id) => library.getFollow(id)));
	ipcMain.handle('follows:all', wrap(() => library.getFollowsAll()));

	// ----- updates feed -----
	ipcMain.handle('updates:check', wrap(() => checkForUpdates(library)));
	ipcMain.handle('updates:feed', wrap(() => library.getUpdatesFeed()));
	ipcMain.handle('follows:setNotify', wrap((id, on) => library.setNotify(id, on)));

	// ----- exports -----
	ipcMain.handle('export:chapter', async (_e, mangaId, chapterId, format) => {
		const manga = library.get(mangaId);
		const ch = manga?.chapters.find((c) => c.id === chapterId);
		if (!ch) throw new Error('Chapter not found in library.');
		const { canceled, filePath } = await dialog.showSaveDialog(win, {
			defaultPath: `${exporter.chapterLabel(manga.title, ch)}.${format}`,
			filters: [{ name: format.toUpperCase(), extensions: [format] }]
		});
		if (canceled || !filePath) return null;
		await exporter.exportChapter(library, mangaId, chapterId, format, filePath);
		return filePath;
	});

	ipcMain.handle('export:manga', async (_e, mangaId, format) => {
		const { canceled, filePaths } = await dialog.showOpenDialog(win, {
			title: 'Choose export folder',
			properties: ['openDirectory', 'createDirectory']
		});
		if (canceled || !filePaths[0]) return null;
		const count = await exporter.exportManga(library, mangaId, format, filePaths[0]);
		return { dir: filePaths[0], count };
	});

	// ----- settings / misc -----
	ipcMain.handle('settings:get', wrap(() => library.getSettings()));
	ipcMain.handle('settings:set', wrap((partial) => library.setSettings(partial)));
	ipcMain.handle('settings:chooseFolder', async () => {
		const { canceled, filePaths } = await dialog.showOpenDialog(win, {
			title: 'Choose library folder',
			properties: ['openDirectory', 'createDirectory']
		});
		if (canceled || !filePaths[0]) return null;
		return library.setSettings({ libraryPath: filePaths[0] });
	});
	// ----- app updates -----
	ipcMain.handle('app:version', wrap(() => app.getVersion()));
	ipcMain.handle('app:checkForUpdates', wrap(() => {
		if (!app.isPackaged) {
			// nothing to check in dev — just report back so the Settings UI doesn't hang
			if (win && !win.isDestroyed()) win.webContents.send('app-update:event', { type: 'none' });
			return;
		}
		return appUpdater.checkForUpdates();
	}));
	// "Restart and update now": installs with the progress window showing, then
	// reopens MangaShelf itself so the user never chases a missing exe.
	ipcMain.handle('app:installUpdate', wrap(() => {
		if (!updateReadyVersion || installingUpdate) return false;
		installingUpdate = true;
		appUpdater.quitAndInstall({ relaunch: true });
		return true;
	}));
	ipcMain.handle('shell:openPath', wrap((p) => shell.openPath(p)));
	ipcMain.handle('shell:openExternal', wrap((url) => {
		if (/^https:\/\//.test(url)) shell.openExternal(url);
	}));
	ipcMain.handle('shell:openMangaFolder', wrap((mangaId) => {
		const m = library.get(mangaId);
		if (m) shell.openPath(m.path);
	}));
}

function showChapterNotification(fresh) {
	const notifiable = (fresh || []).filter((f) => f.notify);
	if (!notifiable.length || !Notification.isSupported()) return;

	let title, body;
	if (notifiable.length === 1) {
		const f = notifiable[0];
		title = f.title;
		body = f.nums.length === 1
			? `Chapter ${f.nums[0]} is out!`
			: `${f.nums.length} new chapters (up to Ch. ${f.nums[0]})`;
	} else {
		title = `New chapters for ${notifiable.length} series`;
		body = notifiable.slice(0, 4).map((f) => `${f.title} (Ch. ${f.nums[0]})`).join(', ')
			+ (notifiable.length > 4 ? '…' : '');
	}

	const n = new Notification({ title, body, icon: path.join(__dirname, '..', 'build', 'icon.png') });
	n.on('click', () => {
		if (win && !win.isDestroyed()) {
			if (win.isMinimized()) win.restore();
			win.show();
			win.focus();
			win.webContents.send('app:navigate', 'updates');
		}
	});
	n.show();
}

async function runAutoCheck(minIntervalMs) {
	const last = library.db.meta.lastUpdateCheckAt;
	if (last && Date.now() - new Date(last).getTime() < minIntervalMs) return;
	try {
		const result = await checkForUpdates(library);
		if (result.added > 0) {
			if (win && !win.isDestroyed()) win.webContents.send('updates:found', result);
			if (library.getSettings().notifications) showChapterNotification(result.fresh);
		}
	} catch (err) {
		console.error('Auto update check failed:', err.message);
	}
}

app.whenReady().then(() => {
	// Windows toasts need the app id of the installed shortcut; in dev the
	// default Electron identity is the one with a valid shortcut, so leave it.
	if (app.isPackaged) app.setAppUserModelId('com.charmed.mangashelf');

	library = new Library(app.getPath('userData'), path.join(app.getPath('documents'), 'Manga Library'));
	cache = new ApiCache(path.join(app.getPath('userData'), 'api-cache.json'));
	downloader = new Downloader(library, (queue) => {
		if (win && !win.isDestroyed()) win.webContents.send('dl:updated', queue);
	});

	protocol.handle('mangafile', (request) => {
		try {
			const url = new URL(request.url);
			const filePath = path.normalize(decodeURIComponent(url.pathname).replace(/^\//, ''));
			if (!library.isAllowedPath(filePath)) {
				return new Response('Forbidden', { status: 403 });
			}
			return net.fetch(pathToFileURL(filePath).toString());
		} catch (err) {
			return new Response(`Bad request: ${err.message}`, { status: 400 });
		}
	});

	// MangaDex CDN sometimes rejects browser-y requests: strip Referer, set a real UA
	session.defaultSession.webRequest.onBeforeSendHeaders(
		{ urls: ['https://uploads.mangadex.org/*', 'https://*.mangadex.network/*'] },
		(details, callback) => {
			details.requestHeaders['User-Agent'] = mangadex.USER_AGENT;
			delete details.requestHeaders.Referer;
			callback({ requestHeaders: details.requestHeaders });
		}
	);

	registerIpc();
	createWindow();

	// resume whatever "Pause & exit" left behind last time
	const paused = library.takePendingQueue();
	if (paused.length) {
		const restored = downloader.restore(paused);
		if (restored) {
			ipcMain.once('app:ready', () => {
				if (win && !win.isDestroyed()) win.webContents.send('dl:resumed', restored);
			});
		}
	}

	// warm the cache right away so Home/Browse paint instantly
	setTimeout(() => {
		const rating = library.getSettings().contentRating;
		cache.wrap(`home:${rating.join()}`, 600_000, () => mangadex.getHomeSections(rating), { persist: true }).catch(() => {});
		cache.wrap('tags', 86_400_000, () => mangadex.getTags(), { persist: true }).catch(() => {});
	}, 1000);

	// auto-check follows for new chapters: shortly after launch, then every 2h
	setTimeout(() => runAutoCheck(6 * 60 * 60 * 1000), 12_000);
	setInterval(() => runAutoCheck(90 * 60 * 1000), 2 * 60 * 60 * 1000);

	// app self-update: only meaningful for an installed (NSIS) packaged build
	if (app.isPackaged) {
		appUpdater.initAutoUpdater((evt) => {
			if (evt.type === 'downloaded') updateReadyVersion = evt.version;
			if (win && !win.isDestroyed()) win.webContents.send('app-update:event', evt);
		});
		setTimeout(() => appUpdater.checkForUpdates(), 8_000);
		setInterval(() => appUpdater.checkForUpdates(), 4 * 60 * 60 * 1000);
	}

	if (process.env.MANGASHELF_TEST_NOTIF) {
		setTimeout(() => {
			showChapterNotification([
				{ title: 'Test Manga', notify: true, nums: ['42'] }
			]);
			console.log('[notif-test] supported:', Notification.isSupported());
		}, 4000);
	}

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});
