// The live copy of a read-together session, kept in one place so everything
// looking at it — the reader, the roster panel, the app's own listeners — can
// never disagree about what's running.
//
// Both front-ends hold their session exactly this way; what differs is how the
// news arrives (IPC on the desktop, an SSE push on the phone) and what each can
// ask for. Those live in each app's own readTogether.js, which drives this.
//
// Every change goes back out as an 'rt-change' window event.

let session = null;
let myId = null; // learned from the first per-caller reply; see applyView
let role = null; // 'host' | 'guest' | null

export function getSession() { return session; }
export function getRole() { return role; }
export function getMyId() { return myId; }

// Are we actually in this session, as opposed to watching one run elsewhere?
export function inSession() { return role === 'host' || role === 'guest'; }

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
export function applyView(view) {
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

export function applyBroadcast(next) {
	session = next;
	role = deriveRole();
	announce();
}

// Nobody at all: the phone was unlinked, and relinking gets a different device
// id, so our old place in anything is gone.
export function reset() {
	session = null;
	myId = null;
	role = null;
	announce();
}
