// Inline SVG icon set — rounded strokes, consistent 24px grid, no emojis.

const PATHS = {
	home: '<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9.5V20.5h13V9.5"/>',
	compass: '<circle cx="12" cy="12" r="8.5"/><path d="M14.8 9.2l-1.7 4.5-4 1.1 1.7-4.5z" fill="currentColor" stroke-width="1"/>',
	books: '<rect x="3.5" y="4" width="4.4" height="16" rx="1.2"/><rect x="10" y="4" width="4.4" height="16" rx="1.2"/><path d="M16.6 5.3l3.9-1 3.4 14.8-3.9 1z" transform="scale(0.92) translate(0.8 0.6)"/>',
	bell: '<path d="M6.2 9.3a5.8 5.8 0 0 1 11.6 0c0 4.6 1.8 6 1.8 6H4.4s1.8-1.4 1.8-6"/><path d="M10.4 19.5a1.9 1.9 0 0 0 3.2 0"/>',
	'bell-off': '<path d="M6.2 9.3a5.8 5.8 0 0 1 11.6 0c0 4.6 1.8 6 1.8 6H4.4s1.8-1.4 1.8-6"/><path d="M10.4 19.5a1.9 1.9 0 0 0 3.2 0"/><path d="M4.5 3.5l15 17"/>',
	download: '<path d="M12 4.5v10"/><path d="M7.5 11 12 15.5 16.5 11"/><path d="M5 19.5h14"/>',
	gear: '<circle cx="12" cy="12" r="3.1"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8"/>',
	search: '<circle cx="11" cy="11" r="6.3"/><path d="M15.7 15.7 20.5 20.5"/>',
	star: '<path d="M12 3.6l2.5 5.2 5.7.8-4.2 4 1 5.6L12 16.5l-5 2.7 1-5.6-4.2-4 5.7-.8z"/>',
	'star-filled': '<path d="M12 3.6l2.5 5.2 5.7.8-4.2 4 1 5.6L12 16.5l-5 2.7 1-5.6-4.2-4 5.7-.8z" fill="currentColor"/>',
	bookmark: '<path d="M6.8 4.5h10.4v15.4l-5.2-3.5-5.2 3.5z"/>',
	'bookmark-filled': '<path d="M6.8 4.5h10.4v15.4l-5.2-3.5-5.2 3.5z" fill="currentColor"/>',
	play: '<path d="M8.5 5.8v12.4l10-6.2z" fill="currentColor" stroke-width="1.5"/>',
	check: '<path d="M4.8 12.6l4.6 4.6 9.8-10.4"/>',
	x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
	trash: '<path d="M4.5 7h15"/><path d="M9.3 7V5.4c0-.7.6-1.3 1.3-1.3h2.8c.7 0 1.3.6 1.3 1.3V7"/><path d="M6.7 7l.9 12.5h8.8L17.3 7"/><path d="M10.1 10.7v5.4M13.9 10.7v5.4"/>',
	folder: '<path d="M3.5 6.3c0-.8.6-1.4 1.4-1.4h3.8l2.4 2.7h8c.8 0 1.4.6 1.4 1.4v9.2c0 .8-.6 1.4-1.4 1.4H4.9c-.8 0-1.4-.6-1.4-1.4z"/>',
	'chevron-left': '<path d="M14.5 5.8 8.3 12l6.2 6.2"/>',
	'chevron-right': '<path d="M9.5 5.8 15.7 12l-6.2 6.2"/>',
	'chevron-down': '<path d="M6 9.6l6 6 6-6"/>',
	plus: '<path d="M12 5.5v13M5.5 12h13"/>',
	minus: '<path d="M6 12h12"/>',
	refresh: '<path d="M19.8 12a7.8 7.8 0 1 1-2.2-5.4"/><path d="M19.9 3.8V7.4h-3.6"/>',
	external: '<path d="M10 5.5H6a1.7 1.7 0 0 0-1.7 1.7V18A1.7 1.7 0 0 0 6 19.7h10.8A1.7 1.7 0 0 0 18.5 18v-4"/><path d="M14.5 4h5.5v5.5"/><path d="M19.6 4.4 11 13"/>',
	file: '<path d="M6.3 3.8h7.4l4 4.2v12.2H6.3z"/><path d="M13.3 3.8V8.3h4.4"/>',
	sliders: '<path d="M4.5 7.5h15M4.5 12h15M4.5 16.5h15"/><circle cx="9.5" cy="7.5" r="1.9" fill="var(--bg2, #131622)"/><circle cx="15" cy="12" r="1.9" fill="var(--bg2, #131622)"/><circle cx="8" cy="16.5" r="1.9" fill="var(--bg2, #131622)"/>',
	rows: '<rect x="4.5" y="4.5" width="15" height="6.3" rx="1.4"/><rect x="4.5" y="13.2" width="15" height="6.3" rx="1.4"/>',
	pages: '<rect x="4" y="5" width="7" height="14" rx="1.4"/><rect x="13" y="5" width="7" height="14" rx="1.4"/>',
	alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8v5"/><circle cx="12" cy="16.2" r="0.4" fill="currentColor" stroke-width="1.6"/>',
	clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.3l3.4 2"/>'
};

export function icon(name, size = 16) {
	const span = document.createElement('span');
	span.className = 'icon';
	span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;
	return span;
}
