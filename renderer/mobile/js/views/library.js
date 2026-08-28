// Your library, as the PC keeps it: the shelves you put things on, everything
// you're part-way through, and what's downloaded. A phone that only ever showed
// the downloads couldn't tell you what you were reading — which is most of what
// a library is for when the series are streamed rather than kept.

import { h, clear, spinner, errorBox, FOLLOW_STATUSES, STATUS_LABEL } from '../util.js';
import { rpc, coverImg } from '../api.js';

const TABS = [
	['continue', 'Continue'],
	...FOLLOW_STATUSES,
	['downloads', 'Downloaded']
];

// the shelf you were last on, kept across tab switches like the desktop does
const state = { tab: 'continue' };

function card(m, sub, onOpen) {
	return h('div', { class: 'm-card', onclick: onOpen },
		h('div', { class: 'm-cover' }, m.coverUrl && coverImg(m.coverUrl)),
		h('div', { class: 'm-title' }, m.title),
		sub && h('div', { class: 'm-sub' }, sub)
	);
}

export async function render(root, params, ctx, signal) {
	if (params.tab) state.tab = params.tab;
	root.append(h('div', { class: 'view-head' }, h('h1', {}, 'Library')));
	const tabBar = h('div', { class: 'shelf-tabs' });
	const body = h('div', { class: 'view-body' }, spinner());
	root.append(tabBar, body);

	let reading = [];
	let follows = [];
	let downloads = [];
	try {
		[reading, follows, downloads] = await Promise.all([
			rpc('reading:all'), rpc('follows:all'), rpc('lib:all')
		]);
	} catch (err) {
		if (signal.aborted) return;
		clear(body);
		body.append(errorBox(`Couldn't load your library: ${err.message}`,
			() => ctx.navigate('library', { tab: state.tab }, { replace: true })));
		return;
	}
	if (signal.aborted) return;

	const countFor = (tab) => (tab === 'continue' ? reading.length
		: tab === 'downloads' ? downloads.length
			: follows.filter((f) => f.status === tab).length);

	const drawTabs = () => {
		clear(tabBar);
		for (const [value, label] of TABS) {
			const n = countFor(value);
			tabBar.append(h('button', {
				class: `shelf-tab${state.tab === value ? ' on' : ''}`,
				onclick: () => { state.tab = value; drawTabs(); draw(); }
			}, label, n ? h('span', { class: 'shelf-count' }, String(n)) : null));
		}
	};

	const open = (id) => ctx.navigate('detail', { id });

	const empty = (text) => body.append(h('div', { class: 'empty' }, text));

	function draw() {
		clear(body);
		const grid = h('div', { class: 'grid' });

		if (state.tab === 'continue') {
			if (!reading.length) {
				return empty('Nothing on the go. Open any series and start reading — your place follows you between your phone and your PC.');
			}
			for (const r of reading) {
				grid.append(card(r.manga,
					`Ch. ${r.chapterNum ?? '?'} · page ${(r.page || 0) + 1}`,
					() => open(r.manga.id)));
			}
		} else if (state.tab === 'downloads') {
			if (!downloads.length) {
				return empty('Nothing downloaded yet. Anything you queue from your phone downloads to your PC and shows up here.');
			}
			for (const m of downloads) {
				const at = m.progress?.chapterNum;
				grid.append(card(m,
					`${m.chapters.length} chapter${m.chapters.length === 1 ? '' : 's'}${at ? ` · at ch. ${at}` : ''}`,
					() => open(m.id)));
			}
		} else {
			const shelf = follows.filter((f) => f.status === state.tab);
			if (!shelf.length) {
				const label = TABS.find(([v]) => v === state.tab)[1];
				return empty(`Nothing in “${label}” yet. Open any series and use Follow to put it on a shelf.`);
			}
			for (const f of shelf) {
				grid.append(card(f.manga,
					f.progress ? `at ch. ${f.progress.chapterNum ?? '?'}` : (STATUS_LABEL[f.manga.status] || ''),
					() => open(f.manga.id)));
			}
		}
		body.append(grid);
	}

	drawTabs();
	draw();
}
