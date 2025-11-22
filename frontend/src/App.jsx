import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Sparkles, Zap, AlertCircle, Menu, Download, FileText, X } from 'lucide-react';
import PdfReader from './components/PdfReader';

function App() {
    const [inputText, setInputText] = useState('');
    const [analysisResult, setAnalysisResult] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);

    // Resizable Layout State
    const [leftWidth, setLeftWidth] = useState(50); // Percentage
    const [isDragging, setIsDragging] = useState(false);

    // Sidebar & Features State
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [pdfDocument, setPdfDocument] = useState(null);
    const [summaryResult, setSummaryResult] = useState(null);
    const [viewMode, setViewMode] = useState('analysis'); // 'analysis' | 'summary'
    const [customSummaryLength, setCustomSummaryLength] = useState(500);
    const [isSummarizing, setIsSummarizing] = useState(false);

    // API Configuration
    const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

    // Handle Resizing
    useEffect(() => {
        const handleMouseMove = (e) => {
            if (!isDragging) return;

            const newWidth = (e.clientX / window.innerWidth) * 100;
            // Constrain between 20% and 80%
            if (newWidth >= 20 && newWidth <= 80) {
                setLeftWidth(newWidth);
            }
        };

        const handleMouseUp = () => {
            setIsDragging(false);
        };

        if (isDragging) {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        } else {
            document.body.style.cursor = 'default';
            document.body.style.userSelect = 'auto';
        }

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = 'default';
            document.body.style.userSelect = 'auto';
        };
    }, [isDragging]);

    const handleTextSelect = async (text) => {
        setInputText(text);
        setViewMode('analysis');
        setIsLoading(true);
        setError(null);
        setAnalysisResult(null);

        try {
            // Call Backend API
            const response = await axios.post(`${API_URL}/api/analyze`, { text });

            // Parse JSON response if it's a string, otherwise use as is
            let result = response.data;
            if (typeof result === 'string') {
                try {
                    result = JSON.parse(result);
                } catch (e) {
                    console.error("Failed to parse JSON string", e);
                }
            }

            setAnalysisResult(result);
        } catch (err) {
            console.error("API Error:", err);
            setError("Failed to analyze text. Ensure backend is running.");
        } finally {
            setIsLoading(false);
        }
    };

    const handleDocumentLoad = (pdf) => {
        setPdfDocument(pdf);
    };

    const extractPdfText = async () => {
        if (!pdfDocument) return '';
        let fullText = '';
        for (let i = 1; i <= pdfDocument.numPages; i++) {
            const page = await pdfDocument.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map(item => item.str).join(' ');
            fullText += pageText + '\n';
        }
        return fullText;
    };

    const handleSummarize = async (length) => {
        if (!pdfDocument) {
            alert("Please load a PDF first.");
            return;
        }
        setIsSummarizing(true);
        setViewMode('summary');
        setSummaryResult(null);

        try {
            const text = await extractPdfText();
            const response = await axios.post(`${API_URL}/api/summarize`, {
                text: text.substring(0, 30000), // Limit text length to avoid payload issues
                length: length
            });
            setSummaryResult(response.data.summary);
        } catch (err) {
            console.error("Summarize Error:", err);
            setError("Failed to summarize document.");
        } finally {
            setIsSummarizing(false);
        }
    };

    const handleExport = (type) => {
        if (!analysisResult || !Array.isArray(analysisResult)) {
            alert("No analysis data to export.");
            return;
        }

        let content = '';
        if (type === 'zh') {
            content = analysisResult.map(item => item.zh).join('\n\n');
        } else {
            content = analysisResult.map(item => `[EN] ${item.en}\n[ZH] ${item.zh}`).join('\n\n');
        }

        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `translation_${type}_${new Date().getTime()}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    return (
        <div className="flex h-screen w-screen overflow-hidden bg-gray-900 text-white font-sans relative">
            {/* Sidebar Toggle */}
            <button
                onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                className="absolute top-4 left-4 z-50 p-2 bg-gray-800 rounded hover:bg-gray-700 transition-colors shadow-lg"
            >
                {isSidebarOpen ? <X size={20} /> : <Menu size={20} />}
            </button>

            {/* Sidebar Drawer */}
            <div className={`fixed top-0 left-0 h-full w-64 bg-gray-900 border-r border-gray-700 z-40 transform transition-transform duration-300 ease-in-out ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'} pt-16 px-4 shadow-2xl`}>
                <h3 className="text-cyan-400 font-bold mb-4 flex items-center gap-2">
                    <Download size={18} /> 匯出翻譯記錄
                </h3>
                <div className="flex flex-col gap-2 mb-8">
                    <button onClick={() => handleExport('zh')} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded text-sm text-left transition">
                        全中文下載
                    </button>
                    <button onClick={() => handleExport('bilingual')} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded text-sm text-left transition">
                        中英對照下載
                    </button>
                </div>

                <h3 className="text-pink-500 font-bold mb-4 flex items-center gap-2">
                    <FileText size={18} /> 文章摘要
                </h3>
                <div className="grid grid-cols-2 gap-2 mb-4">
                    {[250, 500, 1000, 2000].map(len => (
                        <button key={len} onClick={() => handleSummarize(len)} className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-xs transition">
                            {len}字
                        </button>
                    ))}
                </div>
                <div className="flex gap-2">
                    <input
                        type="number"
                        value={customSummaryLength}
                        onChange={(e) => setCustomSummaryLength(parseInt(e.target.value))}
                        className="w-full bg-gray-800 rounded px-2 py-1 text-sm border border-gray-700"
                    />
                    <button onClick={() => handleSummarize(customSummaryLength)} className="px-3 py-1 bg-cyan-600 hover:bg-cyan-500 rounded text-sm whitespace-nowrap">
                        生成
                    </button>
                </div>
            </div>

            {/* Left Panel - PDF Reader */}
            <div
                className="h-full border-r border-gray-700 flex flex-col relative"
                style={{ width: `${leftWidth}%`, minWidth: '20%' }}
            >
                <div className="absolute top-0 left-0 w-full p-2 pl-16 z-10 bg-gray-900/80 backdrop-blur text-cyan-400 font-bold flex items-center gap-2 pointer-events-none">
                    <Zap size={18} /> GravityReader V2
                </div>
                <PdfReader onTextSelect={handleTextSelect} onDocumentLoad={handleDocumentLoad} />
            </div>

            {/* Resizer Handle */}
            <div
                className="w-1 h-full bg-gray-800 hover:bg-cyan-500 cursor-col-resize transition-colors z-20"
                onMouseDown={() => setIsDragging(true)}
            />

            {/* Right Panel - Analysis / Summary */}
            <div
                className="h-full flex flex-col bg-gray-900 p-6 overflow-auto"
                style={{ width: `${100 - leftWidth}%` }}
            >
                <div className="mb-6 border-b border-gray-700 pb-4">
                    <h2 className="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-pink-500 flex items-center gap-2">
                        <Sparkles className="text-pink-500" />
                        {viewMode === 'summary' ? 'Document Summary' : 'Neural Analysis'}
                    </h2>
                    <p className="text-gray-400 text-sm mt-1">
                        {viewMode === 'summary' ? 'AI-generated summary of the document.' : 'Select text in the PDF to analyze.'}
                    </p>
                </div>

                {/* Loading State */}
                {(isLoading || isSummarizing) && (
                    <div className="flex items-center justify-center h-40 animate-pulse text-cyan-400">
                        {isSummarizing ? 'Synthesizing document summary...' : 'Analyzing quantum data...'}
                    </div>
                )}

                {/* Error State */}
                {error && (
                    <div className="p-4 bg-red-900/20 border border-red-500/50 rounded text-red-200 flex items-center gap-2">
                        <AlertCircle size={18} /> {error}
                    </div>
                )}

                {/* Summary View */}
                {viewMode === 'summary' && summaryResult && (
                    <div className="p-8 overflow-y-auto h-full custom-scrollbar">
                        <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-2">
                            <Sparkles className="text-purple-400" /> 文章摘要
                        </h2>

                        <div className="text-gray-300 space-y-4 leading-8 text-justify tracking-wide whitespace-pre-wrap">
                            {summaryResult}
                        </div>
                    </div>
                )}

                {/* Analysis View */}
                {viewMode === 'analysis' && analysisResult && (
                    <div className="space-y-4">
                        {Array.isArray(analysisResult) ? (
                            analysisResult.map((item, index) => (
                                <div key={index} className="p-4 rounded bg-gray-800 border border-gray-700 shadow-lg hover:border-cyan-400/50 transition">
                                    <div className="mb-2 text-lg text-white font-medium">{item.en}</div>
                                    <div className="mb-2 text-cyan-300">{item.zh}</div>
                                </div>
                            ))
                        ) : (
                            <div className="p-4 rounded bg-gray-800 border border-gray-700">
                                <pre className="whitespace-pre-wrap text-sm text-gray-300">
                                    {JSON.stringify(analysisResult, null, 2)}
                                </pre>
                            </div>
                        )}
                    </div>
                )}

                {/* Empty State */}
                {!isLoading && !isSummarizing && !analysisResult && !summaryResult && !error && (
                    <div className="flex-1 flex items-center justify-center text-gray-600 italic">
                        Waiting for input stream...
                    </div>
                )}
            </div>
        </div>
    );
}

export default App;
