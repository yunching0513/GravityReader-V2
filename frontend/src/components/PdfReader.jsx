import React, { useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { ChevronLeft, ChevronRight, Minus, Plus, Upload } from 'lucide-react';
import 'react-pdf/dist/esm/Page/AnnotationLayer.css';
import 'react-pdf/dist/esm/Page/TextLayer.css';

// Critical Worker Fix — use an explicit https scheme so it also resolves under
// the file:// protocol when running inside the packaged Electron app (a
// protocol-relative "//unpkg.com" URL would become "file://unpkg.com" there).
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.js`;

const PdfReader = ({ onTextSelect, onDocumentLoad, highlightedText, highlightColor, externalFile, initialPage, onPageChange }) => {
    const [numPages, setNumPages] = useState(null);
    const [pageNumber, setPageNumber] = useState(1);
    const [file, setFile] = useState(null);
    const [scale, setScale] = useState(1.0);

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
        if (!highlightedText) return;

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
                        }
                    });
                }

                searchIndex = foundIndex + 1;
            }
        }, 100); // Small delay to ensure DOM is ready
    };

    // Re-apply highlight when page/scale/text changes
    React.useEffect(() => {
        applyHighlight();
    }, [highlightedText, pageNumber, scale, highlightColor]);

    // Zoom Handler (Ctrl + Wheel)
    const handleWheel = (e) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const delta = e.deltaY * -0.001;
            const newScale = Math.min(Math.max(scale + delta, 0.5), 3.0);
            setScale(newScale);
        }
    };

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
                    </div>
                )}
            </div>

            <div className="gr-canvas gr-scroll" onWheel={handleWheel}>
                {file ? (
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
