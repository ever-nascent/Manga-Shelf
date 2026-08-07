// Client side of Read Together, mirroring the desktop renderer's copy: one
// live view of the session that both the reader and the join banner read from.
// Changes arrive either as our own command replies or as 'rt-event' pushes off
// the SSE stream, and go back out as an 'rt-change' window event.

import { rpc } from './api.js';

let session = null;
let myId = null; // learned from the first per-caller reply; see applyView
let role = null; // 'host' | 'guest' | 'pending' | null

export function getSession() { return session; }
export function getRole() { return role; }
export function getMyId() { return myId; }

// our own row on the roster, which is where our page and ready state live
export function me() {
	return session?.participants.find((p) => p.id === myId) || null;
}

function announce(declined = false) {
	window.dispatchEvent(new CustomEvent('rt-change', { detail: { session, role, declined } }));
}

// Replies to our own commands say who we are in the session. Pushes can't (one
// frame goes to every phone), so remember the id from the reply and work the
// role out of the roster from then on.
function applyView(view) {
	session = view.session;
	myId = view.you.id || myId;
	role = view.you.role;
	announce();
}

function deriveRole() {
	if (!session || !myId) return null;
	if (session.hostId === myId) return 'host';
	if (session.participants.some((p) => p.id === myId)) return 'guest';
	return session.pending.some((p) => p.id === myId) ? 'pending' : null;
}

function applyBroadcast(next) {
	const wasPending = role === 'pending';
	session = next;
	role = deriveRole();
	// dropped from the queue while the session carries on: the host said no
	announce(wasPending && role === null && Boolean(session));
}

window.addEventListener('rt-event', (e) => applyBroadcast(e.detail.session));

// unlinked: this phone is nobody now, and a relink gets a different device id
export function reset() {
	session = null;
	myId = null;
	role = null;
	announce();
}

export async function refresh() {
	applyView(await rpc('rt:state'));
	return session;
}

// start() and join() are the only calls that come back with the chapter list,
// and the next push replaces our copy with the light one — so they hand back
// the reply's session rather than the stored one. join() only carries chapters
// once the host has approved; before that it's a request, not a join.
export async function start(manga, chapters, index, gate) {
	const view = await rpc('rt:start', manga, chapters, index, gate);
	applyView(view);
	return view.session;
}

export async function join() {
	const view = await rpc('rt:join');
	applyView(view);
	return view.session;
}

export async function leave() {
	applyView(await rpc('rt:leave'));
	return session;
}

export async function approve(id) { applyView(await rpc('rt:approve', id)); }
export async function deny(id) { applyView(await rpc('rt:deny', id)); }
export async function setGate(gate) { applyView(await rpc('rt:gate', gate)); }
export async function setChapter(index) { applyView(await rpc('rt:chapter', index)); }
export async function setReady(ready) { applyView(await rpc('rt:ready', ready)); }

export async function rename(name) {
	const clean = await rpc('device:rename', name);
	await refresh();
	return clean;
}

// Where we are, pushed out. Fire-and-forget: the push comes back around and
// updates our copy along with everyone else's. This never moves anyone else —
// it only says where we got to.
export function sync(index, page, pages) {
	if (role !== 'host' && role !== 'guest') return;
	rpc('rt:sync', index, page, pages).catch(() => {});
}
