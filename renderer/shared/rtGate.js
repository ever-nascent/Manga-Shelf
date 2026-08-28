// The rules of the gate, in one place because both readers have to agree on
// them: if the phone and the PC disagreed about whether someone may move on,
// one of them would sit waiting for a group that had already left.
//
// The gate is the chapter the group is on. Under a soft gate anyone may read
// ahead; under a hard one nobody leaves the gate chapter until everyone is
// ready. These take the session the reader is looking at rather than reaching
// for it, so they stay pure and can be checked on their own.

// Everyone the group is still waiting for has to finish before it moves.
export function allReady(session) {
	return !(session?.waitingOn.length);
}

// Is this reader in this session, on this book, right now?
export function hereNow(session, mangaId, inSession) {
	return Boolean(inSession) && session?.manga.id === mangaId;
}

// Does the gate hold this reader where they are? Being ahead of it already
// (from before the host switched modes) doesn't count — that reader is past the
// gate and free to carry on.
export function gateHolds(session, { mangaId, index, inSession }) {
	return Boolean(session) && session.gate === 'hard'
		&& hereNow(session, mangaId, inSession)
		&& index <= session.index && !allReady(session);
}

// What to say the group is waiting for, as one readable phrase.
export function waitingFor(session) {
	return (session?.waitingOn || []).join(' and ');
}

// Where another reader has got to: their page if they're in the same chapter as
// us, otherwise which chapter they're in.
export function whereTheyAre(participant, { index, chapters }) {
	if (participant.index !== index) {
		const ch = chapters[participant.index];
		return ch?.num ? `Ch. ${ch.num}` : `Ch. ${participant.index + 1}`;
	}
	return participant.pages ? `p. ${participant.page + 1}/${participant.pages}` : '—';
}
