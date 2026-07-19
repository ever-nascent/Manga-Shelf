import * as home from './views/home.js';
import * as browse from './views/browse.js';
import * as detail from './views/detail.js';
import * as library from './views/library.js';
import * as downloads from './views/downloads.js';
import * as settings from './views/settings.js';
import * as updates from './views/updates.js';
import { openReader } from './views/reader.js';
import { clear, toast } from './util.js';
import { icon } from './icons.js';
import { closeActiveMenu, confirmQuitWithDownloads } from './components.js';

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

// clicking a desktop notification jumps to a view (e.g. Updates)
window.api.onNavigate((view) => {
	if (views[view]) {
		stack.length = 0;
		navigate(view, {}, { push: false });
	}
});

// app self-update: checks + downloads silently in the background, installs
// itself the next time the app quits normally — nothing for the user to see
// or act on. Settings > About still surfaces status for anyone who looks.
window.api.onAppUpdate((evt) => {
	window.dispatchEvent(new CustomEvent('app-update-event', { detail: evt }));
	if (evt.type === 'error') console.error('Update check failed:', evt.message);
});

navigate('home', {}, { push: false });
