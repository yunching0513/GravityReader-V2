import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { ChevronLeft, ChevronRight, Minus, Plus, Upload, Headphones, Maximize2, Languages, Volume2 } from 'lucide-react';
import 'react-pdf/dist/esm/Page/AnnotationLayer.css';
import 'react-pdf/dist/esm/Page/TextLayer.css';
// Bundle the pdf.js worker with the app instead of pulling it from a CDN at
// runtime: the packaged Electron app then opens PDFs with no network at all,
// the first page renders without a cross-origin round trip, and the worker can
// never drift out of version-sync with the pdfjs-dist react-pdf resolves to.
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.js?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

const PdfReader = ({ onTextSelect, onReadSelection, onDocumentLoad, highlightedText, highlightColor, externalFile, initialPage, onPageChange, requestedPage, onReadPage, autoScroll, isReading, toolbarExtra }) => {
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
    const textIndexRef = useRef(null);   // memoised search index for the rendered text layer
    const styledRef = useRef([]);        // spans we tinted last pass (so we only clear those)
    const highlightTimerRef = useRef(null);

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
    const fitWidth = () => {
        const el = scrollRef.current;
        if (!el || !pageWidthRef.current) return;
        const target = (el.clientWidth - 72) / pageWidthRef.current;
        const clamped = Math.min(Math.max(target, 0.5), 3.0);
        pendingScaleRef.current = clamped;
        setScale(Number(clamped.toFixed(2)));
    };

    const onPageLoadSuccess = (page) => {
        // page.view = [x0, y0, x1, y1] in PDF points at scale 1
        if (page && page.view) {
            pageWidthRef.current = page.view[2] - page.view[0];
            if (!autoFitDoneRef.current) {
                autoFitDoneRef.current = true;
                fitWidth();
            }
        }
    };

    const onFileChange = (event) => {
        autoFitDoneRef.current = false;
        setFile(event.target.files[0]);
    };

    // Selection → show an intentful popup (translate / read aloud) instead of
    // firing a translation on every mouse-up.
    const handleMouseUp = () => {
        const selection = window.getSelection();
        const text = selection ? selection.toString().trim() : '';
        if (text.length > 1 && selection.rangeCount > 0) {
            const rect = selection.getRangeAt(0).getBoundingClientRect();
            if (rect && rect.width) {
                setSel({
                    text,
                    x: rect.left + rect.width / 2,
                    y: rect.top,
                });
                return;
            }
        }
    };

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
        const color = highlightColor || 'rgba(193, 95, 60, 0.22)';
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
            const target = Math.min(Math.max(pendingScaleRef.current * (1 + delta), 0.5), 3.0);
            pendingScaleRef.current = target;
            if (docWrapRef.current) {
                docWrapRef.current.style.transformOrigin = 'top center';
                docWrapRef.current.style.transform = `scale(${target / scale})`;
            }
            clearTimeout(commitTimerRef.current);
            commitTimerRef.current = setTimeout(() => {
                if (docWrapRef.current) docWrapRef.current.style.transform = '';
                setScale(Number(pendingScaleRef.current.toFixed(2)));
            }, 160);
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [scale]);

    const submitJump = () => {
        const n = parseInt(jumpValue, 10);
        if (!Number.isNaN(n)) goTo(n);
        setJumping(false);
        setJumpValue('');
    };

    return (
        <div className="gr-reader" style={{ border: 'none', height: '100%' }} onMouseUp={handleMouseUp}>
            <div className="gr-reader-bar">
                <div className="gr-brand">
                    <span className="mark">Yun's <b>Reader</b></span>
                    <span className="zh">昀氏閱讀</span>
                </div>

                {file && (
                    <div className="gr-ctrls">
                        <button className="gr-btn gr-btn--icon" disabled={pageNumber <= 1} onClick={prevPage} title="上一頁 (←)">
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
                        <button className="gr-btn gr-btn--icon" disabled={pageNumber >= numPages} onClick={nextPage} title="下一頁 (→)">
                            <ChevronRight size={15} />
                        </button>

                        <div className="gr-zoom">
                            <button className="gr-btn gr-btn--icon" onClick={() => setScale(s => Math.max(s - 0.1, 0.5))} title="縮小">
                                <Minus size={14} />
                            </button>
                            <span className="gr-zoom-val">{Math.round(scale * 100)}%</span>
                            <button className="gr-btn gr-btn--icon" onClick={() => setScale(s => Math.min(s + 0.1, 3.0))} title="放大">
                                <Plus size={14} />
                            </button>
                            <button className="gr-btn gr-btn--icon" onClick={fitWidth} title="適合寬度">
                                <Maximize2 size={13} />
                            </button>
                        </div>

                        <button
                            className={`gr-btn gr-btn--icon gr-read-btn ${isReading ? 'is-active' : ''}`}
                            onClick={() => onReadPage && onReadPage()}
                            title={isReading ? '停止朗讀' : '從本頁開始朗讀'}
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
                            />
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
                            <input type="file" onChange={onFileChange} style={{ display: 'none' }} accept=".pdf" />
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
                    className="gr-sel-pop"
                    style={{ left: sel.x, top: sel.y - 10 }}
                    onMouseUp={(e) => e.stopPropagation()}
                >
                    <button onMouseDown={(e) => e.preventDefault()} onClick={doTranslate}><Languages size={13} /> 翻譯</button>
                    <button onMouseDown={(e) => e.preventDefault()} onClick={doSpeak}><Volume2 size={13} /> 朗讀</button>
                </div>
            )}
        </div>
    );
};

// The reader owns the heaviest subtree in the app. With the parent's callbacks
// now stable, memoising means typing a note or ticking through an audiobook's
// progress no longer reconciles the whole document pane.
export default React.memo(PdfReader);
