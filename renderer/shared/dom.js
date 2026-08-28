// Building and emptying DOM, shared by the desktop renderer and the phone.
//
// The two front-ends are separate apps — one loads off disk, the other over the
// LAN from this PC — so they don't share a bundle. What they can share is a
// folder: the desktop imports these files relatively, and the remote server
// serves them to the phone under /shared (see remoteServer.handleStatic).

export function h(tag, props = {}, ...children) {
	const el = document.createElement(tag);
	for (const [key, value] of Object.entries(props || {})) {
		if (value === undefined || value === null) continue;
		if (key === 'class') el.className = value;
		else if (key === 'dataset') Object.assign(el.dataset, value);
		else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
		else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
		else if (key in el && key !== 'list' && key !== 'form') el[key] = value;
		else el.setAttribute(key, value);
	}
	append(el, children);
	return el;
}

// Children arrive as arrays, nodes, strings and the odd null (a conditional
// that came out false) — a null child is dropped rather than printed.
function append(el, child) {
	if (child === null || child === undefined || child === false) return;
	if (Array.isArray(child)) { child.forEach((c) => append(el, c)); return; }
	el.append(child.nodeType ? child : document.createTextNode(String(child)));
}

export function clear(el) {
	while (el.firstChild) el.removeChild(el.firstChild);
}
