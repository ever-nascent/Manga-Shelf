// MangaDex API client. Docs: https://api.mangadex.org/docs/
// MangaDex asks for a descriptive User-Agent and <5 requests/sec.

const { USER_AGENT, sleep, makeRateLimiter, fetchImage } = require('./util');

const API_BASE = 'https://api.mangadex.org';
const COVER_BASE = 'https://uploads.mangadex.org/covers';

const rateLimit = makeRateLimiter(250);

function buildUrl(path, params = {}) {
	const url = new URL(API_BASE + path);
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null || value === '') continue;
		if (Array.isArray(value)) {
			for (const v of value) url.searchParams.append(`${key}[]`, v);
		} else {
			url.searchParams.append(key, value);
		}
	}
	return url;
}

async function apiFetch(path, params, attempt = 1) {
	await rateLimit();
	const url = buildUrl(path, params);
	const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });

	if (res.status === 429 && attempt <= 3) {
		const retryAfter = Number(res.headers.get('retry-after')) || 2;
		await sleep(retryAfter * 1000);
		return apiFetch(path, params, attempt + 1);
	}
	if (!res.ok) {
		throw new Error(`MangaDex API error ${res.status} on ${path}`);
	}
	return res.json();
}

// ---------- normalization ----------

function pickLocalized(obj) {
	if (!obj || typeof obj !== 'object') return '';
	return obj.en || obj['ja-ro'] || obj.ja || Object.values(obj)[0] || '';
}

function normalizeManga(d) {
	const a = d.attributes || {};
	const rels = d.relationships || [];

	let title = pickLocalized(a.title);
	if (!title) {
		const alt = (a.altTitles || []).find((t) => t.en) || (a.altTitles || [])[0];
		title = pickLocalized(alt) || 'Untitled';
	}

	const coverRel = rels.find((r) => r.type === 'cover_art');
	const coverFile = coverRel?.attributes?.fileName || null;

	const authors = [...new Set(
		rels.filter((r) => r.type === 'author' || r.type === 'artist')
			.map((r) => r.attributes?.name)
			.filter(Boolean)
	)];

	return {
		id: d.id,
		title,
		description: pickLocalized(a.description),
		status: a.status || 'unknown',
		year: a.year || null,
		contentRating: a.contentRating || 'safe',
		tags: (a.tags || []).map((t) => ({
			id: t.id,
			name: t.attributes?.name?.en || '?',
			group: t.attributes?.group || 'other'
		})),
		authors,
		coverUrl: coverFile ? `${COVER_BASE}/${d.id}/${coverFile}.512.jpg` : null,
		coverUrlFull: coverFile ? `${COVER_BASE}/${d.id}/${coverFile}` : null,
		latestChapterId: a.latestUploadedChapter || null,
		related: rels.filter((r) => r.type === 'manga' && r.related)
			.map((r) => ({ id: r.id, relation: r.related }))
	};
}

function normalizeChapter(c) {
	const a = c.attributes || {};
	const group = (c.relationships || []).find((r) => r.type === 'scanlation_group');
	return {
		id: c.id,
		num: a.chapter,          // string like "12.5", or null for oneshots
		volume: a.volume,
		title: a.title || '',
		pages: a.pages || 0,
		language: a.translatedLanguage,
		publishAt: a.publishAt,
		external: Boolean(a.externalUrl),
		externalUrl: a.externalUrl || null,
		group: group?.attributes?.name || 'Unknown group'
	};
}

// ---------- public API ----------

async function listManga(params) {
	const json = await apiFetch('/manga', {
		'includes': ['cover_art'],
		...params
	});
	return {
		items: (json.data || []).map(normalizeManga),
		total: json.total || 0
	};
}

async function getHomeSections(contentRating) {
	const common = {
		limit: 18,
		contentRating,
		hasAvailableChapters: 'true',
		availableTranslatedLanguage: ['en']
	};
	const [popular, topRated, recent] = await Promise.all([
		listManga({ ...common, 'order[followedCount]': 'desc' }),
		listManga({ ...common, 'order[rating]': 'desc' }),
		listManga({ ...common, 'order[latestUploadedChapter]': 'desc' })
	]);
	return { popular: popular.items, topRated: topRated.items, recent: recent.items };
}

const SORT_MAP = {
	relevance: 'order[relevance]',
	popular: 'order[followedCount]',
	rating: 'order[rating]',
	updated: 'order[latestUploadedChapter]',
	newest: 'order[createdAt]'
};

async function searchManga({ query, includedTags, status, sort, offset, limit, contentRating }) {
	const params = {
		title: query || undefined,
		includedTags: includedTags?.length ? includedTags : undefined,
		status: status ? [status] : undefined,
		contentRating,
		hasAvailableChapters: 'true',
		limit: limit || 24,
		offset: offset || 0
	};
	// relevance ordering is only valid alongside a title query
	const effectiveSort = !query && sort === 'relevance' ? 'popular' : sort;
	const sortKey = SORT_MAP[effectiveSort] || (query ? SORT_MAP.relevance : SORT_MAP.popular);
	params[sortKey] = 'desc';
	return listManga(params);
}

async function getTags() {
	const json = await apiFetch('/manga/tag');
	return (json.data || [])
		.map((t) => ({
			id: t.id,
			name: t.attributes?.name?.en || '?',
			group: t.attributes?.group || 'other'
		}))
		.sort((x, y) => x.name.localeCompare(y.name));
}

async function getManga(id) {
	const json = await apiFetch(`/manga/${id}`, {
		'includes': ['cover_art', 'author', 'artist']
	});
	return normalizeManga(json.data);
}

async function getStats(id) {
	try {
		const json = await apiFetch(`/statistics/manga/${id}`);
		const s = json.statistics?.[id];
		if (!s) return null;
		return {
			rating: s.rating?.bayesian ?? s.rating?.average ?? null,
			follows: s.follows ?? null
		};
	} catch {
		return null; // stats are nice-to-have, never fatal
	}
}

async function getChapters(mangaId, { language, contentRating }) {
	const all = [];
	const limit = 500;
	let offset = 0;
	let total = Infinity;

	while (offset < total) {
		const json = await apiFetch(`/manga/${mangaId}/feed`, {
			limit,
			offset,
			translatedLanguage: [language || 'en'],
			contentRating,
			'includes': ['scanlation_group'],
			'order[volume]': 'asc',
			'order[chapter]': 'asc'
		});
		total = json.total || 0;
		all.push(...(json.data || []).map(normalizeChapter));
		offset += limit;
	}
	return all;
}

async function getMangaByIds(ids) {
	if (!ids.length) return [];
	const { items } = await listManga({
		ids: ids.slice(0, 100),
		limit: Math.min(ids.length, 100),
		contentRating: ['safe', 'suggestive', 'erotica', 'pornographic']
	});
	return items;
}

async function getSimilar(manga, contentRating) {
	const tagIds = manga.tags.slice(0, 3).map((t) => t.id);
	if (!tagIds.length) return [];
	const { items } = await listManga({
		includedTags: tagIds,
		contentRating,
		hasAvailableChapters: 'true',
		limit: 13,
		'order[followedCount]': 'desc'
	});
	return items.filter((m) => m.id !== manga.id).slice(0, 12);
}

// Newest few chapters of a manga (single request) — used by the update checker.
async function getLatestChapters(mangaId, { language, contentRating, limit = 12 }) {
	const json = await apiFetch(`/manga/${mangaId}/feed`, {
		limit,
		translatedLanguage: [language || 'en'],
		contentRating,
		'order[chapter]': 'desc'
	});
	return (json.data || []).map(normalizeChapter);
}

// Returns full-size page image URLs for a chapter.
async function getChapterImageUrls(chapterId, quality = 'data') {
	const json = await apiFetch(`/at-home/server/${chapterId}`);
	const { baseUrl } = json;
	const { hash } = json.chapter;
	const files = quality === 'data-saver' ? json.chapter.dataSaver : json.chapter.data;
	const dir = quality === 'data-saver' ? 'data-saver' : 'data';
	return files.map((f) => `${baseUrl}/${dir}/${hash}/${f}`);
}

module.exports = {
	getHomeSections,
	searchManga,
	getTags,
	getManga,
	getStats,
	getChapters,
	getLatestChapters,
	getMangaByIds,
	getSimilar,
	getChapterImageUrls,
	fetchImage,
	USER_AGENT
};
