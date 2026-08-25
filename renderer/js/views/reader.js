import { h, clear, toast, debounce } from '../util.js';
import { styledSelect, openInviteDialog, confirmEndSession } from '../components.js';
import { icon } from '../icons.js';
import * as rt from '../readTogether.js';
import * as gate from '../../shared/rtGate.js';

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

// Page lists for chapters already asked about, so turning to the next one
// doesn't wait on a round trip out to MangaDex. Streamed page URLs are signed
// and go stale, so these are kept only as long as they're good for.
const PAGE_LIST_TTL_MS = 4 * 60_000;
const pageLists = new Map(); // chapter id -> { at, urls, online }

function rememberPages(chapterId, value) {
	pageLists.set(chapterId, { at: Date.now(), ...value });
	if (pageLists.size > 6) pageLists.delete(pageLists.keys().next().value);
}

function recallPages(chapterId) {
	const hit = pageLists.get(chapterId);
	if (!hit) return null;
	if (Date.now() - hit.at > PAGE_LIST_TTL_MS) { pageLists.delete(chapterId); return null; }
	return hit;
}

// Prefer downloaded pages (any group's copy of this chapter number); fall back
// to streaming from MangaDex.
async function fetchPages(mangaId, libEntry, ch) {
	const cached = recallPages(ch.id);
	if (cached) return cached;
	const local = libEntry?.chapters?.find((c) => c.id === ch.id)
		|| (ch.num != null && libEntry?.chapters?.find((c) => c.num === ch.num));
	let urls = local ? await window.api.getChapterPages(mangaId, local.id) : [];
	const online = !urls.length;
	if (online) urls = await window.api.getChapterImages(ch.id);
	const value = { urls, online };
	if (urls.length) rememberPages(ch.id, value);
	return value;
}

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
	const hereNow = () => gate.hereNow(rt.getSession(), manga.id, inSession());
	const allReady = () => gate.allReady(rt.getSession());
	const gateHolds = () => gate.gateHolds(rt.getSession(),
		{ mangaId: manga.id, index: chIndex, inSession: inSession() });

	// every hand-driven chapter change goes through here
	function tryChapterChange(run) {
		if (!gateHolds()) { run(); return; }
		toast(`Waiting for ${gate.waitingFor(rt.getSession())} to finish this chapter.`);
	}

	const pageOf = (p) => gate.whereTheyAre(p, { index: chIndex, chapters: chapterList });

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

	const onRtChange = () => {
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
		pumpLoads(); // keep page fetching prioritized around wherever the reader is
	}

	// ---------- staggered page loading ----------
	// Pages are appended without src and fetched a few at a time, nearest to the
	// current page first — opening a 180-page chapter shouldn't burst 180
	// simultaneous requests at the image server.
	const LOAD_CONCURRENCY = 6;
	const PAGE_RETRIES = 2;
	let loadGen = 0; // bumped per chapter so stale onload callbacks are ignored
	let inFlight = 0;
	let pageEls = []; // the current chapter's <img>, in order

	// Where a freshly opened chapter is meant to sit until it has settled; null
	// once the reader has taken over (see loadChapter).
	let holdTop = null;
	let holdFrames = 0;
	const releaseHold = () => { holdTop = null; };
	function holdScroll() {
		if (holdTop === null || holdFrames-- <= 0) return;
		if (Math.abs(scroll.scrollTop - holdTop) > 2) scroll.scrollTop = holdTop;
		requestAnimationFrame(holdScroll);
	}
	scroll.addEventListener('wheel', releaseHold, { passive: true });
	scroll.addEventListener('mousedown', releaseHold);

	function nextPending() {
		for (let i = page; i < pageEls.length; i++) if (pageEls[i].dataset.src) return i;
		for (let i = Math.min(page, pageEls.length - 1); i >= 0; i--) if (pageEls[i].dataset.src) return i;
		return -1;
	}

	// A page arriving is the one thing that moves the reader without the reader
	// asking: the placeholder was a guess, the image is the truth. When the page
	// that changed size sits above where we're looking, the scroll position
	// moves with it, so nothing appears to happen at all.
	function settle(el) {
		if (prefs.mode !== 'vertical') { el.classList.remove('r-pending'); return; }
		const before = el.offsetHeight;
		const top = el.offsetTop;
		el.classList.remove('r-pending');
		const delta = el.offsetHeight - before;
		if (delta && top + before <= scroll.scrollTop) {
			scroll.scrollTop += delta;
			if (holdTop !== null) holdTop += delta;
		}
	}

	function pumpLoads() {
		const gen = loadGen;
		while (inFlight < LOAD_CONCURRENCY) {
			const i = nextPending();
			if (i < 0) return;
			const el = pageEls[i];
			const src = el.dataset.src;
			delete el.dataset.src;
			inFlight++;
			let tries = 0;
			const done = () => {
				if (gen !== loadGen) return; // a different chapter owns the reader now
				inFlight--;
				pumpLoads();
			};
			el.addEventListener('load', () => { settle(el); done(); }, { once: true });
			// A page that doesn't arrive is worth asking for again — the image
			// servers refuse the odd request under load, and a browser left to
			// itself just draws a broken square and gives up.
			const onError = () => {
				if (gen !== loadGen) return;
				if (++tries <= PAGE_RETRIES) {
					setTimeout(() => {
						if (gen !== loadGen) return;
						el.removeAttribute('src');
						el.src = src;
					}, 400 * tries);
					return;
				}
				el.removeEventListener('error', onError);
				el.classList.remove('r-pending');
				el.classList.add('r-failed');
				// the alt text is what shows inside the box a broken image leaves
				el.alt = 'This page didn\'t load — click to try again';
				el.title = el.alt;
				el.addEventListener('click', () => {
					el.classList.remove('r-failed');
					el.classList.add('r-pending');
					el.alt = '';
					el.dataset.src = src;
					pumpLoads();
				}, { once: true });
				done();
			};
			el.addEventListener('error', onError);
			el.src = src;
		}
	}

	// ---------- page display ----------
	function showPage(scrollIntoView = false) {
		const els = pageEls;
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
		if (page + dir < 0) { tryChapterChange(() => loadChapter(chIndex - 1, 'last')); return; }
		if (page + dir >= pages.length) { tryChapterChange(() => loadChapter(chIndex + 1, 0)); return; }
		page += dir;
		showPage();
	}

	// Vertical mode: the page you're on is the one filling most of the window.
	// The middle pixel alone got it wrong either way round — the next page on a
	// short one, the previous on a tall one.
	function pageOnScreen() {
		const top = scroll.scrollTop;
		const bottom = top + scroll.clientHeight;
		let best = 0;
		let bestCover = -1;
		for (let i = 0; i < pageEls.length; i++) {
			const start = pageEls[i].offsetTop;
			const end = start + pageEls[i].offsetHeight;
			if (end <= top) continue;
			if (start >= bottom) break;
			const cover = Math.min(end, bottom) - Math.max(start, top);
			if (cover > bestCover) { bestCover = cover; best = i; }
		}
		return best;
	}

	let scrollRaf = null;
	scroll.addEventListener('scroll', () => {
		if (prefs.mode !== 'vertical' || scrollRaf || !pageEls.length) return;
		scrollRaf = requestAnimationFrame(() => {
			scrollRaf = null;
			const i = pageOnScreen();
			if (page !== i) { page = i; updateIndicator(); }
		});
	}, { passive: true });

	// ---------- chapter loading ----------
	async function loadChapter(newIndex, startAt) {
		if (newIndex < 0) { toast('This is the first chapter.'); return; }
		if (newIndex >= chapterList.length) { toast('No more chapters — you\'re all caught up!', 'success'); return; }
		chIndex = newIndex;
		loadGen++;
		const gen = loadGen;
		inFlight = 0;
		pageEls = [];
		holdTop = null;
		chapterSelect.set(chIndex);
		const ch = chapterList[chIndex];
		titleEl.textContent = `${manga.title} — ${ch.num ? `Ch. ${ch.num}` : (ch.title || 'Oneshot')}`;

		clear(scroll);
		scroll.append(h('div', { class: 'reader-loading' }, 'Loading pages…'));
		pages = [];
		updateIndicator();

		try {
			const { urls, online } = await fetchPages(manga.id, libEntry, ch);
			if (gen !== loadGen) return; // the reader has moved on since
			if (!urls.length) throw new Error('No pages found');
			pages = urls;

			clear(scroll);
			// Every page holds its space before a byte of it arrives, so the
			// chapter is its real length from the first frame — which is what
			// makes opening at the top, and the page count, mean anything.
			pageEls = urls.map((url) => h('img', {
				class: 'r-page r-pending', dataset: { src: url }, draggable: false, decoding: 'async'
			}));
			scroll.append(...pageEls);
			if (prefs.mode === 'vertical') {
				scroll.append(h('div', { class: 'chapter-end' },
					h('div', {}, `End of ${ch.num ? `chapter ${ch.num}` : 'chapter'}${online ? ' (streamed online)' : ''}`),
					chIndex + 1 < chapterList.length
						? h('button', { class: 'btn primary', onclick: () => tryChapterChange(() => loadChapter(chIndex + 1, 0)) }, 'Next chapter', icon('chevron-right', 14))
						: h('div', {}, 'No more chapters')
				));
			}

			page = startAt === 'last' ? pages.length - 1 : (startAt || 0);
			applyModeClassesOnly();
			// Where the chapter opens: the very top, unless we're picking one
			// back up where it was left. Held there for a few frames — filling a
			// scroller with a chapter's worth of new children is exactly when a
			// browser is most likely to restore the position it had a moment
			// ago, and the end of the chapter you just left is the one place
			// this must never open.
			if (prefs.mode === 'vertical') {
				holdTop = page > 0 ? pageEls[page].offsetTop : 0;
				scroll.scrollTop = holdTop;
				holdFrames = 8;
				requestAnimationFrame(holdScroll);
			}
			pumpLoads();
			showPage(prefs.mode !== 'vertical');
			renderRt();
			// landing in a new chapter changes whether we're done with the gate
			// one — the group shouldn't wait on the debounce to hear it
			if (inSession()) pushSync.flush();
			warmNextChapter();
		} catch (err) {
			if (gen !== loadGen) return;
			clear(scroll);
			scroll.append(h('div', { class: 'reader-loading' }, `Couldn't load chapter: ${err.message}`));
		}
	}

	// The next chapter, fetched while this one is being read: its page list so
	// turning to it costs no round trip, and its first pages so there's
	// something on screen the moment it opens.
	function warmNextChapter() {
		const next = chapterList[chIndex + 1];
		if (!next) return;
		const gen = loadGen;
		setTimeout(() => {
			if (gen !== loadGen) return; // already moved on; that chapter warms itself
			fetchPages(manga.id, libEntry, next).then(({ urls }) => {
				for (const url of urls.slice(0, 2)) {
					const pre = new Image();
					pre.src = url;
				}
			}).catch(() => { pageLists.delete(next.id); });
		}, 2500);
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
