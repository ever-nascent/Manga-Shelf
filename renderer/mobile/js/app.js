// Router + boot: link screen until paired, then tab navigation with the
// browser history API so the phone's back button works naturally.

import { getToken, setToken, clearToken, pair, rpc, connectEvents, setQueue, sinceLastMutation, awayInfo } from './api.js';
import { h, clear } from './util.js';
import { icon } from './icons.js';
import * as home from './views/home.js';
import * as search from './views/search.js';
import * as library from './views/library.js';
import * as downloads from './views/downloads.js';
import * as detail from './views/detail.js';
import * as reader from './views/reader.js';

const views = { home, search, library, downloads, detail, reader };
const NAV_ICONS = { home: 'home', search: 'search', library: 'books', downloads: 'download' };

const content = document.getElementById('content');
const nav = document.getElementById('nav');

let current = null;
let linked = false;
let viewAbort = null;

export function navigate(name, params = {}, { replace = false } = {}) {
	if (!linked) return; // nothing is reachable until the phone is paired
	const state = { name, params };
	if (replace) history.replaceState(state, '');
	else history.pushState(state, '');
	render(state);
}

const ctx = {
	navigate,
	back: () => history.back(),
	openReader: (manga, chapters, index, page = 0) => navigate('reader', { manga, chapters, index, page })
};

async function render(state) {
	viewAbort?.abort();
	viewAbort = new AbortController();
	current = state;
	document.body.classList.toggle('reading', state.name === 'reader');
	for (const btn of nav.querySelectorAll('button')) {
		btn.classList.toggle('active', btn.dataset.view === state.name);
	}
	clear(content);
	content.scrollTop = 0;
	try {
		await views[state.name].render(content, state.params, ctx, viewAbort.signal);
	} catch (err) {
		console.error(err);
	}
}

window.addEventListener('popstate', (e) => {
	if (linked) render(e.state || { name: 'home', params: {} });
});

for (const btn of nav.querySelectorAll('button')) {
	btn.querySelector('.nav-ic').replaceWith(icon(NAV_ICONS[btn.dataset.view], 21));
	btn.addEventListener('click', () => navigate(btn.dataset.view, {}, { replace: true }));
}

// downloads badge follows the live queue
const badge = document.getElementById('dl-badge');
window.addEventListener('queue-update', (e) => {
	const active = e.detail.filter((j) => j.status === 'queued' || j.status === 'downloading').length;
	badge.textContent = active;
	badge.classList.toggle('hidden', active === 0);
});

// something changed on the PC (or another phone) — refresh the current view
// if it shows that data. Skip echoes of changes this phone just made.
const AFFECTS = {
	library: ['home', 'library', 'detail'],
	follows: ['home', 'library', 'detail'],
	reading: ['home', 'library', 'detail'],
	updates: ['home']
};
window.addEventListener('remote-change', (e) => {
	if (!current || current.name === 'reader') return;
	if (sinceLastMutation() < 2500) return;
	if ((AFFECTS[e.detail] || []).includes(current.name)) render(current);
});

// ---------- linking ----------

function showLink(message = '') {
	linked = false;
	document.body.classList.add('linking');
	clear(content);

	const status = h('div', { class: 'link-status' }, message);
	const input = h('input', {
		class: 'link-input',
		placeholder: 'ABCD-EFGH',
		autocapitalize: 'characters',
		autocomplete: 'off',
		spellcheck: false,
		maxLength: 9,
		oninput: () => { input.value = input.value.toUpperCase(); },
		onkeydown: (e) => { if (e.key === 'Enter') connect(); }
	});

	async function connect() {
		const code = input.value.replace(/[^A-Z0-9]/g, '');
		if (code.length < 6) {
			status.textContent = 'Enter the 8-character code from your PC.';
			return;
		}
		status.textContent = 'Linking…';
		try {
			await pair(code);
			startApp();
		} catch (err) {
			status.textContent = pairErrorText(err);
		}
	}

	content.append(h('div', { class: 'link-screen' },
		h('div', { class: 'link-logo' }, icon('phone', 40)),
		h('h1', {}, 'MangaShelf'),
		h('p', { class: 'hint' },
			'Link this phone to MangaShelf on your PC: open Settings, turn on Phone remote, then scan the QR code with your camera or type the link code here.'),
		input,
		h('button', { class: 'btn primary link-btn', onclick: connect }, 'Link'),
		status
	));
}

function startApp() {
	linked = true;
	document.body.classList.remove('linking');
	connectEvents();
	rpc('dl:queue').then(setQueue).catch(() => {});
	navigate('home', {}, { replace: true });
}

// the PC unlinked us — back to the link screen
window.addEventListener('remote-unauthorized', () => {
	if (!linked) return;
	clearToken();
	showLink('This phone was unlinked. Scan the QR code on your PC to link again.');
});

// The code rotates every minute on the PC, so failures need distinct wording:
// stale scans are normal, lockout means stop and wait.
function pairErrorText(err) {
	if (err.message === 'bad-code') return 'That code didn’t match or has expired. Check Settings on your PC for the current one.';
	if (err.message === 'locked') return 'Too many attempts. Wait a few minutes, then try the current code.';
	if (err.message === 'not-local') return 'New phones can’t link at this internet address. While on the same Wi-Fi as your PC, scan the Away QR in Settings — after that, this address works from anywhere.';
	return err.message;
}

// Arriving via a QR code: a pairing code rides in the hash. The Away QR points
// at the HOME address and adds away=1 (set up the internet address after
// linking), and the home page hands the session to the internet origin as
// #token=… — fragments never leave the browser, so no token goes on the wire.
let pendingCode = null;
let pendingToken = null;
let pendingAway = false;
function consumeLinkHash() {
	const params = new URLSearchParams(location.hash.slice(1));
	const code = params.get('link');
	const token = params.get('token');
	if (!code && !token) return false;
	if (code) pendingCode = code.replace(/-/g, '').toUpperCase();
	if (token) pendingToken = token;
	pendingAway = params.get('away') === '1';
	history.replaceState(null, '', location.pathname);
	return true;
}

// The internet address is a different origin with its own storage, so the
// session stored here is invisible there. Ask the PC where it's reachable
// from the internet and hand the token over in the hash — the page there
// stores it and boots already linked. Two roads, because routers differ on
// NAT loopback: if the internet address answers from inside this network,
// hop straight over; if not (loopback unsupported — common), the hop would
// dead-end on an error page, so show the link to save and open once away.
async function goSetUpAway() {
	let url = null;
	try { url = (await awayInfo()).url; } catch { /* treat as not available */ }
	if (!url) return startApp(); // internet access is off — linked for home use anyway
	const link = `${url}/#token=${encodeURIComponent(getToken())}`;
	const probe = new AbortController();
	const timer = setTimeout(() => probe.abort(), 4000);
	try {
		await fetch(`${url}/`, { mode: 'no-cors', cache: 'no-store', signal: probe.signal });
		clearTimeout(timer);
		location.replace(link);
	} catch {
		clearTimeout(timer);
		showAwayLink(link);
	}
}

// Linked at home, but the internet address is only reachable from outside.
// The token rides in the link's hash fragment, which never goes over the
// wire — opening the link anywhere signs this phone in there.
function showAwayLink(link) {
	document.body.classList.add('linking');
	clear(content);
	const input = h('input', {
		class: 'link-input away-link',
		readOnly: true,
		value: link,
		onclick: () => input.select()
	});
	const status = h('div', { class: 'link-status' }, '');
	content.append(h('div', { class: 'link-screen' },
		h('div', { class: 'link-logo' }, icon('phone', 40)),
		h('h1', {}, 'Linked!'),
		h('p', { class: 'hint' },
			'This phone now works with MangaShelf on your Wi-Fi. To read from outside your home, save this link and open it once you’re away — it signs this phone in from anywhere. It’s a key: don’t share it.'),
		input,
		h('button', {
			class: 'btn primary link-btn',
			onclick: () => {
				input.select();
				try { document.execCommand('copy'); status.textContent = 'Copied — paste it somewhere safe, like your notes.'; }
				catch { status.textContent = 'Copy didn’t work — long-press the link to copy it.'; }
			}
		}, 'Copy link'),
		h('button', { class: 'btn link-btn', onclick: () => startApp() }, 'Done'),
		status
	));
}

async function boot() {
	consumeLinkHash();
	// a handed-over session (paired at the home address, delivered here in the
	// hash) replaces whatever this origin had
	if (pendingToken) {
		setToken(pendingToken);
		pendingToken = null;
	}
	// an existing session wins over a scanned code — re-scanning the QR on an
	// already-linked phone shouldn't register it twice
	if (getToken()) {
		try {
			await rpc('dl:queue');
			pendingCode = null;
			if (pendingAway) { pendingAway = false; return goSetUpAway(); }
			return startApp();
		} catch (err) {
			if (err.message !== 'Not linked') { pendingCode = null; return showLink(err.message); }
			clearToken();
		}
	}
	if (pendingCode) {
		const code = pendingCode;
		pendingCode = null;
		try {
			await pair(code);
			if (pendingAway) { pendingAway = false; return goSetUpAway(); }
			return startApp();
		} catch (err) {
			return showLink(pairErrorText(err));
		}
	}
	showLink();
}

// scanning the QR into an already-open tab only changes the hash — no reload
window.addEventListener('hashchange', () => {
	if (consumeLinkHash()) boot();
});

boot();
