import { h, clear, toast, debounce } from '../util.js';
import { styledSelect } from '../components.js';
import { icon } from '../icons.js';

const readerEl = document.getElementById('reader');

const prefs = {
	get mode() { return localStorage.getItem('reader-mode') || 'vertical'; },
	set mode(v) { localStorage.setItem('reader-mode', v); },
	get fit() { return localStorage.getItem('reader-fit') || 'fit-height'; },
	set fit(v) { localStorage.setItem('reader-fit', v); },
	get stripWidth() { return Number(localStorage.getItem('reader-strip')) || 760; },
	set stripWidth(v) { localStorage.setItem('reader-strip', v); }
};

let cleanup = null;

export async function openReader(ctx, manga, chapterList, index, startPage = 0) {
	if (cleanup) cleanup();

	let chIndex = index;
	let page = startPage;
	let pages = [];
	const libEntry = await window.api.getLibraryManga(manga.id);

	readerEl.classList.remove('hidden');
	clear(readerEl);

	// ---------- bar ----------
	const chapterSelect = styledSelect({
		small: true,
		value: chIndex,
		options: chapterList.map((c, i) => ({
			value: i,
			label: c.num ? `Chapter ${c.num}` : (c.title || 'Oneshot')
		})),
		onChange: (i) => loadChapter(i, 0)
	});
	const modeBtn = h('button', { class: 'btn small' });
	const fitBtn = h('button', { class: 'btn small' });
	const narrowBtn = h('button', { class: 'btn small icon-only', title: 'Narrower' }, icon('minus', 14));
	const widenBtn = h('button', { class: 'btn small icon-only', title: 'Wider' }, icon('plus', 14));
	const pageInd = h('span', { class: 'page-ind' });
	const titleEl = h('div', { class: 'r-title' }, manga.title);

	const bar = h('header', { class: 'reader-bar' },
		h('button', { class: 'btn small', onclick: close }, icon('chevron-left', 14), 'Close'),
		titleEl,
		chapterSelect.el,
		h('div', { class: 'r-spacer' }),
		narrowBtn, widenBtn, fitBtn, modeBtn, pageInd
	);

	const scroll = h('div', { class: 'reader-scroll' });
	const zoneL = h('div', { class: 'edge-zone left', onclick: () => turnPage(-1) });
	const zoneR = h('div', { class: 'edge-zone right', onclick: () => turnPage(1) });
	readerEl.append(bar, scroll);

	// ---------- bar auto-hide ----------
	let fadeTimer;
	const wake = () => {
		bar.classList.remove('faded');
		clearTimeout(fadeTimer);
		fadeTimer = setTimeout(() => bar.classList.add('faded'), 2600);
	};
	readerEl.addEventListener('mousemove', wake);
	wake();

	// ---------- mode / fit ----------
	function applyMode() {
		const vertical = prefs.mode === 'vertical';
		scroll.className = `reader-scroll ${vertical ? 'vertical' : `paged ${prefs.fit}`}`;
		scroll.style.setProperty('--strip-width', prefs.stripWidth + 'px');
		clear(modeBtn);
		modeBtn.append(icon(vertical ? 'rows' : 'pages', 14), vertical ? 'Scroll' : 'Paged');
		fitBtn.classList.toggle('hidden', vertical);
		narrowBtn.classList.toggle('hidden', !vertical);
		widenBtn.classList.toggle('hidden', !vertical);
		fitBtn.textContent = prefs.fit === 'fit-height' ? 'Fit height' : 'Fit width';
		if (vertical) { zoneL.remove(); zoneR.remove(); }
		else scroll.append(zoneL, zoneR);
		showPage();
	}

	modeBtn.addEventListener('click', () => { prefs.mode = prefs.mode === 'vertical' ? 'paged' : 'vertical'; applyMode(); });
	fitBtn.addEventListener('click', () => { prefs.fit = prefs.fit === 'fit-height' ? 'fit-width' : 'fit-height'; applyMode(); });
	narrowBtn.addEventListener('click', () => { prefs.stripWidth = Math.max(420, prefs.stripWidth - 80); applyMode(); });
	widenBtn.addEventListener('click', () => { prefs.stripWidth = Math.min(1400, prefs.stripWidth + 80); applyMode(); });

	// ---------- progress (saved for every manga, downloaded or streamed) ----------
	const snapshot = { id: manga.id, title: manga.title, coverUrl: manga.coverUrl || null };
	const saveProgress = debounce(() => {
		const ch = chapterList[chIndex];
		window.api.setReading(snapshot, { chapterId: ch.id, chapterNum: ch.num, page });
	}, 600);

	function updateIndicator() {
		pageInd.textContent = pages.length ? `${page + 1} / ${pages.length}` : '';
		saveProgress();
		pumpLoads(); // keep page fetching prioritized around wherever the reader is
	}

	// ---------- staggered page loading ----------
	// Pages are appended without src and fetched a few at a time, nearest to the
	// current page first — opening a 180-page chapter shouldn't burst 180
	// simultaneous requests at the image server.
	const LOAD_CONCURRENCY = 4;
	let loadGen = 0; // bumped per chapter so stale onload callbacks are ignored
	let inFlight = 0;

	function nextPending() {
		const els = imgs();
		for (let i = page; i < els.length; i++) if (els[i].dataset.src) return els[i];
		for (let i = Math.min(page, els.length - 1); i >= 0; i--) if (els[i].dataset.src) return els[i];
		return null;
	}

	function pumpLoads() {
		const gen = loadGen;
		while (inFlight < LOAD_CONCURRENCY) {
			const el = nextPending();
			if (!el) return;
			inFlight++;
			const done = () => {
				el.classList.remove('r-pending');
				if (gen !== loadGen) return;
				inFlight--;
				pumpLoads();
			};
			el.addEventListener('load', done, { once: true });
			el.addEventListener('error', done, { once: true });
			el.src = el.dataset.src;
			delete el.dataset.src;
		}
	}

	// ---------- page display ----------
	function imgs() { return [...scroll.querySelectorAll('.r-page')]; }

	function showPage(scrollIntoView = false) {
		const els = imgs();
		if (!els.length) return;
		page = Math.max(0, Math.min(page, els.length - 1));
		if (prefs.mode === 'paged') {
			els.forEach((el, i) => el.classList.toggle('current', i === page));
		} else if (scrollIntoView) {
			els[page]?.scrollIntoView();
		}
		updateIndicator();
	}

	function turnPage(dir) {
		if (prefs.mode !== 'paged') return;
		if (page + dir < 0) { loadChapter(chIndex - 1, 'last'); return; }
		if (page + dir >= pages.length) { loadChapter(chIndex + 1, 0); return; }
		page += dir;
		showPage();
	}

	// vertical mode: track which page is at mid-viewport
	let scrollRaf = null;
	scroll.addEventListener('scroll', () => {
		if (prefs.mode !== 'vertical' || scrollRaf) return;
		scrollRaf = requestAnimationFrame(() => {
			scrollRaf = null;
			const mid = scroll.scrollTop + scroll.clientHeight / 2;
			const els = imgs();
			for (let i = 0; i < els.length; i++) {
				if (els[i].offsetTop <= mid && mid < els[i].offsetTop + els[i].offsetHeight) {
					if (page !== i) { page = i; updateIndicator(); }
					break;
				}
			}
		});
	});

	// ---------- chapter loading ----------
	async function loadChapter(newIndex, startAt) {
		if (newIndex < 0) { toast('This is the first chapter.'); return; }
		if (newIndex >= chapterList.length) { toast('No more chapters — you\'re all caught up!', 'success'); return; }
		chIndex = newIndex;
		loadGen++;
		inFlight = 0;
		chapterSelect.set(chIndex);
		const ch = chapterList[chIndex];
		titleEl.textContent = `${manga.title} — ${ch.num ? `Ch. ${ch.num}` : (ch.title || 'Oneshot')}`;

		clear(scroll);
		scroll.append(h('div', { class: 'reader-loading' }, 'Loading pages…'));
		pages = [];
		updateIndicator();

		try {
			// prefer downloaded pages (any group's copy of this chapter number);
			// fall back to streaming from MangaDex
			const local = libEntry?.chapters?.find((c) => c.id === ch.id)
				|| (ch.num != null && libEntry?.chapters?.find((c) => c.num === ch.num));
			let urls = local ? await window.api.getChapterPages(manga.id, local.id) : [];
			const online = !urls.length;
			if (online) urls = await window.api.getChapterImages(ch.id);
			if (!urls.length) throw new Error('No pages found');
			pages = urls;

			clear(scroll);
			for (const url of urls) {
				scroll.append(h('img', { class: 'r-page r-pending', dataset: { src: url }, draggable: false }));
			}
			if (prefs.mode === 'vertical') {
				scroll.append(h('div', { class: 'chapter-end' },
					h('div', {}, `End of ${ch.num ? `chapter ${ch.num}` : 'chapter'}${online ? ' (streamed online)' : ''}`),
					chIndex + 1 < chapterList.length
						? h('button', { class: 'btn primary', onclick: () => loadChapter(chIndex + 1, 0) }, 'Next chapter', icon('chevron-right', 14))
						: h('div', {}, 'No more chapters')
				));
			}

			page = startAt === 'last' ? pages.length - 1 : (startAt || 0);
			pumpLoads();
			applyModeClassesOnly();
			showPage(true);
			if (prefs.mode === 'vertical' && page === 0) scroll.scrollTop = 0;
		} catch (err) {
			clear(scroll);
			scroll.append(h('div', { class: 'reader-loading' }, `Couldn't load chapter: ${err.message}`));
		}
	}

	// applyMode() minus the recursive showPage
	function applyModeClassesOnly() {
		const vertical = prefs.mode === 'vertical';
		scroll.className = `reader-scroll ${vertical ? 'vertical' : `paged ${prefs.fit}`}`;
		scroll.style.setProperty('--strip-width', prefs.stripWidth + 'px');
		if (!vertical) scroll.append(zoneL, zoneR);
	}

	// ---------- keys ----------
	function onKey(e) {
		if (e.key === 'Escape') close();
		else if (e.key === 'ArrowRight' || e.key === 'd') turnPage(1);
		else if (e.key === 'ArrowLeft' || e.key === 'a') turnPage(-1);
	}
	window.addEventListener('keydown', onKey);

	function close() {
		saveProgress.flush();
		window.removeEventListener('keydown', onKey);
		clearTimeout(fadeTimer);
		readerEl.classList.add('hidden');
		clear(readerEl);
		cleanup = null;
		window.dispatchEvent(new CustomEvent('reader-closed'));
	}
	cleanup = close;

	applyMode();
	await loadChapter(chIndex, startPage);
}
