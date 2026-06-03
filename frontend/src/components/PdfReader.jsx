import React, { useState, useRef, useEffect } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { ChevronLeft, ChevronRight, Minus, Plus, Upload, Headphones } from 'lucide-react';
import 'react-pdf/dist/esm/Page/AnnotationLayer.css';
import 'react-pdf/dist/esm/Page/TextLayer.css';

// Critical Worker Fix — use an explicit https scheme so it also resolves under
// the file:// protocol when running inside the packaged Electron app (a
// protocol-relative "//unpkg.com" URL would become "file://unpkg.com" there).
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.js`;

const PdfReader = ({ onTextSelect, onDocumentLoad, highlightedText, highlightColor, externalFile, initialPage, onPageChange, requestedPage, onReadPage, autoScroll, isReading }) => {
    const [numPages, setNumPages] = useState(null);
    const [pageNumber, setPageNumber] = useState(1);
    const [file, setFile] = useState(null);
    const [scale, setScale] = useState(1.0);

    const scrollRef = useRef(null);   // scroll/zoom container
    const docWrapRef = useRef(null);  // wraps the rendered page (for live zoom preview)
    const pendingScaleRef = useRef(1.0);
    const commitTimerRef = useRef(null);

    // Handle external file loading (from My Library)
    React.useEffect(() => {
        if (externalFile) {
            setFile(externalFile);
            setPageNumber(initialPage || 1);
        }
    }, [externalFile, initialPage]);

    // Notify parent of page change
    React.useEffect(() => {
        if (onPageChange) {
            onPageChange(pageNumber);
        }
    }, [pageNumber, onPageChange]);

    // Let the parent drive the page (used by read-aloud auto page-turn).
    React.useEffect(() => {
        if (requestedPage && requestedPage !== pageNumber) {
            setPageNumber(requestedPage);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [requestedPage]);

    function onDocumentLoadSuccess(pdf) {
        setNumPages(pdf.numPages);
        if (onDocumentLoad) {
            onDocumentLoad(pdf);
        }
    }

    const onFileChange = (event) => {
        setFile(event.target.files[0]);
    };

    const handleMouseUp = () => {
        const selection = window.getSelection();
        const text = selection.toString();
        if (text && text.trim().length > 0) {
            onTextSelect(text);
        }
    };

    // Apply Highlight Logic
    const applyHighlight = () => {
        // No active highlight — clear any leftover highlight (e.g. after stopping
        // read-aloud or deselecting an entry) instead of leaving it stuck.
        if (!highlightedText) {
            document.querySelectorAll('.react-pdf__Page__textContent span').forEach(span => {
                span.style.backgroundColor = '';
            });
            return;
        }

        // Wait for text layer to render
        setTimeout(() => {
            const textSpans = Array.from(document.querySelectorAll('.react-pdf__Page__textContent span'));
            if (textSpans.length === 0) return;

            // 1. Build full page text and map indices to spans
            let fullText = '';
            const spanMap = [];

            textSpans.forEach(span => {
                // Reset previous highlight
                span.style.backgroundColor = '';
                span.style.transition = '';

                const text = span.textContent;
                spanMap.push({
                    start: fullText.length,
                    end: fullText.length + text.length,
                    element: span
                });
                fullText += text;
            });

            // 2. Normalize texts for matching (remove whitespace to handle formatting differences)
            const normalize = (str) => str.replace(/\s+/g, '').toLowerCase();
            const normalizedFullText = normalize(fullText);
            const normalizedHighlight = normalize(highlightedText);

            if (normalizedHighlight.length === 0) return;

            let firstHit = null; // first highlighted span (for read-along scroll)

            // 3. Find all occurrences of the highlighted text
            let searchIndex = 0;
            while (true) {
                const foundIndex = normalizedFullText.indexOf(normalizedHighlight, searchIndex);
                if (foundIndex === -1) break;

                const foundEndIndex = foundIndex + normalizedHighlight.length;

                // 4. Map back to original fullText indices
                // We need to find the corresponding indices in the non-normalized fullText
                // This is tricky because spaces were removed.
                // We iterate through fullText and count non-space characters.

                let currentNormalizedIndex = 0;
                let startOriginalIndex = -1;
                let endOriginalIndex = -1;

                for (let i = 0; i < fullText.length; i++) {
                    if (!/\s/.test(fullText[i])) {
                        if (currentNormalizedIndex === foundIndex) startOriginalIndex = i;
                        currentNormalizedIndex++;
                        if (currentNormalizedIndex === foundEndIndex) {
                            endOriginalIndex = i + 1;
                            break;
                        }
                    }
                }

                if (startOriginalIndex !== -1 && endOriginalIndex !== -1) {
                    // 5. Highlight spans that intersect with [startOriginalIndex, endOriginalIndex]
                    spanMap.forEach(item => {
                        // Check for intersection
                        if (item.end > startOriginalIndex && item.start < endOriginalIndex) {
                            item.element.style.backgroundColor = highlightColor || 'rgba(193, 95, 60, 0.22)';
                            item.element.style.transition = 'background-color 0.3s';
                            if (!firstHit) firstHit = item.element;
                        }
                    });
                }

                searchIndex = foundIndex + 1;
            }

            // Read-along: keep the spoken sentence in view.
            if (autoScroll && firstHit) {
                firstHit.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
        }, 100); // Small delay to ensure DOM is ready
    };

    // Re-apply highlight when page/scale/text changes
    React.useEffect(() => {
        applyHighlight();
    }, [highlightedText, pageNumber, scale, highlightColor]);

    // Keep the gesture's running target in sync with discrete (button) changes.
    useEffect(() => { pendingScaleRef.current = scale; }, [scale]);

    // Zoom Handler (Ctrl/⌘ + Wheel).
    //
    // React's onWheel is registered as a *passive* listener, so calling
    // preventDefault() there silently fails — the browser then performs a native
    // zoom AND we fire a scale change on every wheel tick. On a heavy (book) page
    // those rapid changes pile up overlapping pdf.js renders into the same canvas,
    // which paints the page twice and produces the ghosted/doubled text.
    //
    // Fix: attach a non-passive listener so preventDefault works, preview the zoom
    // instantly with a cheap CSS transform, and commit a SINGLE re-render once the
    // gesture settles — so only one render ever touches the canvas.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;

        const onWheel = (e) => {
            if (!(e.ctrlKey || e.metaKey)) return; // let normal scroll through
            e.preventDefault();

            const delta = e.deltaY * -0.0015;
            const target = Math.min(Math.max(pendingScaleRef.current * (1 + delta), 0.5), 3.0);
            pendingScaleRef.current = target;

            // Instant visual feedback: scale the already-rendered page relative to
            // the committed render scale. No re-render happens during the gesture.
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

    return (
        <div className="gr-reader" style={{ border: 'none', height: '100%' }} onMouseUp={handleMouseUp}>
            <div className="gr-reader-bar">
                <div className="gr-brand">
                    <span className="mark">Gravity<b>Reader</b></span>
                    <span className="zh">重力閱讀</span>
                </div>

                {file && (
                    <div className="gr-ctrls">
                        <button
                            className="gr-btn gr-btn--icon"
                            disabled={pageNumber <= 1}
                            onClick={() => setPageNumber(prev => prev - 1)}
                            title="上一頁"
                        >
                            <ChevronLeft size={15} />
                        </button>
                        <span className="gr-page-ind">
                            <b>{String(pageNumber).padStart(2, '0')}</b> / {numPages ? String(numPages).padStart(2, '0') : '··'}
                        </span>
                        <button
                            className="gr-btn gr-btn--icon"
                            disabled={pageNumber >= numPages}
                            onClick={() => setPageNumber(prev => prev + 1)}
                            title="下一頁"
                        >
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
            </div>

            <div className="gr-canvas gr-scroll" ref={scrollRef}>
                {file ? (
                    <div ref={docWrapRef} className="gr-doc-wrap">
                        <Document
                            file={file}
                            onLoadSuccess={onDocumentLoadSuccess}
                            className="gr-doc"
                        >
                            <Page
                                pageNumber={pageNumber}
                                scale={scale}
                                renderTextLayer={true}
                                renderAnnotationLayer={true}
                                onRenderSuccess={applyHighlight}
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
        </div>
    );
};

export default PdfReader;
