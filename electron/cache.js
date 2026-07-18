// API response cache with TTL + stale-while-revalidate.
//
// Fresh hit  -> returned instantly, no network.
// Stale hit  -> returned instantly, refreshed in the background for next time.
// Miss       -> fetched, cached.
//
// Selected keys persist to disk so a restarted app paints the Home page and tag
// list without waiting on the network at all.

const fs = require('fs');
const path = require('path');

class ApiCache {
	constructor(file) {
		this.file = file;
		this.map = new Map();
		this.inflight = new Map();
		this.persistKeys = new Set();
		this.saveTimer = null;
		try {
			if (fs.existsSync(file)) {
				const disk = JSON.parse(fs.readFileSync(file, 'utf-8'));
				for (const [k, e] of Object.entries(disk)) {
					this.map.set(k, e);
					this.persistKeys.add(k);
				}
			}
		} catch { /* cold start is fine */ }
	}

	async wrap(key, ttlMs, fetcher, { persist = false, maxStaleMs = 24 * 60 * 60 * 1000 } = {}) {
		const entry = this.map.get(key);
		const age = entry ? Date.now() - entry.t : Infinity;

		if (entry && age < ttlMs) return entry.v;

		// dedupe concurrent fetches of the same key
		const refresh = () => {
			if (!this.inflight.has(key)) {
				const p = fetcher()
					.then((v) => { this.set(key, v, persist); return v; })
					.finally(() => this.inflight.delete(key));
				this.inflight.set(key, p);
			}
			return this.inflight.get(key);
		};

		if (entry && age < maxStaleMs) {
			// serve stale immediately, refresh behind the scenes
			refresh().catch(() => { /* keep stale value */ });
			return entry.v;
		}
		return refresh();
	}

	set(key, value, persist) {
		this.map.set(key, { t: Date.now(), v: value });
		if (persist) {
			this.persistKeys.add(key);
			this.scheduleSave();
		}
		if (this.map.size > 500) {
			// drop oldest non-persistent entries
			const victims = [...this.map.entries()]
				.filter(([k]) => !this.persistKeys.has(k))
				.sort((a, b) => a[1].t - b[1].t)
				.slice(0, 100);
			for (const [k] of victims) this.map.delete(k);
		}
	}

	scheduleSave() {
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			const out = {};
			for (const k of this.persistKeys) {
				if (this.map.has(k)) out[k] = this.map.get(k);
			}
			try {
				fs.writeFileSync(this.file, JSON.stringify(out));
			} catch (err) {
				console.error('Cache save failed:', err.message);
			}
		}, 1500);
	}
}

module.exports = { ApiCache };
