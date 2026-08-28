// What every view imports. Most of it is the same file the phone uses, from
// renderer/shared, passed straight through so a view still has one place to
// import from. What's left here is what only this app has, and the one thing
// the two do differently: where a link in a description opens.

export { h, clear } from '../shared/dom.js';
export { debounce } from '../shared/timing.js';
export { spinner, errorBox, toast } from '../shared/ui.js';
export { fmtDate } from '../shared/format.js';
export {
	STATUS_LABEL, FOLLOW_STATUSES, followStatusLabel,
	chapterName, resumeIndex, dedupeChapters
} from '../shared/manga.js';
import { mdBlocks, mdInline } from '../shared/markdown.js';
import { h } from '../shared/dom.js';

export function fmtNum(n) {
	if (n === null || n === undefined) return '—';
	if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
	if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
	return String(n);
}

export function fmtBytes(n) {
	if (!n) return '0 MB';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let v = n;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
	return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// MangaDex descriptions are Markdown. Render a safe subset (paragraphs, lists,
// horizontal rules, bold/italic, links) to an array of DOM nodes. Links open in
// the OS browser through the main process, never inside the app window.
export function renderMarkdown(src) {
	return mdBlocks(String(src || ''), mdLink);
}

function mdLink(label, url) {
	if (!/^https?:\/\//i.test(url)) return document.createTextNode(label);
	return h('a', {
		class: 'md-link',
		href: url,
		onclick: (e) => { e.preventDefault(); e.stopPropagation(); window.api.openExternal(url); }
	}, ...mdInline(label, mdLink));
}

