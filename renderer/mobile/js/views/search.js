import { h, clear, spinner, errorBox, debounce } from '../util.js';
import { rpc, img } from '../api.js';
import { icon } from '../icons.js';

const PAGE_SIZE = 24;
let lastQuery = ''; // survives tab switches

export async function render(root, params, ctx, signal) {
	const input = h('input', {
		class: 'search-input',
		type: 'search',
		placeholder: 'Search manga…',
		value: lastQuery,
		autocomplete: 'off',
		oninput: () => { lastQuery = input.value; run(); },
		onkeydown: (e) => { if (e.key === 'Enter') { input.blur(); load(true); } }
	});
	root.append(h('div', { class: 'view-head' },
		h('div', { class: 'search-bar' }, icon('search', 18), input)
	));

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
			for (const m of res.items) {
				grid.append(h('div', { class: 'm-card', onclick: () => ctx.navigate('detail', { id: m.id }) },
					h('div', { class: 'm-cover' }, m.coverUrl && h('img', { src: img(m.coverUrl), loading: 'lazy', alt: '' })),
					h('div', { class: 'm-title' }, m.title)
				));
			}
			if (!res.items.length && offset === 0) status.append(h('div', { class: 'empty' }, 'No results found.'));
			moreBtn.classList.toggle('hidden', offset >= total || res.items.length === 0);
		} catch (err) {
			if (signal.aborted) return;
			clear(status);
			status.append(errorBox(`Search failed: ${err.message}`, () => load(reset)));
		} finally {
			loading = false;
			moreBtn.disabled = false;
		}
	}

	const run = debounce(() => load(true), 450);
	load(true);
}
