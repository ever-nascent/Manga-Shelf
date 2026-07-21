// Vertical-scroll reader. Downloaded chapters stream from the PC's library;
// anything else streams from the source through the PC. Progress saves back
// to the PC so the desktop app resumes exactly where the phone left off.

import { h, clear, spinner, errorBox, chapterName, debounce } from '../util.js';
import { rpc, img } from '../api.js';
import { icon } from '../icons.js';

// Auto-scroll speeds in px/second; remembered across chapters within a session.
const AUTO_SPEEDS = [30, 55, 90, 140, 210, 300];
let autoSpeedIdx = 2;

export async function render(root, { manga, chapters, index, page = 0, autoScroll = false }, ctx, signal) {
	const ch = chapters[index];
	let current = 0;

	const pageInd = h('div', { class: 'r-ind' }, '');

	// auto-scroller: play/pause plus a slower/faster stepper, all in the top bar
	const autoBtn = h('button', { class: 'icon-btn', 'aria-label': 'Auto-scroll' }, icon('play', 22));
	const speedLabel = h('span', { class: 'r-speed' }, `${autoSpeedIdx + 1}×`);
	const slowBtn = h('button', { class: 'icon-btn small', 'aria-label': 'Slower' }, icon('minus', 20));
	const fastBtn = h('button', { class: 'icon-btn small', 'aria-label': 'Faster' }, icon('plus', 20));

	const bar = h('div', { class: 'r-bar' },
		h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: ctx.back }, icon('back', 22)),
		h('div', { class: 'r-titles' },
			h('div', { class: 'r-manga' }, manga.title),
			h('div', { class: 'r-ch' }, chapterName(ch))
		),
		h('div', { class: 'r-auto' }, slowBtn, speedLabel, autoBtn, fastBtn)
	);
	const pagesEl = h('div', { class: 'r-pages' }, spinner());
	root.append(bar, pagesEl, pageInd);

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
		rpc('reading:set', snap, { chapterId: ch.id, chapterNum: ch.num, page: current }).catch(() => {});
	}, 800);
	signal.addEventListener('abort', () => saveProgress.flush(), { once: true });

	let pages = [];
	try {
		pages = await rpc('lib:pages', manga.id, ch.id).catch(() => []);
		if (!pages.length) pages = await rpc('md:chapterImages', ch.id);
	} catch (err) {
		if (signal.aborted) return;
		clear(pagesEl);
		pagesEl.append(errorBox(`Couldn't load pages: ${err.message}`, () => {
			ctx.navigate('reader', { manga, chapters, index, page }, { replace: true });
		}));
		return;
	}
	if (signal.aborted) return;

	clear(pagesEl);
	const imgs = pages.map((p, i) => h('img', {
		class: 'r-page',
		src: p.startsWith('http') ? img(p) : p,
		loading: i < 3 ? 'eager' : 'lazy',
		alt: `Page ${i + 1}`
	}));
	pagesEl.append(...imgs);

	// end-of-chapter controls
	const next = chapters[index + 1];
	const openNext = (auto) => ctx.navigate('reader', { manga, chapters, index: index + 1, autoScroll: auto }, { replace: true });
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

	// resuming mid-chapter: jump once the target page has a size
	if (page > 0 && imgs[page]) {
		const target = imgs[page];
		target.addEventListener('load', () => target.scrollIntoView({ block: 'start' }), { once: true });
	}

	// track the page under the middle of the screen
	const update = () => {
		const mid = root.scrollTop + root.clientHeight / 2;
		let idx = 0;
		for (let i = 0; i < imgs.length; i++) {
			if (imgs[i].offsetTop <= mid) idx = i;
			else break;
		}
		if (idx !== current) {
			current = idx;
			saveProgress();
		}
		pageInd.textContent = `${current + 1} / ${imgs.length}`;
	};
	let ticking = false;
	root.addEventListener('scroll', () => {
		if (ticking) return;
		ticking = true;
		setTimeout(() => { ticking = false; update(); }, 120);
	}, { signal });

	current = Math.min(page, imgs.length - 1);
	pageInd.textContent = `${current + 1} / ${imgs.length}`;
	saveProgress(); // opening a chapter marks it as being read

	// arrived here from the previous chapter's auto-scroll: keep scrolling
	if (autoScroll) startAuto();
}
