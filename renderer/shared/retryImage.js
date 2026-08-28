// An image server that refuses one request out of a screenful hasn't lost the
// file — it's busy. A browser left to itself draws a broken square and never
// asks again, which is what a "?" cover or an empty page actually is.
//
// So: ask again, a couple of times, backing off. What to ask for on a retry and
// what to do once we're out of tries differ between a cover and a page, and
// between the two apps, so those are the caller's.

const RETRIES = 2;

export function retryOnError(el, src, { retries = RETRIES, urlFor = (s) => s, onGiveUp } = {}) {
	let tries = 0;
	el.addEventListener('error', () => {
		if (++tries > retries) { onGiveUp?.(el); return; }
		setTimeout(() => {
			// dropping the src first makes the browser ask again rather than
			// hand back the failure it already has
			el.removeAttribute('src');
			el.src = urlFor(src, tries);
		}, 500 * tries);
	});
	return el;
}
