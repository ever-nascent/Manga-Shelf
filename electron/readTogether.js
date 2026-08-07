// Read Together: a group reads the same series, each at their own pace, and
// moves on to the next chapter only when everyone is ready.
//
// Nobody drives anybody else's page. Each participant reports where they are
// and sees where everyone else is. The one shared position is the *gate* — the
// chapter the group is on. Finishing the gate chapter marks you ready, and once
// the last person is ready the gate moves on and everyone follows it.
//
// The gate has two modes, the host's to choose:
//   soft   anyone may read ahead on their own; they just show as ahead
//   hard   nobody leaves the gate chapter until everyone is ready
//
// Joining needs the host's say-so: a request waits in `pending` until they
// approve it, and only then does the joiner receive the chapter list.
//
// The session lives only in memory — it's a live thing, not something worth
// restoring after a restart — and it belongs to whoever started it: when the
// host leaves, it ends for everyone.
//
// Nothing here knows how to reach anyone. Changes go out through onEvent, which
// main.js fans out over the two channels every other live change already uses
// (IPC to the desktop renderer, SSE to linked phones).

const crypto = require('crypto');

// A chapter list arrives from whichever client hosts, phones included. It's
// only ever handed back out to other clients, but there's no reason to hold an
// unbounded amount of it.
const MAX_CHAPTERS = 5000;

// A join request the host never answers shouldn't wait forever, or the asker is
// left staring at a spinner with nothing to tell them.
const PENDING_TTL_MS = 2 * 60_000;

const GATES = new Set(['soft', 'hard']);

// Titles and names come from whichever client sent them and land on everyone
// else's screen; strip control characters and cap the length, the same way
// device names are handled at pair time.
function text(value, limit) {
	if (typeof value !== 'string') return '';
	return value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, limit);
}

// Keep the three fields the readers actually use. Dropping the rest bounds what
// a host can park in the session and keeps join payloads small.
function normalizeChapters(chapters) {
	if (!Array.isArray(chapters)) return [];
	return chapters.slice(0, MAX_CHAPTERS)
		.filter((c) => c && typeof c.id === 'string')
		.map((c) => ({ id: c.id, num: c.num ?? null, title: text(c.title, 200) || null }));
}

const int = (v, min = 0) => Math.max(min, Math.trunc(Number(v)) || 0);

class ReadTogether {
	constructor() {
		this.session = null;
		this.onEvent = null; // main.js: fan out to the desktop renderer and phones
	}

	active() {
		return Boolean(this.session);
	}

	// ---------- reading the session ----------

	// The snapshot every live event carries. The chapter list is big and never
	// changes mid-session, so it only rides along for participants asking
	// directly (start, join once approved) — see view().
	snapshot(withChapters = false) {
		const s = this.session;
		if (!s) return null;
		this.prunePending();
		const out = {
			id: s.id,
			hostId: s.hostId,
			gate: s.gate,
			manga: s.manga,
			chapterCount: s.chapters.length,
			index: s.index, // the chapter the group is on
			participants: [...s.participants.values()].map((p) => ({
				id: p.id,
				name: p.name,
				index: p.index,
				page: p.page,
				pages: p.pages,
				ready: p.ready,
				host: p.id === s.hostId
			})),
			pending: [...s.pending.values()].map((r) => ({ id: r.id, name: r.name })),
			waitingOn: this.waitingOn(),
			startedAt: s.startedAt,
			updatedAt: s.updatedAt
		};
		if (withChapters) out.chapters = s.chapters;
		return out;
	}

	// A broadcast can't say who the recipient is, so the per-caller commands
	// return the session plus the caller's own standing in it. That's how a
	// client learns its device id, which it then uses to read its role out of
	// later broadcasts.
	view(actor, withChapters = false) {
		const role = this.roleOf(actor?.id);
		const mayHaveChapters = withChapters && (role === 'host' || role === 'guest');
		return {
			session: this.snapshot(mayHaveChapters),
			you: { id: actor?.id || null, role }
		};
	}

	roleOf(id) {
		const s = this.session;
		if (!s || !id) return null;
		if (s.hostId === id) return 'host';
		if (s.participants.has(id)) return 'guest';
		return s.pending.has(id) ? 'pending' : null;
	}

	// A rename lands on everyone's roster straight away, rather than waiting for
	// this person's next page turn to carry it.
	rename(id, name) {
		const p = this.session?.participants.get(id);
		if (!p) return;
		p.name = text(name, 40) || p.name;
		this.emit('participants');
	}

	// who the group is still waiting for, by name
	waitingOn() {
		const s = this.session;
		if (!s) return [];
		return [...s.participants.values()].filter((p) => !p.ready).map((p) => p.name);
	}

	emit(type) {
		this.onEvent?.({ type, session: this.snapshot() });
	}

	state(actor) {
		return this.view(actor);
	}

	// ---------- starting and joining ----------

	start(actor, manga, chapters, index = 0, gate = 'soft') {
		if (!actor?.id) throw new Error('Unknown caller');
		// The PC holds the library and serves every page, so it holds the host
		// seat too. Only main.js marks an actor as able to host.
		if (!actor.canHost) throw new Error('Only this PC can start a session');
		if (!manga?.id) throw new Error('Nothing to read together');
		const list = normalizeChapters(chapters);
		if (!list.length) throw new Error('That series has no chapters to share');

		const now = new Date().toISOString();
		// Starting replaces whatever was running. There's only ever one session,
		// and whoever just pressed the button said plainly what they want to read.
		this.session = {
			id: crypto.randomBytes(6).toString('hex'),
			hostId: actor.id,
			gate: GATES.has(gate) ? gate : 'soft',
			manga: {
				id: manga.id,
				title: text(manga.title, 200) || 'Untitled',
				// Local covers are addressed differently on each side
				// (mangafile:// vs /file?p=), so a path from one client is useless
				// to another. Only a real URL travels; without one the join
				// prompts just show the title.
				coverUrl: typeof manga.coverUrl === 'string' && manga.coverUrl.startsWith('http') ? manga.coverUrl : null
			},
			chapters: list,
			index: Math.min(int(index), list.length - 1),
			participants: new Map(),
			pending: new Map(),
			startedAt: now,
			updatedAt: now
		};
		this.addParticipant(actor);
		this.emit('started');
		return this.view(actor, true);
	}

	addParticipant(actor) {
		const s = this.session;
		s.participants.set(actor.id, {
			id: actor.id,
			name: text(actor.name, 40) || 'Someone',
			index: s.index,
			page: 0,
			pages: 0,
			ready: false,
			readyOverride: null // a manual ready/unready outranks the automatic one
		});
	}

	// Only invited guests join. A linked device is the host's own hardware —
	// their phone joining their own session would just be them twice — so
	// devices host and guests join, and the two never blur together.
	join(actor) {
		if (!actor?.id) throw new Error('Unknown caller');
		if (actor.kind !== 'guest') throw new Error('Only invited guests can join a session');
		const s = this.session;
		if (!s) throw new Error('No one is reading together right now');
		this.prunePending();
		if (s.participants.has(actor.id)) return this.view(actor, true);

		if (!s.pending.has(actor.id)) {
			s.pending.set(actor.id, {
				id: actor.id,
				name: text(actor.name, 40) || 'Someone',
				at: Date.now()
			});
			this.emit('pending');
		}
		return this.view(actor);
	}

	// Someone who redeemed an invite. The invite is the host's yes — they made
	// it deliberately, it expires, and it only stretches to the number of people
	// they said — so there's no second gate to pass.
	addGuest(guest) {
		const s = this.session;
		if (!s || s.participants.has(guest.id)) return;
		this.addParticipant({ id: guest.id, name: guest.name });
		this.recomputeAll();
		this.emit('joined');
	}

	// The host can show someone out again without ending the whole session.
	kick(actor, id) {
		const s = this.requireHost(actor);
		if (id === s.hostId) throw new Error('The host can\'t be removed');
		if (!s.participants.delete(id)) throw new Error('They\'re not in this session');
		this.advanceWhileReady(); // one fewer to wait for may be all the gate needed
		this.emit('participants');
		return this.view(actor);
	}

	approve(actor, id) {
		const s = this.requireHost(actor);
		const req = s.pending.get(id);
		if (!req) throw new Error('That request is no longer waiting');
		s.pending.delete(id);
		this.addParticipant({ id: req.id, name: req.name });
		this.recomputeAll();
		this.emit('participants');
		return this.view(actor);
	}

	deny(actor, id) {
		const s = this.requireHost(actor);
		if (s.pending.delete(id)) this.emit('pending');
		return this.view(actor);
	}

	requireHost(actor) {
		const s = this.session;
		if (!s) throw new Error('No one is reading together right now');
		if (s.hostId !== actor?.id) throw new Error('Only the host can do that');
		return s;
	}

	prunePending() {
		const s = this.session;
		if (!s) return;
		const cutoff = Date.now() - PENDING_TTL_MS;
		for (const [id, req] of s.pending) if (req.at < cutoff) s.pending.delete(id);
	}

	// ---------- leaving ----------

	leave(actor) {
		this.dropDevice(actor?.id);
		return this.view(actor);
	}

	// Also the path for a device that simply went away — a phone whose event
	// stream closed, or one the user unlinked.
	dropDevice(id) {
		const s = this.session;
		if (!s || !id) return;
		if (s.hostId === id) { this.end(); return; }
		const wasIn = s.participants.delete(id) || s.pending.delete(id);
		if (!wasIn) return;
		// one fewer person to wait for may be exactly what the gate needed
		this.advanceWhileReady();
		this.emit('participants');
	}

	end() {
		if (!this.session) return;
		this.session = null;
		this.emit('ended');
	}

	// ---------- positions and readiness ----------

	// "Here is where I am" — never where anyone else should be. Reporting a
	// position also re-derives whether this person is done with the gate
	// chapter, which is what the gate actually waits on.
	sync(actor, index, page, pages) {
		const s = this.session;
		const me = s?.participants.get(actor?.id);
		if (!me) return this.view(actor);
		me.name = text(actor.name, 40) || me.name; // a rename propagates for free
		me.index = Math.min(int(index), s.chapters.length - 1);
		me.page = int(page);
		me.pages = int(pages);
		this.recompute(me);
		s.updatedAt = new Date().toISOString();
		if (!this.advanceWhileReady()) this.emit('sync');
		return this.view(actor);
	}

	// Deliberately saying "I'm done" (or "not yet") outranks the automatic
	// reading of your position until the gate next moves.
	setReady(actor, ready) {
		const s = this.session;
		const me = s?.participants.get(actor?.id);
		if (!me) return this.view(actor);
		me.readyOverride = Boolean(ready);
		me.ready = me.readyOverride;
		if (!this.advanceWhileReady()) this.emit('sync');
		return this.view(actor);
	}

	// You're done with the gate chapter if you've read past it, or you're on it
	// and have reached its last page. Being behind it never counts.
	recompute(p) {
		const s = this.session;
		if (p.readyOverride !== null) { p.ready = p.readyOverride; return; }
		p.ready = p.index > s.index
			? true
			: p.index === s.index && p.pages > 0 && p.page >= p.pages - 1;
	}

	recomputeAll() {
		for (const p of this.session.participants.values()) this.recompute(p);
	}

	// The gate: once everyone is ready it steps forward one chapter, and anyone
	// sitting on the old one follows. Stepping re-derives readiness from where
	// people actually are, which is what stops it running away — the readers who
	// just advanced are now behind the gate, so they aren't ready any more.
	advanceWhileReady() {
		const s = this.session;
		let moved = false;
		for (let guard = 0; guard < s.chapters.length; guard++) {
			const all = [...s.participants.values()];
			if (!all.length || !all.every((p) => p.ready)) break;
			if (s.index + 1 >= s.chapters.length) break; // no more chapters to gate
			s.index++;
			for (const p of all) p.readyOverride = null; // a fresh chapter, a fresh choice
			this.recomputeAll();
			moved = true;
		}
		if (moved) {
			s.updatedAt = new Date().toISOString();
			this.emit('advance');
		}
		return moved;
	}

	// ---------- host controls ----------

	setGate(actor, gate) {
		const s = this.requireHost(actor);
		if (!GATES.has(gate)) throw new Error('Unknown gate mode');
		s.gate = gate;
		this.emit('gate');
		return this.view(actor);
	}

	// Moving the group somewhere else on purpose — back to reread, or forward
	// past something. Without this a hard gate has no reverse.
	setChapter(actor, index) {
		const s = this.requireHost(actor);
		s.index = Math.min(int(index), s.chapters.length - 1);
		for (const p of s.participants.values()) p.readyOverride = null;
		this.recomputeAll();
		s.updatedAt = new Date().toISOString();
		this.emit('advance');
		return this.view(actor);
	}
}

module.exports = { ReadTogether };
