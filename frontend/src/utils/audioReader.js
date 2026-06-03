// useAudioReader — drives read-aloud as a queue of sentence clips.
//
// Play model: one audio clip per sentence, played in order. When a sentence
// starts we call onActive(text) so the UI can highlight + scroll to it; when a
// queue runs out we ask getNext() for the following batch (e.g. the next page),
// enabling continuous "read on" playback. Clips are cached in IndexedDB so the
// same sentence is never regenerated (or re-billed).

import { useRef, useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { getAudio, putAudio } from './db';
import { audioKey } from './tts';

export function useAudioReader({ apiBase, voice, speed, engine, onActive }) {
    const audioRef = useRef(null);
    if (!audioRef.current && typeof Audio !== 'undefined') {
        audioRef.current = new Audio();
    }

    const [isPlaying, setIsPlaying] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [activeText, setActiveText] = useState('');
    const [position, setPosition] = useState({ index: 0, total: 0 });

    // Mutable session state kept in a ref so async flows read fresh values.
    const S = useRef({
        queue: [],
        idx: -1,
        fileId: null,
        getNext: null,
        token: 0,        // bumped to cancel any in-flight playback flow
        currentUrl: null,
    });

    // Always-fresh copies of changing inputs for use inside async closures.
    const voiceRef = useRef(voice); voiceRef.current = voice;
    const speedRef = useRef(speed); speedRef.current = speed;
    const engineRef = useRef(engine); engineRef.current = engine;
    const onActiveRef = useRef(onActive); onActiveRef.current = onActive;

    useEffect(() => {
        if (audioRef.current) audioRef.current.playbackRate = speed;
    }, [speed]);

    // Ensure a clip blob exists (cache-first), without creating an object URL.
    const ensureBlob = useCallback(async (text, fileId) => {
        const eng = engineRef.current || 'gemini';
        const key = audioKey(fileId, eng, voiceRef.current, text);
        let blob = await getAudio(key).catch(() => null);
        if (!blob) {
            const res = await axios.post(
                `${apiBase}/api/tts`,
                { text, voice: voiceRef.current, engine: eng },
                { responseType: 'blob' }
            );
            blob = res.data;
            putAudio(key, fileId, blob).catch(() => {});
        }
        return blob;
    }, [apiBase]);

    const warm = useCallback((i) => {
        const st = S.current;
        if (i < 0 || i >= st.queue.length) return;
        ensureBlob(st.queue[i], st.fileId).catch(() => {});
    }, [ensureBlob]);

    const playIndex = useCallback(async (i, token) => {
        const st = S.current;
        if (st.token !== token) return;

        // End of the current queue — try to pull the next batch.
        if (i >= st.queue.length) {
            if (st.getNext) {
                setIsLoading(true);
                let next = null;
                try { next = await st.getNext(); } catch (_) { next = null; }
                if (st.token !== token) return;
                setIsLoading(false);
                if (next && next.segments && next.segments.length) {
                    st.queue = next.segments;
                    st.idx = -1;
                    return playIndex(0, token);
                }
            }
            setIsPlaying(false);
            setActiveText('');
            setPosition({ index: 0, total: 0 });
            onActiveRef.current && onActiveRef.current(null);
            return;
        }
        if (i < 0) i = 0;

        st.idx = i;
        const text = st.queue[i];
        setActiveText(text);
        setPosition({ index: i + 1, total: st.queue.length });
        onActiveRef.current && onActiveRef.current(text);

        setIsLoading(true);
        let blob;
        try {
            blob = await ensureBlob(text, st.fileId);
        } catch (e) {
            console.error('TTS fetch failed:', e);
            if (st.token !== token) return;
            setIsLoading(false);
            return playIndex(i + 1, token); // skip a failed sentence
        }
        if (st.token !== token) return;
        setIsLoading(false);

        const audio = audioRef.current;
        if (st.currentUrl) { URL.revokeObjectURL(st.currentUrl); st.currentUrl = null; }
        const url = URL.createObjectURL(blob);
        st.currentUrl = url;
        audio.src = url;
        audio.playbackRate = speedRef.current;
        try {
            await audio.play();
            setIsPlaying(true);
        } catch (_) { /* play() can reject if interrupted; ignore */ }

        warm(i + 1); // prefetch the next sentence while this one plays
    }, [ensureBlob, warm]);

    // Advance when a clip finishes.
    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;
        const onEnded = () => {
            const st = S.current;
            playIndex(st.idx + 1, st.token);
        };
        audio.addEventListener('ended', onEnded);
        return () => audio.removeEventListener('ended', onEnded);
    }, [playIndex]);

    // ── public controls ──────────────────────────────────────────────
    const start = useCallback(({ segments, fileId, getNext = null }) => {
        const st = S.current;
        st.token += 1;
        st.queue = segments || [];
        st.idx = -1;
        st.fileId = fileId;
        st.getNext = getNext;
        if (!st.queue.length) {
            if (getNext) { playIndex(st.queue.length, st.token); }
            return;
        }
        playIndex(0, st.token);
    }, [playIndex]);

    const pause = useCallback(() => {
        audioRef.current && audioRef.current.pause();
        setIsPlaying(false);
    }, []);

    const resume = useCallback(() => {
        const audio = audioRef.current;
        if (audio && audio.src) {
            audio.play().then(() => setIsPlaying(true)).catch(() => {});
        }
    }, []);

    const toggle = useCallback(() => {
        const audio = audioRef.current;
        if (!audio) return;
        if (audio.paused) resume(); else pause();
    }, [pause, resume]);

    const stop = useCallback(() => {
        const st = S.current;
        st.token += 1;
        const audio = audioRef.current;
        if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
        if (st.currentUrl) { URL.revokeObjectURL(st.currentUrl); st.currentUrl = null; }
        st.queue = []; st.idx = -1; st.getNext = null;
        setIsPlaying(false);
        setActiveText('');
        setPosition({ index: 0, total: 0 });
        onActiveRef.current && onActiveRef.current(null);
    }, []);

    const next = useCallback(() => {
        const st = S.current;
        playIndex(st.idx + 1, st.token);
    }, [playIndex]);

    const prev = useCallback(() => {
        const st = S.current;
        playIndex(Math.max(0, st.idx - 1), st.token);
    }, [playIndex]);

    return { isPlaying, isLoading, activeText, position, start, pause, resume, toggle, stop, next, prev };
}
