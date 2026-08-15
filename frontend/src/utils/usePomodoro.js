// React binding for the focus cycle. Keeps pomodoro.js itself pure and testable.

import { useEffect, useState } from 'react';
import { useSettings } from './settings';
import { useVisibility } from './useVisibility';
import { advance, cfgFrom, isBreak, remainingMs, totalMs } from './pomodoro';

export function usePomodoro() {
    const settings = useSettings();
    const visible = useVisibility();
    const session = settings.session;
    const flow = settings.flow;

    // Only drives repaint. All real timing comes from the stored timestamps, so
    // a coarse or throttled interval can't make the clock drift.
    const [, forceTick] = useState(0);

    useEffect(() => {
        if (!session || session.pausedAt) return undefined;
        const id = setInterval(() => {
            advance(flow);
            forceTick((n) => n + 1);
        }, 500);
        return () => clearInterval(id);
    }, [session, flow]);

    // A backgrounded window's interval is throttled hard, so catch up the moment
    // it comes back rather than up to half a second late.
    useEffect(() => {
        if (visible && session) {
            advance(flow);
            forceTick((n) => n + 1);
        }
    }, [visible, session, flow]);

    const cfg = cfgFrom(flow);
    const remaining = remainingMs(session);
    const total = totalMs(session, cfg);

    return {
        session,
        flow,
        cfg,
        remaining,
        total,
        progress: total ? 1 - remaining / total : 0,
        onBreak: isBreak(session),
        paused: Boolean(session?.pausedAt),
        running: Boolean(session),
    };
}
