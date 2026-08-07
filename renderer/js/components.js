import { h, clear, toast, dedupeChapters, resumeIndex, STATUS_LABEL } from './util.js';
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
		document.removeEventListener('scroll', onDocScroll, true);
		activeMenu = null;
	}
}
function onDocClick(e) { if (activeMenu && !activeMenu.contains(e.target)) closeActiveMenu(); }
// scrolling the page moves the anchor out from under the fixed menu → close;
// scrolling inside the menu itself (long chapter lists) must NOT close it
function onDocScroll(e) { if (activeMenu && !activeMenu.contains(e.target)) closeActiveMenu(); }
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
		document.addEventListener('scroll', onDocScroll, true);
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

// ---------- shared "pick one of these" dialog ----------

// choices: [{ value, icon, label, hint, cls }]. Dismissing resolves with
// dismissValue, so Escape/backdrop always mean the harmless option.
function choiceDialog({ title, message, choices, dismissValue }) {
	return new Promise((resolve) => {
		let answered = false;
		const answer = (choice) => {
			if (answered) return;
			answered = true;
			backdrop.remove();
			document.removeEventListener('keydown', onKey, true);
			resolve(choice);
		};

		const backdrop = h('div', { class: 'modal-backdrop' },
			h('div', { class: 'modal-dialog quit-dialog' },
				h('div', { class: 'modal-head' },
					h('h2', {}, title),
					h('button', {
						class: 'btn icon-only modal-close', title: 'Close',
						onclick: () => answer(dismissValue)
					}, icon('x', 15))
				),
				h('div', { class: 'modal-body' },
					h('div', { class: 'quit-msg' }, message),
					h('div', { class: 'quit-choices' }, choices.map((c) => h('button',
						{ class: `btn quit-choice ${c.cls || ''}`, onclick: () => answer(c.value) },
						icon(c.icon, 16),
						h('span', {}, h('b', {}, c.label), h('small', {}, c.hint))
					)))
				)
			)
		);

		function onKey(e) {
			if (e.key === 'Escape') { e.stopPropagation(); answer(dismissValue); }
		}
		backdrop.addEventListener('click', (e) => { if (e.target === backdrop) answer(dismissValue); });
		document.addEventListener('keydown', onKey, true);
		document.body.append(backdrop);
		backdrop.querySelector('.quit-choice').focus();
	});
}

// ---------- update downloaded and waiting ----------

// Resolves 'now' (restart into it) or 'later' (install when the app closes).
export function confirmUpdateReady(version) {
	return choiceDialog({
		title: 'Update ready',
		message: `MangaShelf ${version} has been downloaded. Installing takes a few seconds, and MangaShelf has to close while it runs.`,
		dismissValue: 'later',
		choices: [
			{
				value: 'now', icon: 'refresh', cls: 'primary',
				label: 'Restart and update now',
				hint: 'Closes MangaShelf, installs, and reopens it for you.'
			},
			{
				value: 'later', icon: 'clock',
				label: 'Update when I close MangaShelf',
				hint: 'Carry on for now. The installer runs, with its progress showing, once you exit.'
			}
		]
	});
}

// ---------- inviting someone to read along ----------

const INVITE_USES = [
	[1, 'One person'],
	[2, 'Two people'],
	[5, 'Five people'],
	[0, 'No limit']
];
const INVITE_TTL = [
	[10 * 60_000, '10 minutes'],
	[60 * 60_000, '1 hour'],
	[24 * 60 * 60_000, '24 hours']
];

// Make a link, show it as a QR and as text to copy. Deliberately spells out
// what the guest gets, because "here's a link to my library" and "here's a
// link to read one book with me" are very different things to hand someone.
export function openInviteDialog() {
	const { body, close } = openModal('Invite someone to read along');
	let maxUses = 1;
	let ttlMs = 10 * 60_000;

	const usesSel = styledSelect({
		small: true, value: maxUses,
		options: INVITE_USES.map(([value, label]) => ({ value, label })),
		onChange: (v) => { maxUses = Number(v); }
	});
	const ttlSel = styledSelect({
		small: true, value: ttlMs,
		options: INVITE_TTL.map(([value, label]) => ({ value, label })),
		onChange: (v) => { ttlMs = Number(v); }
	});

	const result = h('div', { class: 'invite-result hidden' });
	const status = h('div', { class: 'hint' }, '');
	const makeBtn = h('button', { class: 'btn primary wide' }, 'Create invite');

	makeBtn.addEventListener('click', async () => {
		makeBtn.disabled = true;
		status.textContent = 'Creating…';
		try {
			const invite = await window.api.inviteToReadTogether({ maxUses, ttlMs });
			status.textContent = '';
			renderInvite(invite);
		} catch (err) {
			status.textContent = err.message;
		}
		makeBtn.disabled = false;
	});

	function renderInvite(invite) {
		clear(result);
		const link = h('input', {
			class: 'invite-link', readOnly: true, value: invite.link,
			onclick: () => link.select()
		});
		const copied = h('span', { class: 'hint' }, '');
		result.append(
			h('img', { class: 'invite-qr', src: invite.qrDataUrl, alt: 'Invite QR code' }),
			h('div', { class: 'hint' }, invite.remote
				? 'This link works from any network.'
				: 'This link only works on your Wi-Fi.'),
			link,
			h('div', { class: 'invite-actions' },
				h('button', {
					class: 'btn small',
					onclick: () => {
						link.select();
						try { document.execCommand('copy'); copied.textContent = 'Copied.'; }
						catch { copied.textContent = 'Copy didn\'t work — long-press to copy.'; }
					}
				}, 'Copy link'),
				copied
			),
			h('div', { class: 'hint' },
				`Good for ${invite.maxUses === 0 ? 'any number of people' : invite.maxUses === 1 ? 'one person' : `${invite.maxUses} people`}, `
				+ `until ${new Date(invite.expiresAt).toLocaleTimeString()}.`)
		);
		result.classList.remove('hidden');
	}

	body.append(
		h('div', { class: 'hint' },
			'They\'ll get the reader for this series and nothing else — they can\'t see your library, '
			+ 'search, download, or delete anything. Their access ends the moment you close the book.'),
		h('div', { class: 'settings-row' }, h('span', { class: 'remote-label' }, 'Good for'), usesSel.el),
		h('div', { class: 'settings-row' }, h('span', { class: 'remote-label' }, 'Expires in'), ttlSel.el),
		makeBtn,
		status,
		result
	);
	return { close };
}

// ---------- a new device wants to link ----------

// Resolves 'allow' | 'deny'. Dismissing means deny — the safe answer, since
// allowing hands over a key to the whole library. The address is shown because
// the device's own name is whatever it claims to be; the address isn't.
export function confirmNewDevice({ name, addr }) {
	return choiceDialog({
		title: 'Let this device in?',
		message: `“${name}” gave the right pairing code, from ${addr || 'an unknown address'}. `
			+ 'Allow it only if that\'s a device you\'re linking right now — it will be able to read your '
			+ 'library, queue downloads, and delete chapters.',
		dismissValue: 'deny',
		choices: [
			{
				value: 'allow', icon: 'check', cls: 'primary',
				label: 'Allow',
				hint: 'Link it. You can unlink it again from Settings at any time.'
			},
			{
				value: 'deny', icon: 'x',
				label: 'Deny',
				hint: 'Turn it away. If this wasn\'t you, nothing was given out.'
			}
		]
	});
}

// ---------- closing a book other people are reading ----------

// Resolves 'end' | 'stay'. Dismissing means stay, since ending cuts everyone
// else off mid-chapter.
export function confirmEndSession(names) {
	const who = names.length === 1 ? names[0]
		: names.length === 2 ? `${names[0]} and ${names[1]}`
			: `${names.length} people`;
	return choiceDialog({
		title: 'Others are still reading',
		message: `${who} ${names.length === 1 ? 'is' : 'are'} reading this with you. `
			+ 'Closing the book ends the session and they lose access straight away.',
		dismissValue: 'stay',
		choices: [
			{
				value: 'stay', icon: 'check', cls: 'primary',
				label: 'Keep reading',
				hint: 'Stay in the book and leave the session running.'
			},
			{
				value: 'end', icon: 'x',
				label: 'End the session',
				hint: 'Close the book. Everyone else stops reading too.'
			}
		]
	});
}

// ---------- quit confirmation (downloads still running) ----------

// Resolves with 'pause' | 'cancel' | 'stay'. Dismissing (Escape, backdrop,
// close button) counts as 'stay' — the safe answer, since the other two exit.
export function confirmQuitWithDownloads(active) {
	const n = active === 1 ? '1 chapter is' : `${active} chapters are`;
	return choiceDialog({
		title: 'Downloads in progress',
		message: `${n} still downloading. The queue isn't kept unless you pause it.`,
		dismissValue: 'stay',
		choices: [
			{
				value: 'pause', icon: 'pause', cls: 'primary',
				label: 'Pause and exit',
				hint: 'Saves the queue and picks up where it left off next launch.'
			},
			{
				value: 'cancel', icon: 'trash', cls: 'danger',
				label: 'Cancel downloads and exit',
				hint: 'Clears the queue. Pages already downloaded are kept.'
			},
			{
				value: 'stay', icon: 'download',
				label: 'Keep downloading',
				hint: 'Stay in the app and let the queue finish.'
			}
		]
	});
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
			const found = resumeIndex(list, reading.chapterId, reading.chapterNum);
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
