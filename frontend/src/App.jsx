import React, { useState, useEffect, useRef, useMemo, useCallback, Suspense, lazy } from 'react';
import { AlertCircle, Menu, X, Upload, ChevronDown, ChevronLeft, ChevronRight, Plus, Check, Trash2, Volume2, Headphones, Share2, BookMarked } from 'lucide-react';
import PdfReader from './components/PdfReader';
import AudioBar from './components/AudioBar';
import { saveFile, getFiles, deleteFile, updateFilePage, addNote, getNotes, deleteNote, getTranslation, putTranslation, addDump, getDumps, isSchemaStale } from './utils/db';
import { BookOpen, Timer, FileDown, Network, Link2 } from 'lucide-react';
import { useAudioReader } from './utils/audioReader';
import { splitSentences, hashText } from './utils/tts';
import { useSetting, useSettings, get as getSetting, setPath as setSettingPath, bump } from './utils/settings';
import { usePomodoro } from './utils/usePomodoro';
import { startSession, endSession, togglePause, skipPhase } from './utils/pomodoro';
import FocusTimer from './components/FocusTimer';
import * as flowAudio from './utils/flowAudio';
import { getAsset, putAsset, patchNote } from './utils/db';
import { renderNote, noteFilename, newGrId, sourceTitle, linkTarget } from './utils/noteMarkdown';

// Loaded on demand — the share card is canvas drawing you only reach by
// exporting, and the two flow overlays only mount when they are needed.
const ShareCard = lazy(() => import('./components/ShareCard'));
const BreakLock = lazy(() => import('./components/BreakLock'));
const BrainDump = lazy(() => import('./components/BrainDump'));
import * as api from './utils/apiClient';
const IS_WEB = api.isWebMode();

// Starting points for the pretend-play lens; any free-text persona works too.
const PERSONA_PRESETS = ['你的指導教授', '十年後的自己', '完全外行的人', '這段文字當年的讀者'];

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

    // On first run with no key, open the key settings to prompt the user.
    useEffect(() => {
        refreshKeyStatus().then(has => {
            if (has === false) { setIsSidebarOpen(true); setOpenSection('apikey'); }
        });
        refreshGlossary();
    }, []);

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
        const saved = await addNote({ fileId: currentFileId, text, source: 'manual', page: currentPageRef.current });
        setNoteDraft('');
        await refreshNotes();
        if (getSetting('vault.sync') && !IS_WEB) writeNoteToVault(saved);
    };

    const handleCaptureEntry = async (en, zh) => {
        if (!currentFileId) {
            alert("請先從書庫開啟一份文件，才能擷取為筆記。");
            return;
        }
        const saved = await addNote({ fileId: currentFileId, en, zh, source: 'reading', page: currentPageRef.current });
        setJustCaptured(en);
        setTimeout(() => setJustCaptured(null), 1200);
        await refreshNotes();
        if (getSetting('vault.sync') && !IS_WEB) writeNoteToVault(saved);
    };

    const handleDeleteNote = async (id) => {
        await deleteNote(id);
        refreshNotes();
    };

    // ── 聯想筆記 · Obsidian ───────────────────────────────────────────
    const [vaultInfo, setVaultInfo] = useState(null);   // {available, vault, root, noteCount}
    const [assoc, setAssoc] = useState(null);           // {noteId, loading, items, fallback, reason, error}
    const [vaultBusy, setVaultBusy] = useState(null);   // id of the note being written

    // Only ask for the note count once reading is switched on — counting means
    // indexing, and indexing reads every note in the vault.
    const refreshVault = useCallback(async () => {
        if (IS_WEB) { setVaultInfo({ available: false }); return; }
        try {
            setVaultInfo(await api.vaultStatus(getSetting('vault.folder'), getSetting('vault.associativeEnabled')));
        } catch (_) {
            setVaultInfo({ available: false });
        }
    }, []);
    useEffect(() => { refreshVault(); }, [refreshVault]);

    const enableAssociative = useCallback(() => {
        const where = vaultInfo && vaultInfo.vault ? vaultInfo.vault : '(未偵測到)';
        const yes = window.confirm(
            '聯想功能會讀取你整個 Obsidian vault 的筆記(標題、標籤、前 400 字),'
            + '在本機找出可能的連結。\n\n'
            + `vault:${where}\n\n`
            + '送到 Gemini 的,只有候選筆記的標題、標籤跟前 200 字。完整內文從不送出。\n\n'
            + '要開啟嗎?',
        );
        if (!yes) return;
        setSettingPath('vault.associativeEnabled', true, { flush: true });
        refreshVault();
    }, [vaultInfo, refreshVault]);

    // One renderer (noteMarkdown.js) for both builds: desktop sends it to the
    // backend, which checks ownership and writes it; the browser build
    // downloads the same text.
    const writeNoteToVault = useCallback(async (note) => {
        const grId = note.grId || newGrId();
        const markdown = renderNote({
            grId, en: note.en, zh: note.zh, text: note.text, page: note.page,
            docName: currentDocName, createdAt: note.createdAt, links: note.links || [],
        });
        setVaultBusy(note.id);
        try {
            const r = await api.vaultWriteNote({
                markdown,
                filename: noteFilename(note),
                gr_id: grId,
                source: currentDocName ? sourceTitle(currentDocName) : '',
                page: note.page || null,
                folder: getSetting('vault.folder'),
                path: note.vaultPath || null,
            });
            await patchNote(note.id, r.downloaded ? { grId } : { grId, vaultPath: r.path });
            await refreshNotes();
            return r;
        } catch (err) {
            alert('寫入 Obsidian 失敗:' + ((err && err.response && err.response.data && err.response.data.detail) || err.message));
            return null;
        } finally {
            setVaultBusy(null);
        }
    }, [currentDocName]);

    const findAssociations = useCallback(async (note) => {
        const text = [note.text, note.zh, note.en].filter(Boolean).join('\n');
        setAssoc({ noteId: note.id, loading: true });
        try {
            const r = await api.vaultAssociate({
                text,
                tags: [],
                excludeSource: currentDocName ? sourceTitle(currentDocName) : '',
            });
            setAssoc({ noteId: note.id, items: r.associations || [], fallback: r.fallback, reason: r.reason });
        } catch (err) {
            setAssoc({ noteId: note.id, error: (err && err.response && err.response.data && err.response.data.detail) || err.message });
        }
    }, [currentDocName]);

    const acceptAssociation = useCallback(async (note, item) => {
        const target = linkTarget(item.path);
        const links = [...(note.links || [])];
        if (links.some((l) => l.target === target)) return;
        links.push({ target, reason: item.reason_zh || item.bridge_zh || '' });
        const next = await patchNote(note.id, { links });
        await refreshNotes();
        // Already in the vault? Rewrite it there too, so the link is real.
        if (next.vaultPath) await writeNoteToVault(next);
        setAssoc((a) => (a && a.noteId === note.id
            ? { ...a, items: a.items.map((i) => (i.path === item.path ? { ...i, added: true } : i)) }
            : a));
    }, [writeNoteToVault]);

    // ── 角色濾鏡 · Pretend-play ───────────────────────────────────────
    const [persona, setPersona] = useSetting('read.persona');
    const [pretendState, setPretendState] = useState(null); // {loading, result, error, text, persona}
    const pretendTokenRef = useRef(0);

    const handlePretend = useCallback(async (text, who) => {
        const p = String(who || getSetting('read.persona') || '').trim();
        if (!text || !p) return;
        const token = ++pretendTokenRef.current;
        setActiveTab('reading');
        setPretendState({ loading: true, text, persona: p });

        const cacheKey = `pretend:${p}|${text.length}|${hashText(text)}`;
        try {
            const cached = await getTranslation(cacheKey).catch(() => null);
            if (pretendTokenRef.current !== token) return;
            if (cached) { setPretendState({ result: cached, text, persona: p }); return; }

            let result = await api.pretend(text, p);
            if (typeof result === 'string') {
                try { result = JSON.parse(result); } catch (e) { console.error('pretend parse failed', e); }
            }
            if (pretendTokenRef.current !== token) return;
            setPretendState({ result, text, persona: p });
            if (result && result.reading_zh) putTranslation(cacheKey, result).catch(() => {});
        } catch (err) {
            if (pretendTokenRef.current !== token) return;
            setPretendState({
                error: (err && err.response && err.response.data && err.response.data.detail) || err.message || '角色濾鏡失敗',
                text, persona: p,
            });
        }
    }, []);

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
            setError("無法分析文本，請確認後端服務正在運行。");
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
        setViewMode('summary');
        setSummaryResult(null);
        setError(null);

        try {
            const text = await extractPdfText(SUMMARY_CHAR_BUDGET);
            const summary = await api.summarize(text, length);
            setSummaryResult(summary);
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
    const isEmpty = !isBusy && !analysisResult && !summaryResult && !error && viewMode !== 'digest';

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
                                <input type="file" accept="audio/*" onChange={pickAmbienceFile} style={{ display: 'none' }} />
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

                {/* 09 聯想筆記 — desktop only: the vault is on disk */}
                {!IS_WEB && (
                <section className="gr-side-sec">
                    <button className="gr-side-toggle" onClick={() => { toggleSection('vault'); refreshVault(); }}>
                        <span className="grp">
                            <span className="num">09</span>
                            <span className="zh">聯想筆記</span>
                        </span>
                        <ChevronDown size={13} className={`chev ${openSection === 'vault' ? 'open' : ''}`} />
                    </button>
                    <div className="gr-side-en">
                        Obsidian · {vaultInfo && vaultInfo.available ? '已連線' : '找不到 vault'}
                    </div>

                    {openSection === 'vault' && (
                        <div className="gr-side-body">
                            {vaultInfo && vaultInfo.available ? (
                                <div className="gr-key-status is-ok gr-vault-path" title={vaultInfo.vault}>
                                    {vaultInfo.vault}
                                    {typeof vaultInfo.noteCount === 'number' && ` · ${vaultInfo.noteCount} 則`}
                                </div>
                            ) : (
                                <div className="gr-key-status is-none">
                                    找不到 Obsidian vault。請先在 Obsidian 開一個 vault。
                                </div>
                            )}

                            <label className="gr-audio-field">
                                <span className="gr-audio-field-label">寫入 · 新筆記同步到 Obsidian</span>
                                <div className="gr-seg gr-seg--full">
                                    <button className={settings.vault.sync ? 'is-active' : ''}
                                        disabled={!(vaultInfo && vaultInfo.available)}
                                        onClick={() => setSettingPath('vault.sync', true)}>開啟</button>
                                    <button className={!settings.vault.sync ? 'is-active' : ''}
                                        onClick={() => setSettingPath('vault.sync', false)}>關閉</button>
                                </div>
                            </label>
                            <p className="gr-audio-hint">
                                寫到 <b>{settings.vault.folder}/</b>。每個念頭一則筆記,每份文獻一則索引。
                                只會修改 App 自己建立的檔案 —— 你手寫的筆記就算同名也不會被動。
                            </p>

                            <label className="gr-audio-field">
                                <span className="gr-audio-field-label">讀取 · 遠距聯想</span>
                                <div className="gr-seg gr-seg--full">
                                    <button className={settings.vault.associativeEnabled ? 'is-active' : ''}
                                        disabled={!(vaultInfo && vaultInfo.available)}
                                        onClick={() => { if (!settings.vault.associativeEnabled) enableAssociative(); }}>開啟</button>
                                    <button className={!settings.vault.associativeEnabled ? 'is-active' : ''}
                                        onClick={() => { setSettingPath('vault.associativeEnabled', false); refreshVault(); }}>關閉</button>
                                </div>
                            </label>
                            <p className="gr-audio-hint">
                                開啟後會在本機讀你的 vault 找連結。送到 Gemini 的只有候選筆記的<b>標題、標籤、前 200 字</b>,完整內文從不送出。
                                刻意跳過最明顯的相似筆記 —— 那些你自己就想得到。
                            </p>
                        </div>
                    )}
                </section>
                )}

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
            <div className="gr-reader" style={{ width: `${leftWidth}%`, minWidth: '20%' }}>
                <PdfReader
                    onTextSelect={handleTextSelect}
                    onReadSelection={handleReadSelection}
                    onExplain={handleExplain}
                    onPretend={handlePretend}
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

            {/* Resizer */}
            <div
                className={`gr-resizer ${isDragging ? 'is-dragging' : ''}`}
                onMouseDown={() => setIsDragging(true)}
            />

            {/* Right Panel — Analysis / Summary */}
            <div className="gr-analysis" style={{ width: `${100 - leftWidth}%` }}>
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
                            <div className="gr-tool-group">
                                <span className="gr-tool-label">標</span>
                                <button
                                    className={`gr-swatch ${/0, 26|95, 60/.test(highlightColor) ? 'is-active' : ''}`}
                                    style={{ background: 'rgba(226, 0, 26, 0.40)' }}
                                    onClick={() => setHighlightColor('rgba(226, 0, 26, 0.16)')}
                                    title="紅 · Red"
                                />
                                <button
                                    className={`gr-swatch ${/118, 118|124, 115/.test(highlightColor) ? 'is-active' : ''}`}
                                    style={{ background: 'rgba(118, 118, 118, 0.45)' }}
                                    onClick={() => setHighlightColor('rgba(118, 118, 118, 0.24)')}
                                    title="灰 · Grey"
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
                                : '於左側 PDF 中選取文字以進行對譯。'}
                        </div>
                    </div>

                    {hasKey === false && (
                        <div className="gr-key-banner">
                            <div>
                                <div className="gr-key-banner-zh">尚未設定 Gemini API 金鑰</div>
                                <div className="gr-key-banner-en">翻譯、朗讀與摘要需要你自己的金鑰(免費)。</div>
                            </div>
                            <button className="gr-btn gr-btn--accent" onClick={() => { setIsSidebarOpen(true); setOpenSection('apikey'); }}>
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

                            {/* Pretend-play lens */}
                            {pretendState && (
                                <div className="gr-meta gr-pretend">
                                    <div className="gr-meta-head">
                                        <span className="gr-meta-kicker">角色濾鏡 · Pretend play</span>
                                        <button className="gr-meta-x" onClick={() => setPretendState(null)} title="關閉">
                                            <X size={14} />
                                        </button>
                                    </div>
                                    <div className="gr-pretend-who">
                                        <span className="lbl">以</span>
                                        <select
                                            className="gr-input gr-pretend-pick"
                                            value={PERSONA_PRESETS.includes(pretendState.persona) ? pretendState.persona : '__custom'}
                                            onChange={(e) => {
                                                if (e.target.value === '__custom') return;
                                                setPersona(e.target.value);
                                                handlePretend(pretendState.text, e.target.value);
                                            }}
                                        >
                                            {PERSONA_PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
                                            <option value="__custom">自訂⋯⋯</option>
                                        </select>
                                        <input
                                            className="gr-input gr-pretend-custom"
                                            placeholder="或寫一個人:1848 年的巴黎工人"
                                            defaultValue={PERSONA_PRESETS.includes(pretendState.persona) ? '' : pretendState.persona}
                                            onKeyDown={(e) => {
                                                const v = e.currentTarget.value.trim();
                                                if (e.key === 'Enter' && v) { setPersona(v); handlePretend(pretendState.text, v); }
                                            }}
                                        />
                                        <span className="lbl">的眼睛讀</span>
                                    </div>
                                    <p className="gr-meta-src">{pretendState.text}</p>
                                    {pretendState.loading && <div className="gr-meta-wait">正在換一雙眼睛⋯⋯</div>}
                                    {pretendState.error && <div className="gr-meta-err">{pretendState.error}</div>}
                                    {pretendState.result && (
                                        <>
                                            <p className="gr-meta-main">{pretendState.result.reading_zh}</p>
                                            {pretendState.result.notices_zh && (
                                                <div className="gr-meta-caution">
                                                    <span className="lbl">他會注意到、而你會略過的</span>
                                                    {pretendState.result.notices_zh}
                                                </div>
                                            )}
                                            {pretendState.result.question_zh && (
                                                <div className="gr-meta-caution">
                                                    <span className="lbl">他會問的問題</span>
                                                    {pretendState.result.question_zh}
                                                </div>
                                            )}
                                        </>
                                    )}
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
                                                    <button
                                                        className="gr-entry-tool"
                                                        onClick={(e) => { e.stopPropagation(); handleReadEntry(item.en); }}
                                                        title="朗讀這段"
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
                                                            {item.status === 'open' ? '✅ 開放' : item.status === 'rolling' ? '♻ 滾動' : item.status === 'upcoming' ? '⏳ 即將' : '⚠ 截止'}
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
                                                    {n.vaultPath && <span className="gr-note-tag gr-note-tag--vault">Obsidian</span>}
                                                    <span className="gr-note-acts">
                                                        <button
                                                            className="gr-note-act"
                                                            onClick={() => writeNoteToVault(n)}
                                                            disabled={vaultBusy === n.id}
                                                            title={IS_WEB ? '下載成 Obsidian .md' : (n.vaultPath ? '重新寫進 Obsidian' : '寫進 Obsidian')}
                                                        >
                                                            <FileDown size={13} />
                                                        </button>
                                                        {!IS_WEB && vaultInfo && vaultInfo.available && settings.vault.associativeEnabled && (
                                                            <button
                                                                className="gr-note-act"
                                                                onClick={() => findAssociations(n)}
                                                                title="找遠距聯想"
                                                            >
                                                                <Network size={13} />
                                                            </button>
                                                        )}
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
                                                {Array.isArray(n.links) && n.links.length > 0 && (
                                                    <div className="gr-note-links">
                                                        {n.links.map((l) => (
                                                            <span key={l.target} className="gr-note-link" title={l.reason || ''}>
                                                                <Link2 size={11} /> {l.target}
                                                            </span>
                                                        ))}
                                                    </div>
                                                )}
                                                {assoc && assoc.noteId === n.id && (
                                                    <div className="gr-assoc">
                                                        <div className="gr-assoc-head">
                                                            <span>遠距聯想 · Distant links</span>
                                                            <button className="gr-meta-x" onClick={() => setAssoc(null)} title="關閉"><X size={13} /></button>
                                                        </div>
                                                        {assoc.loading && <div className="gr-meta-wait">在你的 vault 裡找意外的連結⋯⋯</div>}
                                                        {assoc.error && <div className="gr-meta-err">{assoc.error}</div>}
                                                        {assoc.items && assoc.items.length === 0 && (
                                                            <div className="gr-meta-wait">這則筆記在 vault 裡找不到夠遠又成立的連結。</div>
                                                        )}
                                                        {assoc.fallback && assoc.items && assoc.items.length > 0 && (
                                                            <div className="gr-assoc-note">
                                                                {assoc.reason === 'no-key'
                                                                    ? '沒有 Gemini 金鑰:以下是本機比對出的候選,沒有附理由。'
                                                                    : '這次只拿到本機比對的候選,沒有附理由。'}
                                                            </div>
                                                        )}
                                                        {(assoc.items || []).map((it) => (
                                                            <div key={it.path} className="gr-assoc-item">
                                                                <div className="gr-assoc-title">
                                                                    {it.title}
                                                                    {it.dormant && <span className="gr-assoc-dormant">久未翻閱</span>}
                                                                </div>
                                                                {it.reason_zh && <p className="gr-assoc-why">{it.reason_zh}</p>}
                                                                {it.bridge_zh && <p className="gr-assoc-bridge">橋:{it.bridge_zh}</p>}
                                                                <button
                                                                    className="gr-btn"
                                                                    disabled={it.added}
                                                                    onClick={() => acceptAssociation(n, it)}
                                                                >
                                                                    {it.added ? '已連結' : `連結 [[${linkTarget(it.path)}]]`}
                                                                </button>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )
                    )}
                </div>
            </div>

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
