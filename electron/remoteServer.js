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
//   POST /pair        exchange the current pairing code for a session token
//   POST /api/<cmd>   run a registry command, body {args:[...]}
//   GET  /events      SSE stream: live queue snapshots + change pings
//   GET  /file?p=     serve a library image (covers/pages), path-checked
//   GET  /proxy?url=  fetch a cover/page from a manga CDN with the right
//                     headers (the CDNs reject plain phone-browser requests)

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { USER_AGENT, fetchWithTimeout, describeFetchError, IMAGE_TIMEOUT_MS } = require('./util');
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
	constructor({ library, api, downloader }) {
		this.library = library;
		this.api = api;
		this.downloader = downloader;
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
		this.lastSeenFlushed = new Map(); // device id -> when lastSeenAt last hit disk
		this.onInfoChanged = null; // main.js: pairing rotated or devices changed
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
		clearInterval(this.heartbeat);
		this.heartbeat = null;
		clearInterval(this.rotateTimer);
		this.rotateTimer = null;
		this.pairCode = null;
		this.prevPairCode = null;
		this.rotatesAt = 0;
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
			return this.json(res, 401, { ok: false, error: 'bad-code' });
		}
		this.pairFailures.delete(addr);
		const token = generateSessionToken();
		const device = {
			id: crypto.randomBytes(5).toString('hex'),
			name: sanitizeDeviceName(body.name) || 'Phone',
			tokenHash: hashToken(token),
			createdAt: new Date().toISOString(),
			lastSeenAt: new Date().toISOString()
		};
		this.library.setSettings({ remoteDevices: [...this.devices(), device] });
		this.onInfoChanged?.();
		this.json(res, 200, { ok: true, token, device: { id: device.id, name: device.name } });
	}

	// ---------- devices ----------

	devices() {
		return this.library.getSettings().remoteDevices || [];
	}

	connectedDeviceIds() {
		return new Set(this.sseClients.values());
	}

	revokeDevice(id) {
		this.library.setSettings({ remoteDevices: this.devices().filter((d) => d.id !== id) });
		for (const [client, deviceId] of this.sseClients) {
			if (deviceId === id) { client.end(); this.sseClients.delete(client); }
		}
		this.onInfoChanged?.();
	}

	revokeAll() {
		this.library.setSettings({ remoteDevices: [] });
		this.dropClients();
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

	authedDevice(req) {
		const header = req.headers.authorization || '';
		const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
		const cookie = /(?:^|;\s*)mstoken=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '')?.[1];
		const given = bearer || cookie;
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

	// ---------- live events ----------

	broadcastQueue(queue) {
		this.send('queue', queue);
	}

	broadcastChange(domain) {
		this.send('change', { domain });
	}

	send(event, data) {
		if (!this.sseClients.size) return;
		const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const client of this.sseClients.keys()) client.write(frame);
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
		if (u.pathname.startsWith('/api/')) return this.handleApi(req, res, u);
		if (u.pathname === '/events') return this.handleEvents(req, res);
		if (u.pathname === '/file') return this.handleFile(req, res, u);
		if (u.pathname === '/proxy') return this.handleProxy(req, res, u);
		return this.handleStatic(req, res, u);
	}

	async handleApi(req, res, u) {
		if (req.method !== 'POST') return this.json(res, 405, { ok: false, error: 'POST only' });
		if (!this.authedDevice(req)) return this.json(res, 401, { ok: false, error: 'unauthorized' });

		const cmd = decodeURIComponent(u.pathname.slice('/api/'.length));
		if (!this.api.commands[cmd]) return this.json(res, 404, { ok: false, error: `Unknown command: ${cmd}` });

		let args = [];
		try {
			const body = await readBody(req);
			if (body) args = JSON.parse(body).args || [];
		} catch {
			return this.json(res, 400, { ok: false, error: 'Bad JSON body' });
		}

		try {
			let result = await this.api.dispatch(cmd, args, 'remote');
			if (this.postMap[cmd]) result = this.postMap[cmd](result);
			this.json(res, 200, { ok: true, result: result ?? null });
		} catch (err) {
			this.json(res, 500, { ok: false, error: err.message });
		}
	}

	handleEvents(req, res) {
		const device = this.authedDevice(req);
		if (!device) return this.json(res, 401, { ok: false, error: 'unauthorized' });
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive'
		});
		res.write('retry: 3000\n\n');
		// current queue right away so the Downloads view never starts stale
		res.write(`event: queue\ndata: ${JSON.stringify(this.downloader.snapshot())}\n\n`);
		this.sseClients.set(res, device.id);
		this.onInfoChanged?.(); // the device just went "connected"
		req.on('close', () => {
			this.sseClients.delete(res);
			this.onInfoChanged?.();
		});
	}

	handleFile(req, res, u) {
		if (!this.authedDevice(req)) return this.json(res, 401, { ok: false, error: 'unauthorized' });
		const p = u.searchParams.get('p');
		if (!p) return this.json(res, 400, { ok: false, error: 'Missing path' });
		const abs = path.resolve(p);
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
		if (!this.authedDevice(req)) return this.json(res, 401, { ok: false, error: 'unauthorized' });
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
