// Search, against either source the PC can reach: MangaDex for everything, and
// MangaKatana for the series MangaDex doesn't have (or has no readable chapters
// for). The PC does the searching either way — the phone never talks to a
// manga site itself.

import { h, clear, spinner, errorBox, debounce } from '../util.js';
import { rpc, coverImg } from '../api.js';
import { icon } from '../icons.js';

const PAGE_SIZE = 24;
const SOURCES = [['mangadex', 'MangaDex'], ['katana', 'MangaKatana']];

// both survive tab switches
let lastQuery = '';
let lastSource = 'mangadex';

export async function render(root, params, ctx, signal) {
	// arriving from a series page ("look for this on the other source")
	if (params.query !== undefined) lastQuery = params.query;
	if (params.source) lastSource = params.source;

	const input = h('input', {
		class: 'search-input',
		type: 'search',
		placeholder: 'Search manga…',
		value: lastQuery,
		autocomplete: 'off',
		oninput: () => { lastQuery = input.value; run(); },
		onkeydown: (e) => { if (e.key === 'Enter') { input.blur(); load(true); } }
	});

	// MangaKatana has no browse-by-popularity to fall back on, so its placeholder
	// asks for a title rather than promising a list
	const paintPlaceholder = () => {
		input.placeholder = lastSource === 'katana' ? 'Search MangaKatana by title…' : 'Search manga…';
	};

	const srcBar = h('div', { class: 'src-tabs' });
	const drawSources = () => {
		clear(srcBar);
		for (const [value, label] of SOURCES) {
			srcBar.append(h('button', {
				class: `src-tab${lastSource === value ? ' on' : ''}`,
				onclick: () => {
					if (lastSource === value) return;
					lastSource = value;
					drawSources();
					paintPlaceholder();
					load(true);
				}
			}, label));
		}
	};
	drawSources();
	paintPlaceholder();

	root.append(
		h('div', { class: 'view-head' }, h('div', { class: 'search-bar' }, icon('search', 18), input)),
		srcBar
	);

	const grid = h('div', { class: 'grid' });
	const status = h('div', {});
	const moreBtn = h('button', {
		class: 'btn wide hidden',
		onclick: () => load(false)
	}, 'Load more');
	root.append(h('div', { class: 'view-body' }, grid, status, moreBtn));

	let offset = 0;
	let total = 0;
	let loading = false;

	const addCard = (m, sub) => grid.append(h('div', { class: 'm-card', onclick: () => ctx.navigate('detail', { id: m.id }) },
		h('div', { class: 'm-cover' }, m.coverUrl && coverImg(m.coverUrl)),
		h('div', { class: 'm-title' }, m.title),
		sub && h('div', { class: 'm-sub' }, sub)
	));

	async function load(reset) {
		if (loading) return;
		loading = true;
		if (reset) {
			offset = 0;
			clear(grid);
			moreBtn.classList.add('hidden');
			clear(status);
			status.append(spinner());
		} else {
			moreBtn.disabled = true;
		}
		const query = lastQuery.trim();
		try {
			if (lastSource === 'katana') await loadKatana(query);
			else await loadMangaDex(query);
		} catch (err) {
			if (signal.aborted) return;
			clear(status);
			status.append(errorBox(`Search failed: ${err.message}`, () => load(reset)));
		} finally {
			loading = false;
			moreBtn.disabled = false;
		}
	}

	async function loadMangaDex(query) {
		const res = await rpc('md:search', {
			query,
			sort: query ? 'relevance' : 'popular',
			offset,
			limit: PAGE_SIZE
		});
		if (signal.aborted) return;
		clear(status);
		total = res.total;
		offset += res.items.length;
		for (const m of res.items) addCard(m);
		if (!res.items.length && offset === 0) status.append(h('div', { class: 'empty' }, 'No results found.'));
		moreBtn.classList.toggle('hidden', offset >= total || res.items.length === 0);
	}

	// MangaKatana answers with the whole match list at once — there's nothing to
	// page through, and nothing to show for an empty query.
	async function loadKatana(query) {
		if (!query) {
			clear(status);
			status.append(h('div', { class: 'empty' }, 'Type a series title to search MangaKatana.'));
			moreBtn.classList.add('hidden');
			return;
		}
		const found = await rpc('mk:search', query);
		if (signal.aborted) return;
		clear(status);
		moreBtn.classList.add('hidden');
		if (!found.length) {
			status.append(h('div', { class: 'empty' }, 'No matches on MangaKatana.'));
			return;
		}
		for (const m of found) {
			addCard(m, [m.status, m.latestChapterLabel].filter(Boolean).join(' · '));
		}
	}

	const run = debounce(() => load(true), 450);
	load(true);
}
