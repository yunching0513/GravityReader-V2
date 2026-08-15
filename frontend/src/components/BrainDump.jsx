import React, { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import HoldToSkip from './HoldToSkip';

// 思緒卸載盒 · Residue clearing.
//
// Writing down what you're still carrying gets it out of working memory before
// you start reading. The countdown is soft on purpose: at zero it just promotes
// the primary button, it never closes the modal or submits for you. A hard
// deadline on a reflective prompt produces reflexive typing, which defeats it.

const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

const BrainDump = ({
    mode = 'open',        // 'open' before a session | 'cut' when finishing
    docName,
    page,
    lastCut,              // the previous session's "start here next time"
    seconds = 60,
    holdMs = 2000,
    skipCount = 0,
    onSave,
    onSkip,
}) => {
    const [text, setText] = useState('');
    const [nextStep, setNextStep] = useState('');
    const [left, setLeft] = useState(seconds);
    const firstRef = useRef(null);

    useEffect(() => {
        firstRef.current?.focus();
    }, []);

    useEffect(() => {
        if (left <= 0) return undefined;
        const id = setTimeout(() => setLeft((n) => n - 1), 1000);
        return () => clearTimeout(id);
    }, [left]);

    const isCut = mode === 'cut';
    const ready = text.trim() || nextStep.trim();

    const save = () => onSave && onSave({ text: text.trim(), nextStep: nextStep.trim(), kind: mode });

    const submitOnMeta = (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && ready) save();
    };

    return (
        <Modal
            title={isCut ? '乾淨切斷 · Clean cut' : '思緒卸載 · Clear the residue'}
            width={560}
            className="gr-dump"
            onClose={undefined}
        >
            <div className="gr-dump-lead">
                {isCut ? (
                    <>
                        <p className="zh">先給大腦一個明確的「結束」訊號,它才會停止在背景運算這份文件。</p>
                        {docName && <p className="gr-dump-meta">《{docName}》{page ? ` · 讀到 p${page}` : ''}</p>}
                    </>
                ) : (
                    <>
                        <p className="zh">開始讀之前,把還掛在腦子裡的事寫下來。寫下來就可以先放下。</p>
                        {docName && <p className="gr-dump-meta">即將閱讀《{docName}》</p>}
                    </>
                )}
            </div>

            {!isCut && lastCut && (lastCut.nextStep || lastCut.text) && (
                <div className="gr-dump-last">
                    <div className="gr-dump-last-label">上次結束時你寫的</div>
                    {lastCut.nextStep && <p className="gr-dump-last-next">{lastCut.nextStep}</p>}
                    {lastCut.text && <p className="gr-dump-last-text">{lastCut.text}</p>}
                </div>
            )}

            <label className="gr-dump-field">
                <span className="gr-dump-label">
                    {isCut ? '這次讀到什麼?還有什麼沒解決?' : '現在腦中還掛心什麼?'}
                </span>
                <textarea
                    ref={firstRef}
                    className="gr-dump-input"
                    rows={4}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={submitOnMeta}
                    placeholder={isCut ? '例如:第三節的論證我還沒吃透⋯⋯' : '例如:下午要回覆的信、明天的會議⋯⋯'}
                />
            </label>

            <label className="gr-dump-field">
                <span className="gr-dump-label">
                    {isCut ? '下次從哪裡開始?' : '那些事的下一步各是什麼?'}
                </span>
                <textarea
                    className="gr-dump-input"
                    rows={3}
                    value={nextStep}
                    onChange={(e) => setNextStep(e.target.value)}
                    onKeyDown={submitOnMeta}
                    placeholder={isCut ? `例如:從 p${page || 1} 的第二段重讀` : '例如:回信只要三句話,晚上七點寫'}
                />
            </label>

            <div className="gr-dump-foot">
                <div className="gr-dump-timer">
                    {left > 0 ? <>還有 <b>{fmt(left)}</b> · 不急,寫完為止</> : <>時間到了 —— 但不急,寫完再走</>}
                </div>
                <button
                    className={`gr-btn ${left <= 0 || ready ? 'gr-btn--accent' : ''}`}
                    onClick={save}
                    disabled={!ready}
                >
                    {isCut ? '存檔並結束' : '放下了,開始讀'}
                </button>
            </div>

            <div className="gr-dump-skip">
                <HoldToSkip
                    ms={holdMs}
                    onConfirm={onSkip}
                    label="這次跳過"
                    sub={`按住 ${Math.round(holdMs / 1000)} 秒`}
                    count={skipCount}
                    countLabel="你略過卸載"
                />
            </div>
        </Modal>
    );
};

export default BrainDump;
