// Checks followed manga for newly released chapters.
//
// Strategy: one batched /manga?ids[] call per 100 follows tells us each manga's
// latest uploaded chapter id (any language). Only manga whose id changed since
// the last check get an individual feed request, so a quiet library costs a
// couple of API calls total.

const mangadex = require('./mangadex');

async function checkForUpdates(library) {
	const settings = library.getSettings();
	const follows = library.getFollowsAll().filter((f) => f.status !== 'dropped');
	if (!follows.length) {
		library.db.meta.lastUpdateCheckAt = new Date().toISOString();
		library.saveDb();
		return { added: 0, feed: library.getUpdatesFeed(), fresh: [] };
	}

	// batch: current latest-chapter marker for every follow
	const latestById = new Map();
	for (let i = 0; i < follows.length; i += 100) {
		const chunk = follows.slice(i, i + 100).map((f) => f.manga.id);
		const items = await mangadex.getMangaByIds(chunk);
		for (const m of items) latestById.set(m.id, m.latestChapterId);
	}

	let added = 0;
	const freshByManga = []; // for desktop notifications
	for (const f of follows) {
		const id = f.manga.id;
		const latest = latestById.get(id);
		const stored = library.db.follows[id];
		if (!latest || !stored || latest === stored.lastCheckedChapterId) continue;

		try {
			const chapters = await mangadex.getLatestChapters(id, {
				language: settings.language,
				contentRating: settings.contentRating
			});

			if (stored.lastSeenNum === null || stored.lastSeenNum === undefined) {
				// first sync for this follow: record the current newest, report nothing
				const nums = chapters.map((c) => parseFloat(c.num)).filter((n) => !Number.isNaN(n));
				stored.lastSeenNum = nums.length ? Math.max(...nums) : 0;
			} else {
				const fresh = chapters
					.filter((c) => !c.external && !Number.isNaN(parseFloat(c.num)))
					.filter((c) => parseFloat(c.num) > stored.lastSeenNum)
					.map((c) => ({
						mangaId: id,
						mangaTitle: f.manga.title,
						coverUrl: f.manga.coverUrl,
						chapterId: c.id,
						num: c.num,
						chapterTitle: c.title,
						publishAt: c.publishAt,
						foundAt: new Date().toISOString()
					}));
				const pushed = library.pushUpdates(fresh);
				added += pushed.length;
				if (pushed.length) {
					freshByManga.push({
						mangaId: id,
						title: f.manga.title,
						notify: stored.notify !== false,
						nums: pushed.map((e) => e.num)
					});
				}
			}
			stored.lastCheckedChapterId = latest;
		} catch (err) {
			console.error(`Update check failed for ${f.manga.title}:`, err.message);
		}
	}

	library.db.meta.lastUpdateCheckAt = new Date().toISOString();
	library.saveDb();
	return { added, feed: library.getUpdatesFeed(), fresh: freshByManga };
}

module.exports = { checkForUpdates };
