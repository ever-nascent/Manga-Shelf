import { h, clear } from '../util.js';
import { coverImg } from '../components.js';
import { icon } from '../icons.js';

const STATUS_TEXT = {
	queued: 'Queued',
	downloading: 'Downloading',
	paused: 'Paused',
	done: 'Done',
	error: 'Failed',
	cancelled: 'Cancelled'
};

const ACTIVE = new Set(['queued', 'downloading', 'paused']);

export async function render(root, params, ctx, signal) {
	const pauseBtn = h('button', { class: 'btn small hidden' });
	const retryAllBtn = h('button', { class: 'btn small hidden' }, icon('refresh', 14), 'Retry failed');
	const clearBtn = h('button', { class: 'btn small' }, icon('trash', 14), 'Clear finished');
	const summary = h('div', { class: 'dl-summary' });

	root.append(
		h('div', { class: 'view-title' }, 'Downloads'),
		h('div', { class: 'dl-toolbar' }, summary, h('span', { class: 'head-spacer' }), pauseBtn, retryAllBtn, clearBtn)
	);

	let paused = await window.api.getDownloadsPaused();
	if (signal?.aborted) return;

	const renderPauseBtn = (queue) => {
		pauseBtn.classList.toggle('hidden', !queue.some((j) => ACTIVE.has(j.status)));
		clear(pauseBtn);
		pauseBtn.append(icon(paused ? 'play' : 'pause', 14), paused ? 'Resume' : 'Pause');
	};

	pauseBtn.addEventListener('click', async () => {
		pauseBtn.disabled = true;
		paused = paused ? await window.api.resumeDownloads() : await window.api.pauseDownloads();
		pauseBtn.disabled = false;
		renderPauseBtn(lastQueue);
	});

	const list = h('div', { class: 'dl-list' });
	const emptySlot = h('div', {});
	root.append(list, emptySlot);

	clearBtn.addEventListener('click', () => window.api.clearFinishedDownloads());

	// keyed rows: each job gets a persistent element that's patched in place,
	// so nothing ever jumps around while downloads run
	const rows = new Map(); // jobId -> {el, bar, sub, status, actions, lastStatus}

	function buildRow(job) {
		const bar = h('div', {});
		const sub = h('div', { class: 'dl-sub' });
		const status = h('div', { class: 'dl-status' });
		const actions = h('div', { class: 'dl-actions' });
		const el = h('div', { class: 'dl-item' },
			(() => { const img = coverImg(job.coverUrl, ''); img.className = 'dl-thumb'; return img; })(),
			h('div', { class: 'dl-text' },
				h('div', { class: 'dl-name' },
					`${job.mangaTitle} — ${job.chapterNum ? `Chapter ${job.chapterNum}` : (job.chapterTitle || 'Oneshot')}`),
				sub
			),
			h('div', { class: 'dl-bar' }, bar),
			status,
			actions
		);
		return { el, bar, sub, status, actions, lastStatus: null };
	}

	function patchRow(row, job) {
		const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
		row.bar.style.width = (job.status === 'done' ? 100 : pct) + '%';
		row.sub.textContent = job.error
			|| (job.status === 'done' ? `${job.total} pages`
				: job.total ? `${job.done} / ${job.total} pages` : 'Preparing…');
		if (row.lastStatus !== job.status) {
			row.lastStatus = job.status;
			row.el.className = `dl-item st-${job.status}`;
			row.status.textContent = STATUS_TEXT[job.status] || job.status;
			clear(row.actions);
			if (ACTIVE.has(job.status)) {
				row.actions.append(h('button', {
					class: 'btn small icon-only', title: 'Cancel',
					onclick: () => window.api.cancelDownload(job.id)
				}, icon('x', 14)));
			} else if (job.status === 'error' || job.status === 'cancelled') {
				row.actions.append(h('button', {
					class: 'btn small icon-only', title: 'Retry',
					onclick: () => window.api.retryDownload(job.id)
				}, icon('refresh', 14)));
			}
		}
	}

	let lastQueue = [];

	function draw(queue) {
		lastQueue = queue;
		const ids = new Set(queue.map((j) => j.id));
		for (const [id, row] of rows) {
			if (!ids.has(id)) { row.el.remove(); rows.delete(id); }
		}
		for (const job of queue) {
			let row = rows.get(job.id);
			if (!row) {
				row = buildRow(job);
				rows.set(job.id, row);
				list.append(row.el); // insertion order — rows never reorder
			}
			patchRow(row, job);
		}

		const active = queue.filter((j) => j.status === 'downloading').length;
		const queued = queue.filter((j) => j.status === 'queued' || j.status === 'paused').length;
		const failed = queue.filter((j) => j.status === 'error').length;
		const done = queue.filter((j) => j.status === 'done').length;
		const parts = [];
		if (paused && (active || queued)) parts.push('Paused');
		else if (active) parts.push(`${active} downloading`);
		if (queued) parts.push(`${queued} queued`);
		if (done) parts.push(`${done} done`);
		if (failed) parts.push(`${failed} failed`);
		summary.textContent = parts.join(' · ');
		renderPauseBtn(queue);
		retryAllBtn.classList.toggle('hidden', failed === 0);

		clear(emptySlot);
		if (!queue.length) {
			emptySlot.append(h('div', { class: 'empty-state' },
				h('div', { class: 'big' }, icon('download', 44)),
				h('div', {}, 'No downloads yet.'),
				h('div', {}, 'Queue some chapters from any manga page.')
			));
		}
	}

	retryAllBtn.addEventListener('click', async () => {
		const queue = await window.api.getQueue();
		for (const job of queue) {
			if (job.status === 'error') window.api.retryDownload(job.id);
		}
	});

	window.addEventListener('queue-update', (e) => draw(e.detail), { signal });
	const queue = await window.api.getQueue();
	if (!signal?.aborted) draw(queue);
}
