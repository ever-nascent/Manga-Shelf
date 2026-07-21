// LAN remote server: serves the mobile web UI and runs the same commands the
// desktop renderer uses, so a phone on the same Wi-Fi can browse, queue
// downloads on this PC, and read. Only the static app shell is public —
// every data route requires the link token shown in Settings.
//
// Routes:
//   GET  /            mobile app shell (renderer/mobile/)
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
const TOKEN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TOKEN_LENGTH = 8;

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

function generateToken() {
	const bytes = crypto.randomBytes(TOKEN_LENGTH);
	let out = '';
	for (let i = 0; i < TOKEN_LENGTH; i++) out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
	return out;
}

// constant-time compare via digests so length differences don't leak either
function tokenEquals(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
	const ha = crypto.createHash('sha256').update(a).digest();
	const hb = crypto.createHash('sha256').update(b).digest();
	return crypto.timingSafeEqual(ha, hb);
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
		this.sseClients = new Set();
		this.heartbeat = null;
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
						for (const client of this.sseClients) client.write(':hb\n\n');
					}, 25_000);
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
		this.dropClients();
		this.server.close();
		this.server = null;
	}

	// used on token regenerate: every linked phone must re-pair
	dropClients() {
		for (const client of this.sseClients) client.end();
		this.sseClients.clear();
	}

	broadcastQueue(queue) {
		this.send('queue', queue);
	}

	broadcastChange(domain) {
		this.send('change', { domain });
	}

	send(event, data) {
		if (!this.sseClients.size) return;
		const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const client of this.sseClients) client.write(frame);
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

	authed(req, u) {
		const stored = this.library.getSettings().remoteToken;
		const header = req.headers.authorization || '';
		const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
		const cookie = /(?:^|;\s*)mstoken=([A-Z2-9]+)/.exec(req.headers.cookie || '')?.[1];
		const given = bearer || u.searchParams.get('token') || cookie;
		return tokenEquals(given, stored);
	}

	json(res, status, obj) {
		res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
		res.end(JSON.stringify(obj));
	}

	async handle(req, res) {
		const u = new URL(req.url, `http://localhost:${this.port}`);
		res.setHeader('X-Content-Type-Options', 'nosniff');

		if (u.pathname.startsWith('/api/')) return this.handleApi(req, res, u);
		if (u.pathname === '/events') return this.handleEvents(req, res, u);
		if (u.pathname === '/file') return this.handleFile(req, res, u);
		if (u.pathname === '/proxy') return this.handleProxy(req, res, u);
		return this.handleStatic(req, res, u);
	}

	async handleApi(req, res, u) {
		if (req.method !== 'POST') return this.json(res, 405, { ok: false, error: 'POST only' });
		if (!this.authed(req, u)) return this.json(res, 401, { ok: false, error: 'unauthorized' });

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

	handleEvents(req, res, u) {
		if (!this.authed(req, u)) return this.json(res, 401, { ok: false, error: 'unauthorized' });
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive'
		});
		res.write('retry: 3000\n\n');
		// current queue right away so the Downloads view never starts stale
		res.write(`event: queue\ndata: ${JSON.stringify(this.downloader.snapshot())}\n\n`);
		this.sseClients.add(res);
		req.on('close', () => this.sseClients.delete(res));
	}

	handleFile(req, res, u) {
		if (!this.authed(req, u)) return this.json(res, 401, { ok: false, error: 'unauthorized' });
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
		if (!this.authed(req, u)) return this.json(res, 401, { ok: false, error: 'unauthorized' });
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

module.exports = { RemoteServer, generateToken };
