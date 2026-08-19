import { h, clear, toast, debounce } from '../util.js';
import { styledSelect, openInviteDialog, confirmEndSession } from '../components.js';
import { icon } from '../icons.js';
import * as rt from '../readTogether.js';

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
	let pages = [];    // page image URLs for the open chapter
	let pageEls = [];  // and their <img> elements, in order
	let currentEl = null;
	const libEntry = await window.api.getLibraryManga(manga.id);

	// The downloaded copy of a chapter, if there is one: the same chapter, or
	// failing that any group's copy of the same chapter number.
	const localCopy = (c) => libEntry?.chapters?.find((x) => x.id === c.id)
		|| (c.num != null ? libEntry?.chapters?.find((x) => x.num === c.num) : null)
		|| null;

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
		onChange: (i) => tryChapterChange(() => loadChapter(i, 0))
	});
	const modeBtn = h('button', { class: 'btn small' });
	const fitBtn = h('button', { class: 'btn small' });
	const narrowBtn = h('button', { class: 'btn small icon-only', title: 'Narrower' }, icon('minus', 14));
	const widenBtn = h('button', { class: 'btn small icon-only', title: 'Wider' }, icon('plus', 14));
	const pageInd = h('span', { class: 'page-ind' });
	const titleEl = h('div', { class: 'r-title' }, manga.title);
	const rtBtn = h('button', { class: 'btn small rt-btn' });
	const rtReadyBtn = h('button', { class: 'btn small rt-ready hidden' });
	const rtPanel = h('div', { class: 'rt-panel hidden' });

	const bar = h('header', { class: 'reader-bar' },
		h('button', { class: 'btn small', onclick: tryClose }, icon('chevron-left', 14), 'Close'),
		titleEl,
		chapterSelect.el,
		h('div', { class: 'r-spacer' }),
		rtReadyBtn, rtBtn, narrowBtn, widenBtn, fitBtn, modeBtn, pageInd
	);

	const scroll = h('div', { class: 'reader-scroll' });
	const zoneL = h('div', { class: 'edge-zone left', onclick: () => turnPage(-1) });
	const zoneR = h('div', { class: 'edge-zone right', onclick: () => turnPage(1) });
	readerEl.append(bar, scroll, rtPanel);

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

	// ---------- read together ----------
	// Everyone reads at their own pace; nobody's page drives anyone else's. What
	// the group shares is the *gate* — the chapter it's on. Reaching the end of
	// that chapter marks you ready, and once the last person is ready the gate
	// moves and everyone still sitting on the old chapter comes along.
	//
	// Under a hard gate this reader refuses to leave the gate chapter early; the
	// server never moves the gate on its own either, so the two agree.
	const pushSync = debounce(() => rt.sync(chIndex, page, pages.length), 300);

	const inSession = () => ['host', 'guest'].includes(rt.getRole());
	const hereNow = () => rt.getSession()?.manga.id === manga.id;
	const allReady = () => !(rt.getSession()?.waitingOn.length);

	// A hard gate holds everyone on the gate chapter until they're all done.
	// Being ahead of it already (from before the host switched modes) doesn't
	// count — that reader is past the gate and free to carry on.
	function gateHolds() {
		const s = rt.getSession();
		return Boolean(s) && s.gate === 'hard' && inSession() && hereNow()
			&& chIndex <= s.index && !allReady();
	}

	// every hand-driven chapter change goes through here
	function tryChapterChange(run) {
		if (!gateHolds()) { run(); return; }
		const waiting = rt.getSession().waitingOn;
		toast(`Waiting for ${waiting.join(' and ')} to finish this chapter.`);
	}

	function pageOf(p) {
		if (p.index !== chIndex) {
			const ch = chapterList[p.index];
			return ch?.num ? `Ch. ${ch.num}` : `Ch. ${p.index + 1}`;
		}
		return p.pages ? `p. ${p.page + 1}/${p.pages}` : '—';
	}

	function renderRt() {
		const s = rt.getSession();
		const role = rt.getRole();

		clear(rtBtn);
		rtBtn.classList.toggle('active', Boolean(role));
		if (inSession()) {
			rtBtn.append(icon('users', 14), `Together · ${s.participants.length}`);
			rtBtn.title = 'Who\'s reading';
		} else if (s) {
			// a session is running on another book — this reader isn't part of it
			rtBtn.append(icon('users', 14), 'Reading elsewhere');
			rtBtn.title = `A session is running on ${s.manga.title}`;
		} else {
			rtBtn.append(icon('users', 14), 'Read together');
			rtBtn.title = 'Invite someone to read this with you';
		}

		// quick ready toggle, so agreeing to move on doesn't need the panel open
		const mine = rt.me();
		const showReady = inSession() && hereNow() && mine;
		rtReadyBtn.classList.toggle('hidden', !showReady);
		if (showReady) {
			clear(rtReadyBtn);
			// element.append, not the h() helper — a null child would land as "null"
			if (mine.ready) rtReadyBtn.append(icon('check', 14));
			rtReadyBtn.append(mine.ready ? 'Ready' : 'Not ready');
			rtReadyBtn.classList.toggle('active', mine.ready);
			rtReadyBtn.title = allReady()
				? 'Everyone is ready'
				: `Waiting for ${s.waitingOn.join(' and ')}`;
		}
		renderPanel();
	}

	// ---------- the roster panel ----------
	function renderPanel() {
		const s = rt.getSession();
		if (rtPanel.classList.contains('hidden')) return;
		if (!s) { rtPanel.classList.add('hidden'); return; }
		const role = rt.getRole();
		clear(rtPanel);

		const gateCh = chapterList[s.index];
		rtPanel.append(h('div', { class: 'rt-panel-head' },
			h('div', { class: 'rt-panel-title' }, 'Reading together'),
			h('div', { class: 'rt-panel-sub' },
				`Group is on ${gateCh?.num ? `Ch. ${gateCh.num}` : `Ch. ${s.index + 1}`}`)
		));

		for (const p of s.participants) {
			const isMe = p.id === rt.getMyId();
			rtPanel.append(h('div', { class: `rt-row${p.ready ? ' ready' : ''}` },
				h('span', { class: 'rt-dot' }),
				h('span', { class: 'rt-name' }, p.name, isMe ? ' (you)' : '', p.host ? ' · host' : ''),
				h('span', { class: 'rt-where' }, pageOf(p)),
				isMe
					? h('button', { class: 'btn small icon-only', title: 'Change your name', onclick: promptRename }, icon('pencil', 13))
					: h('button', {
						class: 'btn small icon-only', title: `Remove ${p.name}`,
						onclick: () => rt.kick(p.id).catch((e) => toast(e.message, 'error'))
					}, icon('x', 13))
			));
		}

		if (role === 'host') {
			rtPanel.append(h('button', {
				class: 'btn small wide',
				onclick: () => openInviteDialog()
			}, icon('plus', 13), 'Invite someone'));
		}

		if (role === 'host') {
			const hard = s.gate === 'hard';
			rtPanel.append(h('label', { class: 'rt-gate' },
				h('input', {
					type: 'checkbox',
					checked: hard,
					onchange: (e) => rt.setGate(e.target.checked ? 'hard' : 'soft').catch((err) => toast(err.message, 'error'))
				}),
				h('span', {}, 'Wait for everyone'),
				h('span', { class: 'rt-gate-hint' }, hard
					? 'Nobody can move on until all are ready'
					: 'Anyone may read ahead on their own')
			));
		}

		rtPanel.append(h('button', {
			class: 'btn small wide',
			onclick: async () => {
				if (!(await confirmEnd())) return;
				try {
					await rt.leave();
					toast('Read together ended.');
				} catch (err) { toast(err.message, 'error'); }
				rtPanel.classList.add('hidden');
			}
		}, 'End session'));
	}

	async function promptRename() {
		const current = rt.me()?.name || '';
		const next = window.prompt('Show up as:', current);
		if (next === null || next.trim() === current) return;
		try { await rt.rename(next.trim()); } catch (err) { toast(err.message, 'error'); }
	}

	rtReadyBtn.addEventListener('click', () => {
		const mine = rt.me();
		if (mine) rt.setReady(!mine.ready).catch((err) => toast(err.message, 'error'));
	});

	// Nobody is cut off without being told first — closing the book ends the
	// session for everyone in it.
	async function confirmEnd() {
		const others = (rt.getSession()?.participants || []).filter((p) => p.id !== rt.getMyId());
		if (rt.getRole() !== 'host' || !others.length) return true;
		return await confirmEndSession(others.map((p) => p.name)) === 'end';
	}

	rtBtn.addEventListener('click', async () => {
		if (inSession()) {
			rtPanel.classList.toggle('hidden');
			renderPanel();
			return;
		}
		if (rt.getSession()) {
			toast('A session is already running on another book.');
			return;
		}
		try {
			// Waiting for each other is the point of reading together, so that's
			// how a session starts. The host can loosen it from the panel.
			await rt.start(manga, chapterList, chIndex, 'hard');
			toast('Reading together — invite someone from the panel.', 'success');
			rtPanel.classList.remove('hidden');
		} catch (err) {
			toast(err.message, 'error');
		}
		renderRt();
	});

	// The gate moved: anyone still on the old chapter comes along. Readers who
	// are already past it (soft gate) stay where they are.
	//
	// Only when it actually moves. Every page turn, rename and arrival fires a
	// change too, and reloading the chapter on those would throw away the pages
	// already fetched for no reason.
	let seenGate = rt.getSession()?.index ?? null;

	function followGate({ force = false } = {}) {
		const s = rt.getSession();
		if (!s || !inSession() || !hereNow()) return;
		const moved = s.index !== seenGate;
		seenGate = s.index;
		if (!moved && !force) return;
		if (chIndex < s.index) loadChapter(s.index, 0);
	}

	const onRtChange = (e) => {
		if (e.detail.declined) toast('The host didn\'t let you in.', 'error');
		renderRt();
		followGate();
	};
	window.addEventListener('rt-change', onRtChange);

	function updateIndicator() {
		pageInd.textContent = pages.length ? `${page + 1} / ${pages.length}` : '';
		saveProgress();
		// tell the group where we got to — reaching the last page is what marks
		// this reader ready, so the gate depends on this going out
		if (pages.length && inSession()) pushSync();
		requestPump();  // keep page fetching prioritized around wherever the reader is
		prefetchNext(); // and have the next chapter ready before it's asked for
	}

	// ---------- staggered page loading ----------
	// Pages are appended without src and fetched a few at a time, nearest to the
	// current page first — opening a 180-page chapter shouldn't burst 180
	// simultaneous requests at the image server.
	//
	// Only a window around the reader is fetched, never the whole chapter: it
	// used to keep going regardless, so opening a long chapter and turning back
	// after two pages still pulled every remaining page — hundreds of megabytes
	// nobody looked at. A downloaded chapter is already on disk, so its window is
	// much wider; there's no bandwidth to save there, only decoding work.
	const AHEAD_ONLINE = 12;
	const AHEAD_LOCAL = 40;
	const BEHIND = 3;
	let ahead = AHEAD_ONLINE;
	let concurrency = 4;
	let loadGen = 0; // bumped per chapter so stale onload callbacks are ignored
	let inFlight = 0;
	let travel = 1;  // +1 reading forwards, -1 backwards; the window leans this way
	const loading = new Map(); // index -> { el, settle } for the requests in flight

	// How far ahead of the reader a page is *in the direction they're moving*, so
	// the same arithmetic works scrolling either way.
	function lead(i) {
		return (i - Math.min(page, pageEls.length - 1)) * travel;
	}

	// Bounded by the window, so this costs the same on page 3 of a oneshot as on
	// page 300 of a webtoon — it never walks the whole chapter. The deep half
	// points the way the reader is going: someone scrolling back up a chapter
	// needs the read-ahead behind them, and used to get three pages of it
	// against twelve going the other way.
	function nextPending() {
		if (!pageEls.length) return -1;
		// page is only clamped to the chapter once showPage runs, and this is
		// called before that on every chapter change
		const from = Math.min(page, pageEls.length - 1);
		const last = pageEls.length - 1;
		for (let d = 0; d <= ahead; d++) {
			const i = from + d * travel;
			if (i >= 0 && i <= last && pageEls[i].dataset.src) return i;
		}
		for (let d = 1; d <= BEHIND; d++) {
			const i = from - d * travel;
			if (i >= 0 && i <= last && pageEls[i].dataset.src) return i;
		}
		return -1;
	}

	// A jump — a flick, a scrollbar drag, the chapter dropdown — leaves requests
	// in flight for pages the reader has already left. Nothing used to cancel
	// them, so they held every slot and the page now on screen queued behind
	// megabytes nobody was going to look at: on a slow connection that doubled
	// the wait after every jump. Let them go and refill from where the reader is.
	function dropStrayLoads() {
		for (const [i, rec] of loading) {
			const d = lead(i);
			if (d >= -BEHIND && d <= ahead) continue;
			loading.delete(i);
			inFlight--;
			rec.el.removeEventListener('load', rec.settle);
			rec.el.removeEventListener('error', rec.settle);
			rec.el.dataset.src = pages[i];  // back onto the pending list
			rec.el.removeAttribute('src');  // and drop the request itself
			rec.el.classList.add('r-pending');
		}
	}

	function pumpLoads() {
		dropStrayLoads();
		const gen = loadGen;
		while (inFlight < concurrency) {
			const i = nextPending();
			if (i < 0) return;
			const el = pageEls[i];
			inFlight++;
			const settle = () => {
				el.classList.remove('r-pending');
				// a stale chapter, or a load we already gave up on
				if (gen !== loadGen || loading.get(i)?.el !== el) return;
				loading.delete(i);
				inFlight--;
				pumpLoads();
			};
			loading.set(i, { el, settle });
			el.addEventListener('load', settle, { once: true });
			el.addEventListener('error', settle, { once: true });
			// the page being read, and the one after it, are what the reader is
			// actually waiting on; the rest of the window can queue behind them
			const d = lead(i);
			el.fetchPriority = d >= 0 && d <= 1 ? 'high' : 'low';
			el.src = el.dataset.src;
			delete el.dataset.src;
		}
	}

	// A flick crosses pages faster than any one of them could load. Refilling the
	// window at each page it passes would start a request and abandon it a moment
	// later, so while the reader is still moving that fast we let the stale loads
	// go and leave the slots empty until they settle. Anything that finishes a
	// load pumps directly — only reader movement comes through here.
	const SETTLE_MS = 140;
	let lastMove = -Infinity;
	let pumpTimer = null;

	function requestPump() {
		const now = performance.now();
		const flicking = now - lastMove < SETTLE_MS;
		lastMove = now;
		clearTimeout(pumpTimer);
		if (!flicking) { pumpLoads(); return; }
		dropStrayLoads();
		pumpTimer = setTimeout(pumpLoads, SETTLE_MS);
	}

	// ---------- next-chapter prefetch ----------
	// Turning the last page meant waiting on a fresh page-list round trip and
	// then a cold image fetch, with nothing on screen but "Loading pages…".
	// Warming both while the reader is still on the closing pages makes the next
	// chapter open on an image instead. It costs one request per chapter, well
	// inside MangaDex's 40/min budget for that endpoint, and the URLs it hands
	// back stay valid for 15 minutes — far longer than three pages take to read.
	let prefetchedFor = -1;

	function prefetchNext() {
		const next = chapterList[chIndex + 1];
		if (!next || next.external || prefetchedFor === chIndex) return;
		if (!pages.length || page < pages.length - 3) return; // not near the end yet
		prefetchedFor = chIndex;
		(async () => {
			const local = localCopy(next);
			const urls = local
				? await window.api.getChapterPages(manga.id, local.id)
				: await window.api.getChapterImages(next.id);
			// the opening pages only — enough to paint the moment the reader
			// arrives, not a second chapter's worth of traffic on spec
			for (const url of urls.slice(0, 2)) {
				const warm = new Image();
				warm.fetchPriority = 'low';
				warm.src = url;
			}
		})().catch(() => { /* a cold next chapter just loads the slow way */ });
	}

	// ---------- page display ----------
	// The page elements are kept in pageEls rather than re-queried. showPage, the
	// loader and the scroll tracker all run inside the reading loop, and a
	// querySelectorAll over a few hundred pages on each of them was pure
	// overhead.
	function showPage(scrollIntoView = false) {
		if (!pageEls.length) return;
		page = Math.max(0, Math.min(page, pageEls.length - 1));
		if (prefs.mode === 'paged') {
			// move the class between the two pages that change, rather than
			// touching every page in the chapter on every turn
			currentEl?.classList.remove('current');
			currentEl = pageEls[page];
			currentEl.classList.add('current');
		} else if (scrollIntoView) {
			pageEls[page]?.scrollIntoView();
		}
		updateIndicator();
	}

	function turnPage(dir) {
		if (prefs.mode !== 'paged') return;
		if (page + dir < 0) { tryChapterChange(() => loadChapter(chIndex - 1, 'last')); return; }
		if (page + dir >= pages.length) { tryChapterChange(() => loadChapter(chIndex + 1, 0)); return; }
		travel = dir;
		page += dir;
		showPage();
	}

	// Vertical mode: whichever page crosses the middle of the viewport is the one
	// being read. Collapsing the observer's root to that middle line reports it
	// directly, and only when it changes. The scroll handler this replaces read
	// offsetTop and offsetHeight of every page on every frame — each read forces
	// a layout, and the cost grew with the length of the chapter, right when
	// images landing were invalidating that layout anyway.
	const midObserver = new IntersectionObserver((entries) => {
		if (prefs.mode !== 'vertical') return;
		// a fast scroll delivers several crossings at once; the last is where
		// the reader actually ended up
		const landed = entries.filter((e) => e.isIntersecting).pop();
		if (!landed) return;
		const i = pageEls.indexOf(landed.target);
		if (i < 0 || i === page) return;
		travel = i > page ? 1 : -1;
		page = i;
		updateIndicator();
	}, { root: scroll, rootMargin: '-50% 0px -50% 0px', threshold: 0 });

	// ---------- chapter loading ----------
	async function loadChapter(newIndex, startAt) {
		if (newIndex < 0) { toast('This is the first chapter.'); return; }
		if (newIndex >= chapterList.length) { toast('No more chapters — you\'re all caught up!', 'success'); return; }
		chIndex = newIndex;
		loadGen++;
		inFlight = 0;
		loading.clear();
		clearTimeout(pumpTimer);
		lastMove = -Infinity;
		// turning back from the next chapter lands on this one's last page, and
		// from there the reader is heading for its first
		travel = startAt === 'last' ? -1 : 1;
		chapterSelect.set(chIndex);
		const ch = chapterList[chIndex];
		titleEl.textContent = `${manga.title} — ${ch.num ? `Ch. ${ch.num}` : (ch.title || 'Oneshot')}`;

		clear(scroll);
		scroll.append(h('div', { class: 'reader-loading' }, 'Loading pages…'));
		midObserver.disconnect();
		pages = [];
		pageEls = [];
		currentEl = null;
		updateIndicator();

		try {
			// prefer downloaded pages (any group's copy of this chapter number);
			// fall back to streaming from MangaDex
			const local = localCopy(ch);
			let urls = local ? await window.api.getChapterPages(manga.id, local.id) : [];
			const online = !urls.length;
			if (online) urls = await window.api.getChapterImages(ch.id);
			if (!urls.length) throw new Error('No pages found');
			pages = urls;
			ahead = online ? AHEAD_ONLINE : AHEAD_LOCAL;
			concurrency = online ? 4 : 8; // a local page costs a disk read, not a request

			clear(scroll);
			pageEls = urls.map((url) => h('img', {
				class: 'r-page r-pending',
				dataset: { src: url },
				// a manga page is several megapixels; decoding one on the main
				// thread is what makes a fast scroll stutter
				decoding: 'async',
				draggable: false
			}));
			scroll.append(...pageEls);
			for (const el of pageEls) midObserver.observe(el);
			if (prefs.mode === 'vertical') {
				scroll.append(h('div', { class: 'chapter-end' },
					h('div', {}, `End of ${ch.num ? `chapter ${ch.num}` : 'chapter'}${online ? ' (streamed online)' : ''}`),
					chIndex + 1 < chapterList.length
						? h('button', { class: 'btn primary', onclick: () => tryChapterChange(() => loadChapter(chIndex + 1, 0)) }, 'Next chapter', icon('chevron-right', 14))
						: h('div', {}, 'No more chapters')
				));
			}

			page = startAt === 'last' ? pages.length - 1 : (startAt || 0);
			pumpLoads();
			applyModeClassesOnly();
			showPage(true);
			if (prefs.mode === 'vertical' && page === 0) scroll.scrollTop = 0;
			renderRt();
			// landing in a new chapter changes whether we're done with the gate
			// one — the group shouldn't wait on the debounce to hear it
			if (inSession()) pushSync.flush();
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
		if (e.key === 'Escape') tryClose();
		else if (e.key === 'ArrowRight' || e.key === 'd') turnPage(1);
		else if (e.key === 'ArrowLeft' || e.key === 'a') turnPage(-1);
	}
	window.addEventListener('keydown', onKey);

	// Every way out of the book goes through here, so nobody reading with us
	// gets dropped without us being asked first.
	async function tryClose() {
		if (await confirmEnd()) close();
	}

	function close() {
		saveProgress.flush();
		pushSync.flush();
		midObserver.disconnect();
		clearTimeout(pumpTimer);
		// closing the book ends the session for everyone in it
		if (rt.getRole()) rt.leave().catch(() => {});
		window.removeEventListener('rt-change', onRtChange);
		window.removeEventListener('keydown', onKey);
		clearTimeout(fadeTimer);
		readerEl.classList.add('hidden');
		clear(readerEl);
		cleanup = null;
		window.dispatchEvent(new CustomEvent('reader-closed'));
	}
	cleanup = close;

	renderRt();
	applyMode();
	await loadChapter(chIndex, startPage);
	// confirms who we are in any running session, which is what tells the
	// controls above apart from a guest and a bystander
	rt.refresh().catch(() => {});
}
