// Focus / break cycle.
//
// The source of truth is a wall-clock timestamp (`phaseEndsAt`) in settings, and
// remaining time is always recomputed as `phaseEndsAt - Date.now()`. Nothing is
// ever accumulated from ticks. That one decision handles reload, laptop sleep,
// a closed lid, a clock adjustment and a window opened mid-session, all without
// any rehydration logic.
//
// Multi-window needs no owner election either. `nextPhase` is a pure function of
// (session, cfg), and the next phase's end time is derived from the *previous*
// end time rather than from `now` — so three windows firing at once compute a
// byte-identical successor and last-writer-wins converges. The `storage` event
// then propagates it to everyone.

import { get, set, bump } from './settings';
import { addSession } from './db';

const MIN = 60000;

export function cfgFrom(flow) {
    return {
        focusMs: Math.max(1, flow.focusMin || 25) * MIN,
        breakMs: Math.max(1, flow.breakMin || 5) * MIN,
        longBreakMs: Math.max(1, flow.longBreakMin || 15) * MIN,
        cyclesToLong: Math.max(1, flow.cyclesToLong || 4),
    };
}

export function isBreak(session) {
    return Boolean(session) && (session.phase === 'break' || session.phase === 'longBreak');
}

// Milliseconds left in the current phase. Paused time is excluded so a paused
// timer genuinely holds rather than quietly draining.
export function remainingMs(session, now = Date.now()) {
    if (!session) return 0;
    const pausedFor = session.pausedAt ? now - session.pausedAt : 0;
    return Math.max(0, session.phaseEndsAt - now + pausedFor);
}

export function totalMs(session, cfg) {
    if (!session) return 0;
    if (session.phase === 'focus') return cfg.focusMs;
    return session.phase === 'longBreak' ? cfg.longBreakMs : cfg.breakMs;
}

export function startSession(fileId, flow) {
    const cfg = cfgFrom(flow);
    const now = Date.now();
    const session = {
        startedAt: now,
        phase: 'focus',
        phaseStartedAt: now,
        phaseEndsAt: now + cfg.focusMs,
        pausedAt: null,
        pausedTotal: 0,
        cycle: 0,
        fileId: fileId ?? null,
    };
    set({ session }, { flush: true });
    return session;
}

export function pause() {
    const session = get('session');
    if (!session || session.pausedAt) return session;
    const next = { ...session, pausedAt: Date.now() };
    set({ session: next }, { flush: true });
    return next;
}

export function resume() {
    const session = get('session');
    if (!session || !session.pausedAt) return session;
    const paused = Date.now() - session.pausedAt;
    const next = {
        ...session,
        pausedAt: null,
        pausedTotal: (session.pausedTotal || 0) + paused,
        phaseEndsAt: session.phaseEndsAt + paused,
    };
    set({ session: next }, { flush: true });
    return next;
}

export function togglePause() {
    return get('session')?.pausedAt ? resume() : pause();
}

export function endSession(reason = 'stopped') {
    const session = get('session');
    if (session) recordSession(session, reason);
    set({ session: null }, { flush: true });
}

function recordSession(session, outcome) {
    // Fire and forget — a failed history write must never block the timer.
    addSession({
        id: `${session.startedAt}:${session.phaseStartedAt}`,
        kind: session.phase,
        startedAt: session.phaseStartedAt,
        endedAt: Date.now(),
        outcome,
        cycle: session.cycle,
        fileId: session.fileId ?? null,
    }).catch(() => {});
}

// How long past the end of a break we still treat the user as "here". Beyond
// this they went to lunch, and slapping a break overlay on their return would
// be absurd.
const AWAY_GRACE_MS = 5 * MIN;

/**
 * The next session state, or null when no transition is due.
 * Pure: same (session, cfg, now) always gives the same answer.
 */
export function nextPhase(session, cfg, now = Date.now()) {
    if (!session || session.pausedAt) return null;
    if (now < session.phaseEndsAt) return null;

    // Gone for a long time — don't ambush them on return.
    const awayLimit = session.phaseEndsAt + totalMs(session, cfg) + AWAY_GRACE_MS;
    if (now > awayLimit) return { ...session, phase: 'idle', endedFor: 'away' };

    if (session.phase === 'focus') {
        const cycle = session.cycle + 1;
        const long = cycle % cfg.cyclesToLong === 0;
        const phase = long ? 'longBreak' : 'break';
        const length = long ? cfg.longBreakMs : cfg.breakMs;
        return {
            ...session,
            phase,
            cycle,
            phaseStartedAt: session.phaseEndsAt,     // chain from the old end, not from `now`
            phaseEndsAt: session.phaseEndsAt + length,
        };
    }

    return {
        ...session,
        phase: 'focus',
        phaseStartedAt: session.phaseEndsAt,
        phaseEndsAt: session.phaseEndsAt + cfg.focusMs,
    };
}

/** Apply a due transition, if any. Safe to call from every window, every tick. */
export function advance(flow, now = Date.now()) {
    const session = get('session');
    if (!session) return null;
    const cfg = cfgFrom(flow);
    const next = nextPhase(session, cfg, now);
    if (!next) return null;

    recordSession(session, next.phase === 'idle' ? 'away' : 'completed');
    if (session.phase === 'focus') {
        bump(next.phase === 'idle' ? 'stats.focusAbandoned' : 'stats.focusCompleted');
    }

    if (next.phase === 'idle') {
        set({ session: null }, { flush: true });
        return null;
    }
    set({ session: next }, { flush: true });
    return next;
}

/** Skip the rest of the current phase. Counts the skip. */
export function skipPhase(flow) {
    const session = get('session');
    if (!session) return null;
    const kind = isBreak(session) ? 'break' : 'focus';
    if (kind === 'break') bump('stats.skips.break');
    recordSession(session, 'skipped');

    const cfg = cfgFrom(flow);
    const now = Date.now();
    // Land exactly on the boundary so `nextPhase` produces the normal successor.
    const forced = { ...session, pausedAt: null, phaseEndsAt: now };
    const next = nextPhase(forced, cfg, now);
    if (!next || next.phase === 'idle') {
        set({ session: null }, { flush: true });
        return null;
    }
    // Rebase onto `now` — a skipped phase shouldn't shorten the next one.
    const rebased = {
        ...next,
        phaseStartedAt: now,
        phaseEndsAt: now + (next.phase === 'focus'
            ? cfg.focusMs
            : next.phase === 'longBreak' ? cfg.longBreakMs : cfg.breakMs),
    };
    set({ session: rebased }, { flush: true });
    return rebased;
}

export function fmtRemaining(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
