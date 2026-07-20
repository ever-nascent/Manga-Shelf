import { h, clear, spinner, errorBox } from '../util.js';
import { rpc, img } from '../api.js';

function card(m, ctx, sub = null) {
	return h('div', { class: 'm-card', onclick: () => ctx.navigate('detail', { id: m.id }) },
		h('div', { class: 'm-cover' }, m.coverUrl && h('img', { src: img(m.coverUrl), loading: 'lazy', alt: '' })),
		h('div', { class: 'm-title' }, m.title),
		sub && h('div', { class: 'm-sub' }, sub)
	);
}

function section(title, cards) {
	return h('div', { class: 'h-section' },
		h('h2', {}, title),
		h('div', { class: 'h-scroll' }, cards)
	);
}

export async function render(root, params, ctx, signal) {
	root.append(h('div', { class: 'view-head' }, h('h1', {}, 'MangaShelf')));
	const body = h('div', { class: 'view-body' }, spinner());
	root.append(body);

	try {
		const [reading, sections] = await Promise.all([rpc('reading:all'), rpc('md:home')]);
		if (signal.aborted) return;
		clear(body);
		if (reading.length) {
			body.append(section('Continue reading', reading.map((r) =>
				card(r.manga, ctx, `Ch. ${r.chapterNum ?? '?'} · page ${(r.page || 0) + 1}`))));
		}
		body.append(
			section('Popular', sections.popular.map((m) => card(m, ctx))),
			section('Top rated', sections.topRated.map((m) => card(m, ctx))),
			section('Recently updated', sections.recent.map((m) => card(m, ctx)))
		);
	} catch (err) {
		if (signal.aborted) return;
		clear(body);
		body.append(errorBox(`Couldn't load: ${err.message}`, () => render(clearRoot(root), params, ctx, signal)));
	}
}

function clearRoot(root) {
	clear(root);
	return root;
}
