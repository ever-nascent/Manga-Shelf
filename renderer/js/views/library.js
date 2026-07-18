import { h, clear, toast, fmtDate, chapterName } from '../util.js';
import { mangaCard } from '../components.js';
import { icon } from '../icons.js';

const TABS = [
	['reading', 'Reading'], ['plan', 'Plan to Read'], ['completed', 'Completed'],
	['hold', 'On Hold'], ['dropped', 'Dropped'], ['downloads', 'Downloaded']
];

const state = { tab: 'reading' };

export async function render(root, params, ctx) {
	if (params.id) return renderManga(root, params, ctx);
	if (params.tab) state.tab = params.tab;

	root.append(h('div', { class: 'view-title' }, 'My Library'));

	const [follows, downloads] = await Promise.all([
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
			const card = mangaCard(m, () => ctx.navigate('library', { id: m.id }), {
				sub: `${total} chapter${total === 1 ? '' : 's'}${lastReadNum ? ` · at ch. ${lastReadNum}` : ''}`,
				corner: m.progress ? 'play' : null
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

async function renderManga(root, params, ctx) {
	const m = await window.api.getLibraryManga(params.id);
	if (!m) { ctx.navigate('library', {}, { push: false }); return; }

	root.append(h('button', { class: 'back-btn', onclick: ctx.back }, icon('chevron-left', 15), 'Back'));

	const readingList = m.chapters.map((c) => ({ ...c, external: false }));

	const continueBtn = h('button', {
		class: 'btn primary',
		onclick: () => {
			if (!readingList.length) return;
			let idx = 0, page = 0;
			if (m.progress) {
				const found = readingList.findIndex((c) => c.id === m.progress.chapterId);
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
						onclick: async (e) => {
							e.currentTarget.disabled = true;
							try {
								const res = await window.api.exportManga(m.id, 'cbz');
								if (res) toast(`Exported ${res.count} chapters as CBZ.`, 'success');
							} catch (err) { toast(err.message, 'error'); }
							e.currentTarget.disabled = false;
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

	const rerender = () => { clear(root); renderManga(root, params, ctx); };

	root.append(h('div', { class: 'section-sub' }, 'Downloaded chapters'));
	root.append(
		h('table', { class: 'chapter-table' },
			m.chapters.map((ch) => h('tr', {},
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
			))
		)
	);

	// progress may have changed while reading
	const onReaderClosed = () => {
		window.removeEventListener('reader-closed', onReaderClosed);
		if (root.isConnected) rerender();
	};
	window.addEventListener('reader-closed', onReaderClosed);
}
