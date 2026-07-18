import { h, clear, spinner, errorBox, toast, dedupeChapters } from '../util.js';
import { mangaCard, discoverQuickActions } from '../components.js';
import { icon } from '../icons.js';

export async function render(root, params, ctx) {
	root.append(h('div', { class: 'view-title' }, 'Discover'));
	const body = h('div', {});
	root.append(body);
	body.append(spinner());

	let sections;
	let readingAll = [];
	let followSet = new Set();
	try {
		let follows;
		[sections, readingAll, follows] = await Promise.all([
			window.api.getHome(),
			window.api.getReadingAll().catch(() => []),
			window.api.getFollows().catch(() => [])
		]);
		followSet = new Set(follows.map((f) => f.manga.id));
	} catch (err) {
		clear(body);
		body.append(errorBox(`Couldn't reach MangaDex: ${err.message}`, () => ctx.navigate('home', {}, { push: false })));
		return;
	}

	clear(body);
	const open = (m) => ctx.navigate('detail', { id: m.id });

	// jump straight back into the reader at the saved chapter + page
	async function resume(entry) {
		toast(`Resuming ${entry.manga.title}…`, 'info', 2000);
		let list = [];
		try {
			list = dedupeChapters(await window.api.getChapters(entry.manga.id));
		} catch { /* offline? fall through to local copy */ }
		if (!list.length) {
			const lib = await window.api.getLibraryManga(entry.manga.id);
			list = (lib?.chapters || []).map((c) => ({ ...c, external: false }));
		}
		if (!list.length) { ctx.navigate('detail', { id: entry.manga.id }); return; }
		let idx = list.findIndex((c) => c.id === entry.chapterId);
		if (idx === -1 && entry.chapterNum != null) idx = list.findIndex((c) => c.num === entry.chapterNum);
		ctx.openReader(entry.manga, list, Math.max(0, idx), entry.page || 0);
	}

	if (readingAll.length) {
		body.append(
			h('section', { class: 'section' },
				h('div', { class: 'section-head' },
					h('h2', {}, 'Continue Reading'),
					h('button', { class: 'more', onclick: () => ctx.navigate('library') }, 'My library', icon('chevron-right', 13))
				),
				h('div', { class: 'card-row' }, readingAll.slice(0, 12).map((entry) =>
					mangaCard(entry.manga, () => resume(entry), {
						sub: `Ch. ${entry.chapterNum ?? '?'} · page ${(entry.page || 0) + 1}`,
						corner: 'play'
					})))
			)
		);
	}

	const rows = [
		['Most Popular', 'popular', sections.popular],
		['Top Rated', 'rating', sections.topRated],
		['Recently Updated', 'updated', sections.recent]
	];

	for (const [title, sort, items] of rows) {
		body.append(
			h('section', { class: 'section' },
				h('div', { class: 'section-head' },
					h('h2', {}, title),
					h('button', { class: 'more', onclick: () => ctx.navigate('browse', { sort }) }, 'See more', icon('chevron-right', 13))
				),
				h('div', { class: 'card-row' }, items.map((m) =>
					mangaCard(m, open, { quick: discoverQuickActions(ctx, m, followSet) })))
			)
		);
	}
}
