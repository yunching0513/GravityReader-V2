import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Sparkles, Zap, AlertCircle, Menu, Download, FileText, X, Book, Upload } from 'lucide-react';
import PdfReader from './components/PdfReader';
import { saveFile, getFiles, deleteFile, updateFilePage } from './utils/db';

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
    const [translationMode, setTranslationMode] = useState('sentence'); // 'sentence' | 'paragraph'
    const [customSummaryLength, setCustomSummaryLength] = useState(500);
    const [isSummarizing, setIsSummarizing] = useState(false);

    // My Library State
    const [libraryFiles, setLibraryFiles] = useState([]);
    const [externalFile, setExternalFile] = useState(null);
    const [currentFileId, setCurrentFileId] = useState(null);
    const [initialPage, setInitialPage] = useState(1);
    const [openSection, setOpenSection] = useState('library'); // 'library' | 'export' | 'summary'

    // API Configuration
    const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api/analyze';

    // Load Library on Mount
    useEffect(() => {
        loadLibrary();
    }, []);

    const loadLibrary = async () => {
        try {
            const files = await getFiles();
            setLibraryFiles(files.sort((a, b) => b.timestamp - a.timestamp));
        } catch (err) {
            console.error("Failed to load library:", err);
        }
    };

    const handleFileChange = async (e) => {
        const file = e.target.files[0];
        if (file) {
            try {
                const newId = await saveFile(file);
                await loadLibrary();
                // Also load into reader immediately
                setExternalFile(file);
                setCurrentFileId(newId); // Assuming saveFile returns the ID, checking db.js implementation
                setInitialPage(1);
            } catch (err) {
                console.error("Failed to save file:", err);
                alert("Failed to save file to library.");
            }
        }
    };

    const loadFileFromLibrary = (fileData) => {
        setExternalFile(fileData.data);
        setCurrentFileId(fileData.id);
        setInitialPage(fileData.lastPage || 1);
    };

    const handlePageChange = async (page) => {
        if (currentFileId) {
            try {
                await updateFilePage(currentFileId, page);
                // We don't reload the whole library here to avoid UI flickering, 
                // but we could update the local state if we wanted to show the page number in the list.
            } catch (err) {
                console.error("Failed to update page:", err);
            }
        }
    };

    const toggleSection = (section) => {
        setOpenSection(openSection === section ? null : section);
    };

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
            const response = await axios.post(API_URL, {
                text,
                mode: translationMode
            });

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
            // Derive summarize URL from analyze URL
            const summarizeUrl = API_URL.replace('/analyze', '/summarize');
            const response = await axios.post(summarizeUrl, {
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

    const [fontMode, setFontMode] = useState('default'); // 'default' | 'zen'
    const [highlightedText, setHighlightedText] = useState('');
    const [highlightColor, setHighlightColor] = useState('rgba(255, 255, 170, 0.5)'); // Default Yellow

    const handleAnalysisItemClick = (text) => {
        setHighlightedText(text);
    };

    return (
        <div className={`flex h-screen w-screen overflow-hidden bg-[#202225] text-white font-sans relative ${fontMode === 'zen' ? 'font-zen' : 'font-microsoft'}`}>
            {/* Sidebar Toggle */}
            <button
                onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                className="absolute top-4 left-4 z-50 p-2 bg-gray-800 rounded hover:bg-gray-700 transition-colors shadow-lg"
            >
                {isSidebarOpen ? <X size={20} /> : <Menu size={20} />}
            </button>

            {/* Sidebar Drawer */}
            <div className={`fixed top-0 left-0 h-full w-64 bg-[#202225] border-r border-gray-700 z-40 transform transition-transform duration-300 ease-in-out ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'} pt-16 px-4 shadow-2xl overflow-y-auto custom-scrollbar`}>

                {/* 1. My Library Section */}
                <div className="mb-4 border-b border-gray-700 pb-4">
                    <button
                        onClick={() => toggleSection('library')}
                        className="w-full flex items-center justify-between text-cyan-400 font-bold mb-2 hover:text-cyan-300 transition"
                    >
                        <span className="flex items-center gap-2"><Book size={18} /> 我的書庫</span>
                        <span className="text-xs">{openSection === 'library' ? '▲' : '▼'}</span>
                    </button>

                    {openSection === 'library' && (
                        <div className="space-y-2 animate-fadeIn">
                            {/* Upload Button */}
                            <label className="flex items-center justify-center w-full p-2 bg-gray-800 hover:bg-gray-700 rounded cursor-pointer border border-dashed border-gray-600 hover:border-cyan-500 transition group">
                                <Upload size={16} className="mr-2 text-gray-400 group-hover:text-cyan-400" />
                                <span className="text-sm text-gray-300 group-hover:text-white">上傳新文件</span>
                                <input type="file" onChange={handleFileChange} className="hidden" accept=".pdf" />
                            </label>

                            {/* File List */}
                            <div className="max-h-48 overflow-y-auto custom-scrollbar space-y-1 mt-2">
                                {libraryFiles.length === 0 ? (
                                    <p className="text-xs text-gray-500 text-center py-2">尚無文件</p>
                                ) : (
                                    libraryFiles.map(file => (
                                        <div key={file.id} className="flex items-center justify-between p-2 bg-gray-800/50 hover:bg-gray-800 rounded group">
                                            <button
                                                onClick={() => loadFileFromLibrary(file)}
                                                className="text-sm text-gray-300 hover:text-white truncate text-left flex-1"
                                                title={file.name}
                                            >
                                                {file.name}
                                            </button>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); deleteFile(file.id).then(loadLibrary); }}
                                                className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition p-1"
                                            >
                                                <X size={14} />
                                            </button>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* 2. Export Section */}
                <div className="mb-4 border-b border-gray-700 pb-4">
                    <button
                        onClick={() => toggleSection('export')}
                        className="w-full flex items-center justify-between text-green-400 font-bold mb-2 hover:text-green-300 transition"
                    >
                        <span className="flex items-center gap-2"><Download size={18} /> 匯出翻譯記錄</span>
                        <span className="text-xs">{openSection === 'export' ? '▲' : '▼'}</span>
                    </button>

                    {openSection === 'export' && (
                        <div className="flex flex-col gap-2 animate-fadeIn">
                            <button onClick={() => handleExport('zh')} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded text-sm text-left transition border border-gray-700 hover:border-green-500/50">
                                全中文下載 (.txt)
                            </button>
                            <button onClick={() => handleExport('bilingual')} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded text-sm text-left transition border border-gray-700 hover:border-green-500/50">
                                中英對照下載 (.txt)
                            </button>
                        </div>
                    )}
                </div>

                {/* 3. Summary Section */}
                <div className="mb-4">
                    <button
                        onClick={() => toggleSection('summary')}
                        className="w-full flex items-center justify-between text-pink-500 font-bold mb-2 hover:text-pink-400 transition"
                    >
                        <span className="flex items-center gap-2"><FileText size={18} /> 文章摘要</span>
                        <span className="text-xs">{openSection === 'summary' ? '▲' : '▼'}</span>
                    </button>

                    {openSection === 'summary' && (
                        <div className="animate-fadeIn">
                            <div className="grid grid-cols-2 gap-2 mb-4">
                                {[250, 500, 1000, 2000].map(len => (
                                    <button key={len} onClick={() => handleSummarize(len)} className="px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-xs transition border border-gray-700 hover:border-pink-500/50">
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
                                <button onClick={() => handleSummarize(customSummaryLength)} className="px-3 py-1 bg-pink-600 hover:bg-pink-500 rounded text-sm whitespace-nowrap">
                                    生成
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Left Panel - PDF Reader */}
            <div
                className="h-full border-r border-gray-700 flex flex-col relative"
                style={{ width: `${leftWidth}%`, minWidth: '20%' }}
            >
                <div className="absolute top-0 left-0 w-full p-2 pl-16 z-10 bg-[#202225]/80 backdrop-blur text-cyan-400 font-bold flex items-center gap-2 pointer-events-none">
                    <Zap size={18} /> GravityReader V2
                </div>
                <PdfReader
                    onTextSelect={handleTextSelect}
                    onDocumentLoad={handleDocumentLoad}
                    highlightedText={highlightedText}
                    highlightColor={highlightColor}
                    externalFile={externalFile}
                    initialPage={initialPage}
                    onPageChange={handlePageChange}
                />
            </div>

            {/* Resizer Handle */}
            <div
                className="w-1 h-full bg-gray-800 hover:bg-cyan-500 cursor-col-resize transition-colors z-20"
                onMouseDown={() => setIsDragging(true)}
            />

            {/* Right Panel - Analysis / Summary */}
            <div
                className="h-full flex flex-col bg-[#202225] p-6 overflow-auto relative"
                style={{ width: `${100 - leftWidth}%` }}
            >
                {/* Header Section */}
                <div className="mb-6 border-b border-gray-700 pb-4 flex justify-between items-end relative">
                    <div>
                        <h2 className="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-pink-500 flex items-center gap-2">
                            <Sparkles className="text-pink-500" />
                            {viewMode === 'summary' ? 'Document Summary' : 'Neural Analysis'}
                        </h2>
                        <p className="text-gray-400 text-sm mt-1">
                            {viewMode === 'summary' ? 'AI-generated summary of the document.' : 'Select text in the PDF to analyze.'}
                        </p>
                    </div>

                    {/* Highlight Color Toggle */}
                    <div className="absolute top-0 right-64 flex gap-2">
                        <button
                            onClick={() => setHighlightColor('rgba(255, 255, 170, 0.5)')}
                            className={`w-6 h-6 rounded-full border-2 ${highlightColor.includes('170') ? 'border-white' : 'border-transparent'}`}
                            style={{ backgroundColor: 'rgba(255, 255, 170, 1)' }}
                            title="Yellow Highlight"
                        />
                        <button
                            onClick={() => setHighlightColor('rgba(255, 151, 151, 0.5)')}
                            className={`w-6 h-6 rounded-full border-2 ${highlightColor.includes('151') ? 'border-white' : 'border-transparent'}`}
                            style={{ backgroundColor: 'rgba(255, 151, 151, 1)' }}
                            title="Red Highlight"
                        />
                    </div>

                    {/* Font Toggle */}
                    <button
                        onClick={() => setFontMode(fontMode === 'default' ? 'zen' : 'default')}
                        className={`absolute top-0 right-48 px-3 py-1 text-xs rounded border border-gray-600 transition-colors ${fontMode === 'zen' ? 'bg-pink-600 text-white' : 'text-gray-400 hover:text-white'}`}
                        title="Toggle Zen Maru Gothic Font"
                    >
                        Aa
                    </button>

                    {/* Translation Mode Toggle */}
                    {viewMode === 'analysis' && (
                        <div className="absolute bottom-4 right-10 flex bg-gray-800 rounded-lg p-1 border border-gray-700 shadow-lg">
                            <button
                                onClick={() => setTranslationMode('sentence')}
                                className={`px-6 py-2 text-sm font-medium rounded-md transition-all duration-200 ${translationMode === 'sentence' ? 'bg-cyan-600 text-white shadow-md' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
                            >
                                逐句
                            </button>
                            <button
                                onClick={() => setTranslationMode('paragraph')}
                                className={`px-6 py-2 text-sm font-medium rounded-md transition-all duration-200 ${translationMode === 'paragraph' ? 'bg-cyan-600 text-white shadow-md' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
                            >
                                逐段
                            </button>
                        </div>
                    )}
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
                    <div className="space-y-6">
                        {Array.isArray(analysisResult) ? (
                            analysisResult.map((item, index) => (
                                <div
                                    key={index}
                                    className={`bg-gray-800/50 p-6 rounded-xl border border-gray-700 hover:border-cyan-500/50 transition-all group cursor-pointer ${highlightedText === item.en ? 'ring-2 ring-cyan-500 bg-gray-800' : ''}`}
                                    onClick={() => handleAnalysisItemClick(item.en)}
                                >
                                    <p className="text-gray-300 mb-3 leading-relaxed font-serif text-lg group-hover:text-white transition-colors">
                                        {item.en}
                                    </p>
                                    <div className="h-px w-full bg-gray-700 my-3 group-hover:bg-cyan-500/30 transition-colors" />
                                    <p className="text-cyan-300 leading-relaxed font-sans text-lg">
                                        {item.zh}
                                    </p>
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
