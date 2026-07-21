// Small helpers shared by the API clients and the on-disk stores.

const fs = require('fs');

const USER_AGENT = 'MangaShelf/2.0 (personal desktop reader; github.com/LiterallyLink/Manga-Shelf)';

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

// Node's fetch has no default timeout, so a socket that opens and then goes
// quiet hangs forever. That is worst in the downloader, which works through
// chapters strictly serially: one wedged request stalls the entire queue with
// no error and no retry. Every outbound request goes through here.
const API_TIMEOUT_MS = 15_000;
const IMAGE_TIMEOUT_MS = 45_000; // pages are megabytes; allow a slow-but-alive transfer

function fetchWithTimeout(url, options = {}, ms = API_TIMEOUT_MS) {
	return fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
}

// AbortSignal.timeout covers the body read too, not just the headers, so a
// transfer that stalls halfway also lands here rather than hanging.
function describeFetchError(err) {
	return err.name === 'TimeoutError' ? 'timed out' : err.message;
}

async function fetchImage(url, attempt = 1) {
	try {
		const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } }, IMAGE_TIMEOUT_MS);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return Buffer.from(await res.arrayBuffer());
	} catch (err) {
		// a timeout is as worth retrying as a bad status, and used not to be
		if (attempt <= 3) {
			await sleep(1000 * attempt);
			return fetchImage(url, attempt + 1);
		}
		throw new Error(`Image download failed (${describeFetchError(err)}): ${url}`);
	}
}

// Write via temp file + rename so a crash mid-write can't leave a truncated
// file behind (a corrupt library.json would silently wipe the library).
function writeFileAtomic(file, data) {
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

module.exports = {
	USER_AGENT, sleep, makeRateLimiter, fetchImage, writeFileAtomic,
	fetchWithTimeout, describeFetchError, API_TIMEOUT_MS, IMAGE_TIMEOUT_MS
};
