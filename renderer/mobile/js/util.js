// Formatting helpers, mirroring the desktop renderer's util.js. The DOM builder
// itself is the same file both apps use, served by the PC under /shared, and is
// passed straight through so views keep importing everything from one place.

export { h, clear } from '/shared/dom.js';
export { debounce } from '/shared/timing.js';
export {
	STATUS_LABEL, FOLLOW_STATUSES, followStatusLabel,
	chapterName, resumeIndex, dedupeChapters
} from '/shared/manga.js';
import { mdBlocks, mdInline } from '/shared/markdown.js';
import { h } from '/shared/dom.js';

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

// MangaDex descriptions are Markdown. Render a safe subset (paragraphs, lists,
// horizontal rules, bold/italic, links) to an array of DOM nodes. Links open in
// a new browser tab.
export function renderMarkdown(src) {
	return mdBlocks(String(src || ''), mdLink);
}

function mdLink(label, url) {
	if (!/^https?:\/\//i.test(url)) return document.createTextNode(label);
	return h('a', {
		class: 'md-link',
		href: url,
		target: '_blank',
		rel: 'noopener noreferrer',
		onclick: (e) => e.stopPropagation()
	}, ...mdInline(label, mdLink));
}

