import React, { useEffect, useRef } from 'react';
import { buildWordMap, clusterLines, buildTimeline, indexAtTime } from '../utils/textGeometry';

// The reading-pace guide.
//
// Mounted as a child of react-pdf's <Page>, which renders `children` last
// inside a div that already carries `position: relative` and `--scale-factor`.
// That gives us the page's own coordinate system for free: the overlay scrolls
// with the content, and dragging the split-pane resizer moves it along with its
// offset parent, so neither needs a listener or a rebuild.
//
// It is a separate overlay rather than span tinting on purpose. paintHighlight()
// in PdfReader owns `backgroundColor` on those spans and clears every one it
// tracked on each pass; a second writer at 4 repaints a second would fight it.
// Span tinting also can't express sub-word motion — a span is a whole text run,
// so it would strobe line by line rather than sweep.
//
// This component renders once. Everything after that is direct DOM writes from
// a rAF loop, so React never re-renders at frame rate.

const LINE_PAD = 3;

const GuideCursor = ({
    pageNumber,
    scale,
    wpm = 250,
    challenge = 1.04,
    mode = 'line',          // 'line' | 'word'
    running = false,
    hidden = false,         // true during a live zoom preview
    onFinishPage,
}) => {
    const rootRef = useRef(null);
    const bandRef = useRef(null);
    const edgeRef = useRef(null);

    const mapRef = useRef(null);        // {words, lines, timeline}
    const builtForRef = useRef('');     // `${pageNumber}:${scale}`
    const clockRef = useRef({ startedAt: 0, wordsAtStart: 0 });
    const rafRef = useRef(null);
    const idleRef = useRef(null);

    // ── build the word map once per (page, scale) ────────────────────
    useEffect(() => {
        const key = `${pageNumber}:${scale}`;
        if (builtForRef.current === key) return undefined;

        const build = () => {
            const pageEl = rootRef.current && rootRef.current.closest('.react-pdf__Page');
            const measured = buildWordMap(pageEl);
            if (!measured) return;
            const lines = clusterLines(measured.words);
            mapRef.current = {
                words: measured.words,
                lines,
                timeline: buildTimeline(measured.words, { wpm: wpm * challenge }),
            };
            builtForRef.current = key;
            clockRef.current = { startedAt: performance.now(), wordsAtStart: 0 };
        };

        // Measuring is pure reads, but it is still ~1500 getClientRects on a
        // dense page — let it land after the render it belongs to.
        const schedule = window.requestIdleCallback || ((fn) => setTimeout(fn, 1));
        const cancel = window.cancelIdleCallback || clearTimeout;
        idleRef.current = schedule(build);
        return () => cancel(idleRef.current);
    }, [pageNumber, scale, wpm, challenge]);

    // A pace change mid-page rebases rather than restarting, so the cursor
    // stays where it is and simply carries on faster or slower.
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        const now = performance.now();
        const at = indexAtTime(map.timeline, map.timeline[Math.floor(clockRef.current.wordsAtStart)] +
            (now - clockRef.current.startedAt));
        map.timeline = buildTimeline(map.words, { wpm: wpm * challenge });
        clockRef.current = { startedAt: now, wordsAtStart: at };
    }, [wpm, challenge]);

    // ── the sweep ────────────────────────────────────────────────────
    useEffect(() => {
        const root = rootRef.current;
        if (!root) return undefined;

        if (!running || hidden) {
            root.style.opacity = '0';
            cancelAnimationFrame(rafRef.current);
            return undefined;
        }

        // Starting (or resuming) always rebases off the current position.
        clockRef.current.startedAt = performance.now();

        let lastFrame = performance.now();
        const tick = () => {
            const map = mapRef.current;
            if (!map || !map.words.length) {
                rafRef.current = requestAnimationFrame(tick);
                return;
            }
            const now = performance.now();
            // rAF stops while the tab is hidden, so a wall-clock delta would
            // teleport the cursor to the end of the page on return. Clamp the
            // frame delta and push `startedAt` forward by whatever we clamped
            // off, so the elapsed time the sweep sees never contains the gap.
            const raw = now - lastFrame;
            const delta = Math.min(raw, 250);
            clockRef.current.startedAt += raw - delta;
            lastFrame = now;

            const elapsed = now - clockRef.current.startedAt;
            const offset = map.timeline[Math.floor(clockRef.current.wordsAtStart)] || 0;
            const idx = indexAtTime(map.timeline, offset + elapsed);

            if (idx >= map.words.length) {
                root.style.opacity = '0';
                cancelAnimationFrame(rafRef.current);
                onFinishPage && onFinishPage();
                return;
            }

            const word = map.words[Math.floor(idx)];
            const line = map.lines[word.line];
            root.style.opacity = '1';

            if (mode === 'word') {
                bandRef.current.style.transform =
                    `translate3d(${word.x}px, ${word.y + word.h}px, 0)`;
                bandRef.current.style.width = `${word.w}px`;
                bandRef.current.style.height = '2px';
                edgeRef.current.style.opacity = '0';
            } else {
                // Band covers the line; the leading edge interpolates across it.
                bandRef.current.style.transform =
                    `translate3d(${line.x0}px, ${line.y - LINE_PAD}px, 0)`;
                bandRef.current.style.width = `${line.x1 - line.x0}px`;
                bandRef.current.style.height = `${line.h + LINE_PAD * 2}px`;

                const frac = idx - Math.floor(idx);
                const edgeX = word.x + word.w * frac;
                // Anchor the band's tint to the cursor, so the shading marks
                // what has been covered rather than pointing past it.
                const lineW = Math.max(1, line.x1 - line.x0);
                bandRef.current.style.setProperty(
                    '--guide-frac', String(Math.min(1, Math.max(0, (edgeX - line.x0) / lineW))));
                edgeRef.current.style.opacity = '1';
                edgeRef.current.style.transform =
                    `translate3d(${edgeX}px, ${line.y - LINE_PAD}px, 0)`;
                edgeRef.current.style.height = `${line.h + LINE_PAD * 2}px`;
            }

            rafRef.current = requestAnimationFrame(tick);
        };

        rafRef.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(rafRef.current);
    }, [running, hidden, mode, onFinishPage]);

    return (
        <div className="gr-guide" ref={rootRef} aria-hidden="true">
            <span className="gr-guide-band" ref={bandRef} />
            <span className="gr-guide-edge" ref={edgeRef} />
        </div>
    );
};

export default GuideCursor;
