import React, { useState, useEffect, useRef, useMemo, useCallback, Suspense, lazy } from 'react';
import { AlertCircle, Menu, X, Upload, ChevronDown, ChevronLeft, ChevronRight, Plus, Check, Trash2, Volume2, Headphones, Share2, BookMarked } from 'lucide-react';
import PdfReader from './components/PdfReader';
import AudioBar from './components/AudioBar';
import { saveFile, getFiles, deleteFile, updateFilePage, addNote, getNotes, deleteNote, getTranslation, putTranslation, addDump, getDumps, isSchemaStale } from './utils/db';
import { BookOpen, Timer, FileText, Languages, StickyNote, LocateFixed } from 'lucide-react';
import { useAudioReader } from './utils/audioReader';
import { splitSentences, hashText } from './utils/tts';
import { useSetting, useSettings, get as getSetting, setPath as setSettingPath, bump } from './utils/settings';
import { usePomodoro } from './utils/usePomodoro';
import { startSession, endSession, togglePause, skipPhase } from './utils/pomodoro';
import FocusTimer from './components/FocusTimer';
import * as flowAudio from './utils/flowAudio';
import { getAsset, putAsset } from './utils/db';

// Loaded on demand — the share card is canvas drawing you only reach by
// exporting, and the two flow overlays only mount when they are needed.
const ShareCard = lazy(() => import('./components/ShareCard'));
const BreakLock = lazy(() => import('./components/BreakLock'));
const BrainDump = lazy(() => import('./components/BrainDump'));
import * as api from './utils/apiClient';
import { useMediaQuery, MOBILE_QUERY } from './utils/useMediaQuery';
const IS_WEB = api.isWebMode();

// Turn an API failure into a message that names the real cause. The web build
// has no backend, so "is the backend running?" was always the wrong advice
// there — apiClient already throws readable messages for the common cases.
function friendlyError(err, fallback) {
    if (!IS_WEB) return '無法連上本機服務,請確認後端正在運行。';
    const status = err && (err.status || (err.response && err.response.status));
    if (status === 400 || status === 403) return 'Gemini 拒絕了這個金鑰,請到側欄「API 金鑰」確認是否正確。';
    if (status === 429) return 'Gemini 用量暫時達到上限,稍等一分鐘再試。';
    const msg = err && err.message;
    // apiClient's own messages are user-facing Chinese; raw "Gemini 500: {…}" isn't.
    if (msg && !/^Gemini \d{3}:/.test(msg)) return msg;
    return fallback;
}

const DEFAULT_VOICES = [
    { id: 'Kore', label: 'Kore · 沉穩女聲' },
    { id: 'Puck', label: 'Puck · 活潑男聲' },
];

function App() {
    const [analysisResult, setAnalysisResult] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);

    // Resizable Layout State. Width is local while dragging — writing through
    // the settings store on every mousemove would thrash localStorage — and is
    // committed once on mouse-up.
    const [leftWidth, setLeftWidth] = useState(() => getSetting('ui.leftWidth', 50));
    const [isDragging, setIsDragging] = useState(false);

    // Phone layout: one pane at a time, switched by a bottom tab bar.
    const isMobile = useMediaQuery(MOBILE_QUERY);
    // Starts on the analysis pane: with no document open that's where the
    // getting-started checklist lives; opening a PDF jumps to the reader.
    const [mobilePane, setMobilePane] = useState('analysis'); // 'reader' | 'analysis'
    const isMobileRef = useRef(isMobile);
    isMobileRef.current = isMobile;
    // Stable on purpose (refs + a state setter only), so memoised handlers can
    // call it without re-creating themselves when the viewport changes.
    // On a phone the drawer covers ~88% of the screen, so any jump to a pane
    // closes it too.
    const goPane = useCallback((pane) => {
        if (!isMobileRef.current) return;
        setMobilePane(pane);
        setIsSidebarOpen(false);
    }, []);

    // Sidebar & Features State
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [summaryResult, setSummaryResult] = useState(null);
    const [viewMode, setViewMode] = useState('analysis'); // 'analysis' | 'summary'
    const [translationMode, setTranslationMode] = useSetting('read.translationMode');
    const [customSummaryLength, setCustomSummaryLength] = useSetting('read.summaryLength');
    const [isSummarizing, setIsSummarizing] = useState(false);

    // My Library State
    const [libraryFiles, setLibraryFiles] = useState([]);
    const [externalFile, setExternalFile] = useState(null);
    const [currentFileId, setCurrentFileId] = useState(null);
    const [initialPage, setInitialPage] = useState(1);
    const [openSection, setOpenSection] = useState('library'); // 'library' | 'export' | 'summary'

    // Reading preferences — persisted, so they survive a reload.
    const [fontMode, setFontMode] = useSetting('ui.fontMode'); // 'default' | 'zen'
    const [highlightedText, setHighlightedText] = useState('');
    const [highlightColor, setHighlightColor] = useSetting('tts.highlightColor'); // 朱 vermilion

    // Notes State (per-document)
    const [activeTab, setActiveTab] = useState('reading'); // 'reading' | 'notes'
    const [notes, setNotes] = useState([]);
    const [noteDraft, setNoteDraft] = useState('');
    const [justCaptured, setJustCaptured] = useState(null);
    const [shareNote, setShareNote] = useState(null); // note being exported as a card

    // Shared phrasebook (片語本) — <vault>/Glossary.md, shared with Typer
    const [glossary, setGlossary] = useState([]);          // [{zh,en,count,last}]
    const [glossaryAvail, setGlossaryAvail] = useState(false);
    const [justGlossaried, setJustGlossaried] = useState(null); // en marker for button feedback

    // Read-aloud (TTS) State
    const [ttsVoices, setTtsVoices] = useState(DEFAULT_VOICES);
    const [ttsVoice, setTtsVoice] = useSetting('tts.voice');
    const [ttsSpeed, setTtsSpeed] = useSetting('tts.speed');
    const [playEngine, setPlayEngine] = useSetting('tts.engine'); // live read-aloud engine
    const [ttsActive, setTtsActive] = useState(false); // a read session is live
    const [currentPage, setCurrentPage] = useState(1);
    const [requestedPage, setRequestedPage] = useState(null); // drives the viewer
    const currentPageRef = useRef(1);
    const ttsPageRef = useRef(1);     // page currently being read (for auto-advance)
    const pdfDocumentRef = useRef(null);

    // Daily Digest State
    const [digestList, setDigestList] = useState([]);
    const [activeDigest, setActiveDigest] = useState(null);
    const [digestLoading, setDigestLoading] = useState(false);

    // Zotero (read-only) State
    const [zoteroAvail, setZoteroAvail] = useState(null); // null = unchecked
    const [zoteroInfo, setZoteroInfo] = useState(null);
    const [zoteroCollections, setZoteroCollections] = useState([]);
    const [zoteroActiveColl, setZoteroActiveColl] = useState(null); // {id,name} | 'all'
    const [zoteroItems, setZoteroItems] = useState([]);
    const [zoteroSearch, setZoteroSearch] = useState('');
    const [zoteroLoading, setZoteroLoading] = useState(false);
    const [currentDocName, setCurrentDocName] = useState(null); // works for library + zotero

    // API key (user-supplied) State
    const [hasKey, setHasKey] = useState(null); // null = unknown
    const [keyMasked, setKeyMasked] = useState(null);
    const [keyDraft, setKeyDraft] = useState('');
    const [keySaving, setKeySaving] = useState(false);
    const [keyError, setKeyError] = useState('');

    // Whole-book audiobook State (engine: 'say' offline | 'gemini' cloud)
    const [sayVoices, setSayVoices] = useState([]);
    const [bookEngine, setBookEngine] = useState('say');
    const [bookVoice, setBookVoice] = useState('Samantha');
    const [bookJob, setBookJob] = useState(null); // {status, done, total, path, bytes, error}
    const bookTimerRef = useRef(null);
    const [pdfNumPages, setPdfNumPages] = useState(0);
    const [bookRangeMode, setBookRangeMode] = useState('all'); // 'all' | 'page' | 'range'
    const [bookFrom, setBookFrom] = useState(1);
    const [bookTo, setBookTo] = useState(1);

    // ── 心流 · Flow state ─────────────────────────────────────────────
    const settings = useSettings();
    const flow = settings.flow;
    const pomo = usePomodoro();
    const [dumpPrompt, setDumpPrompt] = useState(null); // {mode, docName, page, lastCut} | null
    const [guideOn, setGuideOn] = useSetting('flow.guideEnabled', false);
    const [metaphor, setMetaphor] = useState(null);   // {loading, result, error, text}
    const metaphorTokenRef = useRef(0);
    const [staleDb, setStaleDb] = useState(false);
    const lastDumpAtRef = useRef(0);

    // Another window upgraded the IndexedDB schema, so this window's connection
    // is dead and re-opening at the old version would throw. Ask for a reload
    // rather than failing every subsequent save in silence.
    useEffect(() => {
        const id = setInterval(() => { if (isSchemaStale()) setStaleDb(true); }, 2000);
        return () => clearInterval(id);
    }, []);

    // Offer the dump when opening a document, but not every time — being asked
    // to unload your head twice in ten minutes is itself an interruption.
    const DUMP_COOLDOWN_MS = 30 * 60 * 1000;

    const maybeOpenDump = useCallback(async (fileId, name) => {
        if (!getSetting('flow.dumpBeforeStart')) return;
        if (Date.now() - lastDumpAtRef.current < DUMP_COOLDOWN_MS) return;
        let lastCut = null;
        try {
            const dumps = await getDumps(fileId);
            lastCut = dumps.filter(d => d.kind === 'cut').sort((a, b) => b.createdAt - a.createdAt)[0] || null;
        } catch (_) { /* history is a nicety, never block the prompt */ }
        setDumpPrompt({ mode: 'open', docName: name, page: null, lastCut });
    }, []);

    const closeDump = useCallback((saved) => {
        lastDumpAtRef.current = Date.now();
        setDumpPrompt(null);
        // Starting the clock is the point of the ritual — but only if the user
        // actually has the Pomodoro on, and only if one isn't already running.
        if (saved && getSetting('flow.enabled') && !getSetting('session')) {
            startSession(currentFileId, getSetting('flow'));
        }
    }, [currentFileId]);

    const handleSaveDump = useCallback(async ({ text, nextStep, kind }) => {
        try {
            await addDump({ fileId: currentFileId, text, nextStep, kind });
        } catch (err) {
            console.error('Failed to save the dump:', err);
        }
        closeDump(true);
    }, [currentFileId, closeDump]);

    const handleSkipDump = useCallback(() => {
        bump(dumpPrompt?.mode === 'cut' ? 'stats.skips.cut' : 'stats.skips.dump');
        closeDump(false);
    }, [dumpPrompt, closeDump]);

    const handleCleanCut = useCallback(() => {
        setDumpPrompt({
            mode: 'cut',
            docName: currentDocName,
            page: currentPageRef.current,
            lastCut: null,
        });
    }, [currentDocName]);

    const handleSkipBreak = useCallback(() => { skipPhase(getSetting('flow')); }, []);

    // Lower the difficulty of a stuck passage. Same stale-guard idiom as
    // handleTextSelect, with its own token, and the same translations store —
    // its keys are already namespaced by mode, so "metaphor|..." just slots in.
    const handleExplain = useCallback(async (text) => {
        if (!text) return;
        const token = ++metaphorTokenRef.current;
        setActiveTab('reading');
        goPane('analysis');
        setMetaphor({ loading: true, text });

        const cacheKey = `metaphor|${text.length}|${hashText(text)}`;
        try {
            const cached = await getTranslation(cacheKey).catch(() => null);
            if (metaphorTokenRef.current !== token) return;
            if (cached) { setMetaphor({ result: cached, text }); return; }

            let result = await api.metaphor(text);
            if (typeof result === 'string') {
                try { result = JSON.parse(result); } catch (e) { console.error('metaphor parse failed', e); }
            }
            if (metaphorTokenRef.current !== token) return;
            setMetaphor({ result, text });
            if (result && result.metaphor_zh) putTranslation(cacheKey, result).catch(() => {});
        } catch (err) {
            if (metaphorTokenRef.current !== token) return;
            console.error('Metaphor error:', err);
            setMetaphor({ error: err.message || '降維失敗', text });
        }
    }, []);

    const applyAmbience = useCallback(async (kind) => {
        setSettingPath('audio.ambience', kind);
        let blob = null;
        if (kind === 'file') {
            const asset = await getAsset('ambience').catch(() => null);
            if (!asset) { alert('還沒選音檔。先按「選擇音檔」。'); setSettingPath('audio.ambience', 'off'); return; }
            blob = asset.blob;
        }
        const a = getSetting('audio');
        await flowAudio.setAmbience({ kind, volume: a.ambienceVol, pulseHz: a.pulseHz, blob });
    }, []);

    const applyBinaural = useCallback(async (mode) => {
        setSettingPath('audio.binaural', mode);
        const a = getSetting('audio');
        await flowAudio.setBinaural({
            mode, carrierHz: a.carrierHz, beatHz: a.beatHz, volume: a.binauralVol,
        });
    }, []);

    const pickAmbienceFile = useCallback(async (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        await putAsset('ambience', f, { name: f.name });
        setSettingPath('audio.ambienceAsset', f.name);
        await applyAmbience('file');
    }, [applyAmbience]);

    const handleStartFocus = useCallback(() => {
        startSession(currentFileId, getSetting('flow'));
        setIsSidebarOpen(false);
    }, [currentFileId]);

    // API Configuration

    // ── Read-aloud wiring ─────────────────────────────────────────────
    // Called by the audio reader as each sentence starts (or null when it ends):
    // highlight the spoken sentence on the PDF and keep it scrolled into view.
    const handleActiveSentence = useCallback((text) => {
        if (text) {
            setTtsActive(true);
            setHighlightedText(text);
        } else {
            setTtsActive(false);
            setHighlightedText('');
        }
    }, []);

    const reader = useAudioReader({
        voice: ttsVoice,
        speed: ttsSpeed,
        engine: playEngine,
        onActive: handleActiveSentence,
    });
    // `reader` carries playback state, so its identity changes on every clip.
    // Reach it through a ref inside callbacks that are handed to the PDF pane,
    // so those callbacks stay stable and the reader doesn't reconcile mid-read.
    const readerRef = useRef(reader);
    readerRef.current = reader;

    // Duck the ambience under read-aloud rather than routing the speech through
    // the audio graph. `isPlaying` stays true across the gap between clips, so
    // the bed doesn't pump between sentences, and `isLoading` covers the first
    // clip's latency so the duck is already in place before the voice arrives.
    useEffect(() => {
        if (!settings.audio.duckOnTts) { flowAudio.duck(false); return; }
        flowAudio.duck(reader.isPlaying || reader.isLoading, settings.audio.duckRatio);
    }, [reader.isPlaying, reader.isLoading, settings.audio.duckOnTts, settings.audio.duckRatio]);


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

    // ── API key ───────────────────────────────────────────────────────
    const refreshKeyStatus = async () => {
        try {
            const data = await api.keyStatus();
            setHasKey(data.hasKey);
            setKeyMasked(data.masked);
            return data.hasKey;
        } catch (_) {
            setHasKey(false);
            return false;
        }
    };

    // A missing key used to throw the settings drawer open over a scrim on first
    // run — before the visitor knew what the app was. The reading pane's
    // getting-started checklist now carries that step instead.
    useEffect(() => {
        refreshKeyStatus();
        refreshGlossary();
    }, []);

    const openKeySettings = () => { setIsSidebarOpen(true); setOpenSection('apikey'); };

    // Escape closes the drawer — unless a modal or the break lock is on top:
    // modals handle their own Escape, and the break lock deliberately has none.
    useEffect(() => {
        if (!isSidebarOpen) return undefined;
        const onKey = (e) => {
            if (e.key !== 'Escape') return;
            if (document.querySelector('.gr-modal-backdrop, .gr-share-backdrop, .gr-lock')) return;
            setIsSidebarOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isSidebarOpen]);
    const startFileRef = useRef(null); // hidden PDF input behind the "選擇 PDF" buttons

    const saveKey = async () => {
        const k = keyDraft.trim();
        if (!k) return;
        setKeySaving(true);
        setKeyError('');
        try {
            await api.saveKey(k);
            setKeyDraft('');
            await refreshKeyStatus();
        } catch (e) {
            setKeyError((e && e.response && e.response.data && e.response.data.detail) || e.message || '儲存失敗,請確認金鑰。');
        } finally {
            setKeySaving(false);
        }
    };

    // Load the available voices once.
    useEffect(() => {
        api.ttsVoices()
            .then(data => {
                const g = data && data.gemini;
                if (g && g.length) setTtsVoices(g);
                const s = data && data.say;
                if (s && s.length) {
                    setSayVoices(s);
                    if (!s.find(v => v.id === 'Samantha')) setBookVoice(s[0].id);
                }
            })
            .catch(() => {});
    }, []);

    const extractPageText = useCallback(async (n) => {
        const doc = pdfDocumentRef.current;
        if (!doc) return '';
        const page = await doc.getPage(n);
        const tc = await page.getTextContent();
        return tc.items.map(it => it.str).join(' ');
    }, []);

    // Pull the next page's sentences when the current page finishes — gives
    // continuous "read on" playback (and skips blank pages).
    const readNextPage = useCallback(async () => {
        const doc = pdfDocumentRef.current;
        // Blank pages are skipped by looping, not by recursing: a long run of
        // image-only pages used to grow the call stack one frame per page.
        for (;;) {
            const np = ttsPageRef.current + 1;
            if (!doc || np > doc.numPages) return null;
            ttsPageRef.current = np;
            setRequestedPage(np);
            const segs = splitSentences(await extractPageText(np));
            if (segs.length) return { segments: segs };
        }
    }, [extractPageText]);

    const startReadingFrom = useCallback(async (pageNo) => {
        if (!pdfDocumentRef.current) { alert('請先載入 PDF 文件。'); return; }
        goPane('reader'); // the spoken sentence is highlighted on the page
        ttsPageRef.current = pageNo;
        setRequestedPage(pageNo);
        const segs = splitSentences(await extractPageText(pageNo));
        if (segs.length) {
            readerRef.current.start({ segments: segs, fileId: currentFileId, getNext: readNextPage });
        } else {
            const next = await readNextPage();
            if (next) readerRef.current.start({ segments: next.segments, fileId: currentFileId, getNext: readNextPage });
            else alert('這份文件沒有可朗讀的文字。');
        }
    }, [currentFileId, extractPageText, readNextPage]);

    const handleReadPage = useCallback(() => {
        if (ttsActive) { readerRef.current.stop(); return; }
        startReadingFrom(currentPageRef.current || 1);
    }, [ttsActive, startReadingFrom]);

    const handleReadEntry = useCallback((en) => {
        if (!en) return;
        readerRef.current.start({ segments: splitSentences(en), fileId: currentFileId, getNext: null });
    }, [currentFileId]);

    // Read aloud an arbitrary text selection (from the PDF selection popup).
    const handleReadSelection = useCallback((text) => {
        if (!text) return;
        readerRef.current.start({ segments: splitSentences(text), fileId: currentFileId, getNext: null });
    }, [currentFileId]);

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

        // Resolve the page range to generate.
        const total = doc.numPages;
        let from = 1, to = total;
        if (bookRangeMode === 'page') {
            from = to = currentPageRef.current || 1;
        } else if (bookRangeMode === 'range') {
            from = Math.min(Math.max(1, bookFrom || 1), total);
            to = Math.min(Math.max(from, bookTo || total), total);
        }

        setBookJob({ status: 'extracting', done: 0, total: 0 });
        try {
            const pages = [];
            for (let i = from; i <= to; i++) {
                pages.push(await extractPageText(i));
            }
            const base = (currentDocName || 'audiobook').replace(/\.pdf$/i, '');
            const name = bookRangeMode === 'all'
                ? base
                : `${base} p${from}${to > from ? '-' + to : ''}`;
            const data = await api.startBook({ pages, voice: bookVoice, name, engine: bookEngine });
            const jobId = data.jobId;
            setBookJob({ status: 'running', done: 0, total: 0 });

            clearInterval(bookTimerRef.current);
            bookTimerRef.current = setInterval(async () => {
                try {
                    const status = await api.bookStatus(jobId);
                    setBookJob(status);
                    if (status.status === 'done' || status.status === 'error') {
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

    // Stop polling the audiobook job (and any playback) when the app goes away.
    useEffect(() => () => {
        clearInterval(bookTimerRef.current);
        readerRef.current && readerRef.current.stop();
    }, []);

    // Load digest list on mount
    useEffect(() => {
        api.listDigests().then(setDigestList).catch(() => {});
    }, []);

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

    // ── Shared phrasebook (片語本) ───────────────────────────────────────
    const refreshGlossary = async () => {
        try {
            const s = await api.glossaryStatus();
            setGlossaryAvail(!!s.available);
            if (s.available) setGlossary((await api.glossaryList()).entries || []);
            else setGlossary([]);
        } catch {
            setGlossaryAvail(false);
        }
    };

    // Index by normalized 中文 AND 英文 so a phrase saved from either app (or
    // either direction) lights up when you meet it again while reading.
    const glossaryIndex = useMemo(() => {
        const m = new Map();
        for (const e of glossary) {
            if (e.zh) m.set(e.zh.trim(), e);
            if (e.en) m.set(e.en.trim().toLowerCase(), e);
        }
        return m;
    }, [glossary]);

    const glossaryHit = (en, zh) =>
        glossaryIndex.get((en || '').trim().toLowerCase()) ||
        glossaryIndex.get((zh || '').trim()) || null;

    const handleAddToGlossary = async (en, zh) => {
        if (!en || !zh) return;
        try {
            await api.glossaryRecord(zh, en);
            setJustGlossaried(en);
            setTimeout(() => setJustGlossaried(null), 1200);
            refreshGlossary();
        } catch (err) {
            alert(err?.message || '無法寫入片語本。');
        }
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
                goPane('reader');
                setCurrentFileId(newId); // Assuming saveFile returns the ID, checking db.js implementation
                setCurrentDocName(file.name);
                setInitialPage(1);
                maybeOpenDump(newId, file.name);
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
        setCurrentDocName(fileData.name);
        setInitialPage(fileData.lastPage || 1);
        goPane('reader');
        maybeOpenDump(fileData.id, fileData.name);
    };

    // Open a Zotero paper's PDF straight into the reader (read-only).
    const openZoteroPaper = async (item) => {
        setZoteroLoading(true);
        try {
            reader.stop();
            const blob = await api.zoteroFile(item.attKey);
            setExternalFile(blob);
            setCurrentFileId(`zotero:${item.attKey}`);
            setCurrentDocName(item.title);
            setInitialPage(1);
            setIsSidebarOpen(false);
            goPane('reader');
            maybeOpenDump(`zotero:${item.attKey}`, item.title);
        } catch (e) {
            alert('無法開啟此 PDF。');
        } finally {
            setZoteroLoading(false);
        }
    };

    const loadZoteroLibrary = async () => {
        try {
            const data = await api.zoteroStatus();
            setZoteroAvail(data.available);
            setZoteroInfo(data);
            if (data.available) {
                const c = await api.zoteroCollections();
                setZoteroCollections(c.collections || []);
            }
        } catch (_) {
            setZoteroAvail(false);
        }
    };

    const openDigest = async (date) => {
        setDigestLoading(true);
        try {
            const d = await api.getDigest(date);
            setActiveDigest(d);
            setViewMode('digest');
            setActiveTab('reading');
            setIsSidebarOpen(false);
            goPane('analysis');
        } catch (_) {}
        finally { setDigestLoading(false); }
    };

    const openZoteroCollection = async (coll) => {
        setZoteroActiveColl(coll);
        setZoteroItems([]);
        setZoteroSearch('');
        setZoteroLoading(true);
        try {
            const params = coll === 'all' ? {} : { collection: coll.id };
            const data = await api.zoteroItems(params);
            setZoteroItems(data.items || []);
        } catch (_) {
            setZoteroItems([]);
        } finally {
            setZoteroLoading(false);
        }
    };

    const handlePageChange = useCallback(async (page) => {
        setCurrentPage(page);
        currentPageRef.current = page;
        if (typeof currentFileId === 'number') {
            try {
                await updateFilePage(currentFileId, page);
                // We don't reload the whole library here to avoid UI flickering,
                // but we could update the local state if we wanted to show the page number in the list.
            } catch (err) {
                console.error("Failed to update page:", err);
            }
        }
    }, [currentFileId]);

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
            // Persist once, at the end of the gesture — not on every frame.
            setSettingPath('ui.leftWidth', leftWidth);
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
    }, [isDragging, leftWidth]);

    // Selections can arrive faster than Gemini answers. Stamp each request and
    // drop stale replies, so the pane always shows the passage you selected last
    // rather than whichever call happened to return last.
    const translateTokenRef = useRef(0);

    const handleTextSelect = useCallback(async (text) => {
        const token = ++translateTokenRef.current;
        setActiveTab('reading');
        goPane('analysis');
        setViewMode('analysis');
        setIsLoading(true);
        setError(null);
        setAnalysisResult(null);

        const cacheKey = `${translationMode}|${text.length}|${hashText(text)}`;
        try {
            const cached = await getTranslation(cacheKey).catch(() => null);
            if (translateTokenRef.current !== token) return;
            if (cached) {
                setAnalysisResult(cached);
                setIsLoading(false);
                return;
            }

            // Call Backend API
            let result = await api.translate(text, translationMode);
            if (typeof result === 'string') {
                try {
                    result = JSON.parse(result);
                } catch (e) {
                    console.error("Failed to parse JSON string", e);
                }
            }
            if (translateTokenRef.current !== token) return;

            setAnalysisResult(result);
            if (Array.isArray(result) && result.length) {
                putTranslation(cacheKey, result).catch(() => {});
            }
        } catch (err) {
            if (translateTokenRef.current !== token) return;
            console.error("API Error:", err);
            setError(friendlyError(err, '翻譯失敗,請再試一次。'));
        } finally {
            if (translateTokenRef.current === token) setIsLoading(false);
        }
    }, [translationMode]);

    const handleDocumentLoad = useCallback((pdf) => {
        pdfDocumentRef.current = pdf;
        setPdfNumPages(pdf.numPages);
        setBookFrom(1);
        setBookTo(pdf.numPages);
    }, []);

    // Summarising only ever sends the first SUMMARY_CHAR_BUDGET characters, so
    // stop extracting once we have them — a 400-page thesis used to decode every
    // page's text layer before throwing 95% of it away.
    const SUMMARY_CHAR_BUDGET = 30000;

    const extractPdfText = async (maxChars = Infinity) => {
        const doc = pdfDocumentRef.current;
        if (!doc) return '';
        const parts = [];
        let length = 0;
        for (let i = 1; i <= doc.numPages && length < maxChars; i++) {
            const pageText = await extractPageText(i);
            parts.push(pageText);
            length += pageText.length + 1;
        }
        const full = parts.join('\n');
        return Number.isFinite(maxChars) ? full.slice(0, maxChars) : full;
    };

    const handleSummarize = async (length) => {
        if (!pdfDocumentRef.current) {
            alert("請先載入 PDF 文件。");
            return;
        }
        setIsSummarizing(true);
        setActiveTab('reading');
        goPane('analysis');
        setViewMode('summary');
        setSummaryResult(null);
        setError(null);

        try {
            const text = await extractPdfText(SUMMARY_CHAR_BUDGET);
            const summary = await api.summarize(text, length);
            setSummaryResult(summary);
        } catch (err) {
            console.error("Summarize Error:", err);
            setError(friendlyError(err, '文件摘要生成失敗,請再試一次。'));
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
    const isEmpty = !isBusy && !analysisResult && !summaryResult && !error && viewMode !== 'digest';

    return (
        <div className={`gr-app gr-scroll ${fontMode === 'zen' ? 'is-zen' : ''}${isMobile ? ` is-mobile pane-${mobilePane}` : ''}`}>
            {/* Sidebar Toggle */}
            <button
                onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                className="gr-menu-btn"
                title={isSidebarOpen ? '關閉側欄' : '開啟側欄'}
                aria-label={isSidebarOpen ? '關閉側欄' : '開啟側欄'}
                aria-expanded={isSidebarOpen}
                aria-controls="gr-sidebar"
            >
                {isSidebarOpen ? <X size={18} /> : <Menu size={18} />}
            </button>

            {/* Backdrop */}
            <div
                className={`gr-backdrop ${isSidebarOpen ? 'is-open' : ''}`}
                onClick={() => setIsSidebarOpen(false)}
            />

            {/* Sidebar Drawer */}
            <aside id="gr-sidebar" aria-label="側欄" className={`gr-sidebar gr-scroll ${isSidebarOpen ? 'is-open' : ''}`}>
                <div className="gr-side-head">
                    <div className="gr-side-mark">Yun's <span>Reader</span></div>
                    <div className="gr-side-sub">昀氏閱讀 · 雙語精讀 · II</div>
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
                                <input type="file" onChange={handleFileChange} className="gr-sr-only" accept=".pdf" />
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

                {/* Zotero — desktop only (browser can't read the local DB) */}
                {!IS_WEB && (
                <section className="gr-side-sec">
                    <button
                        className="gr-side-toggle"
                        onClick={() => { toggleSection('zotero'); if (zoteroAvail === null) loadZoteroLibrary(); }}
                    >
                        <span className="grp">
                            <span className="num">Z</span>
                            <span className="zh">Zotero</span>
                        </span>
                        <ChevronDown size={13} className={`chev ${openSection === 'zotero' ? 'open' : ''}`} />
                    </button>
                    <div className="gr-side-en">
                        {zoteroInfo && zoteroInfo.available ? `${zoteroInfo.collections} 個分類 · ${zoteroInfo.pdfs} 篇` : 'Reference library'}
                    </div>

                    {openSection === 'zotero' && (
                        <div className="gr-side-body">
                            {zoteroAvail === false && (
                                <div className="gr-zot-empty">找不到執行中的 Zotero,請先開啟 Zotero。</div>
                            )}
                            {zoteroAvail && (
                                <>
                                    {!zoteroActiveColl ? (
                                        <div className="gr-zot-colls">
                                            <button className="gr-zot-coll" onClick={() => openZoteroCollection('all')}>
                                                <span className="zh">全部論文</span>
                                                <span className="ct">{zoteroInfo ? zoteroInfo.pdfs : ''}</span>
                                            </button>
                                            {zoteroCollections.map(c => (
                                                <button key={c.id} className="gr-zot-coll" onClick={() => openZoteroCollection(c)}>
                                                    <span className="zh">{c.name}</span>
                                                    <ChevronRight size={13} />
                                                </button>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="gr-zot-items-wrap">
                                            <button className="gr-zot-back" onClick={() => { setZoteroActiveColl(null); setZoteroItems([]); }}>
                                                <ChevronLeft size={13} /> {zoteroActiveColl === 'all' ? '全部論文' : zoteroActiveColl.name}
                                            </button>
                                            <input
                                                className="gr-input gr-zot-search"
                                                placeholder="搜尋標題 / 作者…"
                                                value={zoteroSearch}
                                                onChange={(e) => setZoteroSearch(e.target.value)}
                                            />
                                            {zoteroLoading ? (
                                                <div className="gr-zot-empty">載入中…</div>
                                            ) : (
                                                <div className="gr-zot-items gr-scroll">
                                                    {zoteroItems
                                                        .filter(it => {
                                                            const s = zoteroSearch.trim().toLowerCase();
                                                            return !s || it.title.toLowerCase().includes(s) || (it.author || '').toLowerCase().includes(s);
                                                        })
                                                        .map(it => (
                                                            <button
                                                                key={it.attKey}
                                                                className={`gr-zot-item ${currentFileId === `zotero:${it.attKey}` ? 'is-active' : ''}`}
                                                                onClick={() => openZoteroPaper(it)}
                                                                title={it.title}
                                                            >
                                                                <span className="t">{it.title}</span>
                                                                <span className="m">{[it.author, it.year].filter(Boolean).join(' · ')}</span>
                                                            </button>
                                                        ))}
                                                    {!zoteroItems.length && <div className="gr-zot-empty">此分類沒有 PDF。</div>}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    )}
                </section>
                )}

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

                                <label className="gr-audio-field">
                                    <span className="gr-audio-field-label">範圍 · Pages</span>
                                    <div className="gr-seg gr-seg--full">
                                        <button className={bookRangeMode === 'all' ? 'is-active' : ''} onClick={() => setBookRangeMode('all')} disabled={bookBusy}>整本</button>
                                        <button className={bookRangeMode === 'page' ? 'is-active' : ''} onClick={() => setBookRangeMode('page')} disabled={bookBusy}>本頁</button>
                                        <button className={bookRangeMode === 'range' ? 'is-active' : ''} onClick={() => setBookRangeMode('range')} disabled={bookBusy}>範圍</button>
                                    </div>
                                </label>
                                {bookRangeMode === 'range' && (
                                    <div className="gr-book-range">
                                        <input type="number" min="1" max={pdfNumPages || 1} className="gr-input" value={bookFrom}
                                            onChange={(e) => setBookFrom(parseInt(e.target.value) || 1)} disabled={bookBusy} />
                                        <span className="gr-book-range-sep">→</span>
                                        <input type="number" min="1" max={pdfNumPages || 1} className="gr-input" value={bookTo}
                                            onChange={(e) => setBookTo(parseInt(e.target.value) || 1)} disabled={bookBusy} />
                                        <span className="gr-book-range-total">/ {pdfNumPages || '—'}</span>
                                    </div>
                                )}

                                <p className="gr-audio-hint">
                                    {bookEngine === 'gemini'
                                        ? '高音質 · 需網路 · 依字數計費。整本易撞速率限制,Gemini 建議用小範圍。'
                                        : '免費 · 離線 · 生成快速。'}
                                </p>

                                <button className="gr-side-btn" onClick={handleGenerateBook} disabled={bookBusy}>
                                    <span className="zh">
                                        {bookBusy ? '生成中…'
                                            : bookRangeMode === 'all' ? '生成整本有聲書'
                                            : bookRangeMode === 'page' ? `生成本頁(p${currentPage})`
                                            : `生成 p${bookFrom}–${bookTo}`}
                                    </span>
                                    <span className="en">
                                        {bookRangeMode === 'all' ? 'Whole book' : bookRangeMode === 'page' ? 'This page' : `Pages ${bookFrom}-${bookTo}`}
                                        {' '}· .m4a · {bookEngine === 'gemini' ? 'Gemini' : 'offline'}
                                    </span>
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
                                                {bookJob.note && <div className="gr-book-line gr-book-wait">{bookJob.note}</div>}
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
                                                <div className="gr-book-line gr-book-done">已生成 · {fmtBytes(bookJob.bytes)}</div>
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

                {/* 5. API Key */}
                <section className="gr-side-sec">
                    <button className="gr-side-toggle" onClick={() => toggleSection('apikey')}>
                        <span className="grp">
                            <span className="num">05</span>
                            <span className="zh">API 金鑰</span>
                        </span>
                        <ChevronDown size={13} className={`chev ${openSection === 'apikey' ? 'open' : ''}`} />
                    </button>
                    <div className="gr-side-en">Gemini API Key{hasKey === false ? ' · 待設定' : ''}</div>

                    {openSection === 'apikey' && (
                        <div className="gr-side-body">
                            <div className={`gr-key-status ${hasKey ? 'is-ok' : 'is-none'}`}>
                                {hasKey ? `已設定 · ${keyMasked || ''}` : '尚未設定 — 翻譯/朗讀/摘要需要金鑰'}
                            </div>
                            <input
                                type="password"
                                className="gr-input gr-key-input"
                                placeholder="貼上你的 Gemini API 金鑰"
                                value={keyDraft}
                                onChange={(e) => setKeyDraft(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') saveKey(); }}
                            />
                            {keyError && <div className="gr-key-err">{keyError}</div>}
                            <button
                                className="gr-side-btn gr-key-save"
                                onClick={saveKey}
                                disabled={keySaving || !keyDraft.trim()}
                            >
                                <span className="zh">{keySaving ? '驗證中…' : (hasKey ? '更新金鑰' : '儲存金鑰')}</span>
                                <span className="en">Validate &amp; save</span>
                            </button>
                            <a className="gr-key-link" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">
                                取得免費金鑰 · Google AI Studio →
                            </a>
                        </div>
                    )}
                </section>

                {/* 07 心流 */}
                <section className="gr-side-sec">
                    <button className="gr-side-toggle" onClick={() => toggleSection('flow')}>
                        <span className="grp">
                            <span className="num">07</span>
                            <span className="zh">心流專注</span>
                        </span>
                        <ChevronDown size={13} className={`chev ${openSection === 'flow' ? 'open' : ''}`} />
                    </button>
                    <div className="gr-side-en">
                        Flow · {flow.enabled ? `${flow.focusMin}／${flow.breakMin} 分` : '未啟用'}
                    </div>

                    {openSection === 'flow' && (
                        <div className="gr-side-body">
                            <label className="gr-audio-field">
                                <span className="gr-audio-field-label">番茄鐘 · Pomodoro</span>
                                <div className="gr-seg gr-seg--full">
                                    <button
                                        className={flow.enabled ? 'is-active' : ''}
                                        onClick={() => setSettingPath('flow.enabled', true)}
                                    >
                                        開啟
                                    </button>
                                    <button
                                        className={!flow.enabled ? 'is-active' : ''}
                                        onClick={() => { setSettingPath('flow.enabled', false); endSession('disabled'); }}
                                    >
                                        關閉
                                    </button>
                                </div>
                            </label>

                            <label className="gr-audio-field">
                                <span className="gr-audio-field-label">專注 · Focus</span>
                                <div className="gr-num-field">
                                    <input
                                        type="number" min="5" max="90" className="gr-input"
                                        value={flow.focusMin}
                                        onChange={(e) => setSettingPath('flow.focusMin', parseInt(e.target.value, 10) || 25)}
                                    />
                                    <span>分鐘,休息</span>
                                    <input
                                        type="number" min="1" max="30" className="gr-input"
                                        value={flow.breakMin}
                                        onChange={(e) => setSettingPath('flow.breakMin', parseInt(e.target.value, 10) || 5)}
                                    />
                                    <span>分鐘</span>
                                </div>
                            </label>
                            <p className="gr-audio-hint">
                                25／5 是常見起點,不是定律。用幾週後照你自己的疲勞曲線調。
                            </p>

                            <label className="gr-audio-field">
                                <span className="gr-audio-field-label">開始前先卸載思緒</span>
                                <div className="gr-seg gr-seg--full">
                                    <button
                                        className={flow.dumpBeforeStart ? 'is-active' : ''}
                                        onClick={() => setSettingPath('flow.dumpBeforeStart', true)}
                                    >
                                        要
                                    </button>
                                    <button
                                        className={!flow.dumpBeforeStart ? 'is-active' : ''}
                                        onClick={() => setSettingPath('flow.dumpBeforeStart', false)}
                                    >
                                        不用
                                    </button>
                                </div>
                            </label>

                            {!pomo.running ? (
                                <button className="gr-side-btn" onClick={handleStartFocus} disabled={!flow.enabled}>
                                    <span className="zh">
                                        <Timer size={12} style={{ verticalAlign: '-1px', marginRight: 6 }} />
                                        開始一個專注區塊
                                    </span>
                                    <span className="en">Start focus · {flow.focusMin} min</span>
                                </button>
                            ) : (
                                <button className="gr-side-btn" onClick={() => endSession('stopped')}>
                                    <span className="zh">結束這次專注</span>
                                    <span className="en">Stop the timer</span>
                                </button>
                            )}
                            {/* A disabled button with no reason reads as broken. */}
                            {!pomo.running && !flow.enabled && (
                                <p className="gr-audio-hint" style={{ marginTop: -2, marginBottom: 10 }}>先把上方「番茄鐘」切到「開啟」,才能開始專注區塊。</p>
                            )}

                            <button className="gr-side-btn" onClick={handleCleanCut} disabled={!currentFileId}>
                                <span className="zh">乾淨切斷 · 存下次起點</span>
                                <span className="en">Clean cut · save where to resume</span>
                            </button>

                            <div className="gr-flow-stats">
                                <div className="gr-flow-stat">
                                    <span>完成的專注</span><b>{settings.stats.focusCompleted}</b>
                                </div>
                                <div className="gr-flow-stat">
                                    <span>略過休息</span><b>{settings.stats.skips.break}</b>
                                </div>
                                <div className="gr-flow-stat">
                                    <span>略過卸載</span><b>{settings.stats.skips.dump + settings.stats.skips.cut}</b>
                                </div>
                            </div>
                            <p className="gr-audio-hint">
                                通知無法從 App 內關閉 —— 那是作業系統的權限。專注前請自己開 macOS 專注模式。
                            </p>

                            <div className="gr-book">
                                <div className="gr-book-head">閱讀導引 · Pace guide</div>

                                <label className="gr-audio-field">
                                    <span className="gr-audio-field-label">導引光標</span>
                                    <div className="gr-seg gr-seg--full">
                                        <button className={guideOn ? 'is-active' : ''} onClick={() => setGuideOn(true)}>開啟</button>
                                        <button className={!guideOn ? 'is-active' : ''} onClick={() => setGuideOn(false)}>關閉</button>
                                    </div>
                                </label>

                                <label className="gr-audio-field">
                                    <span className="gr-audio-field-label">樣式</span>
                                    <div className="gr-seg gr-seg--full">
                                        <button className={flow.guideMode === 'line' ? 'is-active' : ''}
                                            onClick={() => setSettingPath('flow.guideMode', 'line')}>整行</button>
                                        <button className={flow.guideMode === 'word' ? 'is-active' : ''}
                                            onClick={() => setSettingPath('flow.guideMode', 'word')}>逐字</button>
                                    </div>
                                </label>

                                <label className="gr-audio-field">
                                    <span className="gr-audio-field-label">基線速度 · WPM</span>
                                    <div className="gr-num-field">
                                        <input type="number" min="60" max="900" className="gr-input"
                                            value={flow.wpm}
                                            onChange={(e) => setSettingPath('flow.wpm', parseInt(e.target.value, 10) || 250)} />
                                        <span>字/分</span>
                                    </div>
                                </label>

                                <label className="gr-audio-field">
                                    <span className="gr-audio-field-label">
                                        挑戰倍率 · {Math.round(flow.challenge * 100)}%
                                        {'\u2003'}≈ {Math.round(flow.wpm * flow.challenge)} wpm
                                    </span>
                                    <input type="range" className="gr-range" min="100" max="120" step="1"
                                        value={Math.round(flow.challenge * 100)}
                                        onChange={(e) => setSettingPath('flow.challenge', parseInt(e.target.value, 10) / 100)} />
                                </label>
                                <p className="gr-audio-hint">
                                    「比你的速度快 4%」出自心流的通俗論述,不是實驗常數。這條滑桿就是讓你自己找那個數字。
                                </p>
                                <p className="gr-audio-hint">朗讀進行時光標會自動停,兩者會互相打架。</p>
                            </div>
                        </div>
                    )}
                </section>

                {/* 08 音場 */}
                <section className="gr-side-sec">
                    <button className="gr-side-toggle" onClick={() => toggleSection('sound')}>
                        <span className="grp">
                            <span className="num">08</span>
                            <span className="zh">音場</span>
                        </span>
                        <ChevronDown size={13} className={`chev ${openSection === 'sound' ? 'open' : ''}`} />
                    </button>
                    <div className="gr-side-en">
                        Soundfield · {settings.audio.ambience === 'off' && settings.audio.binaural === 'off' ? '靜音' : '播放中'}
                    </div>

                    {openSection === 'sound' && (
                        <div className="gr-side-body">
                            <label className="gr-audio-field">
                                <span className="gr-audio-field-label">環境音 · Ambience</span>
                                <div className="gr-seg gr-seg--full">
                                    <button className={settings.audio.ambience === 'off' ? 'is-active' : ''} onClick={() => applyAmbience('off')}>關</button>
                                    <button className={settings.audio.ambience === 'pink' ? 'is-active' : ''} onClick={() => applyAmbience('pink')}>粉紅</button>
                                    <button className={settings.audio.ambience === 'brown' ? 'is-active' : ''} onClick={() => applyAmbience('brown')}>棕色</button>
                                    <button className={settings.audio.ambience === 'file' ? 'is-active' : ''} onClick={() => applyAmbience('file')}>音檔</button>
                                </div>
                            </label>

                            <label className="gr-upload gr-upload--slim">
                                <Upload size={14} />
                                <span className="zh">{settings.audio.ambienceAsset || '選擇音檔'}</span>
                                <span className="en">your own track · loops</span>
                                <input type="file" accept="audio/*" onChange={pickAmbienceFile} className="gr-sr-only" />
                            </label>

                            <label className="gr-audio-field">
                                <span className="gr-audio-field-label">環境音量 · {Math.round(settings.audio.ambienceVol * 100)}%</span>
                                <input type="range" className="gr-range" min="0" max="100"
                                    value={Math.round(settings.audio.ambienceVol * 100)}
                                    onChange={(e) => {
                                        const v = parseInt(e.target.value, 10) / 100;
                                        setSettingPath('audio.ambienceVol', v);
                                        flowAudio.setAmbienceVolume(v);
                                    }} />
                            </label>

                            <label className="gr-audio-field">
                                <span className="gr-audio-field-label">
                                    脈動 · {settings.audio.pulseHz > 0 ? `${settings.audio.pulseHz} Hz` : '無'}
                                </span>
                                <input type="range" className="gr-range" min="0" max="20"
                                    value={settings.audio.pulseHz}
                                    onChange={(e) => setSettingPath('audio.pulseHz', parseInt(e.target.value, 10))}
                                    onMouseUp={() => applyAmbience(settings.audio.ambience)} />
                            </label>

                            <div className="gr-book">
                                <div className="gr-book-head">雙耳節拍 · Binaural</div>
                                <div className="gr-seg gr-seg--full">
                                    <button className={settings.audio.binaural === 'off' ? 'is-active' : ''} onClick={() => applyBinaural('off')}>關</button>
                                    <button className={settings.audio.binaural === 'theta' ? 'is-active' : ''} onClick={() => applyBinaural('theta')}>Theta 6Hz</button>
                                    <button className={settings.audio.binaural === 'alpha' ? 'is-active' : ''} onClick={() => applyBinaural('alpha')}>Alpha 10Hz</button>
                                </div>

                                <label className="gr-audio-field" style={{ marginTop: 14 }}>
                                    <span className="gr-audio-field-label">音量 · {Math.round(settings.audio.binauralVol * 100)}%</span>
                                    <input type="range" className="gr-range" min="0" max="25"
                                        value={Math.round(settings.audio.binauralVol * 100)}
                                        onChange={(e) => {
                                            const v = parseInt(e.target.value, 10) / 100;
                                            setSettingPath('audio.binauralVol', v);
                                            flowAudio.setBinauralVolume(v);
                                        }} />
                                </label>

                                <p className="gr-audio-hint">
                                    左右耳播放相差 6Hz(或 10Hz)的純音。<b>必須戴耳機</b>,喇叭聽不到拍頻。
                                    這是它實際做的事;至於能不能提升專注,研究結果偏弱且不一致。
                                </p>
                            </div>

                            <label className="gr-audio-field">
                                <span className="gr-audio-field-label">朗讀時自動壓低</span>
                                <div className="gr-seg gr-seg--full">
                                    <button className={settings.audio.duckOnTts ? 'is-active' : ''}
                                        onClick={() => setSettingPath('audio.duckOnTts', true)}>要</button>
                                    <button className={!settings.audio.duckOnTts ? 'is-active' : ''}
                                        onClick={() => setSettingPath('audio.duckOnTts', false)}>不用</button>
                                </div>
                            </label>

                            <button className="gr-side-btn" onClick={() => { flowAudio.stopAll(); setSettingPath('audio.ambience', 'off'); setSettingPath('audio.binaural', 'off'); }}>
                                <span className="zh">全部靜音</span>
                                <span className="en">Stop all sound</span>
                            </button>
                        </div>
                    )}
                </section>

                {/* 06 每日摘要 */}
                <section className="gr-side-sec">
                    <button className="gr-side-toggle" onClick={() => toggleSection('digest')}>
                        <span className="grp">
                            <span className="num">06</span>
                            <span className="zh">每日摘要</span>
                        </span>
                        <ChevronDown size={13} className={`chev ${openSection === 'digest' ? 'open' : ''}`} />
                    </button>
                    <div className="gr-side-en">Daily Digest · 研究機會</div>

                    {openSection === 'digest' && (
                        <div className="gr-side-body">
                            {digestList.length === 0 ? (
                                <div className="gr-file-empty">尚無摘要 · no digest yet</div>
                            ) : (
                                digestList.map(item => (
                                    <button
                                        key={item.date}
                                        className={`gr-side-btn${activeDigest && activeDigest.date === item.date ? ' is-active' : ''}`}
                                        onClick={() => openDigest(item.date)}
                                        disabled={digestLoading}
                                    >
                                        <span className="zh">{item.date}</span>
                                        <span className="en"><BookOpen size={11} style={{ verticalAlign: '-1px', marginRight: 4 }} />Research Digest</span>
                                    </button>
                                ))
                            )}
                        </div>
                    )}
                </section>
            </aside>

            {/* Left Panel — PDF Reader */}
            <div className="gr-reader gr-pane-reader" style={isMobile ? undefined : { width: `${leftWidth}%`, minWidth: '20%' }}>
                <PdfReader
                    onTextSelect={handleTextSelect}
                    onReadSelection={handleReadSelection}
                    onExplain={handleExplain}
                    onDocumentLoad={handleDocumentLoad}
                    highlightedText={highlightedText}
                    highlightColor={highlightColor}
                    externalFile={externalFile}
                    docName={currentDocName}
                    initialPage={initialPage}
                    onPageChange={handlePageChange}
                    requestedPage={requestedPage}
                    onReadPage={handleReadPage}
                    autoScroll={ttsActive}
                    isReading={ttsActive}
                    guide={{
                        enabled: guideOn,
                        wpm: flow.wpm,
                        challenge: flow.challenge,
                        mode: flow.guideMode,
                    }}
                    toolbarExtra={pomo.running ? (
                        <FocusTimer
                            remaining={pomo.remaining}
                            progress={pomo.progress}
                            phase={pomo.session.phase}
                            cycle={pomo.session.cycle}
                            paused={pomo.paused}
                            onToggle={togglePause}
                            onStop={() => endSession('stopped')}
                        />
                    ) : null}
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

            {/* Resizer — split view only */}
            {!isMobile && (
                <div
                    className={`gr-resizer ${isDragging ? 'is-dragging' : ''}`}
                    onMouseDown={() => setIsDragging(true)}
                />
            )}

            {/* Right Panel — Analysis / Summary */}
            <div className="gr-analysis gr-pane-analysis" style={isMobile ? undefined : { width: `${100 - leftWidth}%` }}>
                {/* Header */}
                <div className="gr-analysis-head">
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

                    <div className="gr-head-tools">
                        {/* Highlight color — reading only */}
                        {activeTab === 'reading' && (
                            <div className="gr-tool-group" role="group" aria-label="標示顏色">
                                <span className="gr-tool-label">標示</span>
                                <button
                                    className={`gr-swatch ${highlightColor.includes('227') ? 'is-active' : ''}`}
                                    style={{ background: 'rgba(227, 6, 19, 0.5)' }}
                                    onClick={() => setHighlightColor('rgba(227, 6, 19, 0.20)')}
                                    aria-pressed={highlightColor.includes('227')}
                                    aria-label="紅色標示"
                                    title="紅 · Red"
                                />
                                <button
                                    className={`gr-swatch ${highlightColor.includes('204') ? 'is-active' : ''}`}
                                    style={{ background: 'rgba(255, 204, 0, 0.7)' }}
                                    onClick={() => setHighlightColor('rgba(255, 204, 0, 0.40)')}
                                    aria-pressed={highlightColor.includes('204')}
                                    aria-label="黃色標示"
                                    title="黃 · Yellow"
                                />
                            </div>
                        )}

                        {/* Reading size toggle */}
                        <button
                            className={`gr-btn gr-btn--case ${fontMode === 'zen' ? 'gr-btn--solid' : ''}`}
                            onClick={() => setFontMode(fontMode === 'default' ? 'zen' : 'default')}
                            aria-pressed={fontMode === 'zen'}
                            aria-label="放大閱讀字級"
                            title={fontMode === 'zen' ? '還原字級 · Reset reading size' : '放大閱讀字級 · Larger reading text'}
                        >
                            Aa
                        </button>

                        {/* Translation mode — reading + analysis only */}
                        {activeTab === 'reading' && viewMode === 'analysis' && (
                            <div className="gr-seg">
                                <button
                                    className={translationMode === 'sentence' ? 'is-active' : ''}
                                    onClick={() => setTranslationMode('sentence')}
                                    aria-pressed={translationMode === 'sentence'}
                                >
                                    逐句
                                </button>
                                <button
                                    className={translationMode === 'paragraph' ? 'is-active' : ''}
                                    onClick={() => setTranslationMode('paragraph')}
                                    aria-pressed={translationMode === 'paragraph'}
                                >
                                    逐段
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                {/* Body */}
                <div className="gr-analysis-body gr-scroll">
                    <div className="gr-body-head">
                        <div className="gr-head-title">
                            {activeTab === 'notes'
                                ? '我的筆記'
                                : viewMode === 'summary' ? '全文摘要'
                                : viewMode === 'digest' ? '每日摘要'
                                : '對譯精讀'}
                        </div>
                        <div className="gr-head-sub">
                            {activeTab === 'notes'
                                ? (currentDocName ? `《${currentDocName}》 · ${notes.length} 則筆記` : '開啟文件以開始筆記')
                                : viewMode === 'summary' ? '由 AI 生成的全文摘要。'
                                : viewMode === 'digest' ? (activeDigest ? `${activeDigest.date} · PhD Research Digest` : '請從側欄選擇摘要')
                                : isMobile ? '在「原文」頁長按選取文字,即可對譯。' : '於左側 PDF 中選取文字以進行對譯。'}
                        </div>
                    </div>

                    {/* The getting-started checklist already carries this step. */}
                    {hasKey === false && !(activeTab === 'reading' && isEmpty) && (
                        <div className="gr-key-banner">
                            <div>
                                <div className="gr-key-banner-zh">尚未設定 Gemini API 金鑰</div>
                                <div className="gr-key-banner-en">翻譯、朗讀與摘要需要你自己的金鑰(免費)。</div>
                            </div>
                            <button className="gr-btn gr-btn--accent" onClick={openKeySettings}>
                                前往設定
                            </button>
                        </div>
                    )}
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

                            {/* Concept metaphor */}
                            {metaphor && (
                                <div className="gr-meta">
                                    <div className="gr-meta-head">
                                        <span className="gr-meta-kicker">降維 · Metaphor</span>
                                        <button className="gr-meta-x" onClick={() => setMetaphor(null)} title="關閉">
                                            <X size={14} />
                                        </button>
                                    </div>
                                    <p className="gr-meta-src">{metaphor.text}</p>
                                    {metaphor.loading && <div className="gr-meta-wait">正在找一個日常的說法⋯⋯</div>}
                                    {metaphor.error && <div className="gr-meta-err">{metaphor.error}</div>}
                                    {metaphor.result && (
                                        <>
                                            <p className="gr-meta-main">{metaphor.result.metaphor_zh}</p>
                                            {metaphor.result.plain_zh && (
                                                <p className="gr-meta-plain">{metaphor.result.plain_zh}</p>
                                            )}
                                            {Array.isArray(metaphor.result.mapping) && metaphor.result.mapping.length > 0 && (
                                                <div className="gr-meta-map">
                                                    {metaphor.result.mapping.map((m, i) => (
                                                        <div key={i} className="gr-meta-row">
                                                            <span className="f">{m.from}</span>
                                                            <span className="a">→</span>
                                                            <span className="t">{m.to}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                            {metaphor.result.caution_zh && (
                                                <div className="gr-meta-caution">
                                                    <span className="lbl">這個比喻在哪裡會失效</span>
                                                    {metaphor.result.caution_zh}
                                                </div>
                                            )}
                                        </>
                                    )}
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
                                                    {/* Phone only: the PDF isn't on screen, so jump to it. */}
                                                    {isMobile && (
                                                        <button
                                                            className="gr-entry-tool"
                                                            onClick={(e) => { e.stopPropagation(); setHighlightedText(item.en); setMobilePane('reader'); }}
                                                            title="在原文中定位"
                                                            aria-label="在原文中定位"
                                                        >
                                                            <LocateFixed size={14} />
                                                        </button>
                                                    )}
                                                    <button
                                                        className="gr-entry-tool"
                                                        onClick={(e) => { e.stopPropagation(); handleReadEntry(item.en); }}
                                                        title="朗讀這段"
                                                        aria-label="朗讀這段"
                                                    >
                                                        <Volume2 size={14} />
                                                    </button>
                                                    {glossaryAvail && (
                                                        <button
                                                            className="gr-entry-tool"
                                                            onClick={(e) => { e.stopPropagation(); handleAddToGlossary(item.en, item.zh); }}
                                                            title="收進片語本(與 Typer 共用)"
                                                        >
                                                            {justGlossaried === item.en ? <Check size={14} /> : <BookMarked size={14} />}
                                                        </button>
                                                    )}
                                                    <button
                                                        className="gr-entry-tool"
                                                        onClick={(e) => { e.stopPropagation(); handleCaptureEntry(item.en, item.zh); }}
                                                        title="擷取為筆記"
                                                    >
                                                        {justCaptured === item.en ? <Check size={14} /> : <Plus size={14} />}
                                                    </button>
                                                </div>
                                                <p className="gr-entry-en">{item.en}</p>
                                                {(() => {
                                                    const hit = glossaryHit(item.en, item.zh);
                                                    return hit ? (
                                                        <div className="gr-entry-glossary" title={`你用過這個譯法 · 最近 ${hit.last || '—'}`}>
                                                            <BookMarked size={12} />
                                                            <span>片語本 ×{hit.count}</span>
                                                            {hit.en && hit.en.trim().toLowerCase() !== (item.en || '').trim().toLowerCase() && (
                                                                <span className="gr-entry-glossary-alt">先前:{hit.en}</span>
                                                            )}
                                                        </div>
                                                    ) : null;
                                                })()}
                                                <div className="gr-entry-rule" />
                                                <p className="gr-entry-zh">{item.zh}</p>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <pre className="gr-raw">{JSON.stringify(analysisResult, null, 2)}</pre>
                                )
                            )}

                            {/* Digest loading */}
                            {digestLoading && (
                                <div className="gr-loading">
                                    <div className="en">Loading digest</div>
                                    <div className="gr-bar" />
                                    <div className="zh">載入每日摘要中</div>
                                </div>
                            )}

                            {/* Digest view */}
                            {!digestLoading && viewMode === 'digest' && activeDigest && (
                                <div className="gr-digest">
                                    {activeDigest.sections.map(sec => (
                                        <div key={sec.id} className="gr-digest-section">
                                            <div className="gr-digest-sec-title">{sec.title}</div>
                                            {sec.type === 'opportunities' && sec.items.map((item, i) => (
                                                <div key={i} className={`gr-digest-opp gr-digest-opp--${item.status}`}>
                                                    <div className="gr-digest-opp-head">
                                                        <span className="gr-digest-opp-name">{item.title}</span>
                                                        <span className={`gr-digest-badge gr-digest-badge--${item.status}`}>
                                                            {item.status === 'open' ? '開放' : item.status === 'rolling' ? '滾動' : item.status === 'upcoming' ? '即將' : '截止'}
                                                        </span>
                                                    </div>
                                                    <div className="gr-digest-opp-meta">
                                                        <span>{item.funder}</span>
                                                        {item.deadline_label && <><span className="gr-digest-sep">·</span>截止：<strong>{item.deadline_label}</strong></>}
                                                    </div>
                                                    {item.eligibility && <div className="gr-digest-opp-elig">{item.eligibility}</div>}
                                                    {item.url && <a className="gr-digest-link" href={item.url} target="_blank" rel="noreferrer">申請 / 詳情 →</a>}
                                                </div>
                                            ))}
                                            {sec.type === 'articles' && sec.items.map((art, i) => (
                                                <div key={i} className="gr-digest-article">
                                                    <div className="gr-digest-art-head">
                                                        <div className="gr-digest-art-title">{art.title}</div>
                                                        <div className="gr-digest-art-meta">{art.author && `${art.author} · `}{art.source} · {art.published}</div>
                                                        {art.url && <a className="gr-digest-link" href={art.url} target="_blank" rel="noreferrer">原文 →</a>}
                                                    </div>
                                                    {art.paragraphs && art.paragraphs.map((p, j) => (
                                                        <div key={j} className="gr-entry">
                                                            <span className="gr-entry-n">{String(j + 1).padStart(2, '0')}</span>
                                                            <p className="gr-entry-en">{p.en}</p>
                                                            <div className="gr-entry-rule" />
                                                            <p className="gr-entry-zh">{p.zh}</p>
                                                        </div>
                                                    ))}
                                                </div>
                                            ))}
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Empty → getting-started checklist that tracks real progress */}
                            {isEmpty && (() => {
                                const steps = [
                                    {
                                        id: 'key',
                                        zh: '設定 Gemini API 金鑰',
                                        en: 'Add your Gemini key',
                                        note: IS_WEB
                                            ? '免費取得。金鑰只存在這個瀏覽器,直接送往 Google,不經其他伺服器。'
                                            : '免費取得。金鑰只存在這台電腦。',
                                        done: hasKey === true,
                                        action: <button className="gr-btn gr-btn--accent" onClick={openKeySettings}>設定金鑰 →</button>,
                                    },
                                    {
                                        id: 'doc',
                                        zh: '開啟一份 PDF',
                                        en: 'Open a document',
                                        note: '或從側欄「我的書庫」開啟上次讀的文件,會接續在同一頁。',
                                        // pdfNumPages is set by every load path (library, Zotero,
                                        // and the reader pane's own file picker); externalFile isn't.
                                        done: pdfNumPages > 0,
                                        action: <button className="gr-btn" onClick={() => startFileRef.current && startFileRef.current.click()}>選擇 PDF →</button>,
                                    },
                                    {
                                        id: 'select',
                                        zh: isMobile ? '在「原文」頁選取一段文字' : '在左側選取一段文字',
                                        en: 'Select a passage',
                                        note: isMobile
                                            ? '長按文字並拖曳選取範圍,點「翻譯」後會跳到這一頁;每一句都能朗讀、存成筆記,或回原文定位。'
                                            : '選取後點「翻譯」,逐句對照會出現在這裡;每一句都能朗讀、存成筆記。',
                                        done: false,
                                        action: null,
                                    },
                                ];
                                const current = steps.findIndex(s => !s.done);
                                return (
                                    <section className="gr-start" aria-labelledby="gr-start-title">
                                        <div className="gr-start-kicker" id="gr-start-title">Getting started · 開始使用</div>
                                        <ol className="gr-start-list">
                                            {steps.map((s, i) => (
                                                <li
                                                    key={s.id}
                                                    className={`gr-start-step${s.done ? ' is-done' : ''}${i === current ? ' is-current' : ''}`}
                                                    aria-current={i === current ? 'step' : undefined}
                                                >
                                                    <span className="gr-start-n">{String(i + 1).padStart(2, '0')}</span>
                                                    <div className="gr-start-body">
                                                        <div className="gr-start-zh">{s.zh}</div>
                                                        <div className="gr-start-en">{s.en}</div>
                                                        {!s.done && <p className="gr-start-note">{s.note}</p>}
                                                    </div>
                                                    <div className="gr-start-act">
                                                        {s.done ? <span className="gr-start-done">完成 · Done</span> : s.action}
                                                    </div>
                                                </li>
                                            ))}
                                        </ol>
                                        <input ref={startFileRef} type="file" accept=".pdf" hidden onChange={handleFileChange} />
                                    </section>
                                );
                            })()}
                        </>
                    )}

                    {/* Notes */}
                    {activeTab === 'notes' && (
                        !currentFileId ? (
                            <div className="gr-empty gr-empty--inline">
                                <div className="en">No document open</div>
                                <div className="zh">筆記跟著文件走 —— 先開啟一份 PDF。</div>
                                <button className="gr-btn" onClick={() => startFileRef.current && startFileRef.current.click()}>選擇 PDF →</button>
                                <input ref={startFileRef} type="file" accept=".pdf" hidden onChange={handleFileChange} />
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
                                                    <span className="gr-note-acts">
                                                        <button
                                                            className="gr-note-act"
                                                            onClick={() => setShareNote(n)}
                                                            title="做成分享字卡"
                                                        >
                                                            <Share2 size={13} />
                                                        </button>
                                                        <button
                                                            className="gr-note-act"
                                                            onClick={() => handleDeleteNote(n.id)}
                                                            title="刪除"
                                                        >
                                                            <Trash2 size={13} />
                                                        </button>
                                                    </span>
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

            {/* Phone: bottom tab bar — one pane at a time */}
            {isMobile && (
                <nav className="gr-mobnav" aria-label="切換畫面">
                    {[
                        { id: 'reader', zh: '原文', en: 'PDF', Icon: FileText,
                          active: mobilePane === 'reader',
                          go: () => setMobilePane('reader') },
                        { id: 'reading', zh: '精讀', en: 'Reading', Icon: Languages,
                          active: mobilePane === 'analysis' && activeTab === 'reading',
                          busy: isBusy,
                          go: () => { setMobilePane('analysis'); setActiveTab('reading'); } },
                        { id: 'notes', zh: '筆記', en: 'Notes', Icon: StickyNote,
                          active: mobilePane === 'analysis' && activeTab === 'notes',
                          count: notes.length,
                          go: () => { setMobilePane('analysis'); setActiveTab('notes'); } },
                    ].map(({ id, zh, en, Icon, active, busy, count, go }) => (
                        <button
                            key={id}
                            className={`gr-mobnav-btn${active ? ' is-active' : ''}`}
                            onClick={go}
                            aria-current={active ? 'page' : undefined}
                        >
                            <Icon size={20} aria-hidden="true" />
                            <span className="zh">{zh}</span>
                            <span className="en">{en}</span>
                            {count > 0 && <span className="gr-mobnav-count">{count}</span>}
                            {busy && !active && <span className="gr-mobnav-busy" aria-label="處理中" />}
                        </button>
                    ))}
                </nav>
            )}

            {shareNote && (
                <Suspense fallback={null}>
                    <ShareCard note={shareNote} docName={currentDocName} onClose={() => setShareNote(null)} />
                </Suspense>
            )}

            {dumpPrompt && (
                <Suspense fallback={null}>
                    <BrainDump
                        mode={dumpPrompt.mode}
                        docName={dumpPrompt.docName}
                        page={dumpPrompt.page}
                        lastCut={dumpPrompt.lastCut}
                        seconds={dumpPrompt.mode === 'cut' ? 30 : 60}
                        holdMs={flow.holdMs}
                        skipCount={dumpPrompt.mode === 'cut' ? settings.stats.skips.cut : settings.stats.skips.dump}
                        onSave={handleSaveDump}
                        onSkip={handleSkipDump}
                    />
                </Suspense>
            )}

            {pomo.onBreak && (
                <Suspense fallback={null}>
                    <BreakLock
                        remaining={pomo.remaining}
                        progress={pomo.progress}
                        isLong={pomo.session.phase === 'longBreak'}
                        cycle={pomo.session.cycle}
                        skipCount={settings.stats.skips.break}
                        holdMs={flow.holdMs}
                        onSkip={handleSkipBreak}
                    />
                </Suspense>
            )}

            {staleDb && (
                <div className="gr-stale">
                    資料庫已由另一個視窗更新 —— 請重新載入這個視窗(⌘R)。
                </div>
            )}
        </div>
    );
}

export default App;
