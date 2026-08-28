// The three smallest pieces of UI, identical on both sides: something to look
// at while a request is out, something to show when it fails, and a line that
// says what just happened and then goes away.
//
// Each expects the styles it's named for (.spinner, .error-box, .toast) and, for
// toast, an element with id="toasts" to live in — both app shells have them.

import { h } from './dom.js';

export const spinner = () => h('div', { class: 'spinner' });

export function errorBox(message, retry) {
	return h('div', { class: 'error-box' },
		h('div', {}, message),
		retry && h('button', { class: 'btn', onclick: retry }, 'Retry')
	);
}

export function toast(message, type = 'info', ms = 3500) {
	const el = h('div', { class: `toast ${type}` }, message);
	document.getElementById('toasts').append(el);
	setTimeout(() => el.remove(), ms);
}
