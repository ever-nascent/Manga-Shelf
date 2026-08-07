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
		if (page + dir < 0) { tryChapterChange(() => loadChapter(chIndex - 1, 'last')); return; }
		if (page + dir >= pages.length) { tryChapterChange(() => loadChapter(chIndex + 1, 0)); return; }
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
