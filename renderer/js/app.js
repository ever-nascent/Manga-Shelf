import * as home from './views/home.js';
import * as browse from './views/browse.js';
import * as detail from './views/detail.js';
import * as library from './views/library.js';
import * as downloads from './views/downloads.js';
import * as settings from './views/settings.js';
import * as updates from './views/updates.js';
import { openReader } from './views/reader.js';
import { h, clear, toast } from './util.js';
import { icon } from './icons.js';
import * as rt from './readTogether.js';
import { closeActiveMenu, confirmQuitWithDownloads, confirmUpdateReady, confirmNewDevice } from './components.js';

const views = { home, browse, detail, library, downloads, settings, updates };
const NAV_ICONS = { home: 'home', browse: 'compass', library: 'books', updates: 'bell', downloads: 'download', settings: 'gear' };
const content = document.getElementById('content');

const stack = [];
let current = null;
let firstRenderDone = false;

// Aborted whenever we navigate away. Views get the signal and hang their
// window listeners off it, so a view that's been replaced can't keep
// reacting to events and appending to a container it no longer owns.
let viewAbort = null;

export const ctx = {
	navigate,
	back,
	openReader: (...args) => openReader(ctx, ...args)
};

export async function navigate(name, params = {}, { push = true } = {}) {
	if (push && current) stack.push(current);
	current = { name, params, scroll: 0 };
	render();
}

export function back() {
	const prev = stack.pop();
	if (prev) {
		current = prev;
		render(prev.scroll);
	} else {
		navigate('home', {}, { push: false });
	}
}

async function render(restoreScroll = 0) {
	closeActiveMenu();
	viewAbort?.abort();
	viewAbort = new AbortController();
	const { signal } = viewAbort;
	for (const btn of document.querySelectorAll('#nav button')) {
		btn.classList.toggle('active', btn.dataset.view === current.name);
	}
	clear(content);
	content.scrollTop = 0;
	try {
		await views[current.name].render(content, current.params, ctx, signal);
		if (signal.aborted) return;
		content.scrollTop = restoreScroll;
	} catch (err) {
		console.error(err);
	} finally {
		// reveal the window on the first render only, success or failure —
		// an error shouldn't leave the user stuck looking at the splash
		if (!firstRenderDone) {
			firstRenderDone = true;
			window.api.notifyReady();
		}
	}
}

// remember scroll position so "back" returns you to the same spot
content.addEventListener('scroll', () => {
	if (current) current.scroll = content.scrollTop;
});

for (const btn of document.querySelectorAll('#nav button')) {
	btn.prepend(icon(NAV_ICONS[btn.dataset.view] || 'home', 17));
	btn.addEventListener('click', () => {
		stack.length = 0;
		navigate(btn.dataset.view, {}, { push: false });
	});
}

// download queue: keep sidebar badge fresh and rebroadcast to open views
const badge = document.getElementById('dl-badge');

function applyQueue(queue) {
	const active = queue.filter((j) => j.status === 'queued' || j.status === 'downloading').length;
	badge.textContent = active;
	badge.classList.toggle('hidden', active === 0);
	window.dispatchEvent(new CustomEvent('queue-update', { detail: queue }));
}

window.api.onQueueUpdate(applyQueue);
window.api.getQueue().then(applyQueue);

// a paused queue from last session was restored and is downloading again
window.api.onDownloadsResumed((n) => {
	toast(`Resumed ${n} paused download${n === 1 ? '' : 's'}.`, 'info', 5000);
});

// closing with downloads running: main asks, we answer
window.api.onQuitConfirm(({ active }) => {
	closeActiveMenu();
	// the dialog is in the DOM as soon as this returns; tell main so it stops
	// counting down and waits for a real answer
	const answered = confirmQuitWithDownloads(active);
	window.api.quitPromptShown();
	answered.then((choice) => window.api.answerQuit(choice));
});

// A device offered a valid pairing code and is waiting to be let in. Queued so
// two devices asking at once can't stack dialogs on top of each other.
let pairPrompt = Promise.resolve();
window.api.onPairRequest((request) => {
	pairPrompt = pairPrompt.then(async () => {
		closeActiveMenu();
		const answer = await confirmNewDevice(request);
		await window.api.answerPairRequest(request.requestId, answer === 'allow');
		toast(answer === 'allow' ? `${request.name} is linked.` : `Turned away ${request.name}.`,
			answer === 'allow' ? 'success' : 'info');
	}).catch((err) => console.error('Pair prompt failed:', err));
});

// new-chapter notifications from the startup check
const upBadge = document.getElementById('up-badge');

export function setUpdatesBadge(count) {
	upBadge.textContent = count;
	upBadge.classList.toggle('hidden', count === 0);
}

window.api.onUpdatesFound((result) => {
	setUpdatesBadge(result.added);
	toast(`${result.added} new chapter${result.added === 1 ? '' : 's'} for manga you follow!`, 'success', 6000);
});

// a linked phone changed shared state (follows, reading progress, library) —
// refresh the current view if it displays that data, keeping scroll position
const REMOTE_AFFECTS = {
	library: ['home', 'library', 'detail'],
	follows: ['home', 'library', 'detail', 'updates'],
	reading: ['home', 'library', 'detail'],
	updates: ['home', 'updates']
};
window.api.onRemoteChanged((domain) => {
	if ((REMOTE_AFFECTS[domain] || []).includes(current?.name)) render(current.scroll);
});

// someone started reading together — offer to join from wherever we are, since
// a session is only worth anything while it's running. Once joined (or waved
// off) the banner goes away; the reader's own controls take over from there.
const rtBanner = h('div', { class: 'rt-banner hidden' });
document.body.append(rtBanner);
let rtDismissed = null; // the one session the user said no to
let rtWasPending = false; // so we can spot the moment the host lets us in

function renderRtBanner() {
	const s = rt.getSession();
	const role = rt.getRole();
	clear(rtBanner);

	// The host answers join requests here rather than only in the reader's
	// roster panel — a request is no use if it lands behind a closed panel.
	if (s && role === 'host' && s.pending.length) {
		const req = s.pending[0];
		rtBanner.classList.remove('hidden');
		rtBanner.append(
			h('div', { class: 'rt-text' },
				h('div', { class: 'rt-who' }, `${req.name} wants to join`),
				h('div', { class: 'rt-what' }, s.manga.title)
			),
			h('button', { class: 'btn primary small', onclick: () => rt.approve(req.id).catch((e) => toast(e.message, 'error')) }, 'Allow'),
			h('button', { class: 'btn small', onclick: () => rt.deny(req.id).catch((e) => toast(e.message, 'error')) }, 'Deny')
		);
		return;
	}

	if (s && role === 'pending') {
		rtBanner.classList.remove('hidden');
		rtBanner.append(h('div', { class: 'rt-text' },
			h('div', { class: 'rt-who' }, 'Asking to join…'),
			h('div', { class: 'rt-what' }, `Waiting for the host of ${s.manga.title}`)
		));
		return;
	}

	const offer = Boolean(s) && !role && s.id !== rtDismissed;
	rtBanner.classList.toggle('hidden', !offer);
	if (!offer) return;
	const host = s.participants.find((p) => p.host);
	// element.append, not the h() helper — a null child would land as "null"
	if (s.manga.coverUrl) rtBanner.append(h('img', { class: 'rt-cover', src: s.manga.coverUrl, alt: '' }));
	rtBanner.append(
		h('div', { class: 'rt-text' },
			h('div', { class: 'rt-who' }, `${host?.name || 'Someone'} is reading together`),
			h('div', { class: 'rt-what' }, s.manga.title)
		),
		h('button', { class: 'btn primary small', onclick: joinReadTogether }, 'Ask to join'),
		h('button', {
			class: 'btn small icon-only',
			title: 'Not now',
			onclick: () => { rtDismissed = s.id; renderRtBanner(); }
		}, icon('x', 14))
	);
}

async function joinReadTogether() {
	try {
		const session = await rt.join();
		// approved already (rejoining) — the reply carries the chapter list
		if (session?.chapters) ctx.openReader(session.manga, session.chapters, session.index, 0);
	} catch (err) {
		toast(err.message, 'error');
	}
	renderRtBanner();
}

window.addEventListener('rt-change', renderRtBanner);

// Let in while we were waiting: the approval broadcast only says we're a guest
// now, so ask again to get the chapter list and open the reader on it.
window.addEventListener('rt-change', async (e) => {
	const role = rt.getRole();
	if (e.detail.declined) toast('The host didn\'t let you in.', 'error');
	else if (rtWasPending && role === 'guest') {
		const session = await rt.join().catch(() => null);
		if (session?.chapters) ctx.openReader(session.manga, session.chapters, session.index, 0);
	}
	rtWasPending = role === 'pending';
});

rt.refresh().catch(() => {});

// clicking a desktop notification jumps to a view (e.g. Updates)
window.api.onNavigate((view) => {
	if (views[view]) {
		stack.length = 0;
		navigate(view, {}, { push: false });
	}
});

// app self-update: checks + downloads quietly in the background, then asks
// before installing. Installing swaps the exe out for a few seconds, so it
// can't happen unannounced — that reads as the app breaking.
let updatePromptShown = false;

window.api.onAppUpdate(async (evt) => {
	window.dispatchEvent(new CustomEvent('app-update-event', { detail: evt }));
	if (evt.type === 'error') console.error('Update check failed:', evt.message);

	if (evt.type !== 'downloaded' || updatePromptShown) return;
	updatePromptShown = true;
	closeActiveMenu();
	if (await confirmUpdateReady(evt.version) === 'now') {
		toast('Installing update — MangaShelf will reopen in a moment…', 'info', 8000);
		await window.api.installUpdate();
	} else {
		toast(`Update ${evt.version} will install when you close MangaShelf.`, 'info', 5000);
	}
});

navigate('home', {}, { push: false });
