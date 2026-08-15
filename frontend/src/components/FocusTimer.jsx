import React from 'react';
import { Pause, Play, Square } from 'lucide-react';
import { fmtRemaining } from '../utils/pomodoro';

// The always-visible focus clock, docked in the reader bar.
//
// Top-left is taken by the sidebar button, so this sits at the right end of the
// bar where it can be glanced at without being in the reading path.

const FocusTimer = ({ remaining, progress, phase, cycle, paused, onToggle, onStop }) => (
    <div className={`gr-timer ${paused ? 'is-paused' : ''}`} title={`第 ${cycle + 1} 個循環`}>
        <span className="gr-timer-ring" style={{ '--timer-progress': progress }} aria-hidden="true" />
        <span className="gr-timer-clock">{fmtRemaining(remaining)}</span>
        <span className="gr-timer-phase">{phase === 'focus' ? '專注' : '休息'}</span>
        <button className="gr-timer-btn" onClick={onToggle} title={paused ? '繼續' : '暫停'}>
            {paused ? <Play size={12} /> : <Pause size={12} />}
        </button>
        <button className="gr-timer-btn" onClick={onStop} title="結束這次專注">
            <Square size={11} />
        </button>
    </div>
);

export default FocusTimer;
