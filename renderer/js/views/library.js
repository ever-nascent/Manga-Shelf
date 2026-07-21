import { h, clear, toast, fmtDate, chapterName, resumeIndex } from '../util.js';
import { mangaCard } from '../components.js';
import { icon } from '../icons.js';

const TABS = [
	['reading', 'Reading'], ['plan', 'Plan to Read'], ['completed', 'Completed'],
	['hold', 'On Hold'], ['dropped', 'Dropped'], ['downloads', 'Downloaded']
];

const state = { tab: 'reading' };

export async function render(root, params, ctx, signal) {
	if (params.id) return renderManga(root, params, ctx, signal);
	if (params.tab) state.tab = params.tab;

	root.append(h('div', { class: 'view-title' }, 'My Library'));

	let [follows, downloads] = await Promise.all([
		window.api.getFollows(),
		window.api.getLibrary()
	]);

	const countFor = (tab) => tab === 'downloads'
		? downloads.length
		: follows.filter((f) => f.status === tab).length;

	const tabBar = h('div', { class: 'pill-tabs' });
	const content = h('div', {});
	root.append(tabBar, content);

	const drawTabs = () => {
		clear(tabBar);
		for (const [value, label] of TABS) {
			tabBar.append(h('button', {
				class: state.tab === value ? 'on' : '',
				onclick: () => { state.tab = value; drawTabs(); drawContent(); }
			}, label, h('span', { class: 'count' }, String(countFor(value)))));
		}
	};

	const drawContent = () => {
		clear(content);
		if (state.tab === 'downloads') return drawDownloads();

		const items = follows.filter((f) => f.status === state.tab);
		if (!items.length) {
			content.append(h('div', { class: 'empty-state' },
				h('div', { class: 'big' }, icon('bookmark', 44)),
				h('div', {}, `Nothing in "${TABS.find(([v]) => v === state.tab)[1]}" yet.`),
				h('div', {}, 'Open any manga and use the bookmark button to add it to a shelf.')
			));
			return;
		}
		const grid = h('div', { class: 'card-grid' });
		content.append(grid);
		for (const f of items) {
			grid.append(mangaCard(f.manga, () => ctx.navigate('detail', { id: f.manga.id }), {
				sub: f.progress ? `at ch. ${f.progress.chapterNum ?? '?'}` : (f.manga.status || ''),
				corner: f.downloaded ? 'download' : null
			}));
		}
	};

	// Open a downloaded series in the reader at its saved spot. Closing the
	// reader reveals this tab again, so refresh the cards to show new progress.
	const resumeDownloaded = (m) => {
		const readingList = m.chapters.map((c) => ({ ...c, external: false }));
		if (!readingList.length) { ctx.navigate('library', { id: m.id }); return; }

		let idx = 0;
		let page = 0;
		if (m.progress) {
			const found = resumeIndex(readingList, m.progress.chapterId, m.progress.chapterNum);
			if (found >= 0) { idx = found; page = m.progress.page || 0; }
		}

		const onClosed = async () => {
			window.removeEventListener('reader-closed', onClosed);
			if (signal?.aborted) return;
			downloads = await window.api.getLibrary();
			if (!signal?.aborted && state.tab === 'downloads') drawContent();
		};
		window.addEventListener('reader-closed', onClosed, { signal });

		ctx.openReader(m, readingList, idx, page);
	};

	const drawDownloads = () => {
		if (!downloads.length) {
			content.append(h('div', { class: 'empty-state' },
				h('div', { class: 'big' }, icon('books', 44)),
				h('div', {}, 'No downloads yet.'),
				h('div', {}, 'Find something on the ', h('button', { class: 'chip', onclick: () => ctx.navigate('browse') }, 'Browse'), ' page and download a few chapters!')
			));
			return;
		}
		const grid = h('div', { class: 'card-grid' });
		content.append(grid);
		for (const m of downloads) {
			const total = m.chapters.length;
			const lastReadNum = m.progress?.chapterNum;
			// clicking a downloaded series drops straight into the reader; the
			// reader is an overlay, so closing it uncovers this same tab again
			const card = mangaCard(m, () => resumeDownloaded(m), {
				sub: `${total} chapter${total === 1 ? '' : 's'}${lastReadNum ? ` · at ch. ${lastReadNum}` : ''}`,
				corner: m.progress ? 'play' : null,
				quick: [
					{ icon: 'books', label: 'Chapters & export', onClick: () => ctx.navigate('library', { id: m.id }) },
					{ icon: 'compass', label: 'Series page', onClick: () => ctx.navigate('detail', { id: m.id }) }
				]
			});
			card.classList.add('lib-card');
			if (total && lastReadNum) {
				const idx = m.chapters.findIndex((c) => c.id === m.progress.chapterId);
				const pct = idx >= 0 ? ((idx + 1) / total) * 100 : 0;
				card.append(h('div', { class: 'progress-line' }, h('div', { style: { width: pct + '%' } })));
			}
			grid.append(card);
		}
	};

	drawTabs();
	drawContent();
}

async function renderManga(root, params, ctx, signal) {
	const m = await window.api.getLibraryManga(params.id);
	// navigated away (or a newer rerender started) while the read was in flight
	if (signal?.aborted) return;
	if (!m) { ctx.navigate('library', {}, { push: false }); return; }

	root.append(h('button', { class: 'back-btn', onclick: ctx.back }, icon('chevron-left', 15), 'Back'));

	const readingList = m.chapters.map((c) => ({ ...c, external: false }));

	const continueBtn = h('button', {
		class: 'btn primary',
		onclick: () => {
			if (!readingList.length) return;
			let idx = 0, page = 0;
			if (m.progress) {
				const found = resumeIndex(readingList, m.progress.chapterId, m.progress.chapterNum);
				if (found >= 0) { idx = found; page = m.progress.page || 0; }
			}
			ctx.openReader(m, readingList, idx, page);
		}
	}, icon('play', 14), m.progress ? 'Continue reading' : 'Read');

	root.append(
		h('div', { class: 'detail-hero' },
			h('div', { class: 'backdrop-wrap' },
				h('div', { class: 'backdrop', style: m.coverUrl ? { backgroundImage: `url("${m.coverUrl}")` } : {} })),
			h('img', { class: 'poster', src: m.coverUrl || '', alt: m.title }),
			h('div', { class: 'detail-info' },
				h('h1', {}, m.title),
				h('div', { class: 'meta' },
					h('span', {}, `${m.chapters.length} downloaded chapter${m.chapters.length === 1 ? '' : 's'}`),
					m.authors?.length ? h('span', {}, m.authors.join(', ')) : null
				),
				h('div', { class: 'desc' }, m.description || ''),
				h('div', { class: 'detail-actions' },
					continueBtn,
					h('button', { class: 'btn', onclick: () => ctx.navigate('detail', { id: m.id }) }, icon('compass', 15), 'Series page'),
					h('button', { class: 'btn', onclick: () => window.api.openMangaFolder(m.id) }, icon('folder', 15), 'Folder'),
					h('button', {
						class: 'btn',
						// currentTarget is null once the handler yields — grab it up front
						onclick: async (e) => {
							const btn = e.currentTarget;
							btn.disabled = true;
							try {
								const res = await window.api.exportManga(m.id, 'cbz');
								if (res) toast(`Exported ${res.count} chapters as CBZ.`, 'success');
							} catch (err) { toast(err.message, 'error'); }
							btn.disabled = false;
						}
					}, icon('file', 15), 'Export all (CBZ)'),
					h('button', {
						class: 'btn danger',
						onclick: async () => {
							if (!confirm(`Delete "${m.title}" and all downloaded chapters from disk?`)) return;
							await window.api.removeManga(m.id);
							toast('Removed from library.');
							ctx.navigate('library', {}, { push: false });
						}
					}, icon('trash', 15), 'Delete')
				)
			)
		)
	);

	// Each pass owns its listeners: a rerender (or navigating away) aborts the
	// previous pass so only one copy of this page can ever react to an event.
	const pass = new AbortController();
	signal?.addEventListener('abort', () => pass.abort(), { once: true });

	const rerender = () => {
		pass.abort();
		clear(root);
		renderManga(root, params, ctx, signal);
	};

	root.append(h('div', { class: 'section-sub' }, 'Downloaded chapters'));

	// ---------- bulk selection / deletion ----------
	const selected = new Set();
	const rowChecks = new Map();

	// "read" = chapters numbered before wherever you're currently reading
	const currentNum = m.progress ? parseFloat(m.progress.chapterNum) : NaN;
	const readChapters = Number.isNaN(currentNum) ? [] : m.chapters.filter((c) => {
		const n = parseFloat(c.num);
		return !Number.isNaN(n) && n < currentNum;
	});

	const selectAll = h('input', { type: 'checkbox', title: 'Select all' });
	const delSelBtn = h('button', { class: 'btn small danger' });
	const delReadBtn = h('button', { class: 'btn small' }, icon('check', 14),
		`Delete read (${readChapters.length})`);

	const refreshBulk = () => {
		clear(delSelBtn);
		delSelBtn.append(icon('trash', 14), `Delete selected${selected.size ? ` (${selected.size})` : ''}`);
		delSelBtn.disabled = selected.size === 0;
		selectAll.checked = selected.size > 0 && selected.size === m.chapters.length;
		selectAll.indeterminate = selected.size > 0 && selected.size < m.chapters.length;
	};

	const deleteMany = async (ids, label) => {
		if (!ids.length) return;
		if (!confirm(`Delete ${ids.length} ${label} from disk? This can't be undone.`)) return;
		await window.api.removeChapters(m.id, ids);
		toast(`Deleted ${ids.length} chapter${ids.length === 1 ? '' : 's'}.`);
		rerender();
	};

	selectAll.addEventListener('change', () => {
		selected.clear();
		if (selectAll.checked) for (const c of m.chapters) selected.add(c.id);
		for (const [id, cb] of rowChecks) cb.checked = selected.has(id);
		refreshBulk();
	});
	delSelBtn.addEventListener('click', () =>
		deleteMany([...selected], selected.size === 1 ? 'chapter' : 'chapters'));
	delReadBtn.addEventListener('click', () =>
		deleteMany(readChapters.map((c) => c.id),
			readChapters.length === 1 ? 'read chapter' : 'read chapters'));

	root.append(h('div', { class: 'bulk-bar' },
		h('label', { class: 'bulk-all' }, selectAll, 'Select all'),
		delSelBtn,
		readChapters.length ? delReadBtn : null
	));

	root.append(
		h('table', { class: 'chapter-table' },
			m.chapters.map((ch) => {
				const cb = h('input', {
					type: 'checkbox',
					onchange: () => {
						cb.checked ? selected.add(ch.id) : selected.delete(ch.id);
						refreshBulk();
					}
				});
				rowChecks.set(ch.id, cb);
				return h('tr', {},
					h('td', { class: 'ch-check' }, cb),
					h('td', { class: 'ch-num' }, ch.num ? `Ch. ${ch.num}` : 'Oneshot'),
					h('td', { class: 'ch-title' }, ch.title || ''),
					h('td', { class: 'ch-group' }, `${ch.pages} pages`),
					h('td', { class: 'ch-date' }, fmtDate(ch.downloadedAt)),
					h('td', { class: 'ch-actions' },
						h('button', {
							class: 'btn small',
							onclick: () => ctx.openReader(m, readingList, readingList.findIndex((c) => c.id === ch.id), 0)
						}, 'Read'), ' ',
						h('button', {
							class: 'btn small', title: 'Export as CBZ',
							onclick: async () => {
								try {
									const f = await window.api.exportChapter(m.id, ch.id, 'cbz');
									if (f) toast('Exported CBZ.', 'success');
								} catch (err) { toast(err.message, 'error'); }
							}
						}, 'CBZ'), ' ',
						h('button', {
							class: 'btn small', title: 'Export as PDF',
							onclick: async () => {
								try {
									const f = await window.api.exportChapter(m.id, ch.id, 'pdf');
									if (f) toast('Exported PDF.', 'success');
								} catch (err) { toast(err.message, 'error'); }
							}
						}, 'PDF'), ' ',
						h('button', {
							class: 'btn small danger icon-only', title: 'Delete chapter',
							onclick: async () => {
								if (!confirm(`Delete ${chapterName(ch)} from disk?`)) return;
								await window.api.removeChapter(m.id, ch.id);
								rerender();
							}
						}, icon('trash', 14))
					)
				);
			})
		)
	);
	refreshBulk();

	// progress may have changed while reading
	window.addEventListener('reader-closed', () => {
		if (!pass.signal.aborted) rerender();
	}, { once: true, signal: pass.signal });
}
