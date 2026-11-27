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

// A request that never answers used to hang the reading pane forever (the
// spinner has no cancel). Bound every call instead.
const DEFAULT_TIMEOUT_MS = 90000;

async function callGemini(model, body, key, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
    const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${key}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (e) {
        if (e.name === 'AbortError') throw new Error('Gemini 沒有在時限內回應,請再試一次。');
        throw new Error(networkMessage());
    } finally {
        clearTimeout(timer);
    }
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        let detail = '';
        try { detail = JSON.parse(text)?.error?.message || ''; } catch (_) { detail = text; }
        const err = new Error(geminiMessage(res.status, detail));
        err.status = res.status;
        err.detail = detail.slice(0, 300);   // the raw reason, for the console, not the screen
        console.error(`Gemini ${res.status}:`, err.detail);
        throw err;
    }
    return res.json();
}

function networkMessage() {
    return (typeof navigator !== 'undefined' && navigator.onLine === false)
        ? '現在沒有網路。PDF 和筆記照常可用,翻譯等 AI 功能要等連上網路。'
        : '連不上 Gemini。請確認網路,或稍後再試。';
}

// Gemini's own error text is English JSON meant for developers. Say what
// happened and what to do about it instead.
function geminiMessage(status, detail = '') {
    const d = String(detail).toLowerCase();
    if (status === 400 && /api key|api_key/.test(d)) return '金鑰無效。請到「API 金鑰」重新貼上,確認有完整複製。';
    if (status === 400) return 'Gemini 看不懂這次的請求。選取的文字太長的話,試著選短一點。';
    if (status === 401 || status === 403) return '這把金鑰沒有權限使用 Gemini。請到 Google AI Studio 確認金鑰。';
    if (status === 404) return '找不到這個 Gemini 模型,可能已經停用。請更新 App。';
    if (status === 429) return 'Gemini 的免費額度暫時用完了。等一兩分鐘再試。';
    if (status >= 500) return 'Gemini 那邊暫時出問題了。稍後再試。';
    return `Gemini 回應錯誤(${status})。稍後再試。`;
}

/**
 * One readable sentence for any error the API layer can throw: the web
 * build's Gemini errors (already readable), the desktop backend's
 * `{detail}` responses, and a dropped connection.
 */
export function friendlyError(err, fallback = '發生錯誤,請再試一次。') {
    if (!err) return fallback;
    const resp = err.response;
    if (resp) {
        const detail = resp.data && resp.data.detail;
        if (resp.status === 503 && /key|金鑰/i.test(String(detail || ''))) return '尚未設定 Gemini API 金鑰,請到「API 金鑰」填入。';
        if (typeof detail === 'string' && detail && !/^\s*[{[]/.test(detail)) return detail;
        return geminiMessage(resp.status, typeof detail === 'string' ? detail : '');
    }
    if (err.request && !err.status) return NO_BACKEND ? networkMessage() : '連不上本機的閱讀器服務。請重新開啟 App。';
    const msg = String(err.message || '');
    if (!msg || /^\s*[{[]/.test(msg) || /^(TypeError|Failed to fetch|Network Error)/i.test(msg)) return fallback;
    return msg;
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

// Ask Gemini for JSON that already matches the shape the reading pane renders,
// so a stray sentence of preamble or a missing code fence can't break a
// translation any more. The fence-stripping below stays as a belt-and-braces
// fallback for models that ignore the schema.
const TRANSLATION_SCHEMA = {
    type: 'ARRAY',
    items: {
        type: 'OBJECT',
        properties: { en: { type: 'STRING' }, zh: { type: 'STRING' } },
        required: ['en', 'zh'],
    },
};

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

    const json = await callGemini(GEMINI_MODEL, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: TRANSLATION_SCHEMA,
        },
    }, key);
    let out = extractText(json).trim();
    if (out.startsWith('```json')) out = out.slice(7);
    else if (out.startsWith('```')) out = out.slice(3);
    if (out.endsWith('```')) out = out.slice(0, -3);
    return out.trim();
}

// Lower the difficulty of a passage without lowering its content. `caution_zh`
// (where the metaphor breaks) is required on purpose — a metaphor you can't see
// the edges of is a mnemonic, not a thinking tool.
const METAPHOR_SCHEMA = {
    type: 'OBJECT',
    properties: {
        metaphor_zh: { type: 'STRING' },
        plain_zh: { type: 'STRING' },
        mapping: {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: { from: { type: 'STRING' }, to: { type: 'STRING' } },
                required: ['from', 'to'],
            },
        },
        caution_zh: { type: 'STRING' },
    },
    required: ['metaphor_zh', 'plain_zh', 'caution_zh'],
};

// Returns the JSON string, matching translate()'s shape.
export async function metaphor(text) {
    if (!NO_BACKEND) {
        const r = await axios.post(`${BACKEND_BASE}/api/metaphor`, { text });
        return r.data;
    }
    const key = getStoredKey();
    if (!key) throw Object.assign(new Error('尚未設定 Gemini API 金鑰,請到設定填入。'), { status: 503 });

    const prompt = `You are helping a researcher who is stuck on a difficult passage.
Lower the difficulty without lowering the content.

Reply in Traditional Chinese (Taiwan) with these fields:
metaphor_zh: an everyday metaphor for the core idea. Concrete, from ordinary life.
plain_zh: the same idea restated plainly, no jargon.
mapping: which part of the metaphor stands for which part of the idea.
caution_zh: where this metaphor breaks down and would mislead if pushed further.

Passage:
${text}`;

    const json = await callGemini(GEMINI_MODEL, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: METAPHOR_SCHEMA,
        },
    }, key);
    let out = extractText(json).trim();
    if (out.startsWith('```json')) out = out.slice(7);
    else if (out.startsWith('```')) out = out.slice(3);
    if (out.endsWith('```')) out = out.slice(0, -3);
    return out.trim();
}

// Role-play reading (演化假裝遊戲濾鏡): how a given person would read the
// passage, what they'd notice that you'd walk past, and what they'd ask.
const PRETEND_SCHEMA = {
    type: 'OBJECT',
    properties: {
        reading_zh: { type: 'STRING' },
        notices_zh: { type: 'STRING' },
        question_zh: { type: 'STRING' },
    },
    required: ['reading_zh', 'notices_zh', 'question_zh'],
};

export async function pretend(text, persona) {
    if (!NO_BACKEND) {
        const r = await axios.post(`${BACKEND_BASE}/api/pretend`, { text, persona });
        return r.data;
    }
    const key = getStoredKey();
    if (!key) throw Object.assign(new Error('尚未設定 Gemini API 金鑰,請到設定填入。'), { status: 503 });
    const who = String(persona || '').trim().slice(0, 120);
    const prompt = `Suspend ordinary assumptions for a moment and read this passage
as ${who}. Stay in character, but stay honest: do not invent facts about the
passage that are not there.

Reply in Traditional Chinese (Taiwan) with these fields:
reading_zh: how ${who} would read and react to this passage.
notices_zh: what ${who} would notice here that a modern researcher walks past.
question_zh: the one question ${who} would ask about it.

Passage:
${text}`;
    const json = await callGemini(GEMINI_MODEL, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: PRETEND_SCHEMA },
    }, key);
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
        await callGemini(GEMINI_MODEL, { contents: [{ parts: [{ text: 'ping' }] }] }, k, { timeout: 20000 });
    } catch (e) {
        throw new Error(e.message || '金鑰驗證失敗,請再試一次。');
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

// ── Daily Research Digest ───────────────────────────────────────────────────
// In web mode the digest JSON files are served as Vite public assets at
// /digests/index.json and /digests/{date}.json — no backend required.

export async function listDigests() {
    if (!NO_BACKEND) {
        const r = await axios.get(`${BACKEND_BASE}/api/digests`);
        return r.data;
    }
    const r = await fetch('./digests/index.json');
    if (!r.ok) return [];
    return r.json();
}

export async function getDigest(date) {
    if (!NO_BACKEND) {
        const r = await axios.get(`${BACKEND_BASE}/api/digests/${date}`);
        return r.data;
    }
    const r = await fetch(`./digests/${date}.json`);
    if (!r.ok) throw new Error(`Digest ${date} not found.`);
    return r.json();
}

// ── Shared phrasebook (片語本) — backed by <vault>/Glossary.md ──────────────
// Desktop-only: it lives in the Obsidian vault on disk, which the browser
// can't reach. In web mode it degrades to "unavailable / empty".
export async function glossaryStatus() {
    if (NO_BACKEND) return { available: false };
    const r = await axios.get(`${BACKEND_BASE}/api/glossary/status`);
    return r.data;
}
export async function glossaryList() {
    if (NO_BACKEND) return { entries: [] };
    const r = await axios.get(`${BACKEND_BASE}/api/glossary/list`);
    return r.data;
}
export async function glossaryRecord(zh, en) {
    if (NO_BACKEND) throw new Error('片語本(Obsidian)僅在桌面版可用。');
    const r = await axios.post(`${BACKEND_BASE}/api/glossary/record`, { zh, en });
    return r.data;
}

// ── Obsidian associative notes ──────────────────────────────────────────────
// Desktop-only: the vault is on disk. In the browser build these report
// "unavailable" — except writing a note, which downloads the same Markdown
// instead, so you can drop it into your vault by hand.
// `count` makes the backend index (= read) the whole vault. Only pass it once
// the user has turned on associative reading.
export async function vaultStatus(folder, count = false) {
    if (NO_BACKEND) return { available: false };
    const params = {};
    if (folder) params.folder = folder;
    if (count) params.count = true;
    const r = await axios.get(`${BACKEND_BASE}/api/vault/status`, { params });
    return r.data;
}
export async function vaultAssociate(payload) {
    if (NO_BACKEND) return { associations: [], fallback: true, reason: 'web' };
    const r = await axios.post(`${BACKEND_BASE}/api/vault/associate`, payload);
    return r.data;
}
export async function vaultWriteNote(payload) {
    if (NO_BACKEND) {
        const blob = new Blob([payload.markdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${payload.filename}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Revoking synchronously can beat the download to the URL, and the
        // browser then falls back to a generic "download" filename.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return { downloaded: true, gr_id: payload.gr_id };
    }
    const r = await axios.post(`${BACKEND_BASE}/api/vault/note`, payload);
    return r.data;
}
