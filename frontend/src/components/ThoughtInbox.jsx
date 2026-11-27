import React, { useEffect, useRef, useState } from 'react';
import { Inbox, Check, X } from 'lucide-react';

// The thought inbox: a place to drop whatever pops into your head mid-reading
// ("reply to the professor", "buy milk") without leaving the page.
//
// Press Q (or the button), type one line, Enter. It goes into the same list as
// the things written in the brain dump before reading, so everything you set
// down can be found again, and cleared once dealt with.

const isTyping = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

const ThoughtInbox = ({ items, onAdd, onDone }) => {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState('');
    const [pos, setPos] = useState({ top: 0, right: 16 });
    const btnRef = useRef(null);
    const panelRef = useRef(null);
    const inputRef = useRef(null);

    const place = () => {
        const b = btnRef.current && btnRef.current.getBoundingClientRect();
        if (b) setPos({ top: b.bottom + 8, right: Math.max(8, window.innerWidth - b.right) });
    };
    const show = () => { place(); setOpen(true); };

    // Q opens it from anywhere, except while typing or behind an overlay.
    useEffect(() => {
        const onKey = (e) => {
            if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
            if ((e.key === 'q' || e.key === 'Q') && !document.querySelector('.gr-lock, .gr-modal-backdrop, .gr-share-backdrop')) {
                e.preventDefault();
                show();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    useEffect(() => {
        if (!open) return undefined;
        const t = setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
        const onDown = (e) => {
            if (panelRef.current && !panelRef.current.contains(e.target) && !btnRef.current.contains(e.target)) setOpen(false);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { setOpen(false); btnRef.current && btnRef.current.focus(); }
        };
        window.addEventListener('pointerdown', onDown, true);
        window.addEventListener('keydown', onKey);
        window.addEventListener('resize', place);
        return () => {
            clearTimeout(t);
            window.removeEventListener('pointerdown', onDown, true);
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('resize', place);
        };
    }, [open]);

    const submit = async () => {
        const text = draft.trim();
        if (!text) return;
        setDraft('');
        await onAdd(text);
    };

    const count = items.length;

    return (
        <>
            <button
                ref={btnRef}
                className={`gr-btn gr-btn--icon gr-inbox-btn ${open ? 'is-open' : ''}`}
                onClick={() => (open ? setOpen(false) : show())}
                title="記下雜念 (Q)"
                aria-label={count ? `雜念,${count} 則待處理` : '記下雜念'}
                aria-expanded={open}
                aria-keyshortcuts="Q"
            >
                <Inbox size={15} />
                {count > 0 && <span className="gr-inbox-count">{count > 99 ? '99+' : count}</span>}
            </button>

            {open && (
                <div
                    ref={panelRef}
                    className="gr-inbox"
                    role="dialog"
                    aria-label="雜念"
                    style={{ top: pos.top, right: pos.right }}
                >
                    <div className="gr-inbox-head">
                        <span>雜念 · {count} 則</span>
                        <button className="gr-inbox-x" onClick={() => setOpen(false)} aria-label="關閉"><X size={14} /></button>
                    </div>
                    <input
                        ref={inputRef}
                        className="gr-inbox-input"
                        value={draft}
                        placeholder="腦中冒出什麼?寫一行,按 Enter"
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
                        aria-label="新的雜念"
                    />
                    <p className="gr-inbox-hint">寫下來就可以先放下。休息時會再給你看。</p>
                    {count > 0 ? (
                        <ul className="gr-inbox-list">
                            {items.map((it) => (
                                <li key={it.id}>
                                    <div className="gr-inbox-text">
                                        {it.text}
                                        {it.nextStep && <span className="gr-inbox-next">下一步:{it.nextStep}</span>}
                                    </div>
                                    <button className="gr-inbox-done" onClick={() => onDone(it.id)} title="處理掉了" aria-label={`處理掉了:${it.text}`}>
                                        <Check size={14} />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="gr-inbox-empty">目前沒有待處理的雜念。</p>
                    )}
                </div>
            )}
        </>
    );
};

export default ThoughtInbox;
