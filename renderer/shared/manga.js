// What both front-ends know about a series and its chapters: the words they put
// on screen for a status, and the three questions every view ends up asking of
// a chapter list.

export const STATUS_LABEL = {
	ongoing: 'Ongoing',
	completed: 'Completed',
	hiatus: 'Hiatus',
	cancelled: 'Cancelled',
	unknown: ''
};

// The shelves a followed series can sit on, in the order they're offered.
export const FOLLOW_STATUSES = [
	['reading', 'Reading'], ['plan', 'Plan to Read'], ['completed', 'Completed'],
	['hold', 'On Hold'], ['dropped', 'Dropped']
];

export function followStatusLabel(s) {
	return FOLLOW_STATUSES.find(([v]) => v === s)?.[1] || s;
}

export function chapterName(ch) {
	if (ch.num === null || ch.num === undefined || ch.num === '') return ch.title || 'Oneshot';
	return `Chapter ${ch.num}${ch.title ? ` — ${ch.title}` : ''}`;
}

// Where to resume in a chapter list: match by chapter id first, then fall back
// to the chapter number (the saved id may belong to another group's upload).
// Returns -1 if neither matches.
export function resumeIndex(list, chapterId, chapterNum) {
	let idx = list.findIndex((c) => c.id === chapterId);
	if (idx === -1 && chapterNum != null) idx = list.findIndex((c) => c.num === chapterNum);
	return idx;
}

// Multiple scanlation groups often upload the same chapter; keep one entry per
// chapter number (first in feed order, which is ascending) for reading and
// bulk downloads.
export function dedupeChapters(chapters) {
	const seen = new Set();
	const out = [];
	for (const ch of chapters) {
		if (ch.external || ch.pages === 0) continue;
		const key = ch.num ?? `oneshot:${ch.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(ch);
	}
	return out;
}
