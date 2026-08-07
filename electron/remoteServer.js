// LAN remote server: serves the mobile web UI and runs the same commands the
// desktop renderer uses, so a phone on the same Wi-Fi can browse, queue
// downloads on this PC, and read. Only the static app shell is public.
// Linking is two-step: the phone trades the short-lived pairing code shown in
// Settings (rotates every minute) for its own long random session token, and
// every data route requires that token. Settings stores only token hashes, so
// nothing in the settings file can authenticate a device.
//
// Routes:
//   GET  /            mobile app shell (renderer/mobile/)
//   POST /pair        offer the current pairing code; unless approval is off,
//                     this only queues the device for the user to allow
//   GET  /pairstatus  collect the answer (and the token, once) for that request
//   GET  /awayinfo    where this PC is reachable from the internet (authed)
//   POST /api/<cmd>   run a registry command, body {args:[...]}
//   GET  /events      SSE stream: live queue snapshots, change pings, and
//                     read-together position updates
//   GET  /file?p=     serve a library image (covers/pages), path-checked
//   GET  /proxy?url=  fetch a cover/page from a manga CDN with the right
//                     headers (the CDNs reject plain phone-browser requests)

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { USER_AGENT, fetchWithTimeout, describeFetchError, IMAGE_TIMEOUT_MS, isDirectlyReachable } = require('./util');
const { makePostMap } = require('./api');

const DEFAULT_PORT = 8420;
const PORT_TRIES = 10;
const MOBILE_DIR = path.join(__dirname, '..', 'renderer', 'mobile');

// unambiguous alphabet (no 0/O, 1/I/L) — the code may be typed by hand
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIR_CODE_LENGTH = 8;
const PAIR_ROTATE_MS = 60_000;

// Guessing a pairing code costs failures, and failures cost time: a handful of
// misses locks that address out, and misses from everywhere at once (a code
// sprayer rotating addresses) lock pairing entirely for a while.
const PAIR_FAIL_LIMIT = 5;
const PAIR_FAIL_GLOBAL_LIMIT = 20;
const PAIR_FAIL_WINDOW_MS = 15 * 60_000;
const PAIR_LOCK_MS = 5 * 60_000;

// Knowing the code is one factor; saying yes at the PC is the other. It stops a
// code that leaked — shoulder-surfed, screenshotted, seen on a shared screen —
// from being worth anything later, and it means an attempt is something you
// find out about instead of something that happens silently.
const PAIR_APPROVAL_TTL_MS = 2 * 60_000;
// How long a decided request sticks around for the phone to collect its answer.
const PAIR_ANSWER_TTL_MS = 60_000;
// What the Settings screen reports as "recent"
const PAIR_ATTEMPT_WINDOW_MS = 60 * 60_000;

// An invite to read along is meant to be used in the next minute or two, by
// someone standing next to you or on the other end of a message.
const INVITE_TTL_MS = 10 * 60_000;
const MAX_INVITE_TTL_MS = 24 * 60 * 60_000;

// How long someone keeps their place in a session after their event stream
// drops. Long enough to cover a locked phone or a walk between rooms; short
// enough that someone who genuinely closed the tab stops holding the gate up.
const DISCONNECT_GRACE_MS = 90_000;

// Everything a read-together guest is allowed to ask for. Anything outside this
// is refused no matter what their client sends — the phone UI hiding the rest
// is a convenience, this is the actual boundary. Note there's no lib:all,
// no lib:get, no search, no downloads, and no reading progress: a guest can
// read the pages of the series being read together, and do nothing else.
const GUEST_COMMANDS = new Set([
	'rt:state', 'rt:join', 'rt:leave', 'rt:sync', 'rt:ready',
	'lib:pages', 'md:chapterImages', 'device:rename'
]);

const PROXY_HOSTS = /^(uploads\.mangadex\.org|[a-z0-9-]+\.mangadex\.network|i\d+\.mangakatana\.com|mangakatana\.com)$/;

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon'
};

function generatePairCode() {
	// rejection sampling: a plain byte % 31 would skew toward the alphabet's
	// start, since 256 isn't a multiple of 31
	const limit = 256 - (256 % PAIR_ALPHABET.length);
	let out = '';
	while (out.length < PAIR_CODE_LENGTH) {
		const [byte] = crypto.randomBytes(1);
		if (byte < limit) out += PAIR_ALPHABET[byte % PAIR_ALPHABET.length];
	}
	return out;
}

// what a phone actually holds after pairing; never persisted, only its hash is
function generateSessionToken() {
	return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
	return crypto.createHash('sha256').update(token).digest('hex');
}

// constant-time compare via digests so length differences don't leak either
function tokenEquals(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
	const ha = crypto.createHash('sha256').update(a).digest();
	const hb = crypto.createHash('sha256').update(b).digest();
	return crypto.timingSafeEqual(ha, hb);
}

// the phone names itself at pair time; it's untrusted input headed for the UI
function sanitizeDeviceName(name) {
	if (typeof name !== 'string') return '';
	return name.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 40);
}

function readBody(req, limit = 2 * 1024 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (c) => {
			size += c.length;
			if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
			chunks.push(c);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
		req.on('error', reject);
	});
}

class RemoteServer {
	constructor({ library, api, downloader, readTogether, isExposed }) {
		this.library = library;
		this.api = api;
		this.downloader = downloader;
		this.readTogether = readTogether;
		// Whether this PC can be reached from outside without a router forwarding
		// anything. Injectable so it can be pinned in tests rather than depending
		// on whatever network the machine running them happens to be on.
		this.isExposed = isExposed || isDirectlyReachable;
		this.server = null;
		this.port = DEFAULT_PORT;
		this.sseClients = new Map(); // res -> device id, so revoke can drop just that phone
		this.heartbeat = null;
		this.pairCode = null;
		this.prevPairCode = null;
		this.rotatesAt = 0;
		this.rotateTimer = null;
		this.pairFailures = new Map(); // remote address -> { count, firstAt, lockedUntil }
		this.globalFailures = { count: 0, firstAt: 0, lockedUntil: 0 };
		this.pendingPairs = new Map(); // requestId -> a device waiting to be let in
		this.pairAttempts = []; // { at, addr, outcome } — what Settings reports
		this.onPairRequest = null; // main.js: ask the user about a new device
		// Read-together guests: someone invited to read along, and nothing else.
		// Never written to disk and never a linked device — the token is only
		// good for the session it was minted for, so it dies when that ends.
		this.guests = new Map(); // token hash -> { id, name, sessionId }
		this.invites = new Map(); // code -> { sessionId, expiresAt }
		this.dropTimers = new Map(); // actor id -> pending "they really did leave"
		this.lastSeenFlushed = new Map(); // device id -> when lastSeenAt last hit disk
		this.onInfoChanged = null; // main.js: pairing rotated or devices changed
		this.awayUrl = null; // main.js: () => current internet URL while mapped
		// phones can't read mangafile:// — local files go through /file instead
		this.postMap = makePostMap(library, (abs) => '/file?p=' + encodeURIComponent(abs));
	}

	isRunning() {
		return Boolean(this.server?.listening);
	}

	start() {
		if (this.server) return Promise.resolve(this.port);
		return new Promise((resolve, reject) => {
			const server = http.createServer((req, res) => {
				this.handle(req, res).catch((err) => {
					if (!res.headersSent) this.json(res, 500, { ok: false, error: err.message });
					else res.end();
				});
			});
			let tries = 0;
			// Both listeners must come off on every outcome. Passing the success
			// callback to listen() instead registers a 'listening' handler that a
			// failed attempt leaves behind, so the next port's success fires the
			// stale one too: start() resolved the port we didn't get, and each
			// retry started a heartbeat that stop() could no longer clear.
			const tryListen = (port) => {
				const onError = (err) => {
					server.removeListener('listening', onListening);
					if (err.code === 'EADDRINUSE' && ++tries < PORT_TRIES) tryListen(port + 1);
					else { this.server = null; reject(err); }
				};
				const onListening = () => {
					server.removeListener('error', onError);
					this.port = port;
					this.server = server;
					// SSE connections idle for long stretches; a periodic comment
					// stops phones and routers from silently dropping them
					this.heartbeat = setInterval(() => {
						for (const client of this.sseClients.keys()) client.write(':hb\n\n');
					}, 25_000);
					this.rotatePairCode();
					this.rotateTimer = setInterval(() => this.rotatePairCode(), PAIR_ROTATE_MS);
					resolve(port);
				};
				server.once('error', onError);
				server.once('listening', onListening);
				server.listen(port, '0.0.0.0');
			};
			tryListen(DEFAULT_PORT);
		});
	}

	stop() {
		if (!this.server) return;
		// with the server down nobody can join or follow, so a session that
		// outlived it would just be a stuck banner on the desktop
		this.readTogether?.end();
		clearInterval(this.heartbeat);
		this.heartbeat = null;
		clearInterval(this.rotateTimer);
		this.rotateTimer = null;
		this.pairCode = null;
		this.prevPairCode = null;
		this.rotatesAt = 0;
		this.pendingPairs.clear(); // nobody can collect an answer with the server down
		for (const t of this.dropTimers.values()) clearTimeout(t);
		this.dropTimers.clear();
		this.dropClients();
		this.server.close();
		this.server = null;
	}

	dropClients() {
		for (const client of this.sseClients.keys()) client.end();
		this.sseClients.clear();
	}

	// ---------- pairing ----------

	rotatePairCode() {
		this.prevPairCode = this.pairCode;
		this.pairCode = generatePairCode();
		this.rotatesAt = Date.now() + PAIR_ROTATE_MS;
		this.onInfoChanged?.();
	}

	pairingInfo() {
		return { code: this.pairCode, rotatesAt: this.rotatesAt };
	}

	pairingLocked(addr) {
		const now = Date.now();
		return (this.pairFailures.get(addr)?.lockedUntil || 0) > now || this.globalFailures.lockedUntil > now;
	}

	registerPairFailure(addr) {
		const now = Date.now();
		if (!this.pairFailures.has(addr)) this.pairFailures.set(addr, { count: 0, firstAt: now, lockedUntil: 0 });
		const bump = (rec, limit) => {
			if (now - rec.firstAt > PAIR_FAIL_WINDOW_MS) { rec.count = 0; rec.firstAt = now; }
			if (++rec.count >= limit) { rec.lockedUntil = now + PAIR_LOCK_MS; rec.count = 0; rec.firstAt = now; }
		};
		bump(this.pairFailures.get(addr), PAIR_FAIL_LIMIT);
		bump(this.globalFailures, PAIR_FAIL_GLOBAL_LIMIT);
	}

	async handlePair(req, res) {
		if (req.method !== 'POST') return this.json(res, 405, { ok: false, error: 'POST only' });
		const addr = req.socket.remoteAddress || 'unknown';
		// Pairing works from any address — the home page and the away page link
		// the same way, by typing (or scanning) the current code. A remote
		// guesser is held off by the code itself: 8 chars rotating every 60s,
		// with per-address and global failure lockouts below.
		if (this.pairingLocked(addr)) {
			return this.json(res, 429, { ok: false, error: 'locked' });
		}
		let body = {};
		try {
			const raw = await readBody(req);
			if (raw) body = JSON.parse(raw);
		} catch {
			return this.json(res, 400, { ok: false, error: 'Bad JSON body' });
		}
		const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
		// the previous code stays good for one extra window, so a QR scanned
		// moments before rotation still links
		if (!tokenEquals(code, this.pairCode ?? '') && !tokenEquals(code, this.prevPairCode ?? '')) {
			this.registerPairFailure(addr);
			this.noteAttempt(addr, 'bad-code');
			this.onInfoChanged?.();
			return this.json(res, 401, { ok: false, error: 'bad-code' });
		}
		this.pairFailures.delete(addr);
		const name = sanitizeDeviceName(body.name) || 'Phone';

		// The code alone used to be enough. Unless the user has turned approval
		// off on a private network, it now only buys a place in the queue.
		if (this.requiresApproval()) {
			this.prunePendingPairs();
			// The request id IS the claim ticket for the token, so it has to be
			// as unguessable as the token itself.
			const requestId = crypto.randomBytes(32).toString('base64url');
			const request = { id: requestId, name, addr, at: Date.now(), state: 'pending' };
			this.pendingPairs.set(requestId, request);
			this.noteAttempt(addr, 'asked');
			this.onPairRequest?.({ requestId, name, addr });
			this.onInfoChanged?.();
			return this.json(res, 200, {
				ok: true,
				pending: true,
				requestId,
				expiresInMs: PAIR_APPROVAL_TTL_MS
			});
		}

		this.noteAttempt(addr, 'linked');
		const { token, device } = this.createDevice(name);
		this.json(res, 200, { ok: true, token, device: { id: device.id, name: device.name } });
	}

	// Approval is the user's choice on a private network, but not once the
	// server is reachable from the internet — there, a code that leaked would
	// otherwise be enough for anyone, from anywhere. That's true whether the
	// user asked for internet access or simply has a PC that sits on it.
	requiresApproval() {
		const s = this.library.getSettings();
		if (s.remoteAnywhere || this.isExposed()) return true;
		return s.approveNewDevices !== false;
	}

	createDevice(name) {
		const token = generateSessionToken();
		const device = {
			id: crypto.randomBytes(5).toString('hex'),
			name,
			tokenHash: hashToken(token),
			createdAt: new Date().toISOString(),
			lastSeenAt: new Date().toISOString()
		};
		this.library.setSettings({ remoteDevices: [...this.devices(), device] });
		this.onInfoChanged?.();
		return { token, device };
	}

	// ---------- approving a new device ----------

	// The phone holds only a request id and asks here until it's answered. The
	// token is handed over exactly once, then the request is dropped.
	handlePairStatus(req, res, u) {
		this.prunePendingPairs();
		const request = this.pendingPairs.get(u.searchParams.get('id') || '');
		if (!request) return this.json(res, 404, { ok: false, error: 'expired' });
		if (request.state === 'pending') return this.json(res, 200, { ok: true, state: 'pending' });
		this.pendingPairs.delete(request.id);
		if (request.state === 'denied') return this.json(res, 403, { ok: false, error: 'denied' });
		this.json(res, 200, {
			ok: true,
			state: 'approved',
			token: request.token,
			device: { id: request.device.id, name: request.device.name }
		});
	}

	pendingPairList() {
		this.prunePendingPairs();
		return [...this.pendingPairs.values()]
			.filter((r) => r.state === 'pending')
			.map((r) => ({ requestId: r.id, name: r.name, addr: r.addr, at: r.at }));
	}

	approvePair(requestId) {
		const request = this.pendingPairs.get(requestId);
		if (!request || request.state !== 'pending') return false;
		const { token, device } = this.createDevice(request.name);
		Object.assign(request, { state: 'approved', token, device, decidedAt: Date.now() });
		this.noteAttempt(request.addr, 'allowed');
		this.onInfoChanged?.();
		return true;
	}

	denyPair(requestId) {
		const request = this.pendingPairs.get(requestId);
		if (!request || request.state !== 'pending') return false;
		Object.assign(request, { state: 'denied', decidedAt: Date.now() });
		this.noteAttempt(request.addr, 'denied');
		this.onInfoChanged?.();
		return true;
	}

	prunePendingPairs() {
		const now = Date.now();
		for (const [id, r] of this.pendingPairs) {
			const stale = r.state === 'pending'
				? now - r.at > PAIR_APPROVAL_TTL_MS
				: now - r.decidedAt > PAIR_ANSWER_TTL_MS;
			if (stale) this.pendingPairs.delete(id);
		}
	}

	// A short history of who tried to link, so a stranger guessing at the code
	// is something the Settings screen can actually show you.
	noteAttempt(addr, outcome) {
		const now = Date.now();
		this.pairAttempts.push({ at: now, addr, outcome });
		this.pairAttempts = this.pairAttempts.filter((a) => now - a.at < PAIR_ATTEMPT_WINDOW_MS);
	}

	recentAttempts() {
		const now = Date.now();
		this.pairAttempts = this.pairAttempts.filter((a) => now - a.at < PAIR_ATTEMPT_WINDOW_MS);
		return this.pairAttempts.slice(-20);
	}

	// A linked phone asks where this PC is reachable from the internet, so the
	// home-address page can hand its session to that origin (mobile app.js).
	handleAwayInfo(req, res) {
		if (!this.authedDevice(req)) return this.json(res, 401, { ok: false, error: 'unauthorized' });
		this.json(res, 200, { ok: true, url: this.awayUrl?.() || null });
	}

	// ---------- devices ----------

	devices() {
		return this.library.getSettings().remoteDevices || [];
	}

	// A phone suspends its event stream whenever the screen locks or the reader
	// goes to the background, and it reconnects seconds later. Treating that as
	// "they left" would drop someone out of a session for glancing at a message
	// — and silently, since their reader carries on working. So a closed stream
	// only starts a clock.
	scheduleDrop(id) {
		this.cancelDrop(id);
		this.dropTimers.set(id, setTimeout(() => {
			this.dropTimers.delete(id);
			if (this.connectedIds().has(id)) return; // came back on another stream
			this.readTogether?.dropDevice(id);
			this.onInfoChanged?.();
		}, DISCONNECT_GRACE_MS));
	}

	cancelDrop(id) {
		const t = this.dropTimers.get(id);
		if (t) { clearTimeout(t); this.dropTimers.delete(id); }
	}

	// linked devices only — this is what the Settings list shows as "connected"
	connectedDeviceIds() {
		return new Set([...this.sseClients.values()].filter((a) => a.kind === 'device').map((a) => a.id));
	}

	// everyone holding a stream, guests included
	connectedIds() {
		return new Set([...this.sseClients.values()].map((a) => a.id));
	}

	revokeDevice(id) {
		this.library.setSettings({ remoteDevices: this.devices().filter((d) => d.id !== id) });
		for (const [client, actor] of this.sseClients) {
			if (actor.id === id) { client.end(); this.sseClients.delete(client); }
		}
		this.readTogether?.dropDevice(id);
		this.onInfoChanged?.();
	}

	revokeAll() {
		this.library.setSettings({ remoteDevices: [] });
		this.dropClients();
		this.readTogether?.end();
		this.onInfoChanged?.();
	}

	// lastSeenAt would hit the settings file on every request; once a minute
	// per device is plenty for a "last seen" label
	touchDevice(id) {
		const now = Date.now();
		if (now - (this.lastSeenFlushed.get(id) || 0) < 60_000) return;
		this.lastSeenFlushed.set(id, now);
		this.library.setSettings({
			remoteDevices: this.devices().map((d) => (d.id === id ? { ...d, lastSeenAt: new Date(now).toISOString() } : d))
		});
	}

	presentedToken(req) {
		const header = req.headers.authorization || '';
		const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
		const cookie = /(?:^|;\s*)mstoken=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '')?.[1];
		return bearer || cookie || null;
	}

	authedDevice(req) {
		const given = this.presentedToken(req);
		if (!given) return null;
		const digest = crypto.createHash('sha256').update(given).digest();
		for (const device of this.devices()) {
			const stored = Buffer.from(device.tokenHash || '', 'hex');
			if (stored.length === digest.length && crypto.timingSafeEqual(digest, stored)) {
				this.touchDevice(device.id);
				return device;
			}
		}
		return null;
	}

	// A guest's token is only ever valid for the one session it was minted for.
	// Nothing needs cleaning up when a session ends — the id stops matching and
	// every token from it is dead.
	authedGuest(req) {
		const given = this.presentedToken(req);
		if (!given) return null;
		const guest = this.guests.get(hashToken(given));
		if (!guest) return null;
		if (guest.sessionId !== this.readTogether?.session?.id) return null;
		return guest;
	}

	// Who is making this request: a linked device, or someone invited to read
	// along. `kind` is what every restriction below keys off.
	authedActor(req) {
		const device = this.authedDevice(req);
		if (device) return { id: device.id, name: device.name, kind: 'device' };
		const guest = this.authedGuest(req);
		return guest ? { id: guest.id, name: guest.name, kind: 'guest' } : null;
	}

	// ---------- inviting someone to read along ----------

	// The host makes one of these deliberately and decides how far it stretches:
	// an invite good for one person can't be forwarded to a crowd, which is the
	// job a per-guest approval prompt would otherwise be doing.
	createInvite({ maxUses = 1, ttlMs = INVITE_TTL_MS } = {}) {
		const session = this.readTogether?.session;
		if (!session) throw new Error('Start reading together first.');
		this.pruneInvites();
		const code = generatePairCode();
		const expiresAt = Date.now() + Math.max(60_000, Math.min(Number(ttlMs) || INVITE_TTL_MS, MAX_INVITE_TTL_MS));
		// 0 means no limit; anything else is clamped to something sane
		const uses = Math.max(0, Math.min(Math.trunc(Number(maxUses)) || 0, 50));
		this.invites.set(code, { sessionId: session.id, expiresAt, maxUses: uses, used: 0 });
		// Reachable from wherever the guest actually is. A guest token is a far
		// smaller thing to expose than a device token — one series, read-only,
		// and dead the moment the host closes the book.
		const url = this.awayUrl?.() || this.bestUrl();
		return { code, url, expiresAt, maxUses: uses };
	}

	pruneInvites() {
		const now = Date.now();
		const liveSession = this.readTogether?.session?.id;
		for (const [code, inv] of this.invites) {
			const spent = inv.maxUses > 0 && inv.used >= inv.maxUses;
			if (inv.expiresAt < now || spent || inv.sessionId !== liveSession) this.invites.delete(code);
		}
		for (const [hash, g] of this.guests) {
			if (g.sessionId !== liveSession) this.guests.delete(hash);
		}
	}

	inviteSummary() {
		this.pruneInvites();
		return [...this.invites.entries()].map(([code, inv]) => ({
			code,
			expiresAt: inv.expiresAt,
			maxUses: inv.maxUses,
			used: inv.used
		}));
	}

	revokeInvite(code) {
		return this.invites.delete(code);
	}

	async handleGuest(req, res) {
		if (req.method !== 'POST') return this.json(res, 405, { ok: false, error: 'POST only' });
		const addr = req.socket.remoteAddress || 'unknown';
		// An invite code is as guessable as a pairing code, so it earns the same
		// lockouts rather than a fresh guessing budget.
		if (this.pairingLocked(addr)) return this.json(res, 429, { ok: false, error: 'locked' });

		let body = {};
		try {
			const raw = await readBody(req);
			if (raw) body = JSON.parse(raw);
		} catch {
			return this.json(res, 400, { ok: false, error: 'Bad JSON body' });
		}
		this.pruneInvites();
		const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
		const invite = this.invites.get(code);
		const session = this.readTogether?.session;
		if (!invite || !session || invite.sessionId !== session.id) {
			this.registerPairFailure(addr);
			return this.json(res, 401, { ok: false, error: 'bad-code' });
		}
		if (invite.maxUses > 0 && invite.used >= invite.maxUses) {
			return this.json(res, 410, { ok: false, error: 'used-up' });
		}
		this.pairFailures.delete(addr);
		invite.used++;
		if (invite.maxUses > 0 && invite.used >= invite.maxUses) this.invites.delete(code);

		const token = generateSessionToken();
		const guest = {
			id: `g${crypto.randomBytes(5).toString('hex')}`,
			name: sanitizeDeviceName(body.name) || 'Guest',
			sessionId: session.id
		};
		this.guests.set(hashToken(token), guest);
		// the invite was the host's yes; joining doesn't need a second one
		this.readTogether.addGuest(guest);
		this.onInfoChanged?.();
		this.json(res, 200, { ok: true, token, guest: { id: guest.id, name: guest.name } });
	}

	// ---------- what a guest may do ----------

	// The session's own chapters, and nothing else in the library. Without this
	// a guest could hand any id to lib:pages and read whatever they liked.
	guestMayReadChapter(chapterId) {
		const session = this.readTogether?.session;
		return Boolean(session) && session.chapters.some((c) => c.id === chapterId);
	}

	guestArgsAllowed(cmd, args) {
		if (cmd === 'lib:pages') {
			const [mangaId, chapterId] = args;
			return mangaId === this.readTogether?.session?.manga.id && this.guestMayReadChapter(chapterId);
		}
		if (cmd === 'md:chapterImages') return this.guestMayReadChapter(args[0]);
		return true;
	}

	// Local page files live under the manga's own folder; a guest gets that
	// folder and no other part of the library.
	guestMayReadFile(abs) {
		const session = this.readTogether?.session;
		const entry = session && this.library.get(session.manga.id);
		if (!entry?.path) return false;
		const root = path.resolve(entry.path);
		return abs === root || abs.startsWith(root + path.sep);
	}

	// ---------- live events ----------

	broadcastQueue(queue) {
		this.send('queue', queue);
	}

	broadcastChange(domain) {
		this.send('change', { domain });
	}

	broadcastReadTogether(evt) {
		this.send('rt', evt);
	}

	send(event, data) {
		if (!this.sseClients.size) return;
		const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const [client, actor] of this.sseClients) {
			// a guest hears about the session and nothing else going on here
			if (actor.kind === 'guest' && event !== 'rt') continue;
			client.write(frame);
		}
	}

	// The address a phone should use. Multiple NICs are common (VPN, virtual
	// adapters) — prefer the classic home-LAN ranges.
	bestUrl() {
		const addrs = [];
		for (const list of Object.values(os.networkInterfaces())) {
			for (const a of list || []) {
				if (a.family === 'IPv4' && !a.internal) addrs.push(a.address);
			}
		}
		const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
		addrs.sort((a, b) => rank(a) - rank(b));
		return `http://${addrs[0] || 'localhost'}:${this.port}`;
	}

	json(res, status, obj) {
		res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
		res.end(JSON.stringify(obj));
	}

	async handle(req, res) {
		const u = new URL(req.url, `http://localhost:${this.port}`);
		res.setHeader('X-Content-Type-Options', 'nosniff');

		if (u.pathname === '/pair') return this.handlePair(req, res);
		if (u.pathname === '/pairstatus') return this.handlePairStatus(req, res, u);
		if (u.pathname === '/guest') return this.handleGuest(req, res);
		if (u.pathname === '/awayinfo') return this.handleAwayInfo(req, res);
		if (u.pathname.startsWith('/api/')) return this.handleApi(req, res, u);
		if (u.pathname === '/events') return this.handleEvents(req, res);
		if (u.pathname === '/file') return this.handleFile(req, res, u);
		if (u.pathname === '/proxy') return this.handleProxy(req, res, u);
		return this.handleStatic(req, res, u);
	}

	async handleApi(req, res, u) {
		if (req.method !== 'POST') return this.json(res, 405, { ok: false, error: 'POST only' });
		const actor = this.authedActor(req);
		if (!actor) return this.json(res, 401, { ok: false, error: 'unauthorized' });

		const cmd = decodeURIComponent(u.pathname.slice('/api/'.length));
		if (!this.api.commands[cmd]) return this.json(res, 404, { ok: false, error: `Unknown command: ${cmd}` });

		let args = [];
		try {
			const body = await readBody(req);
			if (body) args = JSON.parse(body).args || [];
		} catch {
			return this.json(res, 400, { ok: false, error: 'Bad JSON body' });
		}

		// A guest is here to read one series with someone, not to browse a
		// library that isn't theirs. Enforced here rather than in their UI,
		// because their UI is not something we control.
		if (actor.kind === 'guest') {
			if (!GUEST_COMMANDS.has(cmd) || !this.guestArgsAllowed(cmd, args)) {
				return this.json(res, 403, { ok: false, error: 'Not allowed for guests' });
			}
		}

		try {
			// the caller's identity — read-together needs to know who is hosting,
			// who just turned a page, and who is only a guest
			let result = await this.api.dispatch(cmd, args, 'remote', actor);
			if (this.postMap[cmd]) result = this.postMap[cmd](result);
			this.json(res, 200, { ok: true, result: result ?? null });
		} catch (err) {
			this.json(res, 500, { ok: false, error: err.message });
		}
	}

	handleEvents(req, res) {
		const actor = this.authedActor(req);
		if (!actor) return this.json(res, 401, { ok: false, error: 'unauthorized' });
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive'
		});
		res.write('retry: 3000\n\n');
		// the download queue is the owner's business, not a guest's
		if (actor.kind === 'device') {
			res.write(`event: queue\ndata: ${JSON.stringify(this.downloader.snapshot())}\n\n`);
		}
		// whatever is being read together, so a reconnecting client doesn't sit
		// there thinking nothing is running
		if (this.readTogether?.active()) {
			res.write(`event: rt\ndata: ${JSON.stringify({ type: 'started', session: this.readTogether.snapshot() })}\n\n`);
		}
		this.cancelDrop(actor.id); // they're back before the grace period ran out
		this.sseClients.set(res, actor);
		this.onInfoChanged?.(); // this client just went "connected"
		req.on('close', () => {
			this.sseClients.delete(res);
			// A reconnecting phone briefly holds two streams, and the old one can
			// close after the new one opens — only count it as gone once its last
			// stream is down, or a blip would drop it from the session.
			if (!this.connectedIds().has(actor.id)) this.scheduleDrop(actor.id);
			this.onInfoChanged?.();
		});
	}

	handleFile(req, res, u) {
		const actor = this.authedActor(req);
		if (!actor) return this.json(res, 401, { ok: false, error: 'unauthorized' });
		const p = u.searchParams.get('p');
		if (!p) return this.json(res, 400, { ok: false, error: 'Missing path' });
		const abs = path.resolve(p);
		// Pages of the shared series only — the rest of the library isn't theirs.
		// Checked before the file is looked at, so probing can't tell a guest
		// which paths exist.
		if (actor.kind === 'guest' && !this.guestMayReadFile(abs)) {
			return this.json(res, 403, { ok: false, error: 'Not allowed for guests' });
		}
		if (!this.library.isAllowedPath(abs) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
			return this.json(res, 404, { ok: false, error: 'Not found' });
		}
		res.writeHead(200, {
			'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
			'Cache-Control': 'private, max-age=86400'
		});
		fs.createReadStream(abs).pipe(res);
	}

	async handleProxy(req, res, u) {
		// guests included: streamed pages come through here, and the host
		// allowlist below already limits this to manga CDNs
		if (!this.authedActor(req)) return this.json(res, 401, { ok: false, error: 'unauthorized' });
		let target;
		try {
			target = new URL(u.searchParams.get('url'));
		} catch {
			return this.json(res, 400, { ok: false, error: 'Bad url' });
		}
		if (target.protocol !== 'https:' || !PROXY_HOSTS.test(target.hostname)) {
			return this.json(res, 403, { ok: false, error: 'Host not allowed' });
		}
		let upstream;
		try {
			upstream = await fetchWithTimeout(target, { headers: { 'User-Agent': USER_AGENT } }, IMAGE_TIMEOUT_MS);
		} catch (err) {
			// without this the phone's <img> just spins forever on a dead CDN
			return this.json(res, 504, { ok: false, error: `Upstream ${describeFetchError(err)}` });
		}
		if (!upstream.ok) return this.json(res, 502, { ok: false, error: `Upstream ${upstream.status}` });
		const buf = Buffer.from(await upstream.arrayBuffer());
		res.writeHead(200, {
			'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
			'Cache-Control': 'private, max-age=3600'
		});
		res.end(buf);
	}

	handleStatic(req, res, u) {
		const rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
		const abs = path.normalize(path.join(MOBILE_DIR, rel));
		if (!abs.startsWith(MOBILE_DIR + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
			res.writeHead(404, { 'Content-Type': 'text/plain' });
			return res.end('Not found');
		}
		res.writeHead(200, {
			'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
			// always revalidate: the shell must never lag behind the app version
			'Cache-Control': 'no-cache'
		});
		fs.createReadStream(abs).pipe(res);
	}
}

module.exports = { RemoteServer };
