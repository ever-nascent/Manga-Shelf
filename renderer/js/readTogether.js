// Read Together, desktop side: what this app can ask for, and where the news
// arrives. The session itself is held in renderer/shared/rtSession.js, which the
// phone uses too — see there for how a role is worked out and how changes go
// out as 'rt-change'.

import { applyView, applyBroadcast, getSession, getRole, getMyId, me, inSession } from '../shared/rtSession.js';

export { getSession, getRole, getMyId, me };

window.api.onReadTogether((evt) => applyBroadcast(evt.session));

export async function refresh() {
	applyView(await window.api.getReadTogether());
	return getSession();
}

// start() is the only call that comes back with the chapter list, and the next
// broadcast replaces our copy with the light one — so it hands back the reply's
// session rather than the stored one. (Joining is a guest's move, and a guest is
// always a phone: this PC serves the library, so this PC hosts.)
export async function start(manga, chapters, index, gate) {
	const view = await window.api.startReadTogether(manga, chapters, index, gate);
	applyView(view);
	return view.session;
}

export async function leave() {
	applyView(await window.api.leaveReadTogether());
	return getSession();
}

export async function setGate(gate) { applyView(await window.api.setReadTogetherGate(gate)); }
export async function setReady(ready) { applyView(await window.api.setReadTogetherReady(ready)); }

// Showing someone out without ending the session for everyone else. The host's
// call, and the roster panel is where they make it.
export async function kick(id) { applyView(await window.api.kickFromReadTogether(id)); }

// The server puts the new name on everyone's roster itself, so there's nothing
// to fetch back — asking again would only fire a second change for one edit.
export async function rename(name) {
	return window.api.renameSelf(name);
}

// Where we are, pushed out. Fire-and-forget: the broadcast comes back around
// and updates our copy along with everyone else's. This never moves anyone
// else — it only says where we got to.
export function sync(index, page, pages) {
	if (!inSession()) return;
	window.api.syncReadTogether(index, page, pages).catch(() => {});
}
