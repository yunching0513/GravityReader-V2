import React, { useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/esm/Page/AnnotationLayer.css';
import 'react-pdf/dist/esm/Page/TextLayer.css';

// Critical Worker Fix
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.js`;

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
                            item.element.style.backgroundColor = highlightColor || 'rgba(255, 255, 170, 0.5)';
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
        <div className="h-full flex flex-col" onMouseUp={handleMouseUp}>
            <div className="p-4 bg-gray-800 border-b border-gray-700 flex items-center gap-4 justify-between">
                <div className="flex items-center gap-4">
                    <input type="file" onChange={onFileChange} className="text-white" accept=".pdf" />
                    {file && (
                        <div className="text-white flex gap-2 items-center">
                            <button
                                disabled={pageNumber <= 1}
                                onClick={() => setPageNumber(prev => prev - 1)}
                                className="px-2 py-1 bg-gray-700 rounded disabled:opacity-50"
                            >
                                Prev
                            </button>
                            <span>Page {pageNumber} of {numPages}</span>
                            <button
                                disabled={pageNumber >= numPages}
                                onClick={() => setPageNumber(prev => prev + 1)}
                                className="px-2 py-1 bg-gray-700 rounded disabled:opacity-50"
                            >
                                Next
                            </button>
                        </div>
                    )}
                </div>
                {file && (
                    <div className="text-white text-sm flex items-center gap-2">
                        <button onClick={() => setScale(s => Math.max(s - 0.1, 0.5))} className="px-2 bg-gray-700 rounded">-</button>
                        <span>{Math.round(scale * 100)}%</span>
                        <button onClick={() => setScale(s => Math.min(s + 0.1, 3.0))} className="px-2 bg-gray-700 rounded">+</button>
                    </div>
                )}
            </div>

            <div
                className="flex-1 overflow-auto bg-gray-900 flex justify-center p-4"
                onWheel={handleWheel}
            >
                {file ? (
                    <Document
                        file={file}
                        onLoadSuccess={onDocumentLoadSuccess}
                        className="shadow-lg"
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
                    <div className="text-gray-500 flex items-center justify-center h-full">
                        Select a PDF to start reading
                    </div>
                )}
            </div>
        </div>
    );
};

export default PdfReader;
