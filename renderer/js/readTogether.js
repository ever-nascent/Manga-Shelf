// Client side of Read Together: one live copy of the session that the reader
// and the app banner both read from, so they can never disagree about what's
// running. Every change — someone else's, arriving over IPC, or our own from a
// command — lands as an 'rt-change' window event.

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

// Replies to our own commands say who we are in the session. Broadcasts can't
// (one frame goes to everyone), so remember the id from the reply and work the
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

window.api.onReadTogether((evt) => applyBroadcast(evt.session));

export async function refresh() {
	applyView(await window.api.getReadTogether());
	return session;
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
	return session;
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
	if (role !== 'host' && role !== 'guest') return;
	window.api.syncReadTogether(index, page, pages).catch(() => {});
}
