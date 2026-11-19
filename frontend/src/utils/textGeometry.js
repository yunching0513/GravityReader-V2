// Word geometry for the reading-guide cursor.
//
// The guide has to sweep across the *rendered* text at a given words-per-minute,
// so it needs where each word actually sits on screen. pdf.js gives us a text
// layer of absolutely-positioned spans, each one a text *run* (often a whole
// line), stretched horizontally with `transform: scaleX(...)` to match the
// glyph widths in the original PDF.
//
// That scaleX is why we measure DOM Ranges rather than computing from the
// `transform` matrices in getTextContent(): only a Range reflects the stretch
// that was actually applied. It is also why offsets from splitSentences() are
// no use here — that function normalises whitespace, so its output is not a
// substring of the page text.

/**
 * Measure every word in a rendered page's text layer.
 *
 * Coordinates are page-local CSS pixels — i.e. relative to `pageEl`, which is
 * `.react-pdf__Page`. They are deliberately NOT divided by the zoom scale: the
 * guide overlay is mounted inside that same scaled box, so a viewport delta IS
 * the local offset.
 *
 * @param {HTMLElement} pageEl  the `.react-pdf__Page` element
 * @returns {{words: Array, pageW: number, pageH: number}|null}
 */
export function buildWordMap(pageEl) {
    if (!pageEl) return null;
    const spans = pageEl.querySelectorAll('.react-pdf__Page__textContent span');
    if (!spans.length) return null;

    const pageRect = pageEl.getBoundingClientRect();
    const words = [];

    // This loop only reads layout; it never writes. So the first getClientRects()
    // flushes layout once and every later read hits the same cached pass —
    // which is what keeps a 2000-word page in the single-digit milliseconds.
    for (const span of spans) {
        const node = span.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE) continue;
        const text = node.data;
        if (!text || !text.trim()) continue;

        const re = /\S+/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            const range = document.createRange();
            range.setStart(node, m.index);
            range.setEnd(node, m.index + m[0].length);
            const rects = range.getClientRects();
            // A word inside a single span never wraps, so the first rect is it.
            const r = rects.length ? rects[0] : null;
            range.detach && range.detach();
            if (!r || !r.width) continue;

            words.push({
                text: m[0],
                x: r.left - pageRect.left,
                y: r.top - pageRect.top,
                w: r.width,
                h: r.height,
                line: -1,
                // Trailing punctuation that ends a sentence earns extra dwell.
                sentenceEnd: /[.!?][)"'”’\]]*$/.test(m[0]),
            });
        }
    }

    if (!words.length) return null;
    return { words, pageW: pageRect.width, pageH: pageRect.height };
}

/**
 * Group measured words into lines, and tag each word with its line index.
 *
 * Words arrive in DOM order, which for pdf.js is reading order (per column), so
 * multi-column layouts cluster correctly without any column detection.
 *
 * @returns {Array} lines, each {y, h, x0, x1, from, to}
 */
export function clusterLines(words, tol = 0.6) {
    const lines = [];
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        const last = lines[lines.length - 1];
        const sameLine = last
            && Math.abs(word.y - last.y) < tol * Math.min(word.h, last.h);
        if (sameLine) {
            last.x0 = Math.min(last.x0, word.x);
            last.x1 = Math.max(last.x1, word.x + word.w);
            last.y = Math.min(last.y, word.y);
            last.h = Math.max(last.h, word.h);
            last.to = i;
        } else {
            lines.push({
                y: word.y, h: word.h,
                x0: word.x, x1: word.x + word.w,
                from: i, to: i,
            });
        }
        word.line = lines.length - 1;
    }
    return lines;
}

/**
 * Cumulative start time (ms) of each word, plus one past the end.
 *
 * A flat words-per-minute would read like a metronome. Real reading spends
 * extra time at a full stop, and the saccade back to the left margin at a line
 * break is time too — so both get a dwell multiplier.
 */
export function buildTimeline(words, { wpm = 250, punctDwell = 1.7, lineDwell = 1.15 } = {}) {
    const base = 60000 / Math.max(60, wpm);
    const out = new Float64Array(words.length + 1);
    let t = 0;
    for (let i = 0; i < words.length; i++) {
        out[i] = t;
        let weight = 1;
        if (words[i].sentenceEnd) weight *= punctDwell;
        if (i + 1 < words.length && words[i + 1].line !== words[i].line) weight *= lineDwell;
        t += base * weight;
    }
    out[words.length] = t;
    return out;
}

/**
 * Fractional word index at time `t`. The fraction makes the sweep continuous
 * instead of hopping word to word.
 *
 * Same binary-search shape as firstRangeAfter() in PdfReader.
 */
export function indexAtTime(timeline, t) {
    const n = timeline.length - 1;
    if (t <= 0) return 0;
    if (t >= timeline[n]) return n;
    let lo = 0, hi = n;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (timeline[mid] <= t) lo = mid;
        else hi = mid - 1;
    }
    const span = timeline[lo + 1] - timeline[lo];
    return lo + (span > 0 ? (t - timeline[lo]) / span : 0);
}
