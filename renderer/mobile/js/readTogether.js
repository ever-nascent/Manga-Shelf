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

function announce() {
	window.dispatchEvent(new CustomEvent('rt-change', { detail: { session, role } }));
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
	return session.participants.some((p) => p.id === myId) ? 'guest' : null;
}

function applyBroadcast(next) {
	session = next;
	role = deriveRole();
	announce();
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

// join() is the call that comes back with the chapter list, and the next push
// replaces our copy with the light one — so it hands back the reply's session
// rather than the stored one. (A phone is only ever a guest someone invited;
// the PC serves the library, so the PC hosts.)
export async function join() {
	const view = await rpc('rt:join');
	applyView(view);
	return view.session;
}

export async function leave() {
	applyView(await rpc('rt:leave'));
	return session;
}

export async function setReady(ready) { applyView(await rpc('rt:ready', ready)); }

// The server puts the new name on everyone's roster itself, so there's nothing
// to fetch back — asking again would only fire a second change for one edit.
export async function rename(name) {
	return rpc('device:rename', name);
}

// Where we are, pushed out. Fire-and-forget: the push comes back around and
// updates our copy along with everyone else's. This never moves anyone else —
// it only says where we got to.
export function sync(index, page, pages) {
	if (role !== 'host' && role !== 'guest') return;
	rpc('rt:sync', index, page, pages).catch(() => {});
}
