// Small DOM + formatting helpers shared by every view.

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

export function fmtNum(n) {
	if (n === null || n === undefined) return '—';
	if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
	if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
	return String(n);
}

export function fmtDate(iso) {
	if (!iso) return '';
	return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function debounce(fn, ms) {
	let t;
	return (...args) => {
		clearTimeout(t);
		t = setTimeout(() => fn(...args), ms);
	};
}

export const STATUS_LABEL = {
	ongoing: 'Ongoing',
	completed: 'Completed',
	hiatus: 'Hiatus',
	cancelled: 'Cancelled',
	unknown: ''
};

export function chapterName(ch) {
	if (ch.num === null || ch.num === undefined || ch.num === '') return ch.title || 'Oneshot';
	return `Chapter ${ch.num}${ch.title ? ` — ${ch.title}` : ''}`;
}

// Multiple scanlation groups often upload the same chapter; keep one entry per
// chapter number (first in feed order, which is ascending) for reading and
// bulk downloads.
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
