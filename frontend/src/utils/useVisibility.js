// Is this document visible right now?
//
// Two callers need it: the Pomodoro (catch up on a phase change the moment a
// backgrounded window comes back) and the reading guide (rAF stops while
// hidden, so wall-clock time would teleport the cursor to the end of the page).

import { useSyncExternalStore } from 'react';

const subscribe = (fn) => {
    document.addEventListener('visibilitychange', fn);
    return () => document.removeEventListener('visibilitychange', fn);
};

const getSnapshot = () => document.visibilityState !== 'hidden';

export function useVisibility() {
    return useSyncExternalStore(subscribe, getSnapshot, () => true);
}
