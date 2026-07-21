// Local library: tracks downloaded manga/chapters in a JSON db and manages
// files on disk. Layout: <libraryPath>/<Manga Title>/Chapter <num>/<page>.jpg

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./util');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

function sanitizeName(name) {
	return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\.+$/, '').trim().slice(0, 120) || 'Untitled';
}

// Sum the byte size of every file under a directory, ignoring anything that
// can't be read (a file removed mid-walk, a permission error).
function dirSize(dir) {
	let total = 0;
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const e of entries) {
		const p = path.join(dir, e.name);
		try {
			total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
		} catch { /* ignore unreadable entries */ }
	}
	return total;
}

function padChapter(num) {
	if (num === null || num === undefined || num === '') return 'Oneshot';
	const s = String(num);
	const dot = s.indexOf('.');
	const intPart = dot === -1 ? s : s.slice(0, dot);
	const rest = dot === -1 ? '' : s.slice(dot);
	return intPart.padStart(4, '0') + rest;
}

class Library {
	constructor(userDataDir, defaultLibraryPath) {
		this.dbFile = path.join(userDataDir, 'library.json');
		this.settingsFile = path.join(userDataDir, 'settings.json');
		this.settings = {
			libraryPath: defaultLibraryPath,
			contentRating: ['safe', 'suggestive'],
			quality: 'data',
			language: 'en',
			notifications: true,
			// phone remote: off until enabled in Settings; token is the link code
			remoteEnabled: false,
			remoteToken: null
		};
		this.db = { version: 2, manga: {} };
		this.load();
	}

	load() {
		try {
			if (fs.existsSync(this.settingsFile)) {
				Object.assign(this.settings, JSON.parse(fs.readFileSync(this.settingsFile, 'utf-8')));
			}
		} catch (err) {
			console.error('Failed to read settings, using defaults:', err.message);
		}
		try {
			if (fs.existsSync(this.dbFile)) {
				this.db = JSON.parse(fs.readFileSync(this.dbFile, 'utf-8'));
			}
		} catch (err) {
			console.error('Failed to read library db, starting empty:', err.message);
		}

		// v2: follows (bookmarks w/ status), universal reading progress, updates feed
		this.db.manga ??= {};
		this.db.follows ??= {};
		this.db.reading ??= {};
		this.db.updates ??= [];
		this.db.meta ??= {};
		this.db.pendingQueue ??= [];
		for (const m of Object.values(this.db.manga)) {
			if (m.progress && !this.db.reading[m.id]) {
				this.db.reading[m.id] = {
					manga: { id: m.id, title: m.title, coverUrl: null },
					chapterId: m.progress.chapterId,
					chapterNum: m.progress.chapterNum ?? null,
					page: m.progress.page || 0,
					updatedAt: m.progress.updatedAt || new Date().toISOString()
				};
			}
			delete m.progress;
		}
		this.db.version = 2;
	}

	saveDb() {
		writeFileAtomic(this.dbFile, JSON.stringify(this.db, null, '\t'));
	}

	getSettings() {
		return { ...this.settings };
	}

	setSettings(partial) {
		Object.assign(this.settings, partial);
		writeFileAtomic(this.settingsFile, JSON.stringify(this.settings, null, '\t'));
		return this.getSettings();
	}

	ensureLibraryDir() {
		fs.mkdirSync(this.settings.libraryPath, { recursive: true });
	}

	mangaDir(manga) {
		return path.join(this.settings.libraryPath, sanitizeName(manga.title));
	}

	chapterDir(manga, chapter) {
		const label = chapter.num ? `Chapter ${padChapter(chapter.num)}` : 'Oneshot';
		return path.join(this.mangaDir(manga), label);
	}

	// Registers a manga in the db (called when its first chapter downloads).
	upsertManga(manga) {
		const existing = this.db.manga[manga.id];
		const dir = existing?.path || this.mangaDir(manga);
		fs.mkdirSync(dir, { recursive: true });

		this.db.manga[manga.id] = {
			id: manga.id,
			title: manga.title,
			description: manga.description,
			status: manga.status,
			tags: manga.tags,
			authors: manga.authors,
			path: dir,
			coverFile: existing?.coverFile || null,
			addedAt: existing?.addedAt || new Date().toISOString(),
			chapters: existing?.chapters || {},
			progress: existing?.progress || null
		};

		// snapshot metadata next to the images so the folder is self-describing
		fs.writeFileSync(path.join(dir, 'manga.json'), JSON.stringify({
			id: manga.id,
			title: manga.title,
			description: manga.description,
			status: manga.status,
			tags: manga.tags.map((t) => t.name),
			authors: manga.authors
		}, null, '\t'));

		this.saveDb();
		return this.db.manga[manga.id];
	}

	setCover(mangaId, coverFile) {
		const m = this.db.manga[mangaId];
		if (m) {
			m.coverFile = coverFile;
			this.saveDb();
		}
	}

	addChapter(mangaId, chapter, dir, pageCount) {
		const m = this.db.manga[mangaId];
		if (!m) throw new Error(`Manga ${mangaId} not in library`);
		m.chapters[chapter.id] = {
			id: chapter.id,
			num: chapter.num,
			volume: chapter.volume,
			title: chapter.title,
			group: chapter.group,
			pages: pageCount,
			path: dir,
			downloadedAt: new Date().toISOString()
		};
		this.saveDb();
	}

	getAll() {
		return Object.values(this.db.manga)
			.map((m) => this.get(m.id))
			.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
	}

	get(mangaId) {
		const m = this.db.manga[mangaId];
		if (!m) return null;
		return {
			...m,
			chapters: this.sortedChapters(m),
			coverPath: m.coverFile ? path.join(m.path, m.coverFile) : null,
			progress: this.db.reading[mangaId] || null
		};
	}

	sortedChapters(m) {
		return Object.values(m.chapters).sort((a, b) => (parseFloat(a.num) || 0) - (parseFloat(b.num) || 0));
	}

	hasChapter(mangaId, chapterId) {
		return Boolean(this.db.manga[mangaId]?.chapters?.[chapterId]);
	}

	getChapterPages(mangaId, chapterId) {
		const ch = this.db.manga[mangaId]?.chapters?.[chapterId];
		if (!ch || !fs.existsSync(ch.path)) return [];
		return fs.readdirSync(ch.path)
			.filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
			.sort()
			.map((f) => path.join(ch.path, f));
	}

	// ---------- reading progress (works for any manga, downloaded or not) ----------

	setReading(mangaSnap, progress) {
		this.db.reading[mangaSnap.id] = {
			manga: { id: mangaSnap.id, title: mangaSnap.title, coverUrl: mangaSnap.coverUrl || null },
			chapterId: progress.chapterId,
			chapterNum: progress.chapterNum ?? null,
			page: progress.page || 0,
			updatedAt: new Date().toISOString()
		};

		const f = this.db.follows[mangaSnap.id];
		const num = parseFloat(progress.chapterNum);
		if (f && !Number.isNaN(num)) {
			if (f.lastSeenNum === null || f.lastSeenNum === undefined || num > f.lastSeenNum) {
				f.lastSeenNum = num;
			}
			if (f.status === 'plan') f.status = 'reading'; // auto-promote once you start
		}
		if (!Number.isNaN(num)) {
			this.db.updates = this.db.updates.filter(
				(u) => !(u.mangaId === mangaSnap.id && parseFloat(u.num) <= num)
			);
		}
		this.saveDb();
	}

	getReading(mangaId) {
		return this.db.reading[mangaId] || null;
	}

	getReadingAll() {
		return Object.values(this.db.reading)
			.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
	}

	// Drop a series from Continue Reading. Downloads and follows are untouched;
	// this only forgets where you were.
	removeReading(mangaId) {
		delete this.db.reading[mangaId];
		this.saveDb();
	}

	// ---------- paused download queue (survives a quit) ----------

	savePendingQueue(jobs) {
		this.db.pendingQueue = jobs || [];
		this.saveDb();
	}

	// Read once and clear: a restore that crashes shouldn't loop forever on the
	// same queue at every launch.
	takePendingQueue() {
		const jobs = this.db.pendingQueue || [];
		if (jobs.length) {
			this.db.pendingQueue = [];
			this.saveDb();
		}
		return jobs;
	}

	// ---------- follows (bookmarks with a status shelf) ----------

	follow(manga, status, lastSeenNum) {
		const existing = this.db.follows[manga.id];
		this.db.follows[manga.id] = {
			status,
			addedAt: existing?.addedAt || new Date().toISOString(),
			lastSeenNum: existing?.lastSeenNum ?? (Number.isFinite(lastSeenNum) ? lastSeenNum : null),
			lastCheckedChapterId: existing?.lastCheckedChapterId || null,
			notify: existing?.notify ?? true,
			manga: {
				id: manga.id,
				title: manga.title,
				coverUrl: manga.coverUrl || existing?.manga?.coverUrl || null,
				status: manga.status || null,
				year: manga.year || null
			}
		};
		this.saveDb();
		return this.db.follows[manga.id];
	}

	setNotify(mangaId, on) {
		const f = this.db.follows[mangaId];
		if (!f) return null;
		f.notify = Boolean(on);
		this.saveDb();
		return f;
	}

	unfollow(mangaId) {
		delete this.db.follows[mangaId];
		this.db.updates = this.db.updates.filter((u) => u.mangaId !== mangaId);
		this.saveDb();
	}

	getFollow(mangaId) {
		return this.db.follows[mangaId] || null;
	}

	getFollowsAll() {
		return Object.entries(this.db.follows)
			.map(([id, f]) => ({
				...f,
				downloaded: Boolean(this.db.manga[id]),
				progress: this.db.reading[id] || null
			}))
			.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
	}

	// ---------- updates feed ----------

	// returns only the entries that were actually new
	pushUpdates(entries) {
		const known = new Set(this.db.updates.map((u) => u.chapterId));
		const fresh = entries.filter((e) => !known.has(e.chapterId));
		this.db.updates = [...fresh, ...this.db.updates].slice(0, 300);
		this.saveDb();
		return fresh;
	}

	getUpdatesFeed() {
		return this.db.updates;
	}

	removeChapter(mangaId, chapterId) {
		const m = this.db.manga[mangaId];
		const ch = m?.chapters?.[chapterId];
		if (!ch) return;
		fs.rmSync(ch.path, { recursive: true, force: true });
		delete m.chapters[chapterId];
		this.saveDb();
	}

	// Delete several chapters at once, writing the db a single time.
	removeChapters(mangaId, chapterIds) {
		const m = this.db.manga[mangaId];
		if (!m) return 0;
		let removed = 0;
		for (const chapterId of chapterIds || []) {
			const ch = m.chapters[chapterId];
			if (!ch) continue;
			fs.rmSync(ch.path, { recursive: true, force: true });
			delete m.chapters[chapterId];
			removed++;
		}
		if (removed) this.saveDb();
		return removed;
	}

	// Disk usage per downloaded series (bytes), largest first, with the total.
	storageUsage() {
		const items = Object.values(this.db.manga).map((m) => ({
			id: m.id,
			title: m.title,
			chapters: Object.keys(m.chapters).length,
			bytes: fs.existsSync(m.path) ? dirSize(m.path) : 0
		})).sort((a, b) => b.bytes - a.bytes);
		return { items, total: items.reduce((sum, it) => sum + it.bytes, 0) };
	}

	removeManga(mangaId) {
		const m = this.db.manga[mangaId];
		if (!m) return;
		fs.rmSync(m.path, { recursive: true, force: true });
		delete this.db.manga[mangaId];
		this.saveDb();
	}

	// Is this absolute path inside the library (or a tracked manga folder, in
	// case the library folder was moved)? Used by the mangafile:// protocol so
	// the renderer can only read library images.
	isAllowedPath(absPath) {
		const norm = path.resolve(absPath);
		const roots = [this.settings.libraryPath, ...Object.values(this.db.manga).map((m) => m.path)];
		return roots.some((r) => {
			const root = path.resolve(r);
			return norm === root || norm.startsWith(root + path.sep);
		});
	}
}

module.exports = { Library, sanitizeName, padChapter };
