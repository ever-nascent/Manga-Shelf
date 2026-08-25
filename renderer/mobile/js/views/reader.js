// Vertical-scroll reader. Downloaded chapters stream from the PC's library;
// anything else streams from the source through the PC. Progress saves back
// to the PC so the desktop app resumes exactly where the phone left off.

import { h, clear, spinner, errorBox, chapterName, debounce, toast } from '../util.js';
import { rpc, img } from '../api.js';
import { icon } from '../icons.js';
import * as rt from '../readTogether.js';

// Auto-scroll speeds in px/second; remembered across chapters within a session.
const AUTO_SPEEDS = [30, 55, 90, 140, 210, 300];
let autoSpeedIdx = 2;

// How many pages are fetched at once, and how many times a page that doesn't
// arrive is asked for again. Pages are pulled nearest-first rather than all at
// once: a twenty-page burst is what makes the image servers start refusing, and
// a refused page is a broken square on the phone.
const LOAD_CONCURRENCY = 5;
const PAGE_RETRIES = 2;

// Page lists for chapters we've already asked about, so turning to the next one
// doesn't wait on a round trip to the PC and out to MangaDex. Kept just long
// enough to be useful — streamed page URLs are signed and go stale.
const PAGE_LIST_TTL_MS = 4 * 60_000;
const pageLists = new Map(); // chapter id -> { at, urls }

function rememberPages(chapterId, urls) {
	pageLists.set(chapterId, { at: Date.now(), urls });
	if (pageLists.size > 6) pageLists.delete(pageLists.keys().next().value);
}

function recallPages(chapterId) {
	const hit = pageLists.get(chapterId);
	if (!hit) return null;
	if (Date.now() - hit.at > PAGE_LIST_TTL_MS) { pageLists.delete(chapterId); return null; }
	return hit.urls;
}

// Downloaded pages come off the PC's disk; everything else streams through it.
async function fetchPages(mangaId, chapterId) {
	const cached = recallPages(chapterId);
	if (cached) return cached;
	let urls = await rpc('lib:pages', mangaId, chapterId).catch(() => []);
	if (!urls.length) urls = await rpc('md:chapterImages', chapterId);
	if (urls.length) rememberPages(chapterId, urls);
	return urls;
}

export async function render(root, { manga, chapters, index, page = 0, autoScroll = false }, ctx, signal) {
	const ch = chapters[index];
	let current = 0;

	// Where this chapter is meant to sit until it has settled, and the way to
	// stop insisting on it (see "where this chapter opens" below).
	let holdTop = null;
	const releaseHold = () => { holdTop = null; };

	const pageInd = h('div', { class: 'r-ind' }, '');
	const rtBtn = h('button', { class: 'icon-btn r-rt', 'aria-label': 'Read together' }, icon('users', 21));
	const rtChip = h('button', { class: 'r-ready hidden' }, '');
	const rtPanel = h('div', { class: 'rt-panel hidden' });

	// auto-scroller: play/pause plus a slower/faster stepper, all in the top bar
	const autoBtn = h('button', { class: 'icon-btn', 'aria-label': 'Auto-scroll' }, icon('play', 22));
	const speedLabel = h('span', { class: 'r-speed' }, `${autoSpeedIdx + 1}×`);
	const slowBtn = h('button', { class: 'icon-btn small', 'aria-label': 'Slower' }, icon('minus', 20));
	const fastBtn = h('button', { class: 'icon-btn small', 'aria-label': 'Faster' }, icon('plus', 20));

	const bar = h('div', { class: 'r-bar' },
		// a guest has no series page to go back to — the book is all they have
		rt.getRole() === 'guest'
			? h('span', { class: 'r-guest-badge' }, icon('users', 18))
			: h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: ctx.back }, icon('back', 22)),
		h('div', { class: 'r-titles' },
			h('div', { class: 'r-manga' }, manga.title),
			h('div', { class: 'r-ch' }, chapterName(ch))
		),
		rtBtn,
		h('div', { class: 'r-auto' }, slowBtn, speedLabel, autoBtn, fastBtn)
	);
	const pagesEl = h('div', { class: 'r-pages' }, spinner());
	root.append(bar, pagesEl, pageInd, rtChip, rtPanel);

	// ----- auto-scroll engine -----
	let scrolling = false;
	let rafId = null;
	let lastT = 0;
	let carry = 0; // sub-pixel remainder so slow speeds don't stall on integer scrollTop
	// what to do when auto-scroll reaches the bottom: stop, or roll into the next
	// chapter (set once we know there is one). Defaults to stop.
	let onReachEnd;
	const tick = (t) => {
		if (!scrolling) return;
		if (!lastT) lastT = t;
		carry += AUTO_SPEEDS[autoSpeedIdx] * (t - lastT) / 1000;
		lastT = t;
		const step = Math.floor(carry);
		if (step) { carry -= step; root.scrollTop += step; }
		if (root.scrollTop + root.clientHeight >= root.scrollHeight - 2) { onReachEnd(); return; }
		rafId = requestAnimationFrame(tick);
	};
	const startAuto = () => {
		if (scrolling) return;
		releaseHold(); // the scroller is the auto-scroller's now
		// already at the bottom? nothing to scroll
		if (root.scrollTop + root.clientHeight >= root.scrollHeight - 2) return;
		scrolling = true;
		lastT = 0;
		carry = 0;
		clear(autoBtn);
		autoBtn.append(icon('pause', 22));
		autoBtn.classList.add('active');
		rafId = requestAnimationFrame(tick);
	};
	function stopAuto() {
		if (!scrolling) return;
		scrolling = false;
		if (rafId) cancelAnimationFrame(rafId);
		rafId = null;
		clear(autoBtn);
		autoBtn.append(icon('play', 22));
		autoBtn.classList.remove('active');
	}
	onReachEnd = stopAuto; // no next chapter known yet
	const setSpeed = (idx) => {
		autoSpeedIdx = Math.max(0, Math.min(AUTO_SPEEDS.length - 1, idx));
		speedLabel.textContent = `${autoSpeedIdx + 1}×`;
	};
	autoBtn.addEventListener('click', () => (scrolling ? stopAuto() : startAuto()));
	slowBtn.addEventListener('click', () => setSpeed(autoSpeedIdx - 1));
	fastBtn.addEventListener('click', () => setSpeed(autoSpeedIdx + 1));
	signal.addEventListener('abort', stopAuto, { once: true });

	// advance/rewind by roughly one screen, with a little overlap
	const pageStep = (dir) => root.scrollBy({ top: (root.clientHeight - 64) * dir, behavior: 'smooth' });

	// tap zones: top = previous page, middle = toggle bar, bottom = next page
	pagesEl.addEventListener('click', (e) => {
		if (e.target.closest('button')) return;
		const rect = root.getBoundingClientRect();
		const frac = (e.clientY - rect.top) / rect.height;
		if (frac < 0.28) pageStep(-1);
		else if (frac > 0.72) pageStep(1);
		else bar.classList.toggle('r-hidden');
	});

	// a real finger drag pauses the auto-scroller (a tap, which fires no
	// touchmove, does not) so the reader never fights the reader
	root.addEventListener('touchmove', () => stopAuto(), { signal, passive: true });

	const snap = {
		id: manga.id,
		title: manga.title,
		coverUrl: manga.coverUrl?.startsWith('http') ? manga.coverUrl : null
	};
	const saveProgress = debounce(() => {
		// a guest is reading someone else's book; their place is not the owner's
		if (rt.getRole() === 'guest') return;
		rpc('reading:set', snap, { chapterId: ch.id, chapterNum: ch.num, page: current }).catch(() => {});
	}, 800);
	signal.addEventListener('abort', () => saveProgress.flush(), { once: true });

	// ----- read together -----
	// Everyone reads at their own pace; nobody's page drives anyone else's. What
	// the group shares is the *gate* — the chapter it's on. Reaching the end of
	// that chapter marks you ready, and once the last person is ready the gate
	// moves and everyone still on the old chapter comes along.
	//
	// Leaving the session happens in the router — turning to the next chapter
	// re-renders this view, and that mustn't read as walking out.
	let imgs = [];

	const pushSync = debounce(() => rt.sync(index, current, imgs.length), 300);

	// On a phone there is only ever one role worth having: a guest someone
	// invited. Your own linked phone isn't a session participant — the PC holds
	// the host seat — so for it none of this shows at all.
	const inSession = () => rt.getRole() === 'guest';
	const hereNow = () => rt.getSession()?.manga.id === manga.id;
	const allReady = () => !(rt.getSession()?.waitingOn.length);

	// A hard gate holds everyone on the gate chapter until they're all done.
	// Being past it already doesn't count — that reader is through.
	function gateHolds() {
		const s = rt.getSession();
		return Boolean(s) && s.gate === 'hard' && inSession() && hereNow()
			&& index <= s.index && !allReady();
	}

	function tryChapterChange(run) {
		if (!gateHolds()) { run(); return; }
		toast(`Waiting for ${rt.getSession().waitingOn.join(' and ')} to finish this chapter.`);
	}

	function pageOf(p) {
		if (p.index !== index) {
			const c = chapters[p.index];
			return c?.num ? `Ch. ${c.num}` : `Ch. ${p.index + 1}`;
		}
		return p.pages ? `p. ${p.page + 1}/${p.pages}` : '—';
	}

	function renderRt() {
		const s = rt.getSession();

		// nothing read-together to show unless we were invited to one
		rtBtn.classList.toggle('hidden', !inSession());
		rtBtn.classList.toggle('active', inSession());
		rtBtn.setAttribute('aria-label', 'Who\'s reading');

		const mine = rt.me();
		const show = inSession() && hereNow() && mine;
		rtChip.classList.toggle('hidden', !show);
		if (show) {
			rtChip.textContent = mine.ready
				? (allReady() ? 'Everyone ready' : `Ready · waiting for ${s.waitingOn.length}`)
				: 'Not ready';
			rtChip.classList.toggle('active', mine.ready);
		}
		renderPanel();
	}

	function renderPanel() {
		const s = rt.getSession();
		if (rtPanel.classList.contains('hidden')) return;
		if (!s) { rtPanel.classList.add('hidden'); return; }
		clear(rtPanel);

		const gateCh = chapters[s.index];
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
				isMe ? h('button', { class: 'btn small', onclick: promptRename }, 'Rename') : null
			));
		}

		// the gate is the host's to set, so it's shown here as a fact, not a control
		rtPanel.append(h('div', { class: 'rt-gate-note' }, s.gate === 'hard'
			? 'Everyone has to finish a chapter before the group moves on.'
			: 'You can read ahead at your own pace.'));

		rtPanel.append(h('button', {
			class: 'btn wide',
			onclick: async () => {
				try {
					await rt.leave();
					toast('You left the session.');
				} catch (err) { toast(err.message, 'error'); }
				rtPanel.classList.add('hidden');
			}
		}, 'Leave session'));
	}

	async function promptRename() {
		const current = rt.me()?.name || '';
		const next = window.prompt('Show up as:', current);
		if (next === null || next.trim() === current) return;
		try { await rt.rename(next.trim()); } catch (err) { toast(err.message, 'error'); }
	}

	rtChip.addEventListener('click', () => {
		const mine = rt.me();
		if (mine) rt.setReady(!mine.ready).catch((err) => toast(err.message, 'error'));
	});

	rtBtn.addEventListener('click', () => {
		rtPanel.classList.toggle('hidden');
		renderPanel();
	});

	// The gate moved: anyone still on the old chapter comes along.
	//
	// Only when it actually moves. Every page turn, rename and arrival fires a
	// change too, and navigating on those would tear this view down and refetch
	// every page — someone renaming themselves must not restart your chapter.
	let seenGate = rt.getSession()?.index ?? null;

	function followGate({ force = false } = {}) {
		const s = rt.getSession();
		if (!s || !inSession() || !hereNow()) return;
		const moved = s.index !== seenGate;
		seenGate = s.index;
		if (!moved && !force) return;
		if (index < s.index) ctx.navigate('reader', { manga, chapters, index: s.index }, { replace: true });
	}

	window.addEventListener('rt-change', () => { renderRt(); followGate(); }, { signal });
	renderRt();

	let pages = [];
	try {
		pages = await fetchPages(manga.id, ch.id);
		if (!pages.length) throw new Error('No pages found');
	} catch (err) {
		if (signal.aborted) return;
		clear(pagesEl);
		pagesEl.append(errorBox(`Couldn't load pages: ${err.message}`, () => {
			ctx.navigate('reader', { manga, chapters, index, page }, { replace: true });
		}));
		return;
	}
	if (signal.aborted) return;

	// ----- page slots -----
	// Every page gets its full-size box before a single byte of it arrives, so
	// the chapter is its real length from the first frame. Without that the
	// whole chapter is a few hundred pixels tall while it loads, and where you
	// are in it means nothing: opening at the top and reading the page number
	// off the screen both depend on the boxes being right.
	clear(pagesEl);
	const slots = pages.map(() => h('div', { class: 'r-slot' }));
	imgs = pages.map((p, i) => {
		const el = h('img', {
			class: 'r-page',
			alt: `Page ${i + 1}`,
			decoding: 'async',
			draggable: false
		});
		el.dataset.src = p.startsWith('http') ? img(p) : p;
		slots[i].append(el);
		return el;
	});
	pagesEl.append(...slots);

	// A page arriving is the one thing that can move the reader without the
	// reader asking: the box was a guess, the image is the truth. Correcting a
	// page *above* where we're looking would shove the view along with it, so
	// the scroll position is moved by the same amount and nothing appears to
	// happen at all.
	function settle(i) {
		const slot = slots[i];
		const el = imgs[i];
		const before = slot.offsetHeight;
		const top = slot.offsetTop;
		slot.classList.add('r-loaded');
		// the box takes the page's own shape, so the strip is exactly as long
		// as the pages in it
		if (el.naturalWidth && el.naturalHeight) {
			slot.style.aspectRatio = `${el.naturalWidth} / ${el.naturalHeight}`;
		}
		const delta = slot.offsetHeight - before;
		if (delta && top + before <= root.scrollTop) {
			root.scrollTop += delta;
			if (holdTop !== null) holdTop += delta;
		}
		schedulePaint();
	}

	// ----- staggered loading -----
	// Pages are fetched a few at a time, nearest to wherever the reader is
	// first, so the page in front of them is never queued behind twenty others.
	let inFlight = 0;
	let stopped = false;
	signal.addEventListener('abort', () => { stopped = true; }, { once: true });

	function nextPending() {
		for (let i = current; i < imgs.length; i++) if (imgs[i].dataset.src) return i;
		for (let i = Math.min(current, imgs.length - 1); i >= 0; i--) if (imgs[i].dataset.src) return i;
		return -1;
	}

	function pumpLoads() {
		while (!stopped && inFlight < LOAD_CONCURRENCY) {
			const i = nextPending();
			if (i < 0) return;
			const el = imgs[i];
			const src = el.dataset.src;
			delete el.dataset.src;
			inFlight++;
			let tries = 0;
			const done = () => { inFlight--; pumpLoads(); };
			el.addEventListener('load', () => { settle(i); done(); }, { once: true });
			// A page that doesn't arrive is worth asking for again — the PC may
			// have been busy, and a phone browser left to itself just draws a
			// broken square and gives up. Only after that does the slot say so,
			// with a tap to try once more.
			const onError = () => {
				if (stopped) { done(); return; }
				if (++tries <= PAGE_RETRIES) {
					setTimeout(() => { if (!stopped) el.src = `${src}${src.includes('?') ? '&' : '?'}r=${tries}`; }, 400 * tries);
					return;
				}
				el.removeEventListener('error', onError);
				slots[i].classList.add('r-failed');
				slots[i].addEventListener('click', (e) => {
					e.stopPropagation();
					slots[i].classList.remove('r-failed');
					slots[i].style.aspectRatio = '';
					el.dataset.src = src;
					pumpLoads();
				}, { once: true });
				done();
			};
			el.addEventListener('error', onError);
			el.src = src;
		}
	}

	// end-of-chapter controls
	const next = chapters[index + 1];
	const openNext = (auto) => tryChapterChange(() =>
		ctx.navigate('reader', { manga, chapters, index: index + 1, autoScroll: auto }, { replace: true }));
	pagesEl.append(h('div', { class: 'r-end' },
		h('div', { class: 'r-end-label' }, `End of ${chapterName(ch)}`),
		next && h('button', {
			class: 'btn primary wide',
			onclick: () => openNext(false)
		}, `Next: ${chapterName(next)}`),
		h('button', { class: 'btn wide', onclick: ctx.back }, 'Back to series')
	));

	// auto-scroll rolls straight into the next chapter and keeps going; the last
	// chapter just stops at the end
	if (next) onReachEnd = () => { stopAuto(); openNext(true); };

	// ----- where this chapter opens -----
	// At the very top, unless we're picking a chapter back up where it was left.
	current = Math.max(0, Math.min(page, imgs.length - 1));
	holdTop = current > 0 ? slots[current].offsetTop : 0;
	root.scrollTop = holdTop;

	// Held there for a few frames. Handing a scroller a screenful of new
	// children is exactly when a phone browser is most likely to restore or
	// clamp the position it had a moment ago, and landing at the end of the
	// chapter you just left is the one place this must never open. It lets go
	// the instant the reader touches the screen, so it can't fight them.
	root.addEventListener('touchstart', releaseHold, { signal, passive: true, once: true });
	root.addEventListener('wheel', releaseHold, { signal, passive: true, once: true });
	let holds = 8;
	const hold = () => {
		if (holdTop === null || stopped || holds-- <= 0) return;
		if (Math.abs(root.scrollTop - holdTop) > 2) root.scrollTop = holdTop;
		requestAnimationFrame(hold);
	};
	requestAnimationFrame(hold);

	// Which page you're on is the one filling most of the screen — the middle
	// pixel alone got it wrong either way round, calling it the next page on a
	// short page and the previous one on a tall one.
	const pageOnScreen = () => {
		const top = root.scrollTop;
		const bottom = top + root.clientHeight;
		let best = 0;
		let bestCover = -1;
		for (let i = 0; i < slots.length; i++) {
			const start = slots[i].offsetTop;
			const end = start + slots[i].offsetHeight;
			if (end <= top) continue;
			if (start >= bottom) break;
			const cover = Math.min(end, bottom) - Math.max(start, top);
			if (cover > bestCover) { bestCover = cover; best = i; }
		}
		return best;
	};

	const update = () => {
		const idx = pageOnScreen();
		if (idx !== current) {
			current = idx;
			saveProgress();
			// reaching the last page is what marks this reader ready, so the
			// gate depends on this going out
			if (inSession()) pushSync();
			pumpLoads(); // fetch around wherever the reader has got to
		}
		pageInd.textContent = `${current + 1} / ${imgs.length}`;
	};

	// One update per frame at most, and always one after the frame that
	// prompted it — a trailing timer let the number lag a scroll by a tick.
	let painting = false;
	function schedulePaint() {
		if (painting) return;
		painting = true;
		requestAnimationFrame(() => { painting = false; update(); });
	}
	root.addEventListener('scroll', schedulePaint, { signal, passive: true });

	pageInd.textContent = `${current + 1} / ${imgs.length}`;
	pumpLoads();
	saveProgress(); // opening a chapter marks it as being read
	// tell the group where this chapter left us — landing on a new one changes
	// whether we're done with the gate chapter
	rt.sync(index, current, imgs.length);
	renderRt();
	// and if the gate moved while this chapter was loading, catch up now
	followGate({ force: true });

	// The next chapter, fetched while this one is being read: its page list so
	// turning the page costs no round trip, and its first pages so there's
	// something on screen the moment it opens.
	let warmed = false;
	function warmNext() {
		if (warmed || stopped || !next) return;
		warmed = true;
		fetchPages(manga.id, next.id).then((urls) => {
			for (const u of urls.slice(0, 3)) {
				const pre = new Image();
				pre.src = u.startsWith('http') ? img(u) : u;
			}
		}).catch(() => { warmed = false; });
	}
	// once the pages in hand are on their way, or as soon as the reader is
	// most of the way through — whichever comes first
	setTimeout(warmNext, 4000);
	root.addEventListener('scroll', () => {
		if (current >= imgs.length - 3) warmNext();
	}, { signal, passive: true });

	// arrived here from the previous chapter's auto-scroll: keep scrolling
	if (autoScroll) startAuto();
}
