// Download queue: chapters download one at a time, pages within a chapter
// download 4 at a time. Progress is pushed to the renderer after every page.

const fs = require('fs');
const path = require('path');
const mangadex = require('./mangadex');
const mangakatana = require('./mangakatana');

const PAGE_CONCURRENCY = 4;

function clientFor(id) {
	return mangakatana.isMkId(id) ? mangakatana : mangadex;
}

class Downloader {
	constructor(library, onUpdate) {
		this.library = library;
		this.onUpdate = onUpdate;
		this.queue = [];
		this.running = false;
		this.cancelled = new Set();
		this.counter = 0;
		this.lastNotifyAt = 0;
	}

	snapshot() {
		return this.queue.map((j) => ({
			id: j.id,
			mangaId: j.manga.id,
			mangaTitle: j.manga.title,
			coverUrl: j.manga.coverUrl || null,
			chapterId: j.chapter.id,
			chapterNum: j.chapter.num,
			chapterTitle: j.chapter.title,
			status: j.status,
			done: j.done,
			total: j.total,
			error: j.error || null
		}));
	}

	notify() {
		this.lastNotifyAt = Date.now();
		this.onUpdate(this.snapshot());
	}

	// per-page progress ticks: each notify() serializes the whole queue, so on a
	// long queue don't broadcast more than ~4×/sec. Status changes (queued /
	// done / error) still call notify() directly and are never dropped.
	notifyProgress() {
		if (Date.now() - this.lastNotifyAt >= 250) this.notify();
	}

	// manga: normalized manga object; chapters: normalized chapter objects
	add(manga, chapters) {
		const queued = new Set(this.queue.filter((j) => j.status === 'queued' || j.status === 'downloading').map((j) => j.chapter.id));
		for (const chapter of chapters) {
			if (chapter.external) continue;
			if (queued.has(chapter.id)) continue;
			if (this.library.hasChapter(manga.id, chapter.id)) continue;
			this.queue.push({
				id: ++this.counter,
				manga,
				chapter,
				status: 'queued',
				done: 0,
				total: chapter.pages || 0,
				error: null
			});
		}
		this.notify();
		this.run();
	}

	cancel(jobId) {
		const job = this.queue.find((j) => j.id === jobId);
		if (!job) return;
		if (job.status === 'queued') {
			job.status = 'cancelled';
		} else if (job.status === 'downloading') {
			this.cancelled.add(jobId);
		}
		this.notify();
	}

	// re-queue a failed or cancelled job (already-saved pages are skipped)
	retry(jobId) {
		const job = this.queue.find((j) => j.id === jobId);
		if (!job || (job.status !== 'error' && job.status !== 'cancelled')) return;
		job.status = 'queued';
		job.done = 0;
		job.error = null;
		this.notify();
		this.run();
	}

	clearFinished() {
		this.queue = this.queue.filter((j) => j.status === 'queued' || j.status === 'downloading');
		this.notify();
	}

	hasActiveJobs() {
		return this.queue.some((j) => j.status === 'queued' || j.status === 'downloading');
	}

	// Unfinished work, with the full manga/chapter objects a restore needs. The
	// in-flight job comes back as 'queued': its finished pages are already on
	// disk and get skipped, so restarting it costs nothing.
	pendingJobs() {
		return this.queue
			.filter((j) => j.status === 'queued' || j.status === 'downloading')
			.map((j) => ({ manga: j.manga, chapter: j.chapter }));
	}

	// Re-queue jobs saved by a previous session and start downloading.
	restore(saved) {
		if (!Array.isArray(saved) || !saved.length) return 0;
		let added = 0;
		for (const { manga, chapter } of saved) {
			if (!manga?.id || !chapter?.id) continue;
			if (this.library.hasChapter(manga.id, chapter.id)) continue;
			this.queue.push({
				id: ++this.counter,
				manga,
				chapter,
				status: 'queued',
				done: 0,
				total: chapter.pages || 0,
				error: null
			});
			added++;
		}
		if (added) { this.notify(); this.run(); }
		return added;
	}

	async run() {
		if (this.running) return;
		this.running = true;
		try {
			let job;
			while ((job = this.queue.find((j) => j.status === 'queued'))) {
				job.status = 'downloading';
				this.notify();
				try {
					await this.downloadChapter(job);
					job.status = this.cancelled.has(job.id) ? 'cancelled' : 'done';
				} catch (err) {
					console.error('Download failed:', err);
					job.status = 'error';
					job.error = err.message;
				}
				this.cancelled.delete(job.id);
				this.notify();
			}
		} finally {
			this.running = false;
		}
	}

	async downloadChapter(job) {
		const { manga, chapter } = job;
		this.library.ensureLibraryDir();
		const entry = this.library.upsertManga(manga);

		const client = clientFor(manga.id);

		// grab the cover once per manga
		if (!entry.coverFile && manga.coverUrlFull) {
			try {
				const buf = await client.fetchImage(manga.coverUrlFull);
				const ext = path.extname(new URL(manga.coverUrlFull).pathname) || '.jpg';
				const coverFile = `cover${ext}`;
				fs.writeFileSync(path.join(entry.path, coverFile), buf);
				this.library.setCover(manga.id, coverFile);
			} catch (err) {
				console.error('Cover download failed:', err.message);
			}
		}

		const urls = await client.getChapterImageUrls(chapter.id, this.library.getSettings().quality);
		job.total = urls.length;
		this.notify();

		const dir = this.library.chapterDir(manga, chapter);
		fs.mkdirSync(dir, { recursive: true });

		let nextIndex = 0;
		const worker = async () => {
			while (nextIndex < urls.length) {
				if (this.cancelled.has(job.id)) return;
				const i = nextIndex++;
				const url = urls[i];
				const ext = path.extname(new URL(url).pathname) || '.jpg';
				const file = path.join(dir, String(i + 1).padStart(3, '0') + ext);
				if (!fs.existsSync(file)) {
					const buf = await client.fetchImage(url);
					fs.writeFileSync(file, buf);
				}
				job.done++;
				this.notifyProgress();
			}
		};
		await Promise.all(Array.from({ length: PAGE_CONCURRENCY }, worker));

		if (this.cancelled.has(job.id)) {
			fs.rmSync(dir, { recursive: true, force: true });
			return;
		}
		this.library.addChapter(manga.id, chapter, dir, urls.length);
	}
}

module.exports = { Downloader };
