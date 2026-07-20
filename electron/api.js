// Shared command registry: the desktop renderer (over IPC) and linked phones
// (over the LAN remote server) run the same commands against the same state.
// Commands return raw data — covers and pages come back as absolute disk
// paths — and each transport maps those to URLs its client can actually load
// (mangafile:// for the renderer, /file for phones) via makePostMap.

const mangadex = require('./mangadex');
const mangakatana = require('./mangakatana');
const { checkForUpdates } = require('./updates');

const MIN = 60_000;

// commands that mutate shared state, and which domain they touch — used to
// tell the other side (desktop or phone) that it should refresh
const MUTATES = {
	'lib:removeChapter': 'library',
	'lib:removeManga': 'library',
	'reading:set': 'reading',
	'reading:remove': 'reading',
	'follows:set': 'follows',
	'follows:remove': 'follows',
	'follows:setNotify': 'follows',
	'updates:check': 'updates'
};

function createApi({ library, downloader, cache, onChange }) {
	const cr = () => library.getSettings().contentRating;
	const chapterOpts = () => {
		const s = library.getSettings();
		return { contentRating: s.contentRating, language: s.language };
	};

	const commands = {
		// ----- discovery (cached: fresh hits skip the network, stale hits refresh in background) -----
		'md:home': () =>
			cache.wrap(`home:${cr().join()}`, 10 * MIN, () => mangadex.getHomeSections(cr()), { persist: true }),
		'md:tags': () =>
			cache.wrap('tags', 24 * 60 * MIN, () => mangadex.getTags(), { persist: true }),
		'md:search': (opts) =>
			cache.wrap(`search:${JSON.stringify(opts)}:${cr().join()}`, 5 * MIN,
				() => mangadex.searchManga({ ...opts, contentRating: cr() })),
		'md:manga': (id) =>
			cache.wrap(`manga:${id}`, 30 * MIN,
				() => mangakatana.isMkId(id) ? mangakatana.getManga(id) : mangadex.getManga(id)),
		'md:stats': (id) =>
			mangakatana.isMkId(id) ? null : cache.wrap(`stats:${id}`, 30 * MIN, () => mangadex.getStats(id)),
		'md:chapters': (id) =>
			cache.wrap(`chapters:${id}:${JSON.stringify(chapterOpts())}`, 10 * MIN,
				() => mangakatana.isMkId(id) ? mangakatana.getChapters(id) : mangadex.getChapters(id, chapterOpts())),
		'md:byIds': (ids) =>
			cache.wrap(`byIds:${[...ids].sort().join()}`, 30 * MIN, () => mangadex.getMangaByIds(ids)),
		'md:similar': (manga) =>
			mangakatana.isMkId(manga.id) ? [] : cache.wrap(`similar:${manga.id}:${cr().join()}`, 60 * MIN, () => mangadex.getSimilar(manga, cr())),
		// image URLs expire server-side after a short while, so only a short TTL is safe
		'md:chapterImages': (chapterId) =>
			cache.wrap(`pages:${chapterId}:${library.getSettings().quality}`, 5 * MIN,
				() => mangakatana.isMkId(chapterId)
					? mangakatana.getChapterImageUrls(chapterId)
					: mangadex.getChapterImageUrls(chapterId, library.getSettings().quality),
				{ maxStaleMs: 0 }),

		// ----- alternative source (manual fallback when MangaDex doesn't have it) -----
		'mk:search': (query) =>
			cache.wrap(`mk:search:${query}`, 10 * MIN, () => mangakatana.searchManga(query)),

		// ----- downloads -----
		'dl:add': (manga, chapters) => downloader.add(manga, chapters),
		'dl:cancel': (jobId) => downloader.cancel(jobId),
		'dl:retry': (jobId) => downloader.retry(jobId),
		'dl:queue': () => downloader.snapshot(),
		'dl:clearFinished': () => downloader.clearFinished(),

		// ----- library -----
		'lib:all': () => library.getAll(),
		'lib:get': (id) => library.get(id),
		'lib:pages': (mangaId, chapterId) => library.getChapterPages(mangaId, chapterId),
		'lib:removeChapter': (mangaId, chapterId) => library.removeChapter(mangaId, chapterId),
		'lib:removeManga': (mangaId) => library.removeManga(mangaId),

		// ----- reading progress (any manga) -----
		'reading:set': (mangaSnap, progress) => library.setReading(mangaSnap, progress),
		'reading:get': (id) => library.getReading(id),
		'reading:all': () => library.getReadingAll(),
		'reading:remove': (id) => library.removeReading(id),

		// ----- follows -----
		'follows:set': (manga, status, lastSeenNum) => library.follow(manga, status, lastSeenNum),
		'follows:remove': (id) => library.unfollow(id),
		'follows:get': (id) => library.getFollow(id),
		'follows:all': () => library.getFollowsAll(),
		'follows:setNotify': (id, on) => library.setNotify(id, on),

		// ----- updates feed -----
		'updates:check': () => checkForUpdates(library),
		'updates:feed': () => library.getUpdatesFeed()
	};

	async function dispatch(name, args = [], source = 'desktop') {
		const fn = commands[name];
		if (!fn) throw new Error(`Unknown command: ${name}`);
		const result = await fn(...args);
		if (MUTATES[name]) onChange?.(MUTATES[name], source);
		return result;
	}

	return { commands, dispatch };
}

// Per-transport result decoration: fileUrl maps an absolute disk path to a URL
// the transport's client can load. Only commands that expose local files need it.
function makePostMap(library, fileUrl) {
	const manga = (m) => (m ? { ...m, coverUrl: m.coverPath ? fileUrl(m.coverPath) : null } : m);
	// prefer the local cover when the manga is downloaded, else the stored URL
	const reading = (r) => {
		if (!r) return r;
		const lib = library.get(r.manga.id);
		const coverUrl = lib?.coverPath ? fileUrl(lib.coverPath) : r.manga.coverUrl;
		return { ...r, manga: { ...r.manga, coverUrl } };
	};
	return {
		'lib:all': (list) => list.map(manga),
		'lib:get': manga,
		'lib:pages': (paths) => paths.map(fileUrl),
		'reading:get': reading,
		'reading:all': (list) => list.map(reading)
	};
}

module.exports = { createApi, makePostMap };
