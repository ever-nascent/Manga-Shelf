// Rate-limiting a call that fires far more often than it needs to act.

// Runs fn once the calls stop coming for ms. The returned function also has
// .flush(): run a pending call right now — the reader uses it so closing a book
// never drops the last progress save.
export function debounce(fn, ms) {
	let t;
	let pending = null;
	const wrapped = (...args) => {
		pending = args;
		clearTimeout(t);
		t = setTimeout(() => { pending = null; fn(...args); }, ms);
	};
	wrapped.flush = () => {
		if (!pending) return;
		clearTimeout(t);
		const args = pending;
		pending = null;
		fn(...args);
	};
	return wrapped;
}
