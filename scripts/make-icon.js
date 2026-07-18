// Generates build/icon.png (512x512) with zero dependencies: an open book
// under a rising sun on a dark rounded square. electron-builder converts the
// png to .ico at package time.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;

// ---------- tiny png encoder ----------
const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();

function crc32(buf) {
	let c = -1;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}

function encodePNG(rgba, w, hgt) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(hgt, 4);
	ihdr[8] = 8;  // bit depth
	ihdr[9] = 6;  // color type RGBA
	const raw = Buffer.alloc((w * 4 + 1) * hgt);
	for (let y = 0; y < hgt; y++) {
		raw[y * (w * 4 + 1)] = 0; // filter none
		rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0))
	]);
}

// ---------- shape helpers ----------
const inRoundedRect = (x, y, x0, y0, x1, y1, r) => {
	if (x < x0 || x > x1 || y < y0 || y > y1) return false;
	const cx = Math.max(x0 + r, Math.min(x, x1 - r));
	const cy = Math.max(y0 + r, Math.min(y, y1 - r));
	return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= x0 + r && x <= x1 - r) || (y >= y0 + r && y <= y1 - r);
};

const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

const sign = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);

function inTri(px, py, a, b, c) {
	const d1 = sign(a[0], a[1], b[0], b[1], px, py);
	const d2 = sign(b[0], b[1], c[0], c[1], px, py);
	const d3 = sign(c[0], c[1], a[0], a[1], px, py);
	const neg = d1 < 0 || d2 < 0 || d3 < 0;
	const pos = d1 > 0 || d2 > 0 || d3 > 0;
	return !(neg && pos);
}

const inQuad = (px, py, a, b, c, d) => inTri(px, py, a, b, c) || inTri(px, py, a, c, d);

// ---------- draw ----------
// book pages (open book, slight taper toward the spine)
const L = [[244, 310], [112, 274], [112, 402], [244, 438]];
const R = [[268, 310], [400, 274], [400, 402], [268, 438]];

function colorAt(x, y) {
	if (!inRoundedRect(x, y, 14, 14, SIZE - 14, SIZE - 14, 98)) return null;

	// book (drawn over everything)
	if (inQuad(x, y, ...L) || inQuad(x, y, ...R)) {
		const shade = inQuad(x, y, ...L) ? 1 : 0.92; // right page slightly darker
		return [242 * shade, 243 * shade, 248 * shade, 255];
	}

	// sun with vertical orange->gold gradient
	if (inCircle(x, y, 256, 206, 116)) {
		const t = Math.max(0, Math.min(1, (y - 90) / 232));
		return [255, 106 + t * 70, 61 + t * 0, 255];
	}

	// background diagonal gradient
	const t = (x + y) / (2 * SIZE);
	return [29 - t * 15, 33 - t * 17, 48 - t * 27, 255];
}

const px = Buffer.alloc(SIZE * SIZE * 4);
const SUB = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];

for (let y = 0; y < SIZE; y++) {
	for (let x = 0; x < SIZE; x++) {
		let r = 0, g = 0, b = 0, a = 0;
		for (const [dx, dy] of SUB) {
			const c = colorAt(x + dx, y + dy);
			if (c) { r += c[0]; g += c[1]; b += c[2]; a += c[3]; }
		}
		const i = (y * SIZE + x) * 4;
		px[i] = Math.round(r / 4);
		px[i + 1] = Math.round(g / 4);
		px[i + 2] = Math.round(b / 4);
		px[i + 3] = Math.round(a / 4);
	}
}

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePNG(px, SIZE, SIZE));
console.log('Wrote', out);
