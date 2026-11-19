// Background sound: a synthesised ambience bed and binaural beats.
//
// A module singleton, not a hook: a window may only have one AudioContext, and
// it has to survive React remounts and Fast Refresh.
//
// It deliberately never touches the read-aloud <audio> element owned by
// useAudioReader. createMediaElementSource() is one-shot and permanent — once
// an element is captured, its sound only ever comes out through the graph. So
// routing the TTS element here would make this module load-bearing for *all*
// read-aloud, even with the flow features off, and suspending the context
// would silence speech with no error. Instead the ambience ducks under the
// speech, driven from state useAudioReader already returns publicly.
//
// We do route a second <audio> element — the one for a user-supplied track —
// because this module creates and owns it and nothing else ever touches it.
// That asymmetry is the whole point: route what we own, leave alone what we don't.
//
// On the science: a frequency difference between the ears is a real perceptual
// effect, but the evidence that it entrains attention is thin and inconsistent.
// The UI says what this does, not what it promises.

const RAMP = 0.08;          // setTargetAtTime time-constant, seconds
const FADE_IN = 0.6;
const FADE_OUT = 0.8;

let ctx = null;
let userGain = null;        // volume the user set
let duckGain = null;        // separate stage so ducking and volume don't cancel
let ambienceGain = null;
let binauralGain = null;

let noiseSrc = null;
let noiseFilter = null;
let pulseGain = null;
let lfo = null;
let lfoGain = null;

let oscL = null;
let oscR = null;
let merger = null;

let fileEl = null;          // our own <audio>, safe to route
let fileNode = null;
let fileUrl = null;

const noiseCache = new Map();   // 'pink' | 'brown' -> AudioBuffer

let state = { running: false, ambience: 'off', binaural: 'off', ctxState: 'none' };
const listeners = new Set();

const notify = () => {
    state = { ...state, ctxState: ctx ? ctx.state : 'none' };
    for (const fn of listeners) { try { fn(state); } catch (e) { console.error(e); } }
};

export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const getState = () => state;

// ── graph ─────────────────────────────────────────────────────────────

/** Create (or resume) the context. Must be called from a user gesture. */
export async function ensureContext() {
    if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        userGain = ctx.createGain();
        duckGain = ctx.createGain();
        ambienceGain = ctx.createGain();
        binauralGain = ctx.createGain();
        userGain.gain.value = 0.8;
        duckGain.gain.value = 1;
        ambienceGain.gain.value = 0;
        binauralGain.gain.value = 0;
        ambienceGain.connect(userGain);
        binauralGain.connect(userGain);
        userGain.connect(duckGain);
        duckGain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') await ctx.resume();
    notify();
    return ctx;
}

const ramp = (param, value) => {
    if (!ctx) return;
    param.setTargetAtTime(value, ctx.currentTime, RAMP);
};

/**
 * Ten seconds of noise, generated once and looped.
 *
 * Pink uses the Paul Kellett approximation; brown a single-pole integrator.
 * The tail is cross-faded into the head so the loop seam is inaudible.
 */
function noiseBuffer(kind) {
    if (noiseCache.has(kind)) return noiseCache.get(kind);
    const len = ctx.sampleRate * 10;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);

    if (kind === 'brown') {
        let last = 0;
        for (let i = 0; i < len; i++) {
            const white = Math.random() * 2 - 1;
            last = (last + 0.02 * white) / 1.02;
            d[i] = last * 3.5;
        }
    } else {
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < len; i++) {
            const white = Math.random() * 2 - 1;
            b0 = 0.99886 * b0 + white * 0.0555179;
            b1 = 0.99332 * b1 + white * 0.0750759;
            b2 = 0.96900 * b2 + white * 0.1538520;
            b3 = 0.86650 * b3 + white * 0.3104856;
            b4 = 0.55000 * b4 + white * 0.5329522;
            b5 = -0.7616 * b5 - white * 0.0168980;
            d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
            b6 = white * 0.115926;
        }
    }

    const seam = Math.floor(ctx.sampleRate * 0.05);
    for (let i = 0; i < seam; i++) {
        const t = i / seam;
        d[i] = d[i] * t + d[len - seam + i] * (1 - t);
    }

    noiseCache.set(kind, buf);
    return buf;
}

function stopAmbience() {
    if (noiseSrc) {
        ramp(ambienceGain.gain, 0);
        const src = noiseSrc, l = lfo;
        setTimeout(() => {
            try { src.stop(); } catch (_) { /* already stopped */ }
            try { l && l.stop(); } catch (_) { /* already stopped */ }
        }, FADE_OUT * 1000);
        noiseSrc = null; lfo = null; lfoGain = null; pulseGain = null; noiseFilter = null;
    }
    if (fileEl) {
        ramp(ambienceGain.gain, 0);
        const el = fileEl;
        setTimeout(() => { try { el.pause(); } catch (_) { /* ignore */ } }, FADE_OUT * 1000);
    }
}

/**
 * @param {{kind: string, volume: number, pulseHz: number, blob: Blob|null}} opts
 *        kind: 'off' | 'pink' | 'brown' | 'file'
 */
export async function setAmbience({ kind = 'off', volume = 0.35, pulseHz = 0, blob = null } = {}) {
    await ensureContext();
    if (!ctx) return;
    stopAmbience();
    state = { ...state, ambience: kind };

    if (kind === 'off') { notify(); maybeSuspend(); return; }

    if (kind === 'file') {
        if (!blob) { state = { ...state, ambience: 'off' }; notify(); return; }
        if (!fileEl) {
            fileEl = new Audio();
            fileEl.loop = true;
            // Safe to capture: this element is created and owned here.
            fileNode = ctx.createMediaElementSource(fileEl);
            fileNode.connect(ambienceGain);
        }
        if (fileUrl) URL.revokeObjectURL(fileUrl);
        fileUrl = URL.createObjectURL(blob);
        fileEl.src = fileUrl;
        ambienceGain.gain.value = 0;
        try { await fileEl.play(); } catch (_) { /* gesture required; caller retries */ }
        ambienceGain.gain.setTargetAtTime(volume, ctx.currentTime, FADE_IN / 3);
        notify();
        return;
    }

    noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuffer(kind);
    noiseSrc.loop = true;

    noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.value = kind === 'brown' ? 700 : 1600;

    pulseGain = ctx.createGain();
    pulseGain.gain.value = 1;

    noiseSrc.connect(noiseFilter);
    noiseFilter.connect(pulseGain);
    pulseGain.connect(ambienceGain);

    // Amplitude modulation of the bed. pulseHz 0 means no LFO at all.
    if (pulseHz > 0) {
        pulseGain.gain.value = 0.85;
        lfo = ctx.createOscillator();
        lfo.frequency.value = pulseHz;
        lfoGain = ctx.createGain();
        lfoGain.gain.value = 0.15;
        lfo.connect(lfoGain);
        lfoGain.connect(pulseGain.gain);
        lfo.start();
    }

    noiseSrc.start();
    ambienceGain.gain.value = 0;
    ambienceGain.gain.setTargetAtTime(volume, ctx.currentTime, FADE_IN / 3);
    notify();
}

const PRESETS = { theta: { carrierHz: 200, beatHz: 6 }, alpha: { carrierHz: 220, beatHz: 10 } };

/**
 * @param {{mode: string, carrierHz: number, beatHz: number, volume: number}} opts
 *        mode: 'off' | 'theta' | 'alpha' | 'custom'
 */
export async function setBinaural({ mode = 'off', carrierHz = 200, beatHz = 6, volume = 0.18 } = {}) {
    await ensureContext();
    if (!ctx) return;
    state = { ...state, binaural: mode };

    if (mode === 'off') {
        if (oscL) {
            ramp(binauralGain.gain, 0);
            const a = oscL, b = oscR;
            setTimeout(() => {
                try { a.stop(); b.stop(); } catch (_) { /* already stopped */ }
            }, FADE_OUT * 1000);
            oscL = null; oscR = null; merger = null;
        }
        notify(); maybeSuspend();
        return;
    }

    const preset = PRESETS[mode];
    const carrier = preset ? preset.carrierHz : carrierHz;
    const beat = preset ? preset.beatHz : beatHz;
    // Split the beat around the carrier so changing it doesn't shift the pitch.
    const fL = carrier - beat / 2;
    const fR = carrier + beat / 2;

    if (!oscL) {
        merger = ctx.createChannelMerger(2);
        oscL = ctx.createOscillator();
        oscR = ctx.createOscillator();
        oscL.type = 'sine';
        oscR.type = 'sine';
        oscL.frequency.value = fL;
        oscR.frequency.value = fR;
        oscL.connect(merger, 0, 0);
        oscR.connect(merger, 0, 1);
        merger.connect(binauralGain);
        oscL.start();
        oscR.start();
        binauralGain.gain.value = 0;
    } else {
        // Never assign frequency directly — that clicks.
        oscL.frequency.linearRampToValueAtTime(fL, ctx.currentTime + 0.5);
        oscR.frequency.linearRampToValueAtTime(fR, ctx.currentTime + 0.5);
    }
    binauralGain.gain.setTargetAtTime(Math.min(volume, 0.25), ctx.currentTime, FADE_IN / 3);
    notify();
}

export function setMasterVolume(v) {
    if (!ctx) return;
    ramp(userGain.gain, Math.max(0, Math.min(1, v)));
}

export function setAmbienceVolume(v) {
    if (!ctx || state.ambience === 'off') return;
    ramp(ambienceGain.gain, Math.max(0, Math.min(1, v)));
}

export function setBinauralVolume(v) {
    if (!ctx || state.binaural === 'off') return;
    ramp(binauralGain.gain, Math.max(0, Math.min(0.25, v)));
}

/** Duck under read-aloud. Idempotent — safe to call on every render. */
export function duck(on, ratio = 0.25) {
    if (!ctx) return;
    ramp(duckGain.gain, on ? Math.max(0, Math.min(1, ratio)) : 1);
}

function maybeSuspend() {
    // Nothing playing: stop the audio thread. Meaningful on a laptop battery.
    if (ctx && state.ambience === 'off' && state.binaural === 'off' && ctx.state === 'running') {
        setTimeout(() => {
            if (ctx && state.ambience === 'off' && state.binaural === 'off') {
                ctx.suspend().then(notify).catch(() => {});
            }
        }, (FADE_OUT + 0.2) * 1000);
    }
}

export async function stopAll() {
    await setAmbience({ kind: 'off' });
    await setBinaural({ mode: 'off' });
}
