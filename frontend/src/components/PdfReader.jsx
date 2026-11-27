import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { ChevronLeft, ChevronRight, Minus, Plus, Upload, Headphones, Maximize2, Languages, Volume2, Lightbulb, ZoomIn, ZoomOut } from 'lucide-react';
import 'react-pdf/dist/esm/Page/AnnotationLayer.css';
import 'react-pdf/dist/esm/Page/TextLayer.css';
// Bundle the pdf.js worker with the app instead of pulling it from a CDN at
// runtime: the packaged Electron app then opens PDFs with no network at all,
// the first page renders without a cross-origin round trip, and the worker can
// never drift out of version-sync with the pdfjs-dist react-pdf resolves to.
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.js?url';
import GuideCursor from './GuideCursor';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

// Touch screens: a long-press selection never fires mouseup, and the OS draws
// its own copy/lookup callout *above* the selection — so on these devices the
// popup is driven by selectionchange and placed below the selection.
const IS_COARSE = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
const POP_HALF_WIDTH = 130; // keep the popup's centre this far from the screen edge

const PdfReader = ({ onTextSelect, onReadSelection, onExplain, onDocumentLoad, highlightedText, highlightColor, externalFile, docName, initialPage, onPageChange, requestedPage, onReadPage, autoScroll, isReading, toolbarExtra, guide }) => {
    const [numPages, setNumPages] = useState(null);
    const [pageNumber, setPageNumber] = useState(1);
    const [file, setFile] = useState(null);
    const [scale, setScale] = useState(1.0);
    const [jumping, setJumping] = useState(false);   // page-number input open
    const [jumpValue, setJumpValue] = useState('');
    const [sel, setSel] = useState(null);            // selection popup {text,x,y}

    const scrollRef = useRef(null);   // scroll/zoom container
    const docWrapRef = useRef(null);  // wraps the rendered page (for live zoom preview)
    const pendingScaleRef = useRef(1.0);
    const commitTimerRef = useRef(null);
    const pageWidthRef = useRef(null); // page width in points (scale 1), for fit-to-width
    const autoFitDoneRef = useRef(false);
    // Fit mode: until the reader zooms by hand, the page follows the pane's
    // width — window resize, phone rotation, dragging the split. Any manual zoom
    // (−/+, ctrl-wheel, pinch) leaves fit mode; 適合寬度 re-enters it.
    const [fitMode, setFitMode] = useState(true);
    const fitModeRef = useRef(true);
    const fitScaleRef = useRef(1.0);     // the scale that fits, for the phone zoom toggle
    const lastFitWidthRef = useRef(0);   // pane width we last fitted to (ignore jitter)
    const enterFitMode = (on) => { fitModeRef.current = on; setFitMode(on); };
    const textIndexRef = useRef(null);   // memoised search index for the rendered text layer
    const styledRef = useRef([]);        // spans we tinted last pass (so we only clear those)
    const highlightTimerRef = useRef(null);
    const [zooming, setZooming] = useState(false);   // live ctrl-wheel preview

    // The parent re-creates its callbacks on every render. Keep them in refs so
    // effects below depend only on real state changes — otherwise every keystroke
    // in the notes pane would re-run the page-change effect (dimming the page and
    // firing a redundant IndexedDB write).
    const onPageChangeRef = useRef(onPageChange);
    onPageChangeRef.current = onPageChange;

    const goTo = (n) => setPageNumber((p) => Math.min(Math.max(1, n), numPages || p));
    const prevPage = () => setPageNumber((p) => Math.max(1, p - 1));
    const nextPage = () => setPageNumber((p) => Math.min(numPages || p, p + 1));

    // Handle external file loading (from My Library / Zotero)
    React.useEffect(() => {
        if (externalFile) {
            autoFitDoneRef.current = false;
            enterFitMode(true);
            setFile(externalFile);
            setPageNumber(initialPage || 1);
            setSel(null);
        }
    }, [externalFile, initialPage]);

    // Notify parent of page change
    React.useEffect(() => {
        textIndexRef.current = null; // the old text layer is about to be replaced
        if (onPageChangeRef.current) onPageChangeRef.current(pageNumber);
        setSel(null);
        // soft fade while the new page renders
        if (docWrapRef.current) {
            docWrapRef.current.style.transition = 'opacity 0.22s ease';
            docWrapRef.current.style.opacity = '0.35';
        }
    }, [pageNumber]);

    // Let the parent drive the page (read-aloud auto page-turn).
    React.useEffect(() => {
        if (requestedPage && requestedPage !== pageNumber) setPageNumber(requestedPage);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [requestedPage]);

    // Keyboard paging: ← / PageUp = prev, → / PageDown = next, Home/End = ends.
    useEffect(() => {
        const onKey = (e) => {
            if (!file) return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); prevPage(); }
            else if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); nextPage(); }
            else if (e.key === 'Home') { e.preventDefault(); goTo(1); }
            else if (e.key === 'End') { e.preventDefault(); goTo(numPages); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [file, numPages]);

    function onDocumentLoadSuccess(pdf) {
        setNumPages(pdf.numPages);
        if (onDocumentLoad) onDocumentLoad(pdf);
    }

    // Fit the page to the container width (minus padding).
    // Returns false when it can't measure yet — e.g. the reader pane is hidden
    // behind the phone layout's other tab — so the caller can retry later.
    const fitWidth = () => {
        const el = scrollRef.current;
        if (!el || !pageWidthRef.current || el.clientWidth < 80) return false;
        const cs = getComputedStyle(el);
        const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 2; // + page border
        const target = (el.clientWidth - pad) / pageWidthRef.current;
        // Fit may go below the manual 50% floor: in a very narrow pane a page
        // that truly fits beats one that needs sideways scrolling.
        const clamped = Math.min(Math.max(target, 0.25), 3.0);
        pendingScaleRef.current = clamped;
        fitScaleRef.current = clamped;
        lastFitWidthRef.current = el.clientWidth;
        setScale(Number(clamped.toFixed(2)));
        return true;
    };
    const fitToWidth = () => { enterFitMode(true); fitWidth(); };
    const zoomTo = (next) => {
        enterFitMode(false);
        const v = Math.min(Math.max(next, 0.25), 3.0);
        pendingScaleRef.current = v;
        setScale(Number(v.toFixed(2)));
    };
    // Phone: one button flips between "whole page" and "readable" (≈2× fit,
    // body text around 13px), with pinch for anything in between.
    const toggleReadableZoom = () => {
        if (fitModeRef.current) zoomTo(fitScaleRef.current * 2);
        else fitToWidth();
    };

    const onPageLoadSuccess = (page) => {
        // page.view = [x0, y0, x1, y1] in PDF points at scale 1
        if (page && page.view) {
            pageWidthRef.current = page.view[2] - page.view[0];
            if (!autoFitDoneRef.current) autoFitDoneRef.current = fitWidth();
        }
    };

    const onFileChange = (event) => {
        autoFitDoneRef.current = false;
        enterFitMode(true);
        setFile(event.target.files[0]);
    };

    // Selection → show an intentful popup (translate / read aloud) instead of
    // firing a translation on every mouse-up.
    const showSelection = (below) => {
        const selection = window.getSelection();
        const text = selection ? selection.toString().trim() : '';
        if (text.length > 1 && selection.rangeCount > 0) {
            const rect = selection.getRangeAt(0).getBoundingClientRect();
            if (rect && rect.width) {
                const x = rect.left + rect.width / 2;
                setSel({
                    text,
                    x: Math.min(Math.max(x, POP_HALF_WIDTH), window.innerWidth - POP_HALF_WIDTH),
                    y: below ? rect.bottom : rect.top,
                    below,
                });
            }
        }
    };
    const handleMouseUp = () => { if (!IS_COARSE) showSelection(false); };

    // Touch: settle on the selection a beat after the handles stop moving.
    useEffect(() => {
        if (!IS_COARSE) return undefined;
        let timer;
        const onSelectionChange = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                const s = window.getSelection();
                const root = scrollRef.current;
                if (!s || s.isCollapsed || !root || !s.anchorNode || !root.contains(s.anchorNode)) return;
                showSelection(true);
            }, 350);
        };
        document.addEventListener('selectionchange', onSelectionChange);
        return () => { clearTimeout(timer); document.removeEventListener('selectionchange', onSelectionChange); };
    }, []);

    // Re-try fit-to-width once the pane becomes measurable (phone tab switch,
    // window resize from a collapsed state).
    useEffect(() => {
        const el = scrollRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        // Debounced with a timer, not requestAnimationFrame: rAF can be
        // throttled (occluded or power-saving windows) and a dropped frame
        // here meant the page silently never refitted.
        let timer = 0;
        const ro = new ResizeObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                if (!pageWidthRef.current) return;
                if (!autoFitDoneRef.current) { autoFitDoneRef.current = fitWidth(); return; }
                // Follow the pane in fit mode. The 4px dead-band keeps a vertical
                // scrollbar appearing/disappearing from ping-ponging the scale.
                if (fitModeRef.current && Math.abs(el.clientWidth - lastFitWidthRef.current) > 4) fitWidth();
            }, 60);
        });
        ro.observe(el);
        return () => { clearTimeout(timer); ro.disconnect(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Hide the popup when clicking elsewhere or scrolling the page.
    useEffect(() => {
        if (!sel) return;
        const onDown = (e) => { if (!e.target.closest || !e.target.closest('.gr-sel-pop')) setSel(null); };
        const onScroll = () => setSel(null);
        const scroller = scrollRef.current; // capture: the ref may be null by cleanup time
        window.addEventListener('mousedown', onDown);
        scroller && scroller.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            window.removeEventListener('mousedown', onDown);
            scroller && scroller.removeEventListener('scroll', onScroll);
        };
    }, [sel]);

    const clearSelection = () => {
        const s = window.getSelection();
        if (s) s.removeAllRanges();
        setSel(null);
    };

    const doTranslate = () => { if (sel) onTextSelect(sel.text); clearSelection(); };
    const doSpeak = () => { if (sel && onReadSelection) onReadSelection(sel.text); clearSelection(); };
    const doExplain = () => { if (sel && onExplain) onExplain(sel.text); clearSelection(); };

    // ── Highlighting ──────────────────────────────────────────────────
    // Read-aloud re-highlights on every spoken sentence, so this runs dozens of
    // times per page. We build a search index for the rendered text layer once
    // and reuse it until the layer is replaced (page turn / re-render), which
    // turns each highlight into a scan of the needle rather than of the page.

    // spans → concatenated page text, a whitespace-stripped copy for matching,
    // and the map that takes a normalised offset back to the original one.
    const buildTextIndex = useCallback(() => {
        const root = scrollRef.current;
        if (!root) return null;
        const spans = root.querySelectorAll('.react-pdf__Page__textContent span');
        if (!spans.length) return null;

        const ranges = [];
        const norm = [];      // normalised characters
        const normToOrig = []; // normalised offset → offset in the original text
        let cursor = 0;
        for (const el of spans) {
            const text = el.textContent || '';
            ranges.push({ start: cursor, end: cursor + text.length, el });
            for (let i = 0; i < text.length; i++) {
                const ch = text[i];
                if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r' && !/\s/.test(ch)) {
                    norm.push(ch.toLowerCase());
                    normToOrig.push(cursor + i);
                }
            }
            cursor += text.length;
        }
        return { ranges, normalized: norm.join(''), normToOrig };
    }, []);

    // First range whose end is past `pos` (ranges are sorted and contiguous).
    const firstRangeAfter = (ranges, pos) => {
        let lo = 0, hi = ranges.length - 1, hit = ranges.length;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (ranges[mid].end > pos) { hit = mid; hi = mid - 1; }
            else lo = mid + 1;
        }
        return hit;
    };

    const clearHighlight = () => {
        for (const el of styledRef.current) {
            el.style.backgroundColor = '';
            el.style.transition = '';
        }
        styledRef.current = [];
    };

    const paintHighlight = useCallback(() => {
        if (!textIndexRef.current) textIndexRef.current = buildTextIndex();
        const index = textIndexRef.current;
        if (!index) return;

        clearHighlight();

        const needle = (highlightedText || '').replace(/\s+/g, '').toLowerCase();
        if (!needle) return;

        const { ranges, normalized, normToOrig } = index;
        const color = highlightColor || 'rgba(227, 6, 19, 0.20)';
        const styled = [];
        let firstHit = null;

        let from = 0;
        for (;;) {
            const hit = normalized.indexOf(needle, from);
            if (hit === -1) break;
            const startOrig = normToOrig[hit];
            const endOrig = normToOrig[hit + needle.length - 1] + 1;

            for (let r = firstRangeAfter(ranges, startOrig); r < ranges.length; r++) {
                const range = ranges[r];
                if (range.start >= endOrig) break;
                range.el.style.backgroundColor = color;
                range.el.style.transition = 'background-color 0.3s';
                styled.push(range.el);
                if (!firstHit) firstHit = range.el;
            }
            from = hit + 1; // as before, overlapping occurrences each get tinted
        }
        styledRef.current = styled;

        // Keep the highlighted source in view: always during read-along, and
        // on a normal click only when it's off-screen (so it's not jarring).
        if (firstHit) {
            const r = firstHit.getBoundingClientRect();
            const cont = scrollRef.current ? scrollRef.current.getBoundingClientRect() : null;
            const offscreen = cont && (r.top < cont.top + 8 || r.bottom > cont.bottom - 8);
            if (autoScroll || offscreen) firstHit.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    }, [buildTextIndex, highlightedText, highlightColor, autoScroll]);

    // Clearing needs no text layer, so it happens immediately; painting waits a
    // beat for react-pdf to finish laying out the spans.
    const applyHighlight = useCallback(() => {
        clearTimeout(highlightTimerRef.current);
        if (!highlightedText) { clearHighlight(); return; }
        highlightTimerRef.current = setTimeout(paintHighlight, 100);
    }, [highlightedText, paintHighlight]);

    const onRenderSuccess = () => {
        if (docWrapRef.current) docWrapRef.current.style.opacity = '1'; // fade-in finished page
        textIndexRef.current = null; // a fresh text layer was just mounted
        styledRef.current = [];
        applyHighlight();
    };

    // A zoom re-renders the text layer, so the memoised index no longer points
    // at live spans. (Page turns invalidate it in the page-change effect.)
    React.useEffect(() => { textIndexRef.current = null; }, [scale]);

    // Re-apply highlight when page/scale/text changes
    React.useEffect(() => {
        applyHighlight();
        return () => clearTimeout(highlightTimerRef.current);
    }, [applyHighlight, pageNumber, scale]);

    useEffect(() => { pendingScaleRef.current = scale; }, [scale]);

    // Zoom Handler (Ctrl/⌘ + Wheel) — non-passive listener + CSS-preview so only
    // one render ever touches the canvas (avoids ghosted/doubled text).
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const onWheel = (e) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            e.preventDefault();
            const delta = e.deltaY * -0.0015;
            const target = Math.min(Math.max(pendingScaleRef.current * (1 + delta), 0.25), 3.0);
            pendingScaleRef.current = target;
            if (docWrapRef.current) {
                docWrapRef.current.style.transformOrigin = 'top center';
                docWrapRef.current.style.transform = `scale(${target / scale})`;
            }
            setZooming(true);
            clearTimeout(commitTimerRef.current);
            commitTimerRef.current = setTimeout(() => {
                if (docWrapRef.current) docWrapRef.current.style.transform = '';
                enterFitMode(false);
                setScale(Number(pendingScaleRef.current.toFixed(2)));
                setZooming(false);
            }, 160);
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [scale]);

    // Pinch-to-zoom on the page (touch). Same CSS-preview-then-commit approach
    // as ctrl-wheel, anchored on the fingers' midpoint so the passage you were
    // pinching stays under your fingers. touch-action on .gr-canvas stops the
    // browser from zooming the whole UI instead.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return undefined;
        let pinch = null;
        const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
        const onStart = (e) => {
            if (e.touches.length !== 2 || !docWrapRef.current) return;
            const r = el.getBoundingClientRect();
            const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            const wr = docWrapRef.current.getBoundingClientRect();
            pinch = { d0: dist(e.touches), base: pendingScaleRef.current, ox: mx - r.left, oy: my - r.top, k: 1 };
            docWrapRef.current.style.transformOrigin = `${mx - wr.left}px ${my - wr.top}px`;
            setZooming(true);
        };
        const onMove = (e) => {
            if (!pinch || e.touches.length !== 2) return;
            e.preventDefault();
            const target = Math.min(Math.max(pinch.base * (dist(e.touches) / pinch.d0), 0.25), 3.0);
            pinch.k = target / pinch.base;
            pendingScaleRef.current = target;
            docWrapRef.current.style.transform = `scale(${pinch.k})`;
        };
        const onEnd = (e) => {
            if (!pinch || e.touches.length >= 2) return;
            const { ox, oy, k } = pinch;
            const left = el.scrollLeft, top = el.scrollTop;
            pinch = null;
            if (docWrapRef.current) docWrapRef.current.style.transform = '';
            setZooming(false);
            if (Math.abs(k - 1) < 0.02) return; // two fingers landed but didn't zoom: stay in fit mode
            enterFitMode(false);
            setScale(Number(pendingScaleRef.current.toFixed(2)));
            // keep the pinched point where it was once the page re-renders
            setTimeout(() => {
                el.scrollLeft = (left + ox) * k - ox;
                el.scrollTop = (top + oy) * k - oy;
            }, 60);
        };
        el.addEventListener('touchstart', onStart, { passive: true });
        el.addEventListener('touchmove', onMove, { passive: false });
        el.addEventListener('touchend', onEnd);
        el.addEventListener('touchcancel', onEnd);
        return () => {
            el.removeEventListener('touchstart', onStart);
            el.removeEventListener('touchmove', onMove);
            el.removeEventListener('touchend', onEnd);
            el.removeEventListener('touchcancel', onEnd);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const submitJump = () => {
        const n = parseInt(jumpValue, 10);
        if (!Number.isNaN(n)) goTo(n);
        setJumping(false);
        setJumpValue('');
    };

    const docTitle = (docName || (file && file.name) || '').replace(/\.pdf$/i, '');

    return (
        <div className="gr-reader" style={{ border: 'none', height: '100%' }} onMouseUp={handleMouseUp}>
            <div className="gr-reader-bar">
                {/* Once a document is open, its title takes the brand's place —
                    and, unlike the brand, it shrinks (ellipsis) instead of
                    wrapping when the pane gets narrow. */}
                <div className="gr-brand">
                    {file && docTitle ? (
                        <span className="gr-doc-title" title={docTitle}>{docTitle}</span>
                    ) : (
                        <>
                            <span className="mark">Yun's <b>Reader</b></span>
                            <span className="zh">昀氏閱讀</span>
                        </>
                    )}
                </div>

                {file && (
                    <div className="gr-ctrls">
                        <button className="gr-btn gr-btn--icon" disabled={pageNumber <= 1} onClick={prevPage} title="上一頁 (←)" aria-label="上一頁">
                            <ChevronLeft size={15} />
                        </button>
                        {jumping ? (
                            <input
                                className="gr-page-jump"
                                autoFocus
                                value={jumpValue}
                                onChange={(e) => setJumpValue(e.target.value.replace(/[^0-9]/g, ''))}
                                onKeyDown={(e) => { if (e.key === 'Enter') submitJump(); if (e.key === 'Escape') { setJumping(false); setJumpValue(''); } }}
                                onBlur={submitJump}
                                placeholder={String(pageNumber)}
                            />
                        ) : (
                            <button className="gr-page-ind" onClick={() => { setJumping(true); setJumpValue(''); }} title="跳至頁碼">
                                <b>{String(pageNumber).padStart(2, '0')}</b> / {numPages ? String(numPages).padStart(2, '0') : '··'}
                            </button>
                        )}
                        <button className="gr-btn gr-btn--icon" disabled={pageNumber >= numPages} onClick={nextPage} title="下一頁 (→)" aria-label="下一頁">
                            <ChevronRight size={15} />
                        </button>

                        <div className="gr-zoom">
                            <button className="gr-btn gr-btn--icon gr-zoom-step" onClick={() => zoomTo(pendingScaleRef.current - 0.1)} title="縮小" aria-label="縮小">
                                <Minus size={14} />
                            </button>
                            <span className="gr-zoom-val">{Math.round(scale * 100)}%</span>
                            <button className="gr-btn gr-btn--icon gr-zoom-step" onClick={() => zoomTo(pendingScaleRef.current + 0.1)} title="放大" aria-label="放大">
                                <Plus size={14} />
                            </button>
                            <button
                                className={`gr-btn gr-btn--icon gr-zoom-step ${fitMode ? 'is-on' : ''}`}
                                onClick={fitToWidth}
                                title="適合寬度"
                                aria-label="適合寬度"
                                aria-pressed={fitMode}
                            >
                                <Maximize2 size={13} />
                            </button>
                            {/* Narrow panes (phones, a squeezed split) get one toggle instead. */}
                            <button
                                className="gr-btn gr-btn--icon gr-zoom-toggle"
                                onClick={toggleReadableZoom}
                                title={fitMode ? '放大頁面' : '整頁適寬'}
                                aria-label={fitMode ? '放大頁面' : '整頁適寬'}
                            >
                                {fitMode ? <ZoomIn size={16} /> : <ZoomOut size={16} />}
                            </button>
                        </div>

                        <button
                            className={`gr-btn gr-btn--icon gr-read-btn ${isReading ? 'is-active' : ''}`}
                            onClick={() => onReadPage && onReadPage()}
                            title={isReading ? '停止朗讀' : '從本頁開始朗讀'}
                            aria-label={isReading ? '停止朗讀' : '從本頁開始朗讀'}
                        >
                            <Headphones size={15} />
                        </button>
                    </div>
                )}

                {/* Outside the `file &&` block on purpose: a running focus timer
                    must stay visible (and stoppable) even with no PDF open. */}
                {toolbarExtra}
            </div>

            <div className="gr-canvas gr-scroll" ref={scrollRef}>
                {file ? (
                    <div ref={docWrapRef} className="gr-doc-wrap">
                        <Document file={file} onLoadSuccess={onDocumentLoadSuccess} className="gr-doc">
                            <Page
                                pageNumber={pageNumber}
                                scale={scale}
                                renderTextLayer={true}
                                renderAnnotationLayer={true}
                                onRenderSuccess={onRenderSuccess}
                                onLoadSuccess={onPageLoadSuccess}
                            >
                                {guide && guide.enabled && (
                                    <GuideCursor
                                        pageNumber={pageNumber}
                                        scale={scale}
                                        wpm={guide.wpm}
                                        challenge={guide.challenge}
                                        mode={guide.mode}
                                        running={guide.enabled && !isReading}
                                        hidden={zooming}
                                        onFinishPage={guide.onFinishPage}
                                    />
                                )}
                            </Page>
                        </Document>
                    </div>
                ) : (
                    <div className="gr-empty">
                        <div className="glyph">空</div>
                        <div className="en">An empty page</div>
                        <label className="gr-upload" style={{ marginTop: '8px' }}>
                            <Upload size={18} />
                            <span className="zh">選擇 PDF 開始閱讀</span>
                            <span className="en">Open a document</span>
                            <input type="file" onChange={onFileChange} className="gr-sr-only" accept=".pdf" />
                        </label>
                    </div>
                )}
            </div>

            {/* hover-reveal page arrows in the gutters */}
            {file && pageNumber > 1 && (
                <button className="gr-gutter gr-gutter--l" onClick={prevPage} title="上一頁 (←)" aria-label="上一頁">
                    <ChevronLeft size={22} />
                </button>
            )}
            {file && numPages && pageNumber < numPages && (
                <button className="gr-gutter gr-gutter--r" onClick={nextPage} title="下一頁 (→)" aria-label="下一頁">
                    <ChevronRight size={22} />
                </button>
            )}

            {/* selection action popup */}
            {sel && (
                <div
                    className={`gr-sel-pop${sel.below ? ' is-below' : ''}`}
                    style={{ left: sel.x, top: sel.below ? sel.y + 12 : sel.y - 10 }}
                    onMouseUp={(e) => e.stopPropagation()}
                >
                    <button onMouseDown={(e) => e.preventDefault()} onClick={doTranslate}><Languages size={13} /> 翻譯</button>
                    <button onMouseDown={(e) => e.preventDefault()} onClick={doSpeak}><Volume2 size={13} /> 朗讀</button>
                    {onExplain && (
                        <button onMouseDown={(e) => e.preventDefault()} onClick={doExplain}><Lightbulb size={13} /> 降維</button>
                    )}
                </div>
            )}
        </div>
    );
};

// The reader owns the heaviest subtree in the app. With the parent's callbacks
// now stable, memoising means typing a note or ticking through an audiobook's
// progress no longer reconciles the whole document pane.
export default React.memo(PdfReader);
