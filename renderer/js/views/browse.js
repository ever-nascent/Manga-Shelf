import { h, clear, spinner, errorBox, debounce, fmtNum } from '../util.js';
import { mangaCard, styledSelect, discoverQuickActions } from '../components.js';
import { icon } from '../icons.js';

const PAGE_SIZE = 24;

// persisted across navigations so "back" returns to the same search
const state = {
	query: '',
	sort: 'popular',
	status: '',
	tags: new Set(),
	showFilters: false
};

let allTags = null;

export async function render(root, params, ctx) {
	if (params.sort) state.sort = params.sort;
	if (params.tag) { state.tags = new Set([params.tag]); state.showFilters = true; }

	root.append(h('div', { class: 'view-title' }, 'Browse'));

	const searchInput = h('input', {
		type: 'search',
		placeholder: 'Search manga…',
		value: state.query
	});
	const sortSelect = styledSelect({
		value: state.sort,
		options: [
			{ value: 'popular', label: 'Most followed' }, { value: 'relevance', label: 'Relevance' },
			{ value: 'rating', label: 'Top rated' }, { value: 'updated', label: 'Recently updated' },
			{ value: 'newest', label: 'Newest' }
		],
		onChange: (v) => { state.sort = v; reload(); }
	});
	const statusSelect = styledSelect({
		value: state.status,
		options: [
			{ value: '', label: 'Any status' }, { value: 'ongoing', label: 'Ongoing' },
			{ value: 'completed', label: 'Completed' }, { value: 'hiatus', label: 'Hiatus' },
			{ value: 'cancelled', label: 'Cancelled' }
		],
		onChange: (v) => { state.status = v; reload(); }
	});
	const filterBtn = h('button', { class: 'btn' }, icon('sliders', 15), 'Genres & tags');

	const tagPanel = h('div', { class: `tag-panel ${state.showFilters ? '' : 'hidden'}` });
	const resultCount = h('div', { class: 'result-count' });
	const grid = h('div', { class: 'card-grid' });
	const loadMoreBtn = h('button', { class: 'btn load-more hidden' }, 'Load more');
	const status = h('div', {});

	root.append(
		h('div', { class: 'browse-bar' }, searchInput, sortSelect.el, statusSelect.el, filterBtn),
		tagPanel, resultCount, grid, status, loadMoreBtn
	);

	let offset = 0;
	let total = 0;
	let loading = false;
	// one Set instance mutated in place — quick-action closures hold a reference
	const followSet = new Set();
	const followsReady = window.api.getFollows()
		.then((f) => { for (const x of f) followSet.add(x.manga.id); })
		.catch(() => {});

	const open = (m) => ctx.navigate('detail', { id: m.id });

	async function load(reset) {
		if (loading) return;
		loading = true;
		if (reset) {
			offset = 0;
			clear(grid);
			resultCount.textContent = '';
			loadMoreBtn.classList.add('hidden');
			clear(status);
			status.append(spinner());
		} else {
			loadMoreBtn.disabled = true;
		}
		try {
			const res = await window.api.search({
				query: state.query,
				sort: state.sort,
				status: state.status,
				includedTags: [...state.tags],
				offset,
				limit: PAGE_SIZE
			});
			await followsReady; // bookmark icons need the follow set before cards render
			clear(status);
			total = res.total;
			offset += res.items.length;
			resultCount.textContent = total ? `${fmtNum(total)} results` : 'No results found';
			for (const m of res.items) {
				grid.append(mangaCard(m, open, { quick: discoverQuickActions(ctx, m, followSet) }));
			}
			loadMoreBtn.classList.toggle('hidden', offset >= total || res.items.length === 0);
		} catch (err) {
			clear(status);
			status.append(errorBox(`Search failed: ${err.message}`, () => load(reset)));
		} finally {
			loading = false;
			loadMoreBtn.disabled = false;
		}
	}

	const reload = () => load(true);

	searchInput.addEventListener('input', debounce(() => {
		state.query = searchInput.value.trim();
		if (state.query && state.sort === 'popular') {
			state.sort = 'relevance';
			sortSelect.set('relevance');
		}
		reload();
	}, 450));
	loadMoreBtn.addEventListener('click', () => load(false));

	filterBtn.addEventListener('click', async () => {
		state.showFilters = !state.showFilters;
		tagPanel.classList.toggle('hidden', !state.showFilters);
		if (state.showFilters && !tagPanel.hasChildNodes()) await buildTagPanel();
	});

	async function buildTagPanel() {
		tagPanel.append(spinner());
		try {
			allTags ??= await window.api.getTags();
		} catch (err) {
			clear(tagPanel);
			tagPanel.append(h('div', { class: 'hint' }, `Couldn't load tags: ${err.message}`));
			return;
		}
		clear(tagPanel);
		const groups = {};
		for (const t of allTags) (groups[t.group] ??= []).push(t);
		const groupOrder = ['genre', 'theme', 'format', 'content'];
		for (const g of [...groupOrder, ...Object.keys(groups).filter((k) => !groupOrder.includes(k))]) {
			if (!groups[g]) continue;
			tagPanel.append(
				h('div', { class: 'tag-group' },
					h('h4', {}, g),
					h('div', { class: 'chips' }, groups[g].map((t) => {
						const chip = h('button', {
							class: `chip ${state.tags.has(t.id) ? 'on' : ''}`,
							onclick: () => {
								if (state.tags.has(t.id)) state.tags.delete(t.id);
								else state.tags.add(t.id);
								chip.classList.toggle('on');
								reload();
							}
						}, t.name);
						return chip;
					}))
				)
			);
		}
	}

	if (state.showFilters) await buildTagPanel();
	await load(true);
}
