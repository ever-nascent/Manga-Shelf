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
	return err.message;
}

// Arriving via a QR code: a pairing code rides in the URL hash. The one QR
// links at the HOME address; after linking, if internet access is on, the
// phone is offered a sign-in link for the internet origin, carried there as
// #token=… — the fragment never leaves the browser, so no token goes on the
// wire.
let pendingCode = null;
let pendingToken = null;
function consumeLinkHash() {
	const params = new URLSearchParams(location.hash.slice(1));
	const code = params.get('link');
	const token = params.get('token');
	if (!code && !token) return false;
	if (code) pendingCode = code.replace(/-/g, '').toUpperCase();
	if (token) pendingToken = token;
	history.replaceState(null, '', location.pathname);
	return true;
}

// Just linked at home. The internet address is a separate origin with its own
// storage, so the session here is invisible there — the phone has to visit it
// once carrying the token. Whether that's possible from inside the house is up
// to the router (NAT loopback), and many home routers don't allow it, so
// rather than gamble on a silent redirect that could dead-end, we always show
// the sign-in link to save and open once away. Internet access off → nothing
// to set up, straight into the app.
async function goSetUpAway() {
	let url = null;
	try { url = (await awayInfo()).url; } catch { /* treat as not available */ }
	if (!url) return startApp();
	showAwayLink(`${url}/#token=${encodeURIComponent(getToken())}`);
}

// The token rides in the link's hash fragment, which never goes over the wire —
// opening the link from any network signs this phone in there. Re-scanning the
// QR on the PC brings this screen back, so a dismissed link is never lost.
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
			'This phone works with MangaShelf on your Wi-Fi now. To also read when you’re away from home, save this link and open it once from cellular or another network — it signs this phone in from anywhere, so treat it like a key and don’t share it. You can re-scan the QR on your PC to get it again.'),
		input,
		h('button', {
			class: 'btn primary link-btn',
			onclick: () => {
				input.select();
				try { document.execCommand('copy'); status.textContent = 'Copied — paste it somewhere safe, like your notes.'; }
				catch { status.textContent = 'Copy didn’t work — long-press the link to copy it.'; }
			}
		}, 'Copy link'),
		h('button', { class: 'btn link-btn', onclick: () => startApp() }, 'Use on Wi-Fi for now'),
		status
	));
}

async function boot() {
	consumeLinkHash();
	// a handed-over session (paired at the home address, delivered here in the
	// hash) replaces whatever this origin had — we're now on the internet origin,
	// already linked, so drop straight into the app below
	if (pendingToken) {
		setToken(pendingToken);
		pendingToken = null;
	}
	const scannedCode = Boolean(pendingCode);
	// an existing session wins over a scanned code — re-scanning the QR on an
	// already-linked phone shouldn't register it twice
	if (getToken()) {
		try {
			await rpc('dl:queue');
			pendingCode = null;
			// a deliberate (re-)scan offers away setup; a normal app open doesn't
			return scannedCode ? goSetUpAway() : startApp();
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
			return goSetUpAway(); // offers away setup when internet is on, else starts
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
