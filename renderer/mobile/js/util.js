// What every view imports. Most of it is the same file the desktop uses, served
// by the PC under /shared and passed straight through so a view still has one
// place to import from. What's left here is the one thing the two do
// differently: where a link in a description opens.

export { h, clear } from '/shared/dom.js';
export { debounce } from '/shared/timing.js';
export { spinner, errorBox, toast } from '/shared/ui.js';
export { fmtDate } from '/shared/format.js';
export {
	STATUS_LABEL, FOLLOW_STATUSES, followStatusLabel,
	chapterName, resumeIndex, dedupeChapters
} from '/shared/manga.js';
import { mdBlocks, mdInline } from '/shared/markdown.js';
import { h } from '/shared/dom.js';

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

