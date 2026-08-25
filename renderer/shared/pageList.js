// Remembering which images a chapter is made of, briefly.
//
// Turning to the next chapter shouldn't wait on a round trip that was already
// made when the reader looked ahead — but a streamed page URL is signed and
// goes stale, so this keeps them only as long as they're good for, and only a
// few chapters back.

const TTL_MS = 4 * 60_000;
const MAX_CHAPTERS = 6;

export function createPageCache({ ttlMs = TTL_MS, max = MAX_CHAPTERS } = {}) {
	const entries = new Map(); // chapter id -> { at, value }

	const get = (id) => {
		const hit = entries.get(id);
		if (!hit) return null;
		if (Date.now() - hit.at > ttlMs) { entries.delete(id); return null; }
		return hit.value;
	};

	const set = (id, value) => {
		entries.set(id, { at: Date.now(), value });
		// oldest out first; insertion order is age order
		if (entries.size > max) entries.delete(entries.keys().next().value);
	};

	return {
		get,
		set,
		forget: (id) => entries.delete(id),
		// What the reader actually calls: hand back what we have, or fetch it.
		// keep() decides whether the answer was worth remembering — an empty
		// chapter isn't, or the next look would get the same nothing back.
		async load(id, fetcher, keep = (v) => Boolean(v)) {
			const hit = get(id);
			if (hit) return hit;
			const value = await fetcher();
			if (keep(value)) set(id, value);
			return value;
		}
	};
}
