// Text-to-speech helpers: sentence segmentation + a stable cache key.
//
// The whole read-aloud feature is built on a "sentence queue": one audio clip
// per sentence, played in order, with the current sentence highlighted on the
// PDF. So splitting text into clean sentences is the foundation.

const ABBR = 'Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|Inc|Ltd|Co|No|Vol|pp|Fig|Dept|al|Gen|Sen|Rev|Hon|Capt';
const ABBR_RE = new RegExp(`\\b(${ABBR})\\.`, 'g');
// dotted forms like e.g. / i.e. / U.S. / Ph.D. / a.m.
const DOTTED_RE = /\b([A-Za-z](?:\.[A-Za-z])+)\./g;

const SENT = '⦀'; // private placeholder for "protected" periods

const MAX_LEN = 600; // keep a single TTS request comfortably within model limits

/**
 * Split English prose into sentences. Whitespace is normalised and common
 * abbreviations are protected so they don't trigger a false split.
 */
export function splitSentences(text) {
    if (!text) return [];
    let s = String(text).replace(/\s+/g, ' ').trim();
    if (!s) return [];

    // Protect abbreviation periods, then split, then restore.
    s = s.replace(ABBR_RE, (_, w) => `${w}${SENT}`);
    s = s.replace(DOTTED_RE, (m) => m.replace(/\./g, SENT));

    const parts = s.match(/[^.!?]+(?:[.!?]+(?:["'”’)\]]+)?|$)/g) || [s];

    const sentences = [];
    for (const raw of parts) {
        const sentence = raw.replace(new RegExp(SENT, 'g'), '.').trim();
        if (sentence) sentences.push(...capLength(sentence));
    }
    return sentences;
}

// Split an over-long sentence on clause boundaries so each TTS request stays
// within model limits (without cutting mid-word).
function capLength(sentence) {
    if (sentence.length <= MAX_LEN) return [sentence];
    const out = [];
    let rest = sentence;
    while (rest.length > MAX_LEN) {
        let cut = rest.lastIndexOf(', ', MAX_LEN);
        if (cut < MAX_LEN * 0.5) cut = rest.lastIndexOf(' ', MAX_LEN);
        if (cut <= 0) cut = MAX_LEN;
        out.push(rest.slice(0, cut + 1).trim());
        rest = rest.slice(cut + 1);
    }
    if (rest.trim()) out.push(rest.trim());
    return out;
}

// Small, stable string hash (djb2) for cache keys.
export function hashText(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h.toString(36);
}

// Cache key for a clip: same engine + voice + text => same audio (speed is
// applied via playbackRate at play time, so it is intentionally not part of it).
export function audioKey(fileId, engine, voice, text) {
    return `${fileId == null ? 'x' : fileId}|${engine}|${voice}|${hashText(text)}`;
}
