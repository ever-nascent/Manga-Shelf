// Live download queue — everything here runs on the PC; this is a remote
// window into it, kept fresh by SSE queue events.

import { h, clear, toast } from '../util.js';
import { rpc, img, getQueue } from '../api.js';
import { icon } from '../icons.js';

const STATUS_TEXT = {
	queued: 'Queued',
	downloading: 'Downloading',
	done: 'Done',
	error: 'Failed',
	cancelled: 'Cancelled'
};

export async function render(root, params, ctx, signal) {
	root.append(h('div', { class: 'view-head' },
		h('h1', {}, 'Downloads'),
		h('button', {
			class: 'btn small',
			onclick: () => rpc('dl:clearFinished').catch((e) => toast(e.message, 'error'))
		}, 'Clear finished')
	));
	const body = h('div', { class: 'view-body' });
	root.append(body);

	function row(j) {
		const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
		const active = j.status === 'queued' || j.status === 'downloading';
		const action = active
			? h('button', { class: 'icon-btn', 'aria-label': 'Cancel', onclick: () => rpc('dl:cancel', j.id).catch(() => {}) }, icon('x', 18))
			: (j.status === 'error' || j.status === 'cancelled')
				? h('button', { class: 'icon-btn', 'aria-label': 'Retry', onclick: () => rpc('dl:retry', j.id).catch(() => {}) }, icon('refresh', 18))
				: h('span', { class: 'icon-btn done' }, icon('check', 18));

		return h('div', { class: `dl-row ${j.status}` },
			h('div', { class: 'dl-cover' }, j.coverUrl && h('img', { src: img(j.coverUrl), loading: 'lazy', alt: '' })),
			h('div', { class: 'dl-info' },
				h('div', { class: 'dl-title' }, j.mangaTitle),
				h('div', { class: 'dl-sub' },
					`${j.chapterNum != null ? `Ch. ${j.chapterNum}` : (j.chapterTitle || 'Oneshot')} · ` +
					(j.status === 'downloading' ? `${j.done}/${j.total} pages` : (j.error || STATUS_TEXT[j.status]))),
				h('div', { class: 'dl-bar' }, h('div', { class: 'dl-fill', style: { width: `${j.status === 'done' ? 100 : pct}%` } }))
			),
			action
		);
	}

	function paint(queue) {
		clear(body);
		if (!queue.length) {
			body.append(h('div', { class: 'empty' }, 'Nothing queued. Chapters you download are saved on your PC.'));
			return;
		}
		for (const j of [...queue].reverse()) body.append(row(j));
	}

	paint(getQueue());
	window.addEventListener('queue-update', (e) => paint(e.detail), { signal });
}
