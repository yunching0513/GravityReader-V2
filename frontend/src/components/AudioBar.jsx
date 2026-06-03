import React from 'react';
import { Play, Pause, SkipBack, SkipForward, X, Loader } from 'lucide-react';

const SPEEDS = [0.75, 1, 1.25, 1.5];

// The docked read-aloud control bar (bottom of the reader pane).
const AudioBar = ({
    isPlaying, isLoading, activeText, position,
    engineLabel,
    speed, onSpeed,
    onToggle, onPrev, onNext, onStop,
}) => {
    return (
        <div className="gr-audiobar">
            <div className="gr-audio-transport">
                <button className="gr-audio-btn" onClick={onPrev} title="上一句"><SkipBack size={15} /></button>
                <button className="gr-audio-btn gr-audio-btn--main" onClick={onToggle} title={isPlaying ? '暫停' : '播放'}>
                    {isLoading ? <Loader size={17} className="gr-spin" /> : (isPlaying ? <Pause size={17} /> : <Play size={17} />)}
                </button>
                <button className="gr-audio-btn" onClick={onNext} title="下一句"><SkipForward size={15} /></button>
            </div>

            <div className="gr-audio-now">
                <div className="gr-audio-now-text" title={activeText}>{activeText || '準備朗讀…'}</div>
                <div className="gr-audio-meta">
                    <span className="gr-audio-count">{position.total ? `${position.index} / ${position.total}` : '—'}</span>
                    <span className="gr-audio-reading">{isPlaying ? `reading · ${engineLabel}` : 'paused'}</span>
                </div>
            </div>

            <div className="gr-audio-controls">
                <div className="gr-audio-speeds">
                    {SPEEDS.map((s) => (
                        <button
                            key={s}
                            className={`gr-audio-speed ${speed === s ? 'is-active' : ''}`}
                            onClick={() => onSpeed(s)}
                        >
                            {s}×
                        </button>
                    ))}
                </div>
                <button className="gr-audio-btn gr-audio-stop" onClick={onStop} title="停止"><X size={15} /></button>
            </div>
        </div>
    );
};

export default AudioBar;
