import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { AlertCircle, Menu, X, Upload, ChevronDown, Plus, Check, Trash2, Volume2, Headphones } from 'lucide-react';
import PdfReader from './components/PdfReader';
import AudioBar from './components/AudioBar';
import { saveFile, getFiles, deleteFile, updateFilePage, addNote, getNotes, deleteNote } from './utils/db';
import { useAudioReader } from './utils/audioReader';
import { splitSentences } from './utils/tts';

const DEFAULT_VOICES = [
    { id: 'Kore', label: 'Kore · 沉穩女聲' },
    { id: 'Puck', label: 'Puck · 活潑男聲' },
];

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

    // Notes State (per-document)
    const [activeTab, setActiveTab] = useState('reading'); // 'reading' | 'notes'
    const [notes, setNotes] = useState([]);
    const [noteDraft, setNoteDraft] = useState('');
    const [justCaptured, setJustCaptured] = useState(null);

    // Read-aloud (TTS) State
    const [ttsVoices, setTtsVoices] = useState(DEFAULT_VOICES);
    const [ttsVoice, setTtsVoice] = useState('Kore');
    const [ttsSpeed, setTtsSpeed] = useState(1.0);
    const [playEngine, setPlayEngine] = useState('gemini'); // live read-aloud engine
    const [ttsActive, setTtsActive] = useState(false); // a read session is live
    const [currentPage, setCurrentPage] = useState(1);
    const [requestedPage, setRequestedPage] = useState(null); // drives the viewer
    const currentPageRef = useRef(1);
    const ttsPageRef = useRef(1);     // page currently being read (for auto-advance)
    const pdfDocumentRef = useRef(null);

    // Whole-book audiobook State (engine: 'say' offline | 'gemini' cloud)
    const [sayVoices, setSayVoices] = useState([]);
    const [bookEngine, setBookEngine] = useState('say');
    const [bookVoice, setBookVoice] = useState('Samantha');
    const [bookJob, setBookJob] = useState(null); // {status, done, total, path, bytes, error}
    const bookTimerRef = useRef(null);

    // API Configuration
    const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

    // ── Read-aloud wiring ─────────────────────────────────────────────
    // Called by the audio reader as each sentence starts (or null when it ends):
    // highlight the spoken sentence on the PDF and keep it scrolled into view.
    const handleActiveSentence = (text) => {
        if (text) {
            setTtsActive(true);
            setHighlightedText(text);
        } else {
            setTtsActive(false);
            setHighlightedText('');
        }
    };

    const reader = useAudioReader({
        apiBase: API_BASE_URL,
        voice: ttsVoice,
        speed: ttsSpeed,
        engine: playEngine,
        onActive: handleActiveSentence,
    });

    // Switch the live read-aloud engine (and reset to that engine's voice).
    const selectPlayEngine = (engine) => {
        reader.stop();
        setPlayEngine(engine);
        if (engine === 'gemini') {
            setTtsVoice((ttsVoices[0] && ttsVoices[0].id) || 'Kore');
        } else {
            setTtsVoice(sayVoices.find(v => v.id === 'Samantha') ? 'Samantha' : ((sayVoices[0] && sayVoices[0].id) || 'Samantha'));
        }
    };
    const playVoiceOptions = playEngine === 'gemini'
        ? ttsVoices
        : (sayVoices.length ? sayVoices : [{ id: 'Samantha', label: 'Samantha' }]);
    // Offline `say`/`afconvert` are macOS-only; the backend returns no `say`
    // voices on other platforms (e.g. Windows), so we hide offline features.
    const offlineAvailable = sayVoices.length > 0;

    // Load the available voices once.
    useEffect(() => {
        axios.get(`${API_BASE_URL}/api/tts/voices`)
            .then(res => {
                const g = res.data && res.data.gemini;
                if (g && g.length) setTtsVoices(g);
                const s = res.data && res.data.say;
                if (s && s.length) {
                    setSayVoices(s);
                    if (!s.find(v => v.id === 'Samantha')) setBookVoice(s[0].id);
                }
            })
            .catch(() => {});
    }, []);

    const extractPageText = async (n) => {
        const doc = pdfDocumentRef.current;
        if (!doc) return '';
        const page = await doc.getPage(n);
        const tc = await page.getTextContent();
        return tc.items.map(it => it.str).join(' ');
    };

    // Pull the next page's sentences when the current page finishes — gives
    // continuous "read on" playback (and skips blank pages).
    const readNextPage = async () => {
        const doc = pdfDocumentRef.current;
        const np = ttsPageRef.current + 1;
        if (!doc || np > doc.numPages) return null;
        ttsPageRef.current = np;
        setRequestedPage(np);
        const segs = splitSentences(await extractPageText(np));
        if (!segs.length) return readNextPage();
        return { segments: segs };
    };

    const startReadingFrom = async (pageNo) => {
        if (!pdfDocumentRef.current) { alert('請先載入 PDF 文件。'); return; }
        ttsPageRef.current = pageNo;
        setRequestedPage(pageNo);
        const segs = splitSentences(await extractPageText(pageNo));
        if (segs.length) {
            reader.start({ segments: segs, fileId: currentFileId, getNext: readNextPage });
        } else {
            const next = await readNextPage();
            if (next) reader.start({ segments: next.segments, fileId: currentFileId, getNext: readNextPage });
            else alert('這份文件沒有可朗讀的文字。');
        }
    };

    const handleReadPage = () => {
        if (ttsActive) { reader.stop(); return; }
        startReadingFrom(currentPageRef.current || 1);
    };

    const handleReadEntry = (en) => {
        if (!en) return;
        reader.start({ segments: splitSentences(en), fileId: currentFileId, getNext: null });
    };

    // ── Whole-book audiobook ──────────────────────────────────────────
    const bookBusy = bookJob && ['extracting', 'running', 'combining'].includes(bookJob.status);
    const bookVoiceOptions = bookEngine === 'gemini'
        ? ttsVoices
        : (sayVoices.length ? sayVoices : [{ id: 'Samantha', label: 'Samantha' }]);

    const selectBookEngine = (engine) => {
        if (bookBusy) return;
        setBookEngine(engine);
        if (engine === 'gemini') {
            setBookVoice((ttsVoices[0] && ttsVoices[0].id) || 'Kore');
        } else {
            setBookVoice(sayVoices.find(v => v.id === 'Samantha') ? 'Samantha' : ((sayVoices[0] && sayVoices[0].id) || 'Samantha'));
        }
    };

    const handleGenerateBook = async () => {
        const doc = pdfDocumentRef.current;
        if (!doc) { alert('請先載入 PDF 文件。'); return; }
        if (bookBusy) return;

        setBookJob({ status: 'extracting', done: 0, total: 0 });
        try {
            const pages = [];
            for (let i = 1; i <= doc.numPages; i++) {
                pages.push(await extractPageText(i));
            }
            const name = (currentFileName || 'audiobook').replace(/\.pdf$/i, '');
            const { data } = await axios.post(`${API_BASE_URL}/api/tts/book`, { pages, voice: bookVoice, name, engine: bookEngine });
            const jobId = data.jobId;
            setBookJob({ status: 'running', done: 0, total: 0 });

            clearInterval(bookTimerRef.current);
            bookTimerRef.current = setInterval(async () => {
                try {
                    const r = await axios.get(`${API_BASE_URL}/api/tts/book/${jobId}`);
                    setBookJob(r.data);
                    if (r.data.status === 'done' || r.data.status === 'error') {
                        clearInterval(bookTimerRef.current);
                    }
                } catch (_) { /* keep polling */ }
            }, 800);
        } catch (e) {
            setBookJob({ status: 'error', error: '生成失敗:' + (e.message || '') });
        }
    };

    const revealBook = () => {
        if (bookJob && bookJob.path && window.gr && window.gr.reveal) {
            window.gr.reveal(bookJob.path);
        }
    };

    const fmtBytes = (n) => {
        if (!n) return '';
        if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
        return `${Math.round(n / 1024)} KB`;
    };

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

    // Load this document's notes whenever the active file changes.
    useEffect(() => {
        if (!currentFileId) { setNotes([]); return; }
        getNotes(currentFileId)
            .then(list => setNotes(list.sort((a, b) => b.createdAt - a.createdAt)))
            .catch(err => console.error("Failed to load notes:", err));
    }, [currentFileId]);

    const refreshNotes = async () => {
        if (!currentFileId) return;
        const list = await getNotes(currentFileId);
        setNotes(list.sort((a, b) => b.createdAt - a.createdAt));
    };

    const handleAddNote = async () => {
        const text = noteDraft.trim();
        if (!text || !currentFileId) return;
        await addNote({ fileId: currentFileId, text, source: 'manual' });
        setNoteDraft('');
        refreshNotes();
    };

    const handleCaptureEntry = async (en, zh) => {
        if (!currentFileId) {
            alert("請先從書庫開啟一份文件，才能擷取為筆記。");
            return;
        }
        await addNote({ fileId: currentFileId, en, zh, source: 'reading' });
        setJustCaptured(en);
        setTimeout(() => setJustCaptured(null), 1200);
        refreshNotes();
    };

    const handleDeleteNote = async (id) => {
        await deleteNote(id);
        refreshNotes();
    };

    const handleExportNotes = () => {
        if (!notes.length) {
            alert("這份文件尚無筆記可匯出。");
            return;
        }
        const ordered = [...notes].sort((a, b) => a.createdAt - b.createdAt);
        const content = ordered.map(n => {
            const t = new Date(n.createdAt).toLocaleString();
            if (n.source === 'reading') {
                return `[${t}]\n[EN] ${n.en}\n[ZH] ${n.zh}${n.text ? `\n${n.text}` : ''}`;
            }
            return `[${t}]\n${n.text}`;
        }).join('\n\n──────────\n\n');

        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `notes_${new Date().getTime()}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const fmtTime = (ts) => {
        const d = new Date(ts);
        const p = (n) => String(n).padStart(2, '0');
        return `${p(d.getMonth() + 1)}.${p(d.getDate())} · ${p(d.getHours())}:${p(d.getMinutes())}`;
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
        reader.stop();
        setExternalFile(fileData.data);
        setCurrentFileId(fileData.id);
        setInitialPage(fileData.lastPage || 1);
    };

    const handlePageChange = async (page) => {
        setCurrentPage(page);
        currentPageRef.current = page;
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
        setActiveTab('reading');
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
        pdfDocumentRef.current = pdf;
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
        setActiveTab('reading');
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
    const currentFileName = libraryFiles.find(f => f.id === currentFileId)?.name;

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
                            <button className="gr-side-btn" onClick={handleExportNotes}>
                                <span className="zh">筆記下載</span>
                                <span className="en">Notes · .txt</span>
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

                {/* 4. Read Aloud */}
                <section className="gr-side-sec">
                    <button className="gr-side-toggle" onClick={() => toggleSection('audio')}>
                        <span className="grp">
                            <span className="num">04</span>
                            <span className="zh">聲音生成</span>
                        </span>
                        <ChevronDown size={13} className={`chev ${openSection === 'audio' ? 'open' : ''}`} />
                    </button>
                    <div className="gr-side-en">Read Aloud · 英文朗讀</div>

                    {openSection === 'audio' && (
                        <div className="gr-side-body">
                            {offlineAvailable && (
                                <label className="gr-audio-field">
                                    <span className="gr-audio-field-label">即時朗讀引擎 · Live</span>
                                    <div className="gr-seg gr-seg--full">
                                        <button className={playEngine === 'gemini' ? 'is-active' : ''} onClick={() => selectPlayEngine('gemini')}>
                                            Gemini 雲端
                                        </button>
                                        <button className={playEngine === 'say' ? 'is-active' : ''} onClick={() => selectPlayEngine('say')}>
                                            Apple 離線
                                        </button>
                                    </div>
                                </label>
                            )}
                            <label className="gr-audio-field">
                                <span className="gr-audio-field-label">{playEngine === 'gemini' ? '語音 · Gemini' : '語音 · macOS'}</span>
                                <select className="gr-input" value={ttsVoice} onChange={(e) => setTtsVoice(e.target.value)}>
                                    {playVoiceOptions.map(v => <option key={v.id} value={v.id}>{v.label || v.id}</option>)}
                                </select>
                            </label>
                            <p className="gr-audio-hint">
                                {playEngine === 'gemini' ? '高音質 · 需網路 · 依字數計費。' : '免費 · 離線 · 省錢。'}
                            </p>

                            <button className="gr-side-btn" onClick={() => startReadingFrom(currentPageRef.current || 1)}>
                                <span className="zh">從本頁開始朗讀</span>
                                <span className="en">Read from this page</span>
                            </button>
                            <button className="gr-side-btn" onClick={() => startReadingFrom(1)}>
                                <span className="zh">從頭朗讀整本</span>
                                <span className="en">Read the whole book</span>
                            </button>
                            <p className="gr-audio-hint">段落朗讀:在「精讀」每張卡片點 <Volume2 size={11} style={{ verticalAlign: '-1px' }} />。</p>

                            {offlineAvailable && (
                            <div className="gr-book">
                                <div className="gr-book-head">生成有聲書 · Audiobook</div>

                                <label className="gr-audio-field">
                                    <span className="gr-audio-field-label">引擎 · Engine</span>
                                    <div className="gr-seg gr-seg--full">
                                        <button
                                            className={bookEngine === 'say' ? 'is-active' : ''}
                                            onClick={() => selectBookEngine('say')}
                                            disabled={bookBusy}
                                        >
                                            Apple 離線
                                        </button>
                                        <button
                                            className={bookEngine === 'gemini' ? 'is-active' : ''}
                                            onClick={() => selectBookEngine('gemini')}
                                            disabled={bookBusy}
                                        >
                                            Gemini 雲端
                                        </button>
                                    </div>
                                </label>

                                <label className="gr-audio-field">
                                    <span className="gr-audio-field-label">{bookEngine === 'gemini' ? '語音 · Gemini' : '語音 · macOS'}</span>
                                    <select className="gr-input" value={bookVoice} onChange={(e) => setBookVoice(e.target.value)}>
                                        {bookVoiceOptions.map(v => (
                                            <option key={v.id} value={v.id}>{v.label || v.id}</option>
                                        ))}
                                    </select>
                                </label>

                                <p className="gr-audio-hint">
                                    {bookEngine === 'gemini'
                                        ? '高音質 · 需網路 · 依字數計費,整本較慢且受速率限制。'
                                        : '免費 · 離線 · 生成快速。'}
                                </p>

                                <button className="gr-side-btn" onClick={handleGenerateBook} disabled={bookBusy}>
                                    <span className="zh">{bookBusy ? '生成中…' : '生成整本有聲書'}</span>
                                    <span className="en">Whole book · .m4a · {bookEngine === 'gemini' ? 'Gemini' : 'offline'}</span>
                                </button>

                                {bookJob && (
                                    <div className="gr-book-status">
                                        {bookJob.status === 'extracting' && <div className="gr-book-line">擷取文字中…</div>}
                                        {bookJob.status === 'running' && (
                                            <>
                                                <div className="gr-book-bar">
                                                    <div className="gr-book-fill" style={{ width: `${bookJob.total ? Math.round((bookJob.done / bookJob.total) * 100) : 4}%` }} />
                                                </div>
                                                <div className="gr-book-line">生成中 · {bookJob.done} / {bookJob.total} 段</div>
                                            </>
                                        )}
                                        {bookJob.status === 'combining' && (
                                            <>
                                                <div className="gr-book-bar"><div className="gr-book-fill" style={{ width: '100%' }} /></div>
                                                <div className="gr-book-line">合併與轉檔中…</div>
                                            </>
                                        )}
                                        {bookJob.status === 'done' && (
                                            <>
                                                <div className="gr-book-line gr-book-done">✓ 已生成 · {fmtBytes(bookJob.bytes)}</div>
                                                {window.gr ? (
                                                    <button className="gr-side-btn" onClick={revealBook}>
                                                        <span className="zh">在 Finder 顯示</span>
                                                        <span className="en">Reveal in Finder</span>
                                                    </button>
                                                ) : (
                                                    <div className="gr-book-path">{bookJob.path}</div>
                                                )}
                                            </>
                                        )}
                                        {bookJob.status === 'error' && <div className="gr-book-line gr-book-err">{bookJob.error}</div>}
                                    </div>
                                )}
                            </div>
                            )}
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
                    requestedPage={requestedPage}
                    onReadPage={handleReadPage}
                    autoScroll={ttsActive}
                    isReading={ttsActive}
                />
                {ttsActive && (
                    <AudioBar
                        isPlaying={reader.isPlaying}
                        isLoading={reader.isLoading}
                        activeText={reader.activeText}
                        position={reader.position}
                        engineLabel={playEngine === 'gemini' ? 'Gemini' : 'Apple'}
                        speed={ttsSpeed}
                        onSpeed={setTtsSpeed}
                        onToggle={reader.toggle}
                        onPrev={reader.prev}
                        onNext={reader.next}
                        onStop={reader.stop}
                    />
                )}
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
                    <div className="gr-head-main">
                        <div className="gr-tabs">
                            <button
                                className={`gr-tab ${activeTab === 'reading' ? 'is-active' : ''}`}
                                onClick={() => setActiveTab('reading')}
                            >
                                精讀<em>Reading</em>
                            </button>
                            <button
                                className={`gr-tab ${activeTab === 'notes' ? 'is-active' : ''}`}
                                onClick={() => setActiveTab('notes')}
                            >
                                筆記<em>Notes</em>
                                {notes.length > 0 && <span className="gr-tab-count">{notes.length}</span>}
                            </button>
                        </div>
                        <div className="gr-head-title">
                            {activeTab === 'notes'
                                ? '我的筆記'
                                : (viewMode === 'summary' ? '全文摘要' : '對譯精讀')}
                        </div>
                        <div className="gr-head-sub">
                            {activeTab === 'notes'
                                ? (currentFileName ? `《${currentFileName}》 · ${notes.length} 則筆記` : '開啟文件以開始筆記')
                                : (viewMode === 'summary' ? '由 AI 生成的全文摘要。' : '於左側 PDF 中選取文字以進行對譯。')}
                        </div>
                    </div>

                    <div className="gr-head-tools">
                        {/* Highlight color — reading only */}
                        {activeTab === 'reading' && (
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
                        )}

                        {/* Font toggle */}
                        <button
                            className={`gr-btn ${fontMode === 'zen' ? 'gr-btn--solid' : ''}`}
                            onClick={() => setFontMode(fontMode === 'default' ? 'zen' : 'default')}
                            title="切換 Zen Maru Gothic 字體"
                        >
                            Aa
                        </button>

                        {/* Translation mode — reading + analysis only */}
                        {activeTab === 'reading' && viewMode === 'analysis' && (
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
                    {activeTab === 'reading' && (
                        <>
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
                                                <div className="gr-entry-tools">
                                                    <button
                                                        className="gr-entry-tool"
                                                        onClick={(e) => { e.stopPropagation(); handleReadEntry(item.en); }}
                                                        title="朗讀這段"
                                                    >
                                                        <Volume2 size={14} />
                                                    </button>
                                                    <button
                                                        className="gr-entry-tool"
                                                        onClick={(e) => { e.stopPropagation(); handleCaptureEntry(item.en, item.zh); }}
                                                        title="擷取為筆記"
                                                    >
                                                        {justCaptured === item.en ? <Check size={14} /> : <Plus size={14} />}
                                                    </button>
                                                </div>
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
                        </>
                    )}

                    {/* Notes */}
                    {activeTab === 'notes' && (
                        !currentFileId ? (
                            <div className="gr-empty" style={{ minHeight: '60vh' }}>
                                <div className="glyph">錄</div>
                                <div className="en">No document open</div>
                                <div className="zh">開啟文件以開始筆記</div>
                                <div className="hint">open a pdf from the library</div>
                            </div>
                        ) : (
                            <div className="gr-notes">
                                <div className="gr-note-composer">
                                    <textarea
                                        className="gr-note-input"
                                        value={noteDraft}
                                        onChange={(e) => setNoteDraft(e.target.value)}
                                        onKeyDown={(e) => {
                                            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleAddNote();
                                        }}
                                        placeholder="寫下你的想法、引文或提問…"
                                        rows={3}
                                    />
                                    <div className="gr-note-bar">
                                        <span className="hint">⌘ + Enter 送出</span>
                                        <button
                                            className="gr-btn gr-btn--accent"
                                            onClick={handleAddNote}
                                            disabled={!noteDraft.trim()}
                                        >
                                            記下
                                        </button>
                                    </div>
                                </div>

                                {notes.length === 0 ? (
                                    <div className="gr-note-empty">
                                        尚無筆記 · 從上方寫下，或在「精讀」中點 ＋ 擷取對譯
                                    </div>
                                ) : (
                                    <div className="gr-notes-list">
                                        {notes.map((n) => (
                                            <div className="gr-note" key={n.id}>
                                                <div className="gr-note-head">
                                                    <span className="gr-note-time">{fmtTime(n.createdAt)}</span>
                                                    {n.source === 'reading' && <span className="gr-note-tag">對譯</span>}
                                                    <button
                                                        className="gr-note-del"
                                                        onClick={() => handleDeleteNote(n.id)}
                                                        title="刪除"
                                                    >
                                                        <Trash2 size={13} />
                                                    </button>
                                                </div>
                                                {n.source === 'reading' && (
                                                    <div className="gr-note-quote">
                                                        <p className="gr-note-en">{n.en}</p>
                                                        <p className="gr-note-zh">{n.zh}</p>
                                                    </div>
                                                )}
                                                {n.text && <p className="gr-note-text">{n.text}</p>}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )
                    )}
                </div>
            </div>
        </div>
    );
}

export default App;
