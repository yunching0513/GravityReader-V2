// Persisted preferences.
//
// One JSON blob in localStorage, not IndexedDB, for two reasons:
//
//   1. Settings must be readable *synchronously at first paint* — the Pomodoro
//      needs to know whether it is mid-break before anything renders, and an
//      async store means either a loading gate or a visible jump.
//   2. Chromium broadcasts `storage` events to every same-origin document,
//      including across Electron BrowserWindows. That gives the Pomodoro
//      cross-window sync for free, with no IPC.
//
// Bulk data (session history, brain dumps, audio blobs) belongs in IndexedDB —
// see db.js. Keep this blob small.

import { useCallback, useSyncExternalStore } from 'react';

export const SETTINGS_KEY = 'gr.settings.v1';

export const DEFAULTS = Object.freeze({
    __v: 1,

    ui: { leftWidth: 50, fontMode: 'default' },

    tts: {
        voice: 'Kore',
        speed: 1.0,
        engine: 'gemini',
        highlightColor: 'rgba(193, 95, 60, 0.22)',
    },

    read: { translationMode: 'sentence', summaryLength: 500 },

    // 心流 · flow
    // The numbers here are starting points, not findings. The "+4% challenge"
    // figure comes from popular flow writing rather than a reproducible result,
    // so it is a slider, not a constant — tune it against your own experience.
    flow: {
        enabled: false,
        wpm: 250,
        challenge: 1.04,
        guideMode: 'line',      // 'line' | 'word'
        focusMin: 25,
        breakMin: 5,
        longBreakMin: 15,
        cyclesToLong: 4,
        dumpBeforeStart: true,
        cleanCut: true,
        holdMs: 2000,
    },

    audio: {
        ambience: 'off',        // 'off' | 'pink' | 'brown' | 'file'
        ambienceVol: 0.35,
        pulseHz: 0,
        ambienceAsset: null,
        binaural: 'off',        // 'off' | 'theta' | 'alpha' | 'custom'
        carrierHz: 200,
        beatHz: 6,
        binauralVol: 0.18,
        master: 0.8,
        duckOnTts: true,
        duckRatio: 0.25,
    },

    vault: { associativeEnabled: false, folder: "Yun's Reader" },

    stats: {
        skips: { break: 0, dump: 0, cut: 0 },
        focusCompleted: 0,
        focusAbandoned: 0,
    },

    // Live Pomodoro state. Wall-clock timestamps only — see pomodoro.js.
    session: null,
});

// ── internals ─────────────────────────────────────────────────────────

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Merging against DEFAULTS on load means keys added in a later release simply
// appear with their default. Only *renames* would need a __v migration chain.
function deepMerge(base, patch) {
    if (!isPlainObject(patch)) return base;
    const out = { ...base };
    for (const key of Object.keys(patch)) {
        const next = patch[key];
        out[key] = isPlainObject(next) && isPlainObject(base[key])
            ? deepMerge(base[key], next)
            : next;
    }
    return out;
}

function readRaw() {
    try {
        const text = localStorage.getItem(SETTINGS_KEY);
        return text ? JSON.parse(text) : null;
    } catch (_) {
        return null;
    }
}

// `snapshot` must be referentially stable between writes or useSyncExternalStore
// re-renders forever. It is replaced only inside commit().
let snapshot = deepMerge(DEFAULTS, readRaw());

const listeners = new Set();

function notify() {
    for (const fn of listeners) {
        try { fn(snapshot); } catch (e) { console.error('settings listener failed:', e); }
    }
}

let writeTimer = null;

function writeNow() {
    clearTimeout(writeTimer);
    writeTimer = null;
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(snapshot));
    } catch (e) {
        // Quota or private-mode. The in-memory snapshot still works for this
        // session; losing persistence is better than breaking the app.
        console.warn('Could not persist settings:', e);
    }
}

function commit(next, { flush: flushNow = false } = {}) {
    snapshot = next;
    notify();
    if (flushNow) writeNow();
    else if (!writeTimer) writeTimer = setTimeout(writeNow, 250);
}

// ── public API ────────────────────────────────────────────────────────

export function getAll() {
    return snapshot;
}

export function get(path, fallback) {
    let node = snapshot;
    for (const part of String(path).split('.')) {
        if (!isPlainObject(node) || !(part in node)) return fallback;
        node = node[part];
    }
    return node === undefined ? fallback : node;
}

export function set(patch, opts) {
    commit(deepMerge(snapshot, patch), opts);
}

export function setPath(path, value, opts) {
    const parts = String(path).split('.');
    const patch = {};
    let node = patch;
    for (let i = 0; i < parts.length - 1; i++) {
        node[parts[i]] = {};
        node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
    commit(deepMerge(snapshot, patch), opts);
}

// Increment a counter, re-reading from storage first so two windows bumping the
// same counter in the same tick lose at most one increment rather than
// clobbering a whole namespace. Not atomic — and deliberately not hardened:
// these are self-honesty counters, not an accountability system.
export function bump(path, by = 1) {
    const fresh = deepMerge(DEFAULTS, readRaw());
    let node = fresh;
    const parts = String(path).split('.');
    for (let i = 0; i < parts.length - 1; i++) {
        if (!isPlainObject(node[parts[i]])) node[parts[i]] = {};
        node = node[parts[i]];
    }
    const leaf = parts[parts.length - 1];
    node[leaf] = (Number(node[leaf]) || 0) + by;
    commit(deepMerge(snapshot, fresh), { flush: true });
    return node[leaf];
}

export function resetNamespace(ns) {
    if (!(ns in DEFAULTS)) return;
    commit({ ...snapshot, [ns]: DEFAULTS[ns] }, { flush: true });
}

export function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function flush() {
    if (writeTimer) writeNow();
}

// ── cross-document sync ───────────────────────────────────────────────

if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
        if (e.key !== SETTINGS_KEY) return;
        // e.newValue === null means storage was cleared elsewhere.
        snapshot = deepMerge(DEFAULTS, e.newValue ? safeParse(e.newValue) : null);
        notify();
    });

    // Never lose a debounced write to a close or a tab switch.
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
    });
}

function safeParse(text) {
    try { return JSON.parse(text); } catch (_) { return null; }
}

// ── React binding ─────────────────────────────────────────────────────

export function useSetting(path, fallback) {
    const value = useSyncExternalStore(
        subscribe,
        () => get(path, fallback),
        () => get(path, fallback),
    );
    const setValue = useCallback(
        (next, opts) => setPath(path, typeof next === 'function' ? next(get(path, fallback)) : next, opts),
        [path, fallback],
    );
    return [value, setValue];
}

export function useSettings() {
    return useSyncExternalStore(subscribe, getAll, getAll);
}
