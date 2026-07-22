// UPnP port mapping, dependency-free: discover the router over SSDP, then ask
// it via SOAP to forward our port. This is what makes "read from anywhere"
// work with nothing but the app — no tunnel binaries, no accounts, no relay.
// The router even tells us our public address (GetExternalIPAddress), so no
// what's-my-ip web service is involved either.
//
// The hard truth this module has to surface honestly: on ISPs that use
// carrier-grade NAT the router's "external" address is itself private, the
// mapping leads nowhere, and no code on this PC can fix that. The 'blocked'
// status names that case so the UI can explain instead of pretending.

const dgram = require('dgram');
const http = require('http');
const os = require('os');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const DISCOVER_MS = 4000;
const DISCOVER_RESEND_MS = 1200;
const SOAP_TIMEOUT_MS = 5000;
// Measured, not guessed: a router installing its FIRST mapping for a port can
// sit on AddPortMapping for 10+ seconds before answering 200 (it builds the
// firewall rule first, then replies). Reads like GetExternalIPAddress answer
// in milliseconds and keep the short timeout.
const MAPPING_TIMEOUT_MS = 15000;
const MAP_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 1000;
const PORT_SCAN_TRIES = 10; // matches RemoteServer's own port hunt
const LEASE_SECONDS = 7200;
const RENEW_MS = 3600_000; // re-add halfway through the lease
const DESCRIPTION = 'MangaShelf remote';

const WAN_SERVICE = /urn:schemas-upnp-org:service:WAN(IP|PPP)Connection:\d/;

function lanAddresses() {
	const addrs = [];
	for (const list of Object.values(os.networkInterfaces())) {
		for (const a of list || []) {
			if (a.family === 'IPv4' && !a.internal) addrs.push(a.address);
		}
	}
	return addrs;
}

// same preference order as RemoteServer.bestUrl: classic home-LAN ranges first
function lanAddress() {
	const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
	return lanAddresses().sort((a, b) => rank(a) - rank(b))[0] || null;
}

// an "external" address in one of these ranges means the router itself sits
// behind another NAT (CGNAT or double-NAT) — unreachable from the internet
function isPrivateIp(ip) {
	if (!ip) return true;
	const [a, b] = ip.split('.').map(Number);
	if (a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31) return true;
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT range (RFC 6598)
	if (a === 127 || a === 169 && b === 254 || a === 0) return true;
	return false;
}

// agent:false + Connection: close — router HTTP stacks (miniupnpd) close the
// socket after each response, and Node's default keep-alive agent would try to
// reuse that dead socket for the next SOAP call, which then just hangs
function httpFetch(url, { method = 'GET', headers = {}, body = null, from = null } = {}, ms = SOAP_TIMEOUT_MS) {
	return new Promise((resolve, reject) => {
		const req = http.request(url, { method, headers: { ...headers, 'Connection': 'close' }, agent: false, localAddress: from || undefined }, (res) => {
			// local is the address the router saw this request come from — the
			// only trustworthy answer to "which of this PC's addresses are we"
			const local = res.socket?.localAddress || null;
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf-8'), local }));
		});
		req.setTimeout(ms, () => req.destroy(new Error('The router did not answer in time.')));
		req.on('error', reject);
		if (body) req.write(body);
		req.end();
	});
}

// One search, first useful answer wins. Routers answering the IGD:1 search
// includes IGD:2 devices (the spec keeps them backward compatible). The socket
// must be bound to the LAN interface with the multicast interface set — an
// unbound socket sends the search out whichever adapter is the OS default
// (VPNs, virtual switches), and the router never hears it.
function discoverGatewayLocation(lanIp) {
	return new Promise((resolve, reject) => {
		const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
		const query = [
			'M-SEARCH * HTTP/1.1',
			`HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
			'MAN: "ssdp:discover"',
			'MX: 2',
			'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1',
			'', ''
		].join('\r\n');
		let done = false;
		let resend = null;
		const finish = (err, location) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			clearInterval(resend);
			socket.close();
			err ? reject(err) : resolve(location);
		};
		const timer = setTimeout(() => finish(new Error('No UPnP router answered. UPnP may be disabled on the router.')), DISCOVER_MS);
		socket.on('error', (err) => finish(err));
		socket.on('message', (msg) => {
			const loc = /^location:\s*(.+)$/im.exec(msg.toString('utf-8'))?.[1]?.trim();
			if (loc) finish(null, loc);
		});
		socket.bind(0, lanIp, () => {
			try { socket.setMulticastInterface(lanIp); } catch { /* fall back to OS default */ }
			// the search is a single UDP datagram and multicast over Wi-Fi is
			// lossy — repeat it across the window, duplicates are harmless
			const send = () => socket.send(query, SSDP_PORT, SSDP_ADDR, (err) => { if (err) finish(err); });
			send();
			resend = setInterval(send, DISCOVER_RESEND_MS);
		});
	});
}

// The description XML lists nested devices/services; regex is enough to find
// the WAN connection service and its control endpoint.
async function findControl(location) {
	const { status, text } = await httpFetch(location);
	if (status !== 200) throw new Error(`Router description fetch failed (HTTP ${status})`);
	for (const block of text.match(/<service>[\s\S]*?<\/service>/g) || []) {
		const type = /<serviceType>(.*?)<\/serviceType>/.exec(block)?.[1];
		if (!type || !WAN_SERVICE.test(type)) continue;
		const control = /<controlURL>(.*?)<\/controlURL>/.exec(block)?.[1];
		if (control) return { serviceType: type, controlUrl: new URL(control, location).href };
	}
	throw new Error('Router answered but offers no WAN port-mapping service.');
}

async function soap(controlUrl, serviceType, action, args, { ms = SOAP_TIMEOUT_MS, from = null } = {}) {
	const argXml = Object.entries(args)
		.map(([k, v]) => `<${k}>${v}</${k}>`)
		.join('');
	const body =
		'<?xml version="1.0"?>' +
		'<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
		`<s:Body><u:${action} xmlns:u="${serviceType}">${argXml}</u:${action}></s:Body>` +
		'</s:Envelope>';
	const { status, text, local } = await httpFetch(controlUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'text/xml; charset="utf-8"',
			'SOAPAction': `"${serviceType}#${action}"`,
			'Content-Length': Buffer.byteLength(body)
		},
		body,
		from
	}, ms);
	if (status !== 200) {
		const code = /<errorCode>(\d+)<\/errorCode>/.exec(text)?.[1];
		const desc = /<errorDescription>(.*?)<\/errorDescription>/.exec(text)?.[1];
		const err = new Error(desc ? `Router refused: ${desc}` : `Router refused ${action} (HTTP ${status})`);
		err.upnpCode = code ? Number(code) : null;
		throw err;
	}
	return { text, local };
}

// who does the router say holds this external port? null when nobody does
async function mappingOwner(controlUrl, serviceType, port) {
	try {
		const res = await soap(controlUrl, serviceType, 'GetSpecificPortMappingEntry', {
			NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP'
		});
		return /<NewInternalClient>([\d.]+)<\/NewInternalClient>/.exec(res.text)?.[1] || null;
	} catch {
		return null;
	}
}

// Owns one mapping and keeps it alive. All failure text is user-facing.
// map()/unmap() only record the wanted state and kick one reconcile loop, so
// rapid toggling never interleaves two SOAP conversations with the router and
// the outcome always matches the LAST call.
class UpnpMapper {
	constructor({ port, onChange }) {
		this.port = port;
		this.onChange = onChange; // fires whenever status/externalIp/lastError move
		this.control = null;
		this.externalIp = null;
		this.active = false;
		this.blocked = null; // set to an explanation when CGNAT/double-NAT is detected
		this.lastError = null;
		this.renewTimer = null;
		this.wanted = false;
		this.inflight = null;
		this.mappedClient = null; // the address our router mapping points at
		this.externalPort = null; // may differ from port after a conflict fallback
	}

	status() {
		if (this.active) return 'active';
		if (this.blocked) return 'blocked';
		if (this.lastError) return 'failed';
		return 'off';
	}

	map() {
		this.wanted = true;
		return this.kick();
	}

	unmap() {
		this.wanted = false;
		return this.kick();
	}

	kick() {
		if (!this.inflight) {
			this.inflight = this.reconcile().finally(() => { this.inflight = null; });
		}
		return this.inflight;
	}

	async reconcile() {
		// keep going until reality matches the most recent map()/unmap() call
		for (;;) {
			const want = this.wanted;
			if (want) await this.mapOnce();
			else await this.unmapOnce();
			if (this.wanted === want) break;
		}
		this.onChange?.();
	}

	// Even MAPPING_TIMEOUT_MS is a bet, and losing it leaves the router with a
	// mapping we reported as failed — the add usually DID land, the answer was
	// just slower than we waited. Retrying turns that into a short delay: the
	// duplicate add matches the existing entry and returns at once. Dropping
	// the cached control between tries also covers an endpoint gone stale
	// (router rebooted or moved).
	async mapOnce() {
		this.lastError = null;
		let lastErr = null;
		for (let pass = 1; pass <= MAP_ATTEMPTS && this.wanted; pass++) {
			if (pass > 1) {
				await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
				if (!this.wanted) break;
				this.control = null;
			}
			try {
				await this.attempt();
				lastErr = null;
				break;
			} catch (err) {
				lastErr = err;
				this.active = false;
				if (this.blocked) break; // CGNAT is definitive; retrying cannot help
			}
		}
		if (lastErr) this.lastError = lastErr.message;
		if (this.active && !this.renewTimer) {
			this.renewTimer = setInterval(() => this.kick(), RENEW_MS);
		}
	}

	// Deletes even when no add was ever confirmed: after a timed-out add the
	// mapping usually exists anyway, and "off" must actually close the port,
	// not merely stop renewing it. Deleting a mapping that isn't there is a
	// cheap, instant error the router is happy to give us.
	async unmapOnce() {
		clearInterval(this.renewTimer);
		this.renewTimer = null;
		this.active = false;
		if (this.control) {
			// if the route flipped adapters since the add, the delete must go
			// out from the address the mapping points at (see the 718 note)
			const from = this.mappedClient && lanAddresses().includes(this.mappedClient) ? this.mappedClient : null;
			await soap(this.control.controlUrl, this.control.serviceType, 'DeletePortMapping', {
				NewRemoteHost: '', NewExternalPort: this.externalPort || this.port, NewProtocol: 'TCP'
			}, { ms: MAPPING_TIMEOUT_MS, from }).catch(() => {});
		}
	}

	async attempt() {
		const lanIp = lanAddress();
		if (!lanIp) throw new Error('No network connection.');
		if (!this.control) {
			const location = await discoverGatewayLocation(lanIp);
			this.control = await findControl(location);
		}
		const { controlUrl, serviceType } = this.control;

		const ipRes = await soap(controlUrl, serviceType, 'GetExternalIPAddress', {});
		this.externalIp = /<NewExternalIPAddress>([\d.]+)<\/NewExternalIPAddress>/.exec(ipRes.text)?.[1] || null;
		if (isPrivateIp(this.externalIp)) {
			this.blocked = 'Your internet provider shares one public address between customers (CGNAT), so this PC cannot be reached directly. No app setting can change that.';
			this.active = false;
			throw new Error(this.blocked);
		}
		this.blocked = null;

		// The mapping must target the address the router just saw us call from.
		// On a PC with two adapters on one LAN (Ethernet + Wi-Fi), guessing via
		// lanAddress() can pick the OTHER one, and secure-mode routers refuse
		// mappings for anyone but the caller (718 ConflictInMappingEntry).
		const args = {
			NewRemoteHost: '',
			NewExternalPort: this.port,
			NewProtocol: 'TCP',
			NewInternalPort: this.port,
			NewInternalClient: ipRes.local || lanIp,
			NewEnabled: 1,
			NewPortMappingDescription: DESCRIPTION,
			NewLeaseDuration: LEASE_SECONDS
		};
		const add = async (extPort) => {
			const a = { ...args, NewExternalPort: extPort };
			try {
				await soap(controlUrl, serviceType, 'AddPortMapping', a, { ms: MAPPING_TIMEOUT_MS });
			} catch (err) {
				if (err.upnpCode !== 725) throw err;
				// OnlyPermanentLeasesSupported — fine, unmapOnce() still cleans up
				await soap(controlUrl, serviceType, 'AddPortMapping', { ...a, NewLeaseDuration: 0 }, { ms: MAPPING_TIMEOUT_MS });
			}
		};

		// Stick to an external port that already worked this session: the away
		// URL is origin-scoped on the phone, so changing ports would silently
		// unlink every phone that saved it. A fresh session starts at the
		// preferred port again.
		const preferred = this.externalPort || this.port;
		let mappedPort = preferred;
		try {
			await add(preferred);
		} catch (err) {
			if (err.upnpCode !== 718) throw err;
			// ConflictInMappingEntry — an existing entry holds the port. Often it
			// is our own stale one pointing at the OTHER adapter (Ethernet vs
			// Wi-Fi: Windows picks the outgoing interface by route metric, not by
			// our preference, and secure-mode routers refuse to touch any mapping
			// except from the address it points at). When the holder is one of
			// this PC's own addresses, sending the delete FROM that address makes
			// it ours to remove.
			const owner = await mappingOwner(controlUrl, serviceType, preferred);
			const from = owner && lanAddresses().includes(owner) ? owner : null;
			await soap(controlUrl, serviceType, 'DeletePortMapping', {
				NewRemoteHost: '', NewExternalPort: preferred, NewProtocol: 'TCP'
			}, { ms: MAPPING_TIMEOUT_MS, from }).catch(() => {});
			try {
				await add(preferred);
			} catch (err2) {
				if (err2.upnpCode !== 718) throw err2;
				// The entry will not budge — a foreign device's, or ours via an
				// adapter that has no link right now (the delete above can't even
				// connect from a dead adapter's address). The external port is
				// ours to choose though: map a nearby one onto our same internal
				// port, and the away URL simply carries that port instead.
				mappedPort = 0;
				for (let ext = this.port + 1; ext <= this.port + PORT_SCAN_TRIES; ext++) {
					// an entry already pointing at us is ours to reuse — the
					// duplicate add just refreshes its lease, instantly
					const holder = await mappingOwner(controlUrl, serviceType, ext);
					if (holder && holder !== args.NewInternalClient) continue; // someone else's
					try {
						await add(ext);
						mappedPort = ext;
						break;
					} catch (err3) {
						if (err3.upnpCode !== 718) throw err3;
					}
				}
				if (!mappedPort) throw err2;
			}
		}
		const prevPort = this.externalPort;
		const prevClient = this.mappedClient;
		this.active = true;
		this.externalPort = mappedPort;
		this.mappedClient = args.NewInternalClient;
		if (prevPort && prevPort !== mappedPort) {
			// the port we used before is no longer the one in use (a fallback
			// port moved, or the preferred port freed up) — clean up the old
			// entry rather than leaving it forwarded at the router
			const from = prevClient && lanAddresses().includes(prevClient) ? prevClient : null;
			await soap(controlUrl, serviceType, 'DeletePortMapping', {
				NewRemoteHost: '', NewExternalPort: prevPort, NewProtocol: 'TCP'
			}, { ms: MAPPING_TIMEOUT_MS, from }).catch(() => {});
		}
	}

	url() {
		return this.active && this.externalIp ? `http://${this.externalIp}:${this.externalPort || this.port}` : null;
	}
}

module.exports = { UpnpMapper };
