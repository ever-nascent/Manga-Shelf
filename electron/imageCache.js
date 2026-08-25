// Covers and pages that a phone asks for come through this: the CDNs reject
// plain phone-browser requests, so the PC fetches them on the phone's behalf.
//
// Doing that with a bare fetch per request was the slow path. A home screen is
// ~50 covers and a chapter is ~20 pages, all asked for at once, so without this
// every visit re-downloads the same bytes and the burst itself is what makes
// the CDN start refusing — which is what a broken-image square on the phone
// actually is.
//
// Three things fix that, and they have to be together:
//   * a memory cache, so the second look at a cover costs nothing
//   * one fetch per URL, so fifty <img> tags for the same cover are one request
//   * a ceiling on how many fetches run at once, so a burst queues instead of
//     being thrown at the CDN and half-refused

const { USER_AGENT, sleep, fetchWithTimeout, describeFetchError, IMAGE_TIMEOUT_MS } = require('./util');

const MAX_BYTES = 64 * 1024 * 1024;   // pages are ~300KB, covers ~40KB
const MAX_CONCURRENT = 6;             // per MangaDex's guidance for their image servers
const MAX_ENTRY_BYTES = 12 * 1024 * 1024;

class ImageCache {
	constructor({ maxBytes = MAX_BYTES, maxConcurrent = MAX_CONCURRENT } = {}) {
		this.maxBytes = maxBytes;
		this.maxConcurrent = maxConcurrent;
		this.map = new Map();      // url -> { buf, type }; insertion order is the LRU
		this.bytes = 0;
		this.inflight = new Map(); // url -> Promise, so duplicate asks share one fetch
		this.active = 0;
		this.waiting = [];
	}

	// Cached hit, if any. Touching it moves it to the young end of the LRU.
	get(url) {
		const entry = this.map.get(url);
		if (!entry) return null;
		this.map.delete(url);
		this.map.set(url, entry);
		return entry;
	}

	// Cached value or a fetch — never two fetches for the same URL at once.
	load(url) {
		const hit = this.get(url);
		if (hit) return Promise.resolve(hit);
		if (this.inflight.has(url)) return this.inflight.get(url);
		const p = this.gated(() => this.fetchImage(url))
			.then((entry) => { this.store(url, entry); return entry; })
			.finally(() => this.inflight.delete(url));
		this.inflight.set(url, p);
		return p;
	}

	// Warm the cache without anyone waiting on it (used to pull the next
	// chapter's first pages in before the reader gets there).
	prefetch(url) {
		if (this.map.has(url) || this.inflight.has(url)) return;
		this.load(url).catch(() => { /* a prefetch that fails is just a miss */ });
	}

	async gated(run) {
		if (this.active >= this.maxConcurrent) {
			await new Promise((resolve) => this.waiting.push(resolve));
		}
		this.active++;
		try {
			return await run();
		} finally {
			this.active--;
			this.waiting.shift()?.();
		}
	}

	// One retry: a refused or timed-out image is usually a busy server rather
	// than a missing file, and the phone has no way to ask again by itself.
	async fetchImage(url, attempt = 1) {
		let res;
		try {
			res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } }, IMAGE_TIMEOUT_MS);
		} catch (err) {
			if (attempt < 2) {
				await sleep(500);
				return this.fetchImage(url, attempt + 1);
			}
			const e = new Error(`Upstream ${describeFetchError(err)}`);
			e.status = 504;
			throw e;
		}
		if (!res.ok) {
			// 404 means it isn't there; anything else is worth one more go
			if (res.status !== 404 && attempt < 2) {
				await sleep(res.status === 429 ? 1500 : 500);
				return this.fetchImage(url, attempt + 1);
			}
			const e = new Error(`Upstream ${res.status}`);
			e.status = res.status === 404 ? 404 : 502;
			throw e;
		}
		return {
			buf: Buffer.from(await res.arrayBuffer()),
			type: res.headers.get('content-type') || 'image/jpeg'
		};
	}

	store(url, entry) {
		if (entry.buf.length > MAX_ENTRY_BYTES) return; // one huge page mustn't evict everything
		this.map.set(url, entry);
		this.bytes += entry.buf.length;
		for (const [k, v] of this.map) {
			if (this.bytes <= this.maxBytes) break;
			if (k === url) continue;
			this.map.delete(k);
			this.bytes -= v.buf.length;
		}
	}

	clear() {
		this.map.clear();
		this.bytes = 0;
	}
}

module.exports = { ImageCache };
