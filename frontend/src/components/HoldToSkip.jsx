import React, { useCallback, useEffect, useRef, useState } from 'react';

// Press and hold to skip.
//
// The whole point of the flow features is friction, not a prison — every forced
// step has an exit, but the exit costs two deliberate seconds so it can't be a
// reflex. The skip count is shown right here, under the button, rather than
// buried in a stats page: the feedback belongs where the choice happens.
//
// Nothing here is hardened. The counter lives in localStorage and you can zero
// it in a second. That is correct — this is an instrument for noticing your own
// habits, not an accountability system to defeat.

const HoldToSkip = ({
    ms = 2000,
    onConfirm,
    label = '略過',
    sub,
    count = 0,
    countLabel = '略過過',
    className = '',
}) => {
    const [progress, setProgress] = useState(0); // 0..1
    const rafRef = useRef(null);
    const startRef = useRef(0);
    const doneRef = useRef(false);

    const stop = useCallback(() => {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        setProgress(0);
    }, []);

    const tick = useCallback(() => {
        const elapsed = performance.now() - startRef.current;
        const p = Math.min(1, elapsed / ms);
        setProgress(p);
        if (p >= 1) {
            if (!doneRef.current) {
                doneRef.current = true;
                stop();
                onConfirm && onConfirm();
            }
            return;
        }
        rafRef.current = requestAnimationFrame(tick);
    }, [ms, onConfirm, stop]);

    const begin = useCallback(() => {
        if (rafRef.current) return;
        doneRef.current = false;
        startRef.current = performance.now();
        rafRef.current = requestAnimationFrame(tick);
    }, [tick]);

    useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

    // Pointer capture keeps the hold alive when the finger drifts off the
    // button — otherwise a slightly shaky 2-second press silently fails.
    const onPointerDown = (e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        begin();
    };
    const onPointerUp = (e) => {
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        stop();
    };

    // Keyboard parity. `e.repeat` matters: without it, auto-repeat would fire
    // keydown dozens of times and the hold would "complete" instantly.
    const onKeyDown = (e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
            e.preventDefault();
            begin();
        }
    };
    const onKeyUp = (e) => {
        if (e.key === ' ' || e.key === 'Enter') stop();
    };

    return (
        <div className={`gr-hold-wrap ${className}`}>
            <button
                type="button"
                className={`gr-hold ${progress > 0 ? 'is-holding' : ''}`}
                style={{ '--hold-progress': progress }}
                onPointerDown={onPointerDown}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onKeyDown={onKeyDown}
                onKeyUp={onKeyUp}
                onBlur={stop}
            >
                <span className="gr-hold-fill" aria-hidden="true" />
                <span className="gr-hold-text">
                    <span className="zh">{label}</span>
                    <span className="en">{sub || `按住 ${Math.round(ms / 1000)} 秒`}</span>
                </span>
            </button>
            {count > 0 && (
                <div className="gr-hold-count">{countLabel} {count} 次</div>
            )}
        </div>
    );
};

export default HoldToSkip;
