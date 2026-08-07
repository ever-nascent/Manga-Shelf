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

function announce(declined = false) {
	window.dispatchEvent(new CustomEvent('rt-change', { detail: { session, role, declined } }));
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

window.api.onReadTogether((evt) => applyBroadcast(evt.session));

export async function refresh() {
	applyView(await window.api.getReadTogether());
	return session;
}

// start() and join() are the only calls that come back with the chapter list,
// and the next broadcast replaces our copy with the light one — so they hand
// back the reply's session rather than the stored one. join() only carries
// chapters once the host has approved; before that it's a request, not a join.
export async function start(manga, chapters, index, gate) {
	const view = await window.api.startReadTogether(manga, chapters, index, gate);
	applyView(view);
	return view.session;
}

export async function join() {
	const view = await window.api.joinReadTogether();
	applyView(view);
	return view.session;
}

export async function leave() {
	applyView(await window.api.leaveReadTogether());
	return session;
}

export async function approve(id) { applyView(await window.api.approveReadTogether(id)); }
export async function deny(id) { applyView(await window.api.denyReadTogether(id)); }
export async function setGate(gate) { applyView(await window.api.setReadTogetherGate(gate)); }
export async function setChapter(index) { applyView(await window.api.setReadTogetherChapter(index)); }
export async function setReady(ready) { applyView(await window.api.setReadTogetherReady(ready)); }

export async function rename(name) {
	const clean = await window.api.renameSelf(name);
	await refresh();
	return clean;
}

// Where we are, pushed out. Fire-and-forget: the broadcast comes back around
// and updates our copy along with everyone else's. This never moves anyone
// else — it only says where we got to.
export function sync(index, page, pages) {
	if (role !== 'host' && role !== 'guest') return;
	window.api.syncReadTogether(index, page, pages).catch(() => {});
}
