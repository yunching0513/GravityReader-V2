import React from 'react';
import HoldToSkip from './HoldToSkip';
import { fmtRemaining } from '../utils/pomodoro';

// The DMN rest overlay.
//
// Fogged paper, not a black scrim: a black screen reads as punishment, while
// the page simply going quiet reads as "this is resting now". The breathing
// circle is pure CSS on a 12s cycle (~5 breaths/min, coherent breathing), so it
// costs nothing per frame.
//
// Escape is deliberately not bound. The 2-second hold is the only way out, and
// it is always visible and never disabled.

const BreakLock = ({ remaining, progress, isLong, cycle, skipCount, holdMs, onSkip, thoughts = [], moreThoughts = 0 }) => (
    <div className="gr-lock" role="dialog" aria-modal="true" aria-label="休息中">
        <div className="gr-lock-inner">
            <div className="gr-lock-kicker">
                {isLong ? '長休息 · Long rest' : '休息 · Rest'}
                {cycle > 0 && <span className="gr-lock-cycle">第 {cycle} 個循環後</span>}
            </div>

            <div className="gr-breathe" aria-hidden="true">
                <span className="gr-breathe-ring" />
                <span className="gr-breathe-core" />
            </div>

            <div className="gr-breathe-cue" aria-hidden="true">
                <span className="gr-cue gr-cue--in">吸氣</span>
                <span className="gr-cue gr-cue--out">吐氣</span>
            </div>

            <div className="gr-lock-clock">{fmtRemaining(remaining)}</div>

            <div className="gr-lock-bar">
                <div className="gr-lock-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>

            <p className="gr-lock-note">
                把眼睛放遠一點。不要滑手機 —— 低認知負荷的休息才有用。
            </p>

            {/* What you set aside while reading. Shown, not to be dealt with now:
                knowing it's written down is what lets it go. */}
            {thoughts.length > 0 && (
                <div className="gr-lock-thoughts">
                    <div className="gr-lock-thoughts-head">你記下的事 · 休息完再處理</div>
                    <ul>
                        {thoughts.map((t) => <li key={t.id}>{t.text}</li>)}
                    </ul>
                    {moreThoughts > 0 && <div className="gr-lock-thoughts-more">還有 {moreThoughts} 則</div>}
                </div>
            )}

            <HoldToSkip
                ms={holdMs}
                onConfirm={onSkip}
                label="我需要繼續讀"
                sub={`按住 ${Math.round(holdMs / 1000)} 秒`}
                count={skipCount}
                countLabel="你略過休息"
                className="gr-lock-skip"
            />
        </div>
    </div>
);

export default BreakLock;
