import { h, clear, spinner, errorBox, fmtNum, fmtDate, toast, STATUS_LABEL, dedupeChapters, resumeIndex } from '../util.js';
import { mangaCard, coverImg, openMenu, openModal, styledSelect, quickRead, discoverQuickActions, FOLLOW_STATUSES, followStatusLabel } from '../components.js';
import { icon } from '../icons.js';

export async function render(root, params, ctx, signal) {
	root.append(h('button', { class: 'back-btn', onclick: ctx.back }, icon('chevron-left', 15), 'Back'));
	const body = h('div', {});
	root.append(body);
	body.append(spinner());

	let manga;
	try {
		manga = await window.api.getManga(params.id);
	} catch (err) {
		clear(body);
		body.append(errorBox(`Couldn't load manga: ${err.message}`, () => ctx.navigate('detail', params, { push: false })));
		return;
	}

	const [stats, libEntry, reading, followsAll] = await Promise.all([
		window.api.getStats(manga.id),
		window.api.getLibraryManga(manga.id),
		window.api.getReading(manga.id),
		window.api.getFollows()
	]);
	let follow = await window.api.getFollow(manga.id);
	const followSet = new Set(followsAll.map((f) => f.manga.id));

	clear(body);

	let chapters = [];

	// ---------- hero action buttons ----------
	const downloadAllBtn = h('button', { class: 'btn primary' }, icon('download', 15), 'Download all');
	const readBtn = h('button', { class: 'btn' }, icon('play', 14),
		reading ? `Continue ch. ${reading.chapterNum ?? '?'}` : 'Read');
	const folderBtn = libEntry
		? h('button', { class: 'btn', onclick: () => window.api.openMangaFolder(manga.id) }, icon('folder', 15), 'Folder')
		: null;
	const altSourceBtn = manga.id.startsWith('mk:') ? null
		: h('button', {
			class: 'btn',
			title: 'Search MangaKatana for this series',
			onclick: () => openAltSourceSearch(manga, ctx)
		}, icon('search', 14), 'Alternative source');

	const followBtn = h('button', { class: 'btn' });
	const bellBtn = h('button', { class: 'btn icon-only', title: 'Notifications for new chapters' });

	const maxChapterNum = () => {
		const nums = chapters.map((c) => parseFloat(c.num)).filter((n) => !Number.isNaN(n));
		return nums.length ? Math.max(...nums) : undefined;
	};

	const refreshFollowUi = () => {
		clear(followBtn);
		followBtn.append(
			icon(follow ? 'bookmark-filled' : 'bookmark', 15),
			follow ? followStatusLabel(follow.status) : 'Add to Library',
			icon('chevron-down', 12)
		);
		followBtn.classList.toggle('primary', !follow && !libEntry);
		bellBtn.classList.toggle('hidden', !follow);
		if (follow) {
			clear(bellBtn);
			bellBtn.append(icon(follow.notify !== false ? 'bell' : 'bell-off', 16));
			bellBtn.classList.toggle('muted', follow.notify === false);
		}
	};

	followBtn.addEventListener('click', () => {
		const items = FOLLOW_STATUSES.map(([value, label]) => ({
			label,
			selected: follow?.status === value,
			onClick: async () => {
				follow = await window.api.setFollow(manga, value, maxChapterNum());
				followSet.add(manga.id);
				refreshFollowUi();
				toast(`Added to ${label}.`, 'success', 1800);
			}
		}));
		if (follow) {
			items.push('divider', {
				label: 'Remove from Library',
				icon: 'trash',
				danger: true,
				onClick: async () => {
					await window.api.removeFollow(manga.id);
					follow = null;
					followSet.delete(manga.id);
					refreshFollowUi();
					toast('Removed from library.', 'info', 1800);
				}
			});
		}
		openMenu(followBtn, items);
	});

	bellBtn.addEventListener('click', async () => {
		if (!follow) return;
		follow = await window.api.setFollowNotify(manga.id, follow.notify === false);
		refreshFollowUi();
		toast(follow.notify
			? "You'll get a notification when new chapters drop."
			: 'Notifications muted for this series.', 'success', 2200);
	});
	refreshFollowUi();

	// ---------- hero ----------
	const meta = [];
	const statusText = [STATUS_LABEL[manga.status], manga.year].filter(Boolean).join(' · ');
	if (statusText) meta.push(h('span', {}, statusText));
	if (manga.authors.length) meta.push(h('span', {}, manga.authors.join(', ')));
	if (stats?.rating) meta.push(h('span', { class: 'stat rating' }, icon('star-filled', 13), h('b', {}, stats.rating.toFixed(2))));
	if (stats?.follows) meta.push(h('span', { class: 'stat' }, h('b', {}, fmtNum(stats.follows)), ' follows'));

	body.append(
		h('div', { class: 'detail-hero' },
			h('div', { class: 'backdrop-wrap' },
				h('div', {
					class: 'backdrop',
					style: manga.coverUrl ? { backgroundImage: `url("${manga.coverUrl}")` } : {}
				})
			),
			(() => { const img = coverImg(manga.coverUrl, manga.title); img.className = 'poster'; return img; })(),
			h('div', { class: 'detail-info' },
				h('h1', {}, manga.title),
				h('div', { class: 'meta' }, meta),
				h('div', { class: 'tags' }, manga.tags.map((t) => manga.id.startsWith('mk:')
					? h('span', { class: 'chip' }, t.name)
					: h('button', { class: 'chip', onclick: () => ctx.navigate('browse', { tag: t.id }) }, t.name))),
				h('div', { class: 'desc' }, manga.description || 'No description.'),
				h('div', { class: 'detail-actions' }, followBtn, bellBtn, readBtn, downloadAllBtn, folderBtn, altSourceBtn)
			)
		)
	);

	// ---------- chapters ----------
	const chaptersHead = h('div', { class: 'section-sub chapters-head' }, 'Chapters');
	const noticeSlot = h('div', {});
	const chaptersWrap = h('div', {});
	body.append(noticeSlot, chaptersHead, chaptersWrap);
	chaptersWrap.append(spinner());

	try {
		chapters = await window.api.getChapters(manga.id);
	} catch (err) {
		clear(chaptersWrap);
		chaptersWrap.append(errorBox(`Couldn't load chapters: ${err.message}`));
	}

	const downloaded = new Set((libEntry?.chapters || []).map((c) => c.id));

	// --- source (scanlation group) selection ---
	const readable = chapters.filter((c) => !c.external && c.pages > 0);
	const groupCounts = new Map();
	for (const c of readable) groupCounts.set(c.group, (groupCounts.get(c.group) || 0) + 1);
	const groupsSorted = [...groupCounts.entries()].sort((a, b) => b[1] - a[1]);
	const primaryGroup = groupsSorted[0]?.[0] || null;
	let sourceMode = 'best';

	function displayChapters() {
		if (sourceMode === 'all') return chapters;
		if (sourceMode !== 'best') return chapters.filter((c) => c.group === sourceMode && !c.external);

		// "best": one row per chapter number — prefer the primary group, fill
		// gaps from other groups, keep external-only chapters visible
		const byNum = new Map();
		const oneshots = [];
		for (const c of chapters) {
			if (c.num == null || c.num === '') { oneshots.push(c); continue; }
			const cur = byNum.get(c.num);
			const curReadable = cur && !cur.external && cur.pages > 0;
			const cReadable = !c.external && c.pages > 0;
			const better = !cur
				|| (!curReadable && cReadable)
				|| (curReadable && cReadable && cur.group !== primaryGroup && c.group === primaryGroup);
			if (better) byNum.set(c.num, c);
		}
		const rows = [...byNum.values()].sort((a, b) => (parseFloat(a.num) || 0) - (parseFloat(b.num) || 0));
		return [...oneshots.slice(0, 1), ...rows];
	}

	const readingListNow = () => {
		const list = sourceMode === 'all' ? dedupeChapters(chapters) : displayChapters().filter((c) => !c.external && c.pages > 0);
		return list;
	};

	if (groupsSorted.length > 1) {
		const select = styledSelect({
			small: true,
			value: 'best',
			options: [
				{ value: 'best', label: 'Best source', sub: primaryGroup ? `mostly ${primaryGroup}` : '' },
				...groupsSorted.map(([g, n]) => ({ value: g, label: g, sub: `${n} ch.` })),
				{ value: 'all', label: 'All sources' }
			],
			onChange: (v) => { sourceMode = v; renderTable(); }
		});
		chaptersHead.append(h('span', { class: 'head-spacer' }), select.el);
	}

	// licensed series: every chapter lives on the publisher's site
	if (chapters.length && !readable.length) {
		noticeSlot.append(h('div', { class: 'notice' },
			icon('external', 16),
			h('div', {},
				h('b', {}, 'Officially licensed series. '),
				'MangaDex doesn\'t host these chapters — they link to the publisher\'s own reader (e.g. MangaPlus). Use the buttons below to read there; downloading isn\'t possible for licensed chapters.')
		));
	}

	function openReaderAt(chapter, page = 0) {
		const list = readingListNow();
		const index = resumeIndex(list, chapter.id, chapter.num);
		if (index === -1) { toast('This chapter has no readable pages.', 'error'); return; }
		ctx.openReader(manga, list, index, page);
	}

	readBtn.addEventListener('click', () => {
		const list = readingListNow();
		if (!list.length) { toast('No readable chapters available.', 'error'); return; }
		if (reading) {
			const idx = resumeIndex(list, reading.chapterId, reading.chapterNum);
			ctx.openReader(manga, list, Math.max(0, idx), reading.page || 0);
		} else {
			ctx.openReader(manga, list, 0, 0);
		}
	});

	downloadAllBtn.addEventListener('click', () => {
		const todo = readingListNow().filter((c) => !downloaded.has(c.id));
		if (!todo.length) {
			toast(readable.length ? 'Everything is already downloaded or queued.' : 'No downloadable chapters — this series is licensed.', 'info', 3000);
			return;
		}
		window.api.download(manga, todo);
		toast(`Queued ${todo.length} chapter${todo.length === 1 ? '' : 's'} for download.`, 'success');
	});

	let actionCells = new Map();

	const renderActions = (td, ch) => {
		clear(td);
		if (ch.external) {
			td.append(h('button', {
				class: 'btn small',
				title: 'Read on the official site',
				onclick: () => window.api.openExternal(ch.externalUrl)
			}, icon('external', 13), 'Official'));
			return;
		}
		if (downloaded.has(ch.id)) {
			td.append(
				h('span', { class: 'done-mark', title: 'Downloaded' }, icon('check', 14)),
				h('button', { class: 'btn small', onclick: () => openReaderAt(ch) }, 'Read')
			);
		} else {
			td.append(
				h('button', { class: 'btn small', onclick: () => openReaderAt(ch) }, 'Read'),
				' ',
				h('button', {
					class: 'btn small icon-only', title: 'Download this chapter',
					onclick: (e) => {
						window.api.download(manga, [ch]);
						e.currentTarget.disabled = true;
						toast(`Queued chapter ${ch.num ?? ''}`.trim() + ' for download.', 'success');
					}
				}, icon('download', 14))
			);
		}
	};

	function renderTable() {
		clear(chaptersWrap);
		const list = displayChapters();
		if (!list.length) {
			chaptersWrap.append(h('div', { class: 'result-count' }, 'No chapters for this language/source.'));
			return;
		}
		actionCells = new Map();
		chaptersWrap.append(h('table', { class: 'chapter-table' },
			list.map((ch) => {
				const td = h('td', { class: 'ch-actions' });
				actionCells.set(ch.id, { td, ch });
				renderActions(td, ch);
				return h('tr', {},
					h('td', { class: 'ch-num' }, ch.num ? `Ch. ${ch.num}` : 'Oneshot'),
					h('td', { class: 'ch-title' }, ch.title || ''),
					h('td', { class: 'ch-group' }, ch.group),
					h('td', { class: 'ch-date' }, fmtDate(ch.publishAt)),
					td
				);
			})
		));
	}

	if (chapters.length) {
		renderTable();
		const onQueue = (e) => {
			for (const job of e.detail) {
				if (job.mangaId === manga.id && job.status === 'done' && !downloaded.has(job.chapterId)) {
					downloaded.add(job.chapterId);
					const cell = actionCells.get(job.chapterId);
					if (cell) renderActions(cell.td, cell.ch);
				}
			}
		};
		window.addEventListener('queue-update', onQueue, { signal });
	} else if (!chaptersWrap.querySelector('.error-box')) {
		clear(chaptersWrap);
		chaptersWrap.append(h('div', { class: 'notice' },
			icon('alert', 16),
			h('div', {},
				'No chapters available in your language on MangaDex. This usually means the series is officially licensed and its translations were removed — check the publisher\'s site, or try another chapter language in Settings.')
		));
	}

	// ---------- related & similar ----------
	const open = (m) => ctx.navigate('detail', { id: m.id });
	const cardOpts = (m, extra = {}) => ({
		...extra,
		quick: discoverQuickActions(ctx, m, followSet)
	});

	if (manga.related?.length) {
		try {
			// byIds bypasses the content-rating filter (it must resolve any id for
			// the updates checker), so apply the user's filter here
			const allowed = new Set((await window.api.getSettings()).contentRating);
			const related = (await window.api.getMangaByIds(manga.related.map((r) => r.id)))
				.filter((m) => allowed.has(m.contentRating));
			if (related.length) {
				const relMap = new Map(manga.related.map((r) => [r.id, r.relation]));
				body.append(
					h('div', { class: 'section-sub' }, 'Related'),
					h('div', { class: 'card-row' }, related.map((m) =>
						mangaCard(m, open, cardOpts(m, { sub: (relMap.get(m.id) || '').replace(/_/g, ' ') }))))
				);
			}
		} catch { /* non-essential */ }
	}

	try {
		const similar = await window.api.getSimilar(manga);
		if (similar.length) {
			body.append(
				h('div', { class: 'section-sub' }, 'More like this'),
				h('div', { class: 'card-row' }, similar.map((m) => mangaCard(m, open, cardOpts(m))))
			);
		}
	} catch { /* non-essential */ }
}

// Manual fallback: look this series up on MangaKatana and jump to its own
// detail page (id-prefixed `mk:`) so downloads/reading work exactly the same.
function openAltSourceSearch(manga, ctx) {
	const { body, close } = openModal('Search MangaKatana');
	const input = h('input', { type: 'text', value: manga.title, placeholder: 'Series title…' });
	const searchBtn = h('button', { class: 'btn primary' }, icon('search', 14), 'Search');
	const results = h('div', { class: 'alt-source-results' });

	body.append(
		h('div', { class: 'alt-source-form' }, input, searchBtn),
		results
	);

	async function runSearch() {
		const query = input.value.trim();
		if (!query) return;
		clear(results);
		results.append(spinner());
		try {
			const found = await window.api.searchMangaKatana(query);
			clear(results);
			if (!found.length) {
				results.append(h('div', { class: 'result-count' }, 'No matches on MangaKatana.'));
				return;
			}
			for (const r of found) {
				results.append(h('button', {
					class: 'alt-source-row',
					onclick: () => { close(); ctx.navigate('detail', { id: r.id }); }
				},
					h('img', { src: r.coverUrl || '', alt: '' }),
					h('div', {},
						h('div', { class: 'as-title' }, r.title),
						h('div', { class: 'as-sub' }, [r.status, r.latestChapterLabel].filter(Boolean).join(' · ')))
				));
			}
		} catch (err) {
			clear(results);
			results.append(errorBox(`Search failed: ${err.message}`));
		}
	}

	searchBtn.addEventListener('click', runSearch);
	input.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
	runSearch();
}
