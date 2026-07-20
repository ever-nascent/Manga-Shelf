// Inline SVG icons (stroke-based, currentColor) — subset of the desktop set.

const PATHS = {
	home: '<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9.5V20.5h13V9.5"/>',
	search: '<circle cx="11" cy="11" r="6.3"/><path d="M15.7 15.7 20.5 20.5"/>',
	books: '<rect x="3.5" y="4" width="4.4" height="16" rx="1.2"/><rect x="10" y="4" width="4.4" height="16" rx="1.2"/><path d="M16.6 5.3l3.9-1 3.4 14.8-3.9 1z" transform="scale(0.92) translate(0.8 0.6)"/>',
	download: '<path d="M12 4.5v10"/><path d="M7.5 11 12 15.5 16.5 11"/><path d="M5 19.5h14"/>',
	back: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
	check: '<path d="M4.8 12.6l4.6 4.6 9.8-10.4"/>',
	x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
	refresh: '<path d="M19.8 12a7.8 7.8 0 1 1-2.2-5.4"/><path d="M19.9 3.8V7.4h-3.6"/>',
	play: '<path d="M8.5 5.8v12.4l10-6.2z" fill="currentColor" stroke-width="1.5"/>',
	bookmark: '<path d="M6.8 4.5h10.4v15.4l-5.2-3.5-5.2 3.5z"/>',
	trash: '<path d="M4.5 7h15"/><path d="M9.3 7V5.4c0-.7.6-1.3 1.3-1.3h2.8c.7 0 1.3.6 1.3 1.3V7"/><path d="M6.7 7l.9 12.5h8.8L17.3 7"/><path d="M10.1 10.7v5.4M13.9 10.7v5.4"/>',
	alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8v5"/><circle cx="12" cy="16.2" r="0.4" fill="currentColor" stroke-width="1.6"/>',
	phone: '<rect x="7" y="3.5" width="10" height="17" rx="2"/><path d="M10.5 18h3"/>'
};

export function icon(name, size = 20) {
	const span = document.createElement('span');
	span.className = 'icon';
	span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${PATHS[name] || ''}</svg>`;
	return span;
}
