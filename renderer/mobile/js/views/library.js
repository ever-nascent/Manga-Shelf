import { h, clear, spinner, errorBox } from '../util.js';
import { rpc, img } from '../api.js';

export async function render(root, params, ctx, signal) {
	root.append(h('div', { class: 'view-head' }, h('h1', {}, 'Library')));
	const body = h('div', { class: 'view-body' }, spinner());
	root.append(body);

	try {
		const all = await rpc('lib:all');
		if (signal.aborted) return;
		clear(body);
		if (!all.length) {
			body.append(h('div', { class: 'empty' },
				'Nothing downloaded yet. Anything you queue from your phone downloads to your PC and shows up here.'));
			return;
		}
		const grid = h('div', { class: 'grid' });
		for (const m of all) {
			grid.append(h('div', { class: 'm-card', onclick: () => ctx.navigate('detail', { id: m.id }) },
				h('div', { class: 'm-cover' }, m.coverUrl && h('img', { src: img(m.coverUrl), loading: 'lazy', alt: '' })),
				h('div', { class: 'm-title' }, m.title),
				h('div', { class: 'm-sub' }, `${m.chapters.length} chapter${m.chapters.length === 1 ? '' : 's'}`)
			));
		}
		body.append(grid);
	} catch (err) {
		if (signal.aborted) return;
		clear(body);
		body.append(errorBox(`Couldn't load library: ${err.message}`));
	}
}
