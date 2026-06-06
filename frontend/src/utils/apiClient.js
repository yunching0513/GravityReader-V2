// Unified client: in desktop mode goes to the local Python backend; in web mode
// (no-backend) calls Gemini directly from the browser using the user-supplied key.
//
// Same call shape as the backend's endpoints so the UI code doesn't fork.

import axios from 'axios';

const NO_BACKEND = import.meta.env.VITE_NO_BACKEND === '1' || import.meta.env.VITE_NO_BACKEND === 'true';
const BACKEND_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export const isWebMode = () => NO_BACKEND;

const KEY_STORAGE = 'gr.googleApiKey';
export const getStoredKey = () => (localStorage.getItem(KEY_STORAGE) || '').trim();
export const setStoredKey = (k) => {
    if (k) localStorage.setItem(KEY_STORAGE, k);
    else localStorage.removeItem(KEY_STORAGE);
};

const GEMINI_MODEL = 'models/gemini-flash-latest';
const GEMINI_TTS_MODEL = 'models/gemini-2.5-flash-preview-tts';

// ── Gemini REST helpers (web mode) ──────────────────────────────────────────

async function callGemini(model, body, key) {
    const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${key}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
        err.status = res.status;
        throw err;
    }
    return res.json();
}

function extractText(json) {
    const part = json?.candidates?.[0]?.content?.parts?.[0];
    return part?.text || '';
}

function extractInlineAudio(json) {
    const part = json?.candidates?.[0]?.content?.parts?.[0];
    const inline = part?.inlineData || part?.inline_data;
    if (!inline) return null;
    return { data: inline.data, mime: inline.mimeType || inline.mime_type || '' };
}

// Wrap raw little-endian 16-bit PCM (what Gemini TTS returns) into a WAV blob.
function pcmToWav(pcm, rate = 24000) {
    const bytesPerSample = 2;
    const blockAlign = bytesPerSample; // mono
    const byteRate = rate * blockAlign;
    const dataSize = pcm.length;
    const buf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buf);
    const writeStr = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true);  // PCM
    view.setUint16(22, 1, true);  // mono
    view.setUint32(24, rate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true); // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);
    new Uint8Array(buf, 44).set(pcm);
    return new Blob([buf], { type: 'audio/wav' });
}

function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

// ── Public API: mirrors the backend's endpoints ─────────────────────────────

// translate(text, mode) → returns the JSON-string the backend used to return.
export async function translate(text, mode = 'sentence') {
    if (!NO_BACKEND) {
        const r = await axios.post(`${BACKEND_BASE}/api/analyze`, { text, mode });
        return r.data;
    }
    const key = getStoredKey();
    if (!key) throw Object.assign(new Error('尚未設定 Gemini API 金鑰,請到設定填入。'), { status: 503 });

    const instruction = mode === 'paragraph'
        ? 'Split the text by PARAGRAPHS. Translate each paragraph as a whole unit.'
        : 'Split the text by SENTENCES. Translate each sentence individually.';
    const prompt = `You are a professional translator. Translate the following English text into fluent Traditional Chinese (Taiwan).

Instruction: ${instruction}

Strict Output Format: Return a raw JSON list of objects. Each object must have ONLY two fields:
en: The original English text segment.
zh: The Traditional Chinese translation. DO NOT provide any grammar notes, vocabulary lists, or explanations. Just the translation.

Text to analyze:
${text}`;

    const json = await callGemini(GEMINI_MODEL, { contents: [{ parts: [{ text: prompt }] }] }, key);
    let out = extractText(json).trim();
    if (out.startsWith('```json')) out = out.slice(7);
    else if (out.startsWith('```')) out = out.slice(3);
    if (out.endsWith('```')) out = out.slice(0, -3);
    return out.trim();
}

export async function summarize(text, length) {
    if (!NO_BACKEND) {
        const r = await axios.post(`${BACKEND_BASE}/api/summarize`, { text, length });
        return r.data.summary;
    }
    const key = getStoredKey();
    if (!key) throw Object.assign(new Error('尚未設定 Gemini API 金鑰,請到設定填入。'), { status: 503 });
    const prompt = `You are a research assistant. Summarize the provided text into approximately ${length} Traditional Chinese words. Capture the main arguments and conclusions.

Text to summarize:
${text}`;
    const json = await callGemini(GEMINI_MODEL, { contents: [{ parts: [{ text: prompt }] }] }, key);
    return extractText(json);
}

// TTS: returns a Blob in both modes (audio/wav).
export async function tts({ text, voice, engine }) {
    if (!NO_BACKEND) {
        const r = await axios.post(`${BACKEND_BASE}/api/tts`, { text, voice, engine }, { responseType: 'blob' });
        return r.data;
    }
    const key = getStoredKey();
    if (!key) throw Object.assign(new Error('尚未設定 Gemini API 金鑰,請到設定填入。'), { status: 503 });
    const body = {
        contents: [{ parts: [{ text }] }],
        generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Kore' } } },
        },
    };
    const json = await callGemini(GEMINI_TTS_MODEL, body, key);
    const audio = extractInlineAudio(json);
    if (!audio) throw new Error('Gemini did not return audio.');
    let rate = 24000;
    const m = /rate=(\d+)/.exec(audio.mime);
    if (m) rate = parseInt(m[1], 10);
    return pcmToWav(b64ToBytes(audio.data), rate);
}

// Voice list. In web mode only Gemini voices are returned; no `say`.
export async function ttsVoices() {
    if (!NO_BACKEND) {
        const r = await axios.get(`${BACKEND_BASE}/api/tts/voices`);
        return r.data;
    }
    return {
        gemini: [
            { id: 'Kore', label: 'Kore · 沉穩女聲' },
            { id: 'Aoede', label: 'Aoede · 輕快女聲' },
            { id: 'Leda', label: 'Leda · 明亮女聲' },
            { id: 'Puck', label: 'Puck · 活潑男聲' },
            { id: 'Charon', label: 'Charon · 低沉男聲' },
            { id: 'Orus', label: 'Orus · 穩重男聲' },
        ],
        say: [], // none in the browser; Audiobook section is hidden
    };
}

// Key status — backend persists; in web mode we report localStorage.
export async function keyStatus() {
    if (!NO_BACKEND) {
        const r = await axios.get(`${BACKEND_BASE}/api/key`);
        return r.data;
    }
    const k = getStoredKey();
    const masked = k && k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : null;
    return { hasKey: !!k, masked };
}

// Validate-and-save the key. In web mode we sanity-check by listing models.
export async function saveKey(key) {
    const k = (key || '').trim();
    if (!k) throw new Error('金鑰不可為空。');
    if (!NO_BACKEND) {
        return (await axios.post(`${BACKEND_BASE}/api/key`, { key: k })).data;
    }
    // Light validation: a generateContent ping with the key.
    try {
        await callGemini(GEMINI_MODEL, { contents: [{ parts: [{ text: 'ping' }] }] }, k);
    } catch (e) {
        throw new Error('金鑰驗證失敗:' + (e.message || '').slice(0, 140));
    }
    setStoredKey(k);
    return { ok: true, hasKey: true };
}

// Audiobook + Zotero are desktop-only; in web mode the UI hides them, but
// expose stubs so callers that still reach in don't crash.
export async function startBook(payload) {
    if (NO_BACKEND) throw new Error('整本有聲書生成僅在桌面版可用。');
    const r = await axios.post(`${BACKEND_BASE}/api/tts/book`, payload);
    return r.data;
}
export async function bookStatus(id) {
    if (NO_BACKEND) throw new Error('Audiobook is desktop-only.');
    const r = await axios.get(`${BACKEND_BASE}/api/tts/book/${id}`);
    return r.data;
}
export async function zoteroStatus() {
    if (NO_BACKEND) return { available: false };
    const r = await axios.get(`${BACKEND_BASE}/api/zotero/status`);
    return r.data;
}
export async function zoteroCollections() {
    if (NO_BACKEND) return { collections: [] };
    const r = await axios.get(`${BACKEND_BASE}/api/zotero/collections`);
    return r.data;
}
export async function zoteroItems(params) {
    if (NO_BACKEND) return { items: [] };
    const r = await axios.get(`${BACKEND_BASE}/api/zotero/items`, { params });
    return r.data;
}
export async function zoteroFile(attKey) {
    if (NO_BACKEND) throw new Error('Zotero integration is desktop-only.');
    const r = await axios.get(`${BACKEND_BASE}/api/zotero/file/${attKey}`, { responseType: 'blob' });
    return r.data;
}
