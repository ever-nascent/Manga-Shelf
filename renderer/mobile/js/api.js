// Transport to the PC: every command goes to POST /api/<cmd> with the link
// token; live pushes (queue progress, change pings) arrive over SSE.

const TOKEN_KEY = 'mstoken';

export function getToken() {
	return localStorage.getItem(TOKEN_KEY) || '';
}

// The cookie is what lets <img src="/file...">, <img src="/proxy...">, and the
// EventSource authenticate — those can't attach an Authorization header.
export function setToken(t) {
	localStorage.setItem(TOKEN_KEY, t);
	document.cookie = `mstoken=${t}; path=/; max-age=31536000; SameSite=Lax`;
}

export function clearToken() {
	localStorage.removeItem(TOKEN_KEY);
	document.cookie = 'mstoken=; path=/; max-age=0';
}

// Change pings echo back to the phone that made the change; remembering our
// own recent mutations lets the app skip pointless self-refreshes.
const MUTATING = new Set([
	'follows:set', 'follows:remove', 'follows:setNotify',
	'reading:set', 'reading:remove',
	'lib:removeChapter', 'lib:removeManga', 'updates:check'
]);
let lastMutationAt = 0;

export function sinceLastMutation() {
	return Date.now() - lastMutationAt;
}

export async function rpc(cmd, ...args) {
	let res;
	try {
		res = await fetch(`/api/${cmd}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
			body: JSON.stringify({ args })
		});
	} catch {
		throw new Error('MangaShelf is unreachable. Is it open on your PC?');
	}
	if (res.status === 401) {
		window.dispatchEvent(new Event('remote-unauthorized'));
		throw new Error('Not linked');
	}
	const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
	if (!data.ok) throw new Error(data.error || 'Request failed');
	if (MUTATING.has(cmd)) lastMutationAt = Date.now();
	return data.result;
}

// Covers and pages on manga CDNs reject plain phone-browser requests, so the
// PC fetches them for us. Local library files (/file...) load directly.
export function img(url) {
	if (!url) return '';
	return url.startsWith('http') ? `/proxy?url=${encodeURIComponent(url)}` : url;
}

// ---------- live download queue ----------

let queue = [];

export function getQueue() {
	return queue;
}

export function setQueue(q) {
	queue = q || [];
	window.dispatchEvent(new CustomEvent('queue-update', { detail: queue }));
}

let es = null;

export function connectEvents() {
	es?.close();
	es = new EventSource('/events'); // cookie carries the token
	es.addEventListener('queue', (e) => setQueue(JSON.parse(e.data)));
	es.addEventListener('change', (e) => {
		window.dispatchEvent(new CustomEvent('remote-change', { detail: JSON.parse(e.data).domain }));
	});
	// EventSource reconnects on its own; nothing to do on transient errors
}

export function disconnectEvents() {
	es?.close();
	es = null;
}
