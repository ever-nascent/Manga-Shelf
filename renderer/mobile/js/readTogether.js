// Read Together, phone side: what this app can ask for, and where the news
// arrives. The session itself is held in the shared rtSession.js that the
// desktop uses too — see there for how a role is worked out and how changes go
// out as 'rt-change'.

import { applyView, applyBroadcast, getSession, getRole, getMyId, me, inSession, reset } from '/shared/rtSession.js';
import { rpc } from './api.js';

export { getSession, getRole, getMyId, me, reset };

window.addEventListener('rt-event', (e) => applyBroadcast(e.detail.session));

export async function refresh() {
	applyView(await rpc('rt:state'));
	return getSession();
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
	return getSession();
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
	if (!inSession()) return;
	rpc('rt:sync', index, page, pages).catch(() => {});
}
