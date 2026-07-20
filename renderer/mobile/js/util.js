// Small DOM + formatting helpers, mirroring the desktop renderer's util.js.

export function h(tag, props = {}, ...children) {
	const el = document.createElement(tag);
	for (const [key, value] of Object.entries(props || {})) {
		if (value === undefined || value === null) continue;
		if (key === 'class') el.className = value;
		else if (key === 'dataset') Object.assign(el.dataset, value);
		else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
		else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
		else if (key in el && key !== 'list' && key !== 'form') el[key] = value;
		else el.setAttribute(key, value);
	}
	append(el, children);
	return el;
}

function append(el, child) {
	if (child === null || child === undefined || child === false) return;
	if (Array.isArray(child)) { child.forEach((c) => append(el, c)); return; }
	el.append(child.nodeType ? child : document.createTextNode(String(child)));
}

export function clear(el) {
	while (el.firstChild) el.removeChild(el.firstChild);
}

export const spinner = () => h('div', { class: 'spinner' });

export function errorBox(message, retry) {
	return h('div', { class: 'error-box' },
		h('div', {}, message),
		retry && h('button', { class: 'btn', onclick: retry }, 'Retry')
	);
}

export function toast(message, type = 'info', ms = 3500) {
	const el = h('div', { class: `toast ${type}` }, message);
	document.getElementById('toasts').append(el);
	setTimeout(() => el.remove(), ms);
}

export function fmtDate(iso) {
	if (!iso) return '';
	return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// The returned function also has .flush(): run a pending call immediately
// (the reader uses it so leaving never drops the last progress save).
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

export const STATUS_LABEL = {
	ongoing: 'Ongoing',
	completed: 'Completed',
	hiatus: 'Hiatus',
	cancelled: 'Cancelled',
	unknown: ''
};

export const FOLLOW_STATUSES = [
	['reading', 'Reading'], ['plan', 'Plan to Read'], ['completed', 'Completed'],
	['hold', 'On Hold'], ['dropped', 'Dropped']
];

export function followStatusLabel(s) {
	return FOLLOW_STATUSES.find(([v]) => v === s)?.[1] || s;
}

export function chapterName(ch) {
	if (ch.num === null || ch.num === undefined || ch.num === '') return ch.title || 'Oneshot';
	return `Chapter ${ch.num}${ch.title ? ` — ${ch.title}` : ''}`;
}

// Where to resume in a chapter list: match by chapter id first, then fall back
// to the chapter number (the saved id may belong to another group's upload).
export function resumeIndex(list, chapterId, chapterNum) {
	let idx = list.findIndex((c) => c.id === chapterId);
	if (idx === -1 && chapterNum != null) idx = list.findIndex((c) => c.num === chapterNum);
	return idx;
}

// Multiple scanlation groups often upload the same chapter; keep one entry per
// chapter number for reading and bulk downloads.
export function dedupeChapters(chapters) {
	const seen = new Set();
	const out = [];
	for (const ch of chapters) {
		if (ch.external || ch.pages === 0) continue;
		const key = ch.num ?? `oneshot:${ch.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(ch);
	}
	return out;
}
