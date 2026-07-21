// Checks followed manga for newly released chapters.
//
// Follows can come from two sources:
//   MangaDex   (UUID ids)       one batched /manga?ids[] call per 100 follows
//                               tells us each manga's latest uploaded chapter
//                               id, so only manga whose id changed since the
//                               last check cost an individual feed request.
//   MangaKatana (mk: ids)       no API, so each follow costs one HTML scrape of
//                               its chapter list. The newest chapter id doubles
//                               as the "changed since last time?" marker.

const mangadex = require('./mangadex');
const mangakatana = require('./mangakatana');

// Turns a manga's newest chapters into feed entries, seeding on first sight so
// we never dump a follow's entire backlog into the updates feed. Shared by both
// sources. Mutates `stored.lastSeenNum` and returns what to report.
function collectFresh(follow, chapters, stored, library) {
	const id = follow.manga.id;

	if (stored.lastSeenNum === null || stored.lastSeenNum === undefined) {
		// first sync for this follow: record the current newest, report nothing
		const nums = chapters.map((c) => parseFloat(c.num)).filter((n) => !Number.isNaN(n));
		stored.lastSeenNum = nums.length ? Math.max(...nums) : 0;
		return { added: 0, fresh: null };
	}

	const entries = chapters
		.filter((c) => !c.external && !Number.isNaN(parseFloat(c.num)))
		.filter((c) => parseFloat(c.num) > stored.lastSeenNum)
		.map((c) => ({
			mangaId: id,
			mangaTitle: follow.manga.title,
			coverUrl: follow.manga.coverUrl,
			chapterId: c.id,
			num: c.num,
			chapterTitle: c.title,
			publishAt: c.publishAt,
			foundAt: new Date().toISOString()
		}));

	const pushed = library.pushUpdates(entries);
	return {
		added: pushed.length,
		fresh: pushed.length
			? {
				mangaId: id,
				title: follow.manga.title,
				notify: stored.notify !== false,
				nums: pushed.map((e) => e.num)
			}
			: null
	};
}

async function checkForUpdates(library) {
	const settings = library.getSettings();
	const follows = library.getFollowsAll().filter((f) => f.status !== 'dropped');
	if (!follows.length) {
		library.db.meta.lastUpdateCheckAt = new Date().toISOString();
		library.saveDb();
		return { added: 0, feed: library.getUpdatesFeed(), fresh: [], failed: [] };
	}

	const mdFollows = follows.filter((f) => !mangakatana.isMkId(f.manga.id));
	const mkFollows = follows.filter((f) => mangakatana.isMkId(f.manga.id));

	let added = 0;
	const freshByManga = []; // for desktop notifications
	const failed = []; // series we couldn't check, surfaced in the Updates view

	// ----- MangaDex: batch the cheap "did anything change?" markers -----
	// One malformed batch (or a MangaDex outage) must not sink the whole check,
	// so a failed chunk just leaves those follows unmarked and skipped this run.
	const latestById = new Map();
	for (let i = 0; i < mdFollows.length; i += 100) {
		const chunk = mdFollows.slice(i, i + 100).map((f) => f.manga.id);
		try {
			const items = await mangadex.getMangaByIds(chunk);
			for (const m of items) latestById.set(m.id, m.latestChapterId);
		} catch (err) {
			console.error('Update batch failed for a chunk of follows:', err.message);
			failed.push({ title: `${chunk.length} MangaDex follows (batch check)`, error: err.message });
		}
	}

	for (const f of mdFollows) {
		const id = f.manga.id;
		const latest = latestById.get(id);
		const stored = library.db.follows[id];
		if (!latest || !stored || latest === stored.lastCheckedChapterId) continue;

		try {
			const chapters = await mangadex.getLatestChapters(id, {
				language: settings.language,
				contentRating: settings.contentRating
			});
			const result = collectFresh(f, chapters, stored, library);
			added += result.added;
			if (result.fresh) freshByManga.push(result.fresh);
			stored.lastCheckedChapterId = latest;
		} catch (err) {
			console.error(`Update check failed for ${f.manga.title}:`, err.message);
			failed.push({ title: f.manga.title, error: err.message });
		}
	}

	// ----- MangaKatana: one chapter-list scrape per follow -----
	for (const f of mkFollows) {
		const id = f.manga.id;
		const stored = library.db.follows[id];
		if (!stored) continue;

		try {
			// getChapters throws on a blocked page or layout change, so an empty
			// list can't silently pass for "nothing new" anymore
			const chapters = await mangakatana.getChapters(id);
			const latest = chapters[chapters.length - 1].id; // list is oldest -> newest
			if (latest === stored.lastCheckedChapterId) continue;

			const result = collectFresh(f, chapters, stored, library);
			added += result.added;
			if (result.fresh) freshByManga.push(result.fresh);
			stored.lastCheckedChapterId = latest;
		} catch (err) {
			console.error(`Update check failed for ${f.manga.title}:`, err.message);
			failed.push({ title: f.manga.title, error: err.message });
		}
	}

	library.db.meta.lastUpdateCheckAt = new Date().toISOString();
	library.saveDb();
	return { added, feed: library.getUpdatesFeed(), fresh: freshByManga, failed };
}

module.exports = { checkForUpdates };
