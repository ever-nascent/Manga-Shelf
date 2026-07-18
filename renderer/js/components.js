import { h, clear, toast, dedupeChapters, STATUS_LABEL } from './util.js';
import { icon } from './icons.js';

const FALLBACK_COVER =
	'data:image/svg+xml;utf8,' + encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420">
			<rect width="100%" height="100%" fill="#1a1e2e"/>
			<text x="50%" y="50%" fill="#3a4266" font-size="60" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif">?</text>
		</svg>`);

export function coverImg(src, alt) {
	const img = h('img', { src: src || FALLBACK_COVER, alt: alt || '', loading: 'lazy' });
	img.addEventListener('error', () => { img.src = FALLBACK_COVER; }, { once: true });
	return img;
}

// ---------- fixed-position popup menu (never clipped by containers) ----------

let activeMenu = null;

export function closeActiveMenu() {
	if (activeMenu) {
		activeMenu.remove();
		document.removeEventListener('click', onDocClick, true);
		document.removeEventListener('keydown', onDocKey, true);
		document.removeEventListener('scroll', closeActiveMenu, true);
		activeMenu = null;
	}
}
function onDocClick(e) { if (activeMenu && !activeMenu.contains(e.target)) closeActiveMenu(); }
function onDocKey(e) {
	if (e.key === 'Escape' && activeMenu) {
		// Escape only closes the menu — don't let it also close the reader
		e.stopPropagation();
		closeActiveMenu();
	}
}

// items: {label, icon?, danger?, selected?, sub?, onClick} or 'divider'
export function openMenu(anchor, items) {
	const wasOpen = activeMenu?.anchor === anchor;
	closeActiveMenu();
	if (wasOpen) return; // clicking the anchor again toggles closed

	const menu = h('div', { class: 'pop-menu' });
	menu.anchor = anchor;
	for (const it of items) {
		if (it === 'divider') { menu.append(h('hr')); continue; }
		menu.append(h('button', { class: it.danger ? 'danger' : '', onclick: () => { closeActiveMenu(); it.onClick(); } },
			it.icon ? icon(it.icon, 15) : null,
			h('span', { class: 'pm-label' }, it.label, it.sub ? h('span', { class: 'pm-sub' }, it.sub) : null),
			it.selected ? icon('check', 14) : h('span', { class: 'pm-pad' })
		));
	}
	document.body.append(menu);

	const r = anchor.getBoundingClientRect();
	menu.style.minWidth = Math.max(190, r.width) + 'px';
	let top = r.bottom + 6;
	if (top + menu.offsetHeight > window.innerHeight - 8) {
		top = Math.max(8, r.top - menu.offsetHeight - 6);
	}
	menu.style.top = top + 'px';
	menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';

	activeMenu = menu;
	setTimeout(() => {
		document.addEventListener('click', onDocClick, true);
		document.addEventListener('keydown', onDocKey, true);
		document.addEventListener('scroll', closeActiveMenu, true);
	}, 0);
}

// ---------- modal ----------

// Centered dialog with a backdrop. Returns a close() fn; the caller builds
// whatever content it needs and appends it to the returned body element.
export function openModal(title) {
	const backdrop = h('div', { class: 'modal-backdrop' });
	const body = h('div', { class: 'modal-body' });
	const closeBtn = h('button', { class: 'btn icon-only modal-close', title: 'Close' }, icon('x', 15));
	const dialog = h('div', { class: 'modal-dialog' },
		h('div', { class: 'modal-head' }, h('h2', {}, title), closeBtn),
		body
	);
	backdrop.append(dialog);
	document.body.append(backdrop);

	function close() {
		backdrop.remove();
		document.removeEventListener('keydown', onKey, true);
	}
	function onKey(e) {
		if (e.key === 'Escape') { e.stopPropagation(); close(); }
	}
	backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
	closeBtn.addEventListener('click', close);
	document.addEventListener('keydown', onKey, true);

	return { body, close };
}

// ---------- styled <select> replacement ----------

export function styledSelect({ options, value, onChange, small = false }) {
	let current = value;
	const btn = h('button', { class: `btn select-btn ${small ? 'small' : ''}` });

	const labelFor = (v) => options.find((o) => o.value === v)?.label ?? String(v ?? '');
	const sync = () => {
		clear(btn);
		btn.append(h('span', { class: 'select-label' }, labelFor(current)), icon('chevron-down', 13));
	};
	btn.addEventListener('click', () => {
		openMenu(btn, options.map((o) => ({
			label: o.label,
			sub: o.sub,
			selected: o.value === current,
			onClick: () => {
				if (o.value === current) return;
				current = o.value;
				sync();
				onChange(o.value);
			}
		})));
	});
	sync();
	return {
		el: btn,
		get value() { return current; },
		set(v) { current = v; sync(); }
	};
}

// ---------- manga card with hover quick-actions ----------

// opts: sub (string), corner (icon name), quick ([{icon, label, onClick}])
export function mangaCard(m, onOpen, { sub, corner, quick } = {}) {
	return h('article', { class: 'card', onclick: () => onOpen(m) },
		h('div', { class: 'cover' },
			coverImg(m.coverUrl, m.title),
			corner && h('span', { class: 'corner' }, icon(corner, 13)),
			quick?.length && h('div', { class: 'card-actions' },
				quick.map((q) => {
					const btn = h('button', {
						class: 'card-action',
						title: q.label,
						onclick: (e) => { e.stopPropagation(); q.onClick(e, btn); }
					}, icon(q.icon, 17));
					return btn;
				}))
		),
		h('div', { class: 'card-title', title: m.title }, m.title),
		h('div', { class: 'card-sub' }, sub ?? STATUS_LABEL[m.status] ?? '')
	);
}

// ---------- shared card quick-actions for discovery views ----------

export const FOLLOW_STATUSES = [
	['reading', 'Reading'], ['plan', 'Plan to Read'], ['completed', 'Completed'],
	['hold', 'On Hold'], ['dropped', 'Dropped']
];

export function followStatusLabel(s) {
	return FOLLOW_STATUSES.find(([v]) => v === s)?.[1] || s;
}

// Jump straight into the reader for a manga (resumes saved progress if any).
export async function quickRead(ctx, manga) {
	toast(`Opening ${manga.title}…`, 'info', 2000);
	try {
		const [chapters, reading] = await Promise.all([
			window.api.getChapters(manga.id),
			window.api.getReading(manga.id)
		]);
		const list = dedupeChapters(chapters);
		if (!list.length) {
			toast('No readable chapters on MangaDex — this may be an official-only release.', 'error', 4000);
			ctx.navigate('detail', { id: manga.id });
			return;
		}
		let idx = 0;
		let page = 0;
		if (reading) {
			let found = list.findIndex((c) => c.id === reading.chapterId);
			if (found === -1 && reading.chapterNum != null) found = list.findIndex((c) => c.num === reading.chapterNum);
			if (found >= 0) { idx = found; page = reading.page || 0; }
		}
		ctx.openReader(manga, list, idx, page);
	} catch (err) {
		toast(`Couldn't load chapters: ${err.message}`, 'error');
	}
}

// followSet: Set of followed manga ids shared by the view, kept in sync here.
export function discoverQuickActions(ctx, m, followSet) {
	return [
		{
			icon: followSet.has(m.id) ? 'bookmark-filled' : 'bookmark',
			label: 'Add to library',
			onClick: async (e, btn) => {
				const items = FOLLOW_STATUSES.map(([value, label]) => ({
					label,
					onClick: async () => {
						await window.api.setFollow(m, value);
						followSet.add(m.id);
						clear(btn);
						btn.append(icon('bookmark-filled', 17));
						toast(`${m.title} added to ${label}.`, 'success', 2000);
					}
				}));
				if (followSet.has(m.id)) {
					const f = await window.api.getFollow(m.id);
					items.forEach((it, i) => { it.selected = FOLLOW_STATUSES[i][0] === f?.status; });
					items.push('divider', {
						label: 'Remove from Library',
						icon: 'trash',
						danger: true,
						onClick: async () => {
							await window.api.removeFollow(m.id);
							followSet.delete(m.id);
							clear(btn);
							btn.append(icon('bookmark', 17));
							toast('Removed from library.', 'info', 1800);
						}
					});
				}
				openMenu(btn, items);
			}
		},
		{ icon: 'play', label: 'Read now', onClick: () => quickRead(ctx, m) }
	];
}
