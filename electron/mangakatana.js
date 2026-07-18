// MangaKatana scraper — used as a manual "alternative source" fallback when a
// series isn't on MangaDex (or lacks downloadable chapters there). There's no
// public API, so this parses the site's HTML directly.
//
// IDs are self-describing so nothing needs a side lookup table:
//   manga id   -> `mk:<slug>.<numericId>`      e.g. mk:one-piece.49
//   chapter id -> `mk:<slug>.<numericId>/<chapterSlug>`  e.g. mk:one-piece.49/c1188
// Both map straight back to a URL under BASE.

const cheerio = require('cheerio');

const BASE = 'https://mangakatana.com';
const USER_AGENT = 'MangaShelf/2.0 (personal desktop reader; github.com/LiterallyLink/Manga-Downloader)';

const MIN_REQUEST_GAP_MS = 400;
let nextSlot = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rateLimit() {
	const now = Date.now();
	const wait = Math.max(0, nextSlot - now);
	nextSlot = Math.max(now, nextSlot) + MIN_REQUEST_GAP_MS;
	if (wait > 0) await sleep(wait);
}

async function htmlFetch(url, attempt = 1) {
	await rateLimit();
	const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
	if (!res.ok) {
		if (res.status === 429 && attempt <= 3) {
			await sleep(1500 * attempt);
			return htmlFetch(url, attempt + 1);
		}
		throw new Error(`MangaKatana request failed (${res.status}): ${url}`);
	}
	return res.text();
}

function isMkId(id) {
	return typeof id === 'string' && id.startsWith('mk:');
}

function slugFromMangaId(mangaId) {
	return mangaId.slice('mk:'.length);
}

function mangaUrlFromId(mangaId) {
	return `${BASE}/manga/${slugFromMangaId(mangaId)}`;
}

function chapterUrlFromId(chapterId) {
	return `${BASE}/manga/${chapterId.slice('mk:'.length)}`;
}

// Pulls the `<slug>.<numericId>` segment out of a MangaKatana manga URL/href.
function slugIdFromHref(href) {
	const m = href.match(/\/manga\/([^/?#]+)/);
	return m ? m[1] : null;
}

function parseUpdateDate(text) {
	if (!text) return null;
	const d = new Date(text.trim());
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------- search ----------

async function searchManga(query) {
	const url = `${BASE}/?search=${encodeURIComponent(query)}&search_by=book_name`;
	const html = await htmlFetch(url);
	const $ = cheerio.load(html);
	const results = [];

	$('#book_list .item, #single_list .item, .item[data-id]').each((_, el) => {
		const $el = $(el);
		const titleLink = $el.find('h3.title a').first();
		const href = titleLink.attr('href');
		if (!href) return;
		const slugId = slugIdFromHref(href);
		if (!slugId) return;

		const cover = $el.find('.wrap_img img').first();
		const coverUrl = cover.attr('data-src') || cover.attr('src') || null;
		const latestChapter = $el.find('.chapter a').first().text().trim() || null;
		const status = $el.find('.status').text().trim() || null;

		results.push({
			id: `mk:${slugId}`,
			title: titleLink.text().trim(),
			coverUrl,
			latestChapterLabel: latestChapter,
			status
		});
	});

	// de-dupe (the page renders a couple of overlapping list markups)
	const seen = new Set();
	return results.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
}

// ---------- manga details ----------

async function getManga(mangaId) {
	const html = await htmlFetch(mangaUrlFromId(mangaId));
	const $ = cheerio.load(html);

	const title = $('#single_book h1.heading').first().text().trim() || 'Untitled';
	const coverUrl = $('#single_book .cover img').first().attr('src') || null;
	const description = $('#single_book .summary p').first().text().trim();
	const authors = $('#single_book .value.authors a').map((_, a) => $(a).text().trim()).get();
	const statusText = $('#single_book .value.status').first().text().trim().toLowerCase();
	const status = statusText.includes('ongoing') ? 'ongoing' : statusText.includes('completed') ? 'completed' : 'unknown';
	const tags = $('#single_book .genres a').map((_, a) => {
		const name = $(a).text().trim();
		return { id: `mk-genre:${name.toLowerCase().replace(/\s+/g, '-')}`, name, group: 'genre' };
	}).get();

	return {
		id: mangaId,
		title,
		description,
		status,
		year: null,
		contentRating: 'safe',
		tags,
		authors,
		coverUrl,
		coverUrlFull: coverUrl,
		latestChapterId: null,
		related: [],
		source: 'mangakatana'
	};
}

// ---------- chapters ----------

function parseChapterNumAndTitle(linkText) {
	// e.g. "Chapter 1188: Wailing Void" / "Chapter 11.5" / "Chapter 0 v2"
	const m = linkText.match(/^Chapter\s+([\d.]+)\s*[: ]?\s*(.*)$/i);
	if (!m) return { num: null, title: linkText.trim() };
	return { num: m[1], title: m[2].trim() };
}

async function getChapters(mangaId) {
	const html = await htmlFetch(mangaUrlFromId(mangaId));
	const $ = cheerio.load(html);
	const slugId = slugFromMangaId(mangaId);
	const chapters = [];

	$('.chapters table tr').each((_, tr) => {
		const $tr = $(tr);
		const link = $tr.find('.chapter a').first();
		const href = link.attr('href');
		if (!href) return;
		const chapterSlug = href.split('/').filter(Boolean).pop();
		const { num, title } = parseChapterNumAndTitle(link.text().trim());
		const publishAt = parseUpdateDate($tr.find('.update_time').first().text());

		chapters.push({
			id: `mk:${slugId}/${chapterSlug}`,
			num,
			volume: null,
			title,
			pages: 1, // real count is only known once the reader page is fetched
			language: 'en',
			publishAt,
			external: false,
			externalUrl: null,
			group: 'MangaKatana'
		});
	});

	return chapters.reverse(); // table lists newest first
}

// ---------- chapter images ----------

// Reader pages embed the page URLs as a plain JS array (no obfuscation to
// reverse) — pull every distinct token URL out of the raw HTML in document
// order, which naturally de-dupes the redundant `ytaw`/`thzq` declarations.
const IMG_URL_RE = /https:\/\/i\d\.mangakatana\.com\/[^\s'"]+?\.(?:jpg|jpeg|png|webp)/g;

async function getChapterImageUrls(chapterId) {
	const html = await htmlFetch(chapterUrlFromId(chapterId));
	const matches = html.match(IMG_URL_RE) || [];
	const seen = new Set();
	const urls = [];
	for (const url of matches) {
		if (seen.has(url)) continue;
		seen.add(url);
		urls.push(url);
	}
	if (!urls.length) throw new Error('No page images found for this chapter.');
	return urls;
}

async function fetchImage(url, attempt = 1) {
	const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
	if (!res.ok) {
		if (attempt <= 3) {
			await sleep(1000 * attempt);
			return fetchImage(url, attempt + 1);
		}
		throw new Error(`Image download failed (${res.status}): ${url}`);
	}
	return Buffer.from(await res.arrayBuffer());
}

module.exports = {
	isMkId,
	searchManga,
	getManga,
	getChapters,
	getChapterImageUrls,
	fetchImage,
	USER_AGENT
};
