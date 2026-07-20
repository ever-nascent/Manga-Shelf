// Vertical-scroll reader. Downloaded chapters stream from the PC's library;
// anything else streams from the source through the PC. Progress saves back
// to the PC so the desktop app resumes exactly where the phone left off.

import { h, clear, spinner, errorBox, chapterName, debounce } from '../util.js';
import { rpc, img } from '../api.js';
import { icon } from '../icons.js';

export async function render(root, { manga, chapters, index, page = 0 }, ctx, signal) {
	const ch = chapters[index];
	let current = 0;

	const pageInd = h('div', { class: 'r-ind' }, '');
	const bar = h('div', { class: 'r-bar' },
		h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: ctx.back }, icon('back', 22)),
		h('div', { class: 'r-titles' },
			h('div', { class: 'r-manga' }, manga.title),
			h('div', { class: 'r-ch' }, chapterName(ch))
		)
	);
	const pagesEl = h('div', { class: 'r-pages' }, spinner());
	root.append(bar, pagesEl, pageInd);

	// tap anywhere (that isn't a control) to show/hide the bar
	pagesEl.addEventListener('click', (e) => {
		if (e.target.closest('button')) return;
		bar.classList.toggle('r-hidden');
	});

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
	pagesEl.append(h('div', { class: 'r-end' },
		h('div', { class: 'r-end-label' }, `End of ${chapterName(ch)}`),
		next && h('button', {
			class: 'btn primary wide',
			onclick: () => ctx.navigate('reader', { manga, chapters, index: index + 1 }, { replace: true })
		}, `Next: ${chapterName(next)}`),
		h('button', { class: 'btn wide', onclick: ctx.back }, 'Back to series')
	));

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
}
