// Small helpers shared by the API clients and the on-disk stores.

const fs = require('fs');
const os = require('os');

const USER_AGENT = 'MangaShelf/2.0 (personal desktop reader; github.com/LiterallyLink/Manga-Shelf)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Serializes requests to one host: each caller awaits its slot, slots are
// spaced gapMs apart.
function makeRateLimiter(gapMs) {
	let nextSlot = 0;
	return async function rateLimit() {
		const now = Date.now();
		const wait = Math.max(0, nextSlot - now);
		nextSlot = Math.max(now, nextSlot) + gapMs;
		if (wait > 0) await sleep(wait);
	};
}

// Node's fetch has no default timeout, so a socket that opens and then goes
// quiet hangs forever. That is worst in the downloader, which works through
// chapters strictly serially: one wedged request stalls the entire queue with
// no error and no retry. Every outbound request goes through here.
const API_TIMEOUT_MS = 15_000;
const IMAGE_TIMEOUT_MS = 45_000; // pages are megabytes; allow a slow-but-alive transfer

function fetchWithTimeout(url, options = {}, ms = API_TIMEOUT_MS) {
	return fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
}

// AbortSignal.timeout covers the body read too, not just the headers, so a
// transfer that stalls halfway also lands here rather than hanging.
function describeFetchError(err) {
	return err.name === 'TimeoutError' ? 'timed out' : err.message;
}

async function fetchImage(url, attempt = 1) {
	try {
		const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } }, IMAGE_TIMEOUT_MS);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return Buffer.from(await res.arrayBuffer());
	} catch (err) {
		// a timeout is as worth retrying as a bad status, and used not to be
		if (attempt <= 3) {
			await sleep(1000 * attempt);
			return fetchImage(url, attempt + 1);
		}
		throw new Error(`Image download failed (${describeFetchError(err)}): ${url}`);
	}
}

// Is this address on a local network (or this machine)? Only isDirectlyReachable
// below asks — a PC with no private address of its own is sitting on the
// internet rather than behind a router, which changes what "away" means.
// (Pairing is not gated on this: it works from any address, held off by the
// rotating code and the approval prompt. See remoteServer.handlePair.)
//
// Deliberately excludes carrier-grade NAT (100.64.0.0/10): that range sits
// between an ISP and a customer's router, never on a home LAN, so a request
// bearing it did not originate on this network. Fails closed — anything not
// recognizably local (global IPv6, unparseable) is treated as not-LAN.
function isLanAddress(addr) {
	if (!addr) return false;
	// Node reports IPv4-mapped IPv6 as e.g. ::ffff:192.168.1.5
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
	const ip = mapped ? mapped[1] : addr;
	if (ip === '::1') return true; // IPv6 loopback
	const parts = ip.split('.');
	if (parts.length !== 4) return false;
	const [a, b] = parts.map(Number);
	if (Number.isNaN(a) || Number.isNaN(b)) return false;
	if (a === 127) return true;                        // loopback
	if (a === 10) return true;                          // 10.0.0.0/8
	if (a === 192 && b === 168) return true;            // 192.168.0.0/16
	if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
	if (a === 169 && b === 254) return true;            // link-local
	return false;
}

// Every IPv4 this machine actually holds, loopback and virtual-internal aside.
function localIPv4s() {
	const out = [];
	for (const list of Object.values(os.networkInterfaces())) {
		for (const a of list || []) {
			if (a.family === 'IPv4' && !a.internal) out.push(a.address);
		}
	}
	return out;
}

// Some PCs sit straight on the internet rather than behind a home router — a
// modem in bridge mode, or an ISP that hands the machine a public address.
// Those have no private address at all, and it changes three things: there's no
// router to ask for a port forward (UPnP can only fail), the address a phone
// would use is already the internet address, and the server is reachable from
// outside whether or not the user ever ticked the "from the internet" box.
//
// A machine with any private address is treated as behind a router, which is
// the safe reading for the multi-homed case.
function isDirectlyReachable() {
	const addrs = localIPv4s();
	return addrs.length > 0 && addrs.every((ip) => !isLanAddress(ip));
}

// Write via temp file + rename so a crash mid-write can't leave a truncated
// file behind (a corrupt library.json would silently wipe the library).
function writeFileAtomic(file, data) {
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

module.exports = {
	USER_AGENT, sleep, makeRateLimiter, fetchImage, writeFileAtomic,
	isDirectlyReachable, fetchWithTimeout, describeFetchError, IMAGE_TIMEOUT_MS
};
