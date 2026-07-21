// UPnP port mapping, dependency-free: discover the router over SSDP, then ask
// it via SOAP to forward our port. This is what makes "read from anywhere"
// work with nothing but the app — no tunnel binaries, no accounts, no relay.
// The router even tells us our public address (GetExternalIPAddress), so no
// what's-my-ip web service is involved either.
//
// The hard truth this module has to surface honestly: on ISPs that use
// carrier-grade NAT the router's "external" address is itself private, the
// mapping leads nowhere, and no code on this PC can fix that. detectBlocked()
// names that case so the UI can explain instead of pretending.

const dgram = require('dgram');
const http = require('http');
const os = require('os');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const DISCOVER_MS = 3000;
const SOAP_TIMEOUT_MS = 5000;
const LEASE_SECONDS = 7200;
const RENEW_MS = 3600_000; // re-add halfway through the lease
const DESCRIPTION = 'MangaShelf remote';

const WAN_SERVICE = /urn:schemas-upnp-org:service:WAN(IP|PPP)Connection:\d/;

// same preference order as RemoteServer.bestUrl: classic home-LAN ranges first
function lanAddress() {
	const addrs = [];
	for (const list of Object.values(os.networkInterfaces())) {
		for (const a of list || []) {
			if (a.family === 'IPv4' && !a.internal) addrs.push(a.address);
		}
	}
	const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
	addrs.sort((a, b) => rank(a) - rank(b));
	return addrs[0] || null;
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
function httpFetch(url, { method = 'GET', headers = {}, body = null } = {}, ms = SOAP_TIMEOUT_MS) {
	return new Promise((resolve, reject) => {
		const req = http.request(url, { method, headers: { ...headers, 'Connection': 'close' }, agent: false }, (res) => {
			const chunks = [];
			res.on('data', (c) => chunks.push(c));
			res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf-8') }));
		});
		req.setTimeout(ms, () => req.destroy(new Error('timed out')));
		req.on('error', reject);
		if (body) req.write(body);
		req.end();
	});
}

// One M-SEARCH, first useful answer wins. Routers answering the IGD:1 search
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
		const finish = (err, location) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
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
			socket.send(query, SSDP_PORT, SSDP_ADDR, (err) => { if (err) finish(err); });
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

async function soap(controlUrl, serviceType, action, args) {
	const argXml = Object.entries(args)
		.map(([k, v]) => `<${k}>${v}</${k}>`)
		.join('');
	const body =
		'<?xml version="1.0"?>' +
		'<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
		`<s:Body><u:${action} xmlns:u="${serviceType}">${argXml}</u:${action}></s:Body>` +
		'</s:Envelope>';
	const { status, text } = await httpFetch(controlUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'text/xml; charset="utf-8"',
			'SOAPAction': `"${serviceType}#${action}"`,
			'Content-Length': Buffer.byteLength(body)
		},
		body
	});
	if (status !== 200) {
		const code = /<errorCode>(\d+)<\/errorCode>/.exec(text)?.[1];
		const desc = /<errorDescription>(.*?)<\/errorDescription>/.exec(text)?.[1];
		const err = new Error(desc ? `Router refused: ${desc}` : `Router refused ${action} (HTTP ${status})`);
		err.upnpCode = code ? Number(code) : null;
		throw err;
	}
	return text;
}

// Owns one mapping and keeps it alive. All failure text is user-facing.
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
	}

	status() {
		if (this.active) return 'active';
		if (this.blocked) return 'blocked';
		if (this.lastError) return 'failed';
		return 'off';
	}

	async map() {
		try {
			await this.attempt();
			this.lastError = null;
		} catch (err) {
			this.active = false;
			this.lastError = err.message;
		}
		if (!this.renewTimer && this.active) {
			this.renewTimer = setInterval(() => this.map(), RENEW_MS);
		}
		this.onChange?.();
	}

	async attempt() {
		const lanIp = lanAddress();
		if (!lanIp) throw new Error('No network connection.');
		if (!this.control) {
			const location = await discoverGatewayLocation(lanIp);
			this.control = await findControl(location);
		}
		const { controlUrl, serviceType } = this.control;

		const ipXml = await soap(controlUrl, serviceType, 'GetExternalIPAddress', {});
		this.externalIp = /<NewExternalIPAddress>([\d.]+)<\/NewExternalIPAddress>/.exec(ipXml)?.[1] || null;
		if (isPrivateIp(this.externalIp)) {
			this.blocked = 'Your internet provider shares one public address between customers (CGNAT), so this PC cannot be reached directly. No app setting can change that.';
			this.active = false;
			throw new Error(this.blocked);
		}
		this.blocked = null;

		const args = {
			NewRemoteHost: '',
			NewExternalPort: this.port,
			NewProtocol: 'TCP',
			NewInternalPort: this.port,
			NewInternalClient: lanIp,
			NewEnabled: 1,
			NewPortMappingDescription: DESCRIPTION,
			NewLeaseDuration: LEASE_SECONDS
		};
		try {
			await soap(controlUrl, serviceType, 'AddPortMapping', args);
		} catch (err) {
			if (err.upnpCode === 725) {
				// OnlyPermanentLeasesSupported — fine, unmap() still cleans up
				await soap(controlUrl, serviceType, 'AddPortMapping', { ...args, NewLeaseDuration: 0 });
			} else if (err.upnpCode === 718) {
				// ConflictInMappingEntry — a stale entry (ours from a crash, or
				// another device) holds the port; replace it once
				await soap(controlUrl, serviceType, 'DeletePortMapping', {
					NewRemoteHost: '', NewExternalPort: this.port, NewProtocol: 'TCP'
				}).catch(() => {});
				await soap(controlUrl, serviceType, 'AddPortMapping', args);
			} else {
				throw err;
			}
		}
		this.active = true;
	}

	// best effort: routers drop the lease on their own eventually
	async unmap() {
		clearInterval(this.renewTimer);
		this.renewTimer = null;
		const wasActive = this.active;
		this.active = false;
		if (this.control && wasActive) {
			await soap(this.control.controlUrl, this.control.serviceType, 'DeletePortMapping', {
				NewRemoteHost: '', NewExternalPort: this.port, NewProtocol: 'TCP'
			}).catch(() => {});
		}
		this.onChange?.();
	}

	url() {
		return this.active && this.externalIp ? `http://${this.externalIp}:${this.port}` : null;
	}
}

module.exports = { UpnpMapper };
