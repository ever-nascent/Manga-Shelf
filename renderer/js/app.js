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
import { closeActiveMenu } from './components.js';

const views = { home, browse, detail, library, downloads, settings, updates };
const NAV_ICONS = { home: 'home', browse: 'compass', library: 'books', updates: 'bell', downloads: 'download', settings: 'gear' };
const content = document.getElementById('content');

const stack = [];
let current = null;

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
	for (const btn of document.querySelectorAll('#nav button')) {
		btn.classList.toggle('active', btn.dataset.view === current.name);
	}
	clear(content);
	content.scrollTop = 0;
	try {
		await views[current.name].render(content, current.params, ctx);
		content.scrollTop = restoreScroll;
	} catch (err) {
		console.error(err);
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

// app self-update: quietly downloads in the background, then offers a restart
const updateBanner = document.getElementById('update-banner');
window.api.onAppUpdate((evt) => {
	window.dispatchEvent(new CustomEvent('app-update-event', { detail: evt }));
	if (evt.type === 'available') {
		toast(`Update v${evt.version} found — downloading…`, 'info', 4000);
	} else if (evt.type === 'downloaded') {
		clear(updateBanner);
		updateBanner.classList.remove('hidden');
		updateBanner.append(
			`v${evt.version} ready — `,
			(() => {
				const btn = document.createElement('button');
				btn.textContent = 'Restart to update';
				btn.addEventListener('click', () => window.api.restartToUpdate());
				return btn;
			})()
		);
	} else if (evt.type === 'error') {
		console.error('Update check failed:', evt.message);
	}
});

navigate('home', {}, { push: false });
