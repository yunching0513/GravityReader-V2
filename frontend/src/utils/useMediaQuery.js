// Subscribe to a CSS media query. Read synchronously on first render so the
// phone layout never flashes the two-pane desktop layout first.

import { useSyncExternalStore } from 'react';

export function useMediaQuery(query) {
    return useSyncExternalStore(
        (onChange) => {
            const mql = window.matchMedia(query);
            mql.addEventListener('change', onChange);
            return () => mql.removeEventListener('change', onChange);
        },
        () => window.matchMedia(query).matches,
        () => false,
    );
}

// One breakpoint for the whole app: below it, the two panes become one pane
// at a time with a bottom tab bar. iPad portrait (768px) keeps the split view.
export const MOBILE_QUERY = '(max-width: 760px)';
