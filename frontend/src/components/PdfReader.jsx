import React, { useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/esm/Page/AnnotationLayer.css';
import 'react-pdf/dist/esm/Page/TextLayer.css';

// Critical Worker Fix
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.js`;

const PdfReader = ({ onTextSelect, onDocumentLoad }) => {
    const [numPages, setNumPages] = useState(null);
    const [pageNumber, setPageNumber] = useState(1);
    const [file, setFile] = useState(null);
    const [scale, setScale] = useState(1.0);

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
