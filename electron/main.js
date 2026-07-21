const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { pathToFileURL } = require('url');

const mangadex = require('./mangadex');
const { Library } = require('./library');
const { Downloader } = require('./downloader');
const { ApiCache } = require('./cache');
const exporter = require('./exporter');
const { checkForUpdates } = require('./updates');
const appUpdater = require('./appUpdater');
const { createApi, makePostMap } = require('./api');
const { RemoteServer, generateToken } = require('./remoteServer');

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
let api = null;
let remoteServer = null;
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
const DEV_CONTROL_PORT = 9310;

// /eval runs arbitrary JS in the renderer, so the port must only answer our own
// (curl-based) test harness — never a web page. Binding to 127.0.0.1 stops
// remote machines, but a site open in your normal browser could still reach the
// port via CSRF or DNS rebinding. A browser-issued fetch always carries at least
// one of the signals below; curl carries none of them, so this lets the harness
// through while shutting the browser out.
function isTrustedLocalCaller(req) {
	const host = req.headers.host;
	if (host !== `127.0.0.1:${DEV_CONTROL_PORT}` && host !== `localhost:${DEV_CONTROL_PORT}`) {
		return false; // DNS rebinding: Host is the attacker's domain, not ours
	}
	if (req.headers.origin) return false; // cross-site browser fetch attaches Origin
	const fetchSite = req.headers['sec-fetch-site'];
	if (fetchSite && fetchSite !== 'none') return false; // any page-initiated fetch
	return true;
}

function startDevControlServer() {
	const server = http.createServer(async (req, res) => {
		res.setHeader('Content-Type', 'application/json');
		if (!isTrustedLocalCaller(req)) {
			res.statusCode = 403;
			res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
			return;
		}
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
	server.listen(DEV_CONTROL_PORT, '127.0.0.1');
}

// A shared-state change made on one side means the other side's view of it is
// stale: phone changes push a refresh hint to the desktop renderer, and every
// change goes to linked phones over SSE (the desktop already updated its own
// UI, so it only needs to hear about remote-made changes).
function onDomainChange(domain, source) {
	if (source !== 'desktop' && win && !win.isDestroyed()) win.webContents.send('remote:changed', domain);
	remoteServer?.broadcastChange(domain);
}

async function remoteInfo() {
	const s = library.getSettings();
	const running = remoteServer.isRunning();
	const info = {
		enabled: Boolean(s.remoteEnabled),
		running,
		url: running ? remoteServer.bestUrl() : null,
		token: s.remoteToken || null,
		qrDataUrl: null
	};
	if (running && s.remoteToken) {
		const QRCode = require('qrcode');
		info.qrDataUrl = await QRCode.toDataURL(`${info.url}/#link=${s.remoteToken}`, {
			margin: 1, width: 480, color: { dark: '#0e1015ff', light: '#ffffffff' }
		});
	}
	return info;
}

function registerIpc() {
	const wrap = (fn) => async (_event, ...args) => fn(...args);

	// ----- shared commands (same registry the phone remote uses) -----
	const post = makePostMap(library, toMangaFileUrl);
	for (const name of Object.keys(api.commands)) {
		ipcMain.handle(name, async (_e, ...args) => {
			const result = await api.dispatch(name, args, 'desktop');
			return post[name] ? post[name](result) : result;
		});
	}

	// ----- phone remote (pair/unpair lives on the desktop only) -----
	ipcMain.handle('remote:info', wrap(() => remoteInfo()));
	ipcMain.handle('remote:setEnabled', wrap(async (on) => {
		if (on) {
			if (!library.getSettings().remoteToken) library.setSettings({ remoteToken: generateToken() });
			library.setSettings({ remoteEnabled: true });
			await remoteServer.start();
		} else {
			library.setSettings({ remoteEnabled: false });
			remoteServer.stop();
		}
		return remoteInfo();
	}));
	ipcMain.handle('remote:regenerate', wrap(() => {
		library.setSettings({ remoteToken: generateToken() });
		remoteServer.dropClients(); // every phone re-pairs with the new code
		return remoteInfo();
	}));

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
		const { count, skipped } = await exporter.exportManga(library, mangaId, format, filePaths[0]);
		return { dir: filePaths[0], count, skipped };
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
	// Takes no path on purpose. shell.openPath launches whatever it is handed,
	// executables included, so the renderer doesn't get to name the target: the
	// only folder it ever asked for was the configured library.
	ipcMain.handle('shell:openLibraryFolder', wrap(() => shell.openPath(library.getSettings().libraryPath)));
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
			remoteServer?.broadcastChange('updates');
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
		remoteServer?.broadcastQueue(queue);
	});
	api = createApi({ library, downloader, cache, onChange: onDomainChange });
	remoteServer = new RemoteServer({ library, api, downloader });
	if (library.getSettings().remoteEnabled) {
		remoteServer.start().catch((err) => console.error('Remote server failed to start:', err.message));
	}

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
