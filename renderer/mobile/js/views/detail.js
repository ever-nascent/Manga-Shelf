// Series page: info, follow status, chapter list. Downloads queue on the PC;
// reading works for downloaded chapters (served from the PC's library) and
// online ones (streamed through the PC).

import { h, clear, spinner, errorBox, toast, chapterName, resumeIndex, dedupeChapters, STATUS_LABEL, FOLLOW_STATUSES, followStatusLabel, renderMarkdown } from '../util.js';
import { rpc, img, getQueue } from '../api.js';
import { icon } from '../icons.js';

export async function render(root, { id }, ctx, signal) {
	root.append(h('div', { class: 'view-head' },
		h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: ctx.back }, icon('back', 22)),
		h('h1', { class: 'head-title' }, '')
	));
	const body = h('div', { class: 'view-body' }, spinner());
	root.append(body);

	// online data preferred; the PC's library fills in when offline
	const [remote, lib] = await Promise.all([
		rpc('md:manga', id).catch(() => null),
		rpc('lib:get', id).catch(() => null)
	]);
	if (signal.aborted) return;
	const manga = remote || lib;
	if (!manga) {
		clear(body);
		body.append(errorBox('Couldn’t load this series.'));
		return;
	}
	root.querySelector('.head-title').textContent = manga.title;

	let chapters = [];
	try {
		chapters = dedupeChapters(await rpc('md:chapters', id));
	} catch {
		chapters = lib ? lib.chapters : [];
	}
	if (!chapters.length && lib) chapters = lib.chapters;
	let [follow, reading] = await Promise.all([
		rpc('follows:get', id).catch(() => null),
		rpc('reading:get', id).catch(() => null)
	]);
	if (signal.aborted) return;

	const downloaded = new Set(lib ? lib.chapters.map((c) => c.id) : []);
	// follows/reading snapshots must store the original cover URL — a /file or
	// /proxy URL would be meaningless to the desktop app
	const snap = {
		id: manga.id,
		title: manga.title,
		coverUrl: manga.coverUrl?.startsWith('http') ? manga.coverUrl : null,
		status: manga.status || null,
		year: manga.year || null
	};
	const maxChapterNum = () => chapters.reduce((mx, c) => Math.max(mx, parseFloat(c.num) || 0), 0);

	// ----- header -----
	const followBtn = h('button', { class: 'btn', onclick: openFollowSheet });
	const paintFollow = () => {
		clear(followBtn);
		followBtn.append(icon(follow ? 'check' : 'bookmark', 16), follow ? followStatusLabel(follow.status) : 'Follow');
		followBtn.classList.toggle('primary', !follow);
	};
	paintFollow();

	const readBtn = h('button', { class: 'btn accent', onclick: openRead });
	const paintRead = () => {
		clear(readBtn);
		const resume = reading && resumeIndex(chapters, reading.chapterId, reading.chapterNum) !== -1;
		readBtn.append(icon('play', 16), resume ? `Resume Ch. ${reading.chapterNum ?? '?'}` : 'Read');
		readBtn.disabled = !chapters.length;
	};
	paintRead();

	function openRead() {
		let idx = reading ? resumeIndex(chapters, reading.chapterId, reading.chapterNum) : 0;
		if (idx === -1) idx = 0;
		ctx.openReader(dlManga(), chapters, idx, reading && idx !== 0 ? reading.page || 0 : 0);
	}

	const dlAllBtn = remote && h('button', {
		class: 'btn',
		onclick: async () => {
			try {
				await rpc('dl:add', dlManga(), chapters);
				toast(`Queued on your PC — see Downloads.`, 'success');
			} catch (err) {
				toast(err.message, 'error');
			}
		}
	}, icon('download', 16), 'All');

	// what the downloader needs (coverUrlFull for the cover grab) — only the
	// online object has it, which is fine: downloading needs to be online anyway
	function dlManga() {
		return remote || { ...manga, coverUrl: null };
	}

	const meta = [manga.authors?.length && manga.authors.join(', '),
		[STATUS_LABEL[manga.status], manga.year].filter(Boolean).join(' · ')].filter(Boolean);

	const desc = h('div', { class: 'd-desc clamped', onclick: () => desc.classList.toggle('clamped') },
		manga.description ? renderMarkdown(manga.description) : '');

	clear(body);
	body.append(
		h('div', { class: 'd-head' },
			h('div', { class: 'd-cover' }, manga.coverUrl && h('img', { src: img(manga.coverUrl), alt: '' })),
			h('div', { class: 'd-info' },
				h('div', { class: 'd-title' }, manga.title),
				meta.map((m) => h('div', { class: 'd-meta' }, m))
			)
		),
		h('div', { class: 'd-actions' }, readBtn, followBtn, dlAllBtn),
		manga.description ? desc : null,
		h('h2', { class: 'ch-count' }, `${chapters.length} chapter${chapters.length === 1 ? '' : 's'}`)
	);

	// ----- chapter list -----
	const list = h('div', { class: 'ch-list' });
	body.append(list);

	const rows = new Map(); // chapterId -> { stateEl }
	chapters.forEach((ch, idx) => {
		const stateEl = h('span', { class: 'ch-state' });
		const row = h('div', {
			class: `ch-row${reading?.chapterId === ch.id ? ' current' : ''}`,
			onclick: () => ctx.openReader(dlManga(), chapters, idx)
		},
			h('div', { class: 'ch-name' }, chapterName(ch)),
			stateEl
		);
		rows.set(ch.id, stateEl);
		list.append(row);
	});

	function paintStates() {
		const jobs = new Map(getQueue().filter((j) => j.mangaId === id).map((j) => [j.chapterId, j]));
		for (const [chId, stateEl] of rows) {
			clear(stateEl);
			const job = jobs.get(chId);
			if (job && (job.status === 'queued' || job.status === 'downloading')) {
				stateEl.append(h('span', { class: 'ch-progress' },
					job.status === 'queued' ? 'Queued' : `${job.done}/${job.total}`));
			} else if (downloaded.has(chId) || job?.status === 'done') {
				if (job?.status === 'done') downloaded.add(chId);
				stateEl.append(h('span', { class: 'ch-done' }, icon('check', 16)));
			} else if (remote) {
				stateEl.append(h('button', {
					class: 'icon-btn',
					'aria-label': 'Download chapter',
					onclick: (e) => {
						e.stopPropagation();
						const ch = chapters.find((c) => c.id === chId);
						rpc('dl:add', dlManga(), [ch])
							.then(() => toast('Queued on your PC.', 'success', 1800))
							.catch((err) => toast(err.message, 'error'));
					}
				}, icon('download', 17)));
			}
		}
	}
	paintStates();
	window.addEventListener('queue-update', paintStates, { signal });

	// ----- follow sheet -----
	function openFollowSheet() {
		const close = () => sheet.remove();
		const pick = async (status) => {
			close();
			try {
				if (status === null) {
					await rpc('follows:remove', id);
					follow = null;
				} else {
					follow = await rpc('follows:set', snap, status, maxChapterNum());
				}
				paintFollow();
			} catch (err) {
				toast(err.message, 'error');
			}
		};
		const sheet = h('div', { class: 'sheet-overlay', onclick: (e) => { if (e.target === sheet) close(); } },
			h('div', { class: 'sheet' },
				h('div', { class: 'sheet-title' }, 'Add to library'),
				FOLLOW_STATUSES.map(([value, label]) => h('button', {
					class: `sheet-item${follow?.status === value ? ' selected' : ''}`,
					onclick: () => pick(value)
				}, label, follow?.status === value && icon('check', 16))),
				follow && h('button', { class: 'sheet-item danger', onclick: () => pick(null) }, 'Remove from library'),
				h('button', { class: 'sheet-item muted', onclick: close }, 'Cancel')
			)
		);
		document.body.append(sheet);
		signal.addEventListener('abort', close, { once: true });
	}
}
