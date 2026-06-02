import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { AlertCircle, Menu, X, Upload, ChevronDown } from 'lucide-react';
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

    // Reading preferences
    const [fontMode, setFontMode] = useState('default'); // 'default' | 'zen'
    const [highlightedText, setHighlightedText] = useState('');
    const [highlightColor, setHighlightColor] = useState('rgba(193, 95, 60, 0.22)'); // 朱 vermilion

    // API Configuration
    const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

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
            const response = await axios.post(`${API_BASE_URL}/api/analyze`, {
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
            setError("無法分析文本，請確認後端服務正在運行。");
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
            alert("請先載入 PDF 文件。");
            return;
        }
        setIsSummarizing(true);
        setViewMode('summary');
        setSummaryResult(null);

        try {
            const text = await extractPdfText();
            const response = await axios.post(`${API_BASE_URL}/api/summarize`, {
                text: text.substring(0, 30000), // Limit text length to avoid payload issues
                length: length
            });
            setSummaryResult(response.data.summary);
        } catch (err) {
            console.error("Summarize Error:", err);
            setError("文件摘要生成失敗。");
        } finally {
            setIsSummarizing(false);
        }
    };

    const handleExport = (type) => {
        if (!analysisResult || !Array.isArray(analysisResult)) {
            alert("尚無翻譯資料可匯出。");
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

    const handleAnalysisItemClick = (text) => {
        setHighlightedText(text);
    };

    const isBusy = isLoading || isSummarizing;
    const isEmpty = !isBusy && !analysisResult && !summaryResult && !error;

    return (
        <div className={`gr-app gr-scroll ${fontMode === 'zen' ? 'is-zen' : ''}`}>
            {/* Sidebar Toggle */}
            <button
                onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                className="gr-menu-btn"
                title={isSidebarOpen ? '關閉側欄' : '開啟側欄'}
            >
                {isSidebarOpen ? <X size={18} /> : <Menu size={18} />}
            </button>

            {/* Backdrop */}
            <div
                className={`gr-backdrop ${isSidebarOpen ? 'is-open' : ''}`}
                onClick={() => setIsSidebarOpen(false)}
            />

            {/* Sidebar Drawer */}
            <aside className={`gr-sidebar gr-scroll ${isSidebarOpen ? 'is-open' : ''}`}>
                <div className="gr-side-head">
                    <div className="gr-side-mark">Gravity<span>Reader</span></div>
                    <div className="gr-side-sub">重力閱讀 · 雙語精讀 · II</div>
                </div>

                {/* 1. My Library */}
                <section className="gr-side-sec">
                    <button className="gr-side-toggle" onClick={() => toggleSection('library')}>
                        <span className="grp">
                            <span className="num">01</span>
                            <span className="zh">我的書庫</span>
                        </span>
                        <ChevronDown size={13} className={`chev ${openSection === 'library' ? 'open' : ''}`} />
                    </button>
                    <div className="gr-side-en">Library · 收藏文件</div>

                    {openSection === 'library' && (
                        <div className="gr-side-body">
                            <label className="gr-upload">
                                <Upload size={18} />
                                <span className="zh">上傳新文件</span>
                                <span className="en">Upload PDF</span>
                                <input type="file" onChange={handleFileChange} style={{ display: 'none' }} accept=".pdf" />
                            </label>

                            <div className="gr-filelist gr-scroll">
                                {libraryFiles.length === 0 ? (
                                    <div className="gr-file-empty">尚無文件 · empty</div>
                                ) : (
                                    libraryFiles.map(file => (
                                        <div key={file.id} className={`gr-file ${currentFileId === file.id ? 'is-active' : ''}`}>
                                            <button
                                                className="gr-file-name"
                                                onClick={() => loadFileFromLibrary(file)}
                                                title={file.name}
                                            >
                                                {file.name}
                                            </button>
                                            <button
                                                className="gr-file-del"
                                                onClick={(e) => { e.stopPropagation(); deleteFile(file.id).then(loadLibrary); }}
                                                title="刪除"
                                            >
                                                <X size={14} />
                                            </button>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    )}
                </section>

                {/* 2. Export */}
                <section className="gr-side-sec">
                    <button className="gr-side-toggle" onClick={() => toggleSection('export')}>
                        <span className="grp">
                            <span className="num">02</span>
                            <span className="zh">匯出記錄</span>
                        </span>
                        <ChevronDown size={13} className={`chev ${openSection === 'export' ? 'open' : ''}`} />
                    </button>
                    <div className="gr-side-en">Export · 翻譯紀錄</div>

                    {openSection === 'export' && (
                        <div className="gr-side-body">
                            <button className="gr-side-btn" onClick={() => handleExport('zh')}>
                                <span className="zh">全中文下載</span>
                                <span className="en">Chinese only · .txt</span>
                            </button>
                            <button className="gr-side-btn" onClick={() => handleExport('bilingual')}>
                                <span className="zh">中英對照下載</span>
                                <span className="en">Bilingual · .txt</span>
                            </button>
                        </div>
                    )}
                </section>

                {/* 3. Summary */}
                <section className="gr-side-sec">
                    <button className="gr-side-toggle" onClick={() => toggleSection('summary')}>
                        <span className="grp">
                            <span className="num">03</span>
                            <span className="zh">文章摘要</span>
                        </span>
                        <ChevronDown size={13} className={`chev ${openSection === 'summary' ? 'open' : ''}`} />
                    </button>
                    <div className="gr-side-en">Synopsis · 全文摘要</div>

                    {openSection === 'summary' && (
                        <div className="gr-side-body">
                            <div className="gr-len-grid">
                                {[250, 500, 1000, 2000].map(len => (
                                    <button key={len} className="gr-len-btn" onClick={() => handleSummarize(len)}>
                                        <span className="v">{len}</span>
                                        <span className="u">字</span>
                                    </button>
                                ))}
                            </div>
                            <div className="gr-len-custom">
                                <input
                                    type="number"
                                    className="gr-input"
                                    value={customSummaryLength}
                                    onChange={(e) => setCustomSummaryLength(parseInt(e.target.value))}
                                />
                                <button className="gr-btn gr-btn--accent" onClick={() => handleSummarize(customSummaryLength)}>
                                    生成
                                </button>
                            </div>
                        </div>
                    )}
                </section>
            </aside>

            {/* Left Panel — PDF Reader */}
            <div className="gr-reader" style={{ width: `${leftWidth}%`, minWidth: '20%' }}>
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

            {/* Resizer */}
            <div
                className={`gr-resizer ${isDragging ? 'is-dragging' : ''}`}
                onMouseDown={() => setIsDragging(true)}
            />

            {/* Right Panel — Analysis / Summary */}
            <div className="gr-analysis" style={{ width: `${100 - leftWidth}%` }}>
                {/* Header */}
                <div className="gr-analysis-head">
                    <div>
                        <div className="gr-head-kicker">
                            {viewMode === 'summary' ? 'Synopsis — full-text digest' : 'Close Reading — bilingual study'}
                        </div>
                        <div className="gr-head-title">
                            {viewMode === 'summary' ? '全文摘要' : '對譯精讀'}
                        </div>
                        <div className="gr-head-sub">
                            {viewMode === 'summary' ? '由 AI 生成的全文摘要。' : '於左側 PDF 中選取文字以進行對譯。'}
                        </div>
                    </div>

                    <div className="gr-head-tools">
                        {/* Highlight color */}
                        <div className="gr-tool-group">
                            <span className="gr-tool-label">標</span>
                            <button
                                className={`gr-swatch ${highlightColor.includes('95, 60') ? 'is-active' : ''}`}
                                style={{ background: 'rgba(193, 95, 60, 0.45)' }}
                                onClick={() => setHighlightColor('rgba(193, 95, 60, 0.22)')}
                                title="朱 · Vermilion"
                            />
                            <button
                                className={`gr-swatch ${highlightColor.includes('124, 115') ? 'is-active' : ''}`}
                                style={{ background: 'rgba(128, 124, 115, 0.45)' }}
                                onClick={() => setHighlightColor('rgba(128, 124, 115, 0.28)')}
                                title="鋼灰 · Steel"
                            />
                        </div>

                        {/* Font toggle */}
                        <button
                            className={`gr-btn ${fontMode === 'zen' ? 'gr-btn--solid' : ''}`}
                            onClick={() => setFontMode(fontMode === 'default' ? 'zen' : 'default')}
                            title="切換 Zen Maru Gothic 字體"
                        >
                            Aa
                        </button>

                        {/* Translation mode */}
                        {viewMode === 'analysis' && (
                            <div className="gr-seg">
                                <button
                                    className={translationMode === 'sentence' ? 'is-active' : ''}
                                    onClick={() => setTranslationMode('sentence')}
                                >
                                    逐句
                                </button>
                                <button
                                    className={translationMode === 'paragraph' ? 'is-active' : ''}
                                    onClick={() => setTranslationMode('paragraph')}
                                >
                                    逐段
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                {/* Body */}
                <div className="gr-analysis-body gr-scroll">
                    {/* Loading */}
                    {isBusy && (
                        <div className="gr-loading">
                            <div className="en">{isSummarizing ? 'Synthesizing synopsis' : 'Reading the passage'}</div>
                            <div className="gr-bar" />
                            <div className="zh">{isSummarizing ? '正在凝練摘要' : '正在對譯文本'}</div>
                        </div>
                    )}

                    {/* Error */}
                    {error && (
                        <div className="gr-error">
                            <AlertCircle size={18} /> {error}
                        </div>
                    )}

                    {/* Summary */}
                    {!isBusy && viewMode === 'summary' && summaryResult && (
                        <div className="gr-summary">
                            <div className="gr-summary-text">{summaryResult}</div>
                        </div>
                    )}

                    {/* Analysis */}
                    {!isBusy && viewMode === 'analysis' && analysisResult && (
                        Array.isArray(analysisResult) ? (
                            <div className="gr-cards">
                                {analysisResult.map((item, index) => (
                                    <div
                                        key={index}
                                        className={`gr-entry ${highlightedText === item.en ? 'is-active' : ''}`}
                                        onClick={() => handleAnalysisItemClick(item.en)}
                                    >
                                        <span className="gr-entry-n">{String(index + 1).padStart(2, '0')}</span>
                                        <p className="gr-entry-en">{item.en}</p>
                                        <div className="gr-entry-rule" />
                                        <p className="gr-entry-zh">{item.zh}</p>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <pre className="gr-raw">{JSON.stringify(analysisResult, null, 2)}</pre>
                        )
                    )}

                    {/* Empty */}
                    {isEmpty && (
                        <div className="gr-empty" style={{ minHeight: '60vh' }}>
                            <div className="glyph">間</div>
                            <div className="en">Awaiting the text</div>
                            <div className="zh">靜待文本</div>
                            <div className="hint">select text in the pdf</div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

export default App;
