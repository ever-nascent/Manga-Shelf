// A safe subset of Markdown — paragraphs, lists, horizontal rules, bold, italic
// and links — rendered straight to DOM nodes. Series descriptions come from
// MangaDex as Markdown and are shown on both the desktop and the phone.
//
// How a link behaves is the one thing the two don't agree on (the desktop hands
// it to the OS browser, the phone opens a tab), so the caller passes a linkFn
// that builds the anchor. mdInline is exported for it: a link's own label can
// contain bold or italic.

import { h } from './dom.js';

export function mdBlocks(text, linkFn) {
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

export function mdInline(text, linkFn) {
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
