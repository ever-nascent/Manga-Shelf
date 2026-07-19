// Small helpers shared by the API clients and the on-disk stores.

const fs = require('fs');

const USER_AGENT = 'MangaShelf/2.0 (personal desktop reader; github.com/LiterallyLink/Manga-Downloader)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Serializes requests to one host: each caller awaits its slot, slots are
// spaced gapMs apart.
function makeRateLimiter(gapMs) {
	let nextSlot = 0;
	return async function rateLimit() {
		const now = Date.now();
		const wait = Math.max(0, nextSlot - now);
		nextSlot = Math.max(now, nextSlot) + gapMs;
		if (wait > 0) await sleep(wait);
	};
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

// Write via temp file + rename so a crash mid-write can't leave a truncated
// file behind (a corrupt library.json would silently wipe the library).
function writeFileAtomic(file, data) {
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

module.exports = { USER_AGENT, sleep, makeRateLimiter, fetchImage, writeFileAtomic };
