// Formatting helpers, mirroring the desktop renderer's util.js. The DOM builder
// itself is the same file both apps use, served by the PC under /shared, and is
// passed straight through so views keep importing everything from one place.

export { h, clear } from '/shared/dom.js';
export { debounce } from '/shared/timing.js';
export {
	STATUS_LABEL, FOLLOW_STATUSES, followStatusLabel,
	chapterName, resumeIndex, dedupeChapters
} from '/shared/manga.js';
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

function mdBlocks(text, linkFn) {
	const src = String(text || '').replace(/\r\n?/g, '\n').trim();
	const blocks = [];
	if (!src) return blocks;
	let para = [];
	let list = null;
	const flushPara = () => {
		const s = para.join(' ').trim();
		para = [];
		if (s) blocks.push(h('p', {}, ...mdInline(s, linkFn)));
	};
	const flushList = () => { if (list) { blocks.push(list); list = null; } };
	for (const raw of src.split('\n')) {
		const line = raw.trim();
		if (!line) { flushPara(); flushList(); continue; }
		if (/^([-*_])(\s*\1){2,}$/.test(line)) { flushPara(); flushList(); blocks.push(h('hr', {})); continue; }
		const bullet = line.match(/^[*-]\s+(.*)$/);
		if (bullet) {
			flushPara();
			if (!list) list = h('ul', {});
			list.append(h('li', {}, ...mdInline(bullet[1], linkFn)));
			continue;
		}
		const heading = line.match(/^#{1,6}\s+(.*)$/);
		if (heading) { flushPara(); flushList(); blocks.push(h('p', { class: 'md-h' }, ...mdInline(heading[1], linkFn))); continue; }
		flushList();
		para.push(line);
	}
	flushPara(); flushList();
	return blocks;
}

function mdInline(text, linkFn) {
	const re = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+?)\*\*|__([^_]+?)__|(?<![\w*])\*([^*]+?)\*(?![\w*])|(?<![\w_])_([^_]+?)_(?![\w_])/;
	const nodes = [];
	let rest = String(text || '');
	while (rest) {
		const m = re.exec(rest);
		if (!m) { nodes.push(document.createTextNode(rest)); break; }
		if (m.index) nodes.push(document.createTextNode(rest.slice(0, m.index)));
		if (m[1] !== undefined) nodes.push(linkFn(m[1], m[2].trim()));
		else if (m[3] ?? m[4]) nodes.push(h('strong', {}, ...mdInline(m[3] ?? m[4], linkFn)));
		else nodes.push(h('em', {}, ...mdInline(m[5] ?? m[6], linkFn)));
		rest = rest.slice(m.index + m[0].length);
	}
	return nodes;
}

