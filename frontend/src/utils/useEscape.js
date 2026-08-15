// Close-on-Escape for modals.
//
// Deliberately NOT used by the break overlay: a one-key bypass isn't friction,
// it's decoration. There the 2-second hold is the only exit.

import { useEffect } from 'react';

export function useEscape(onEscape, active = true) {
    useEffect(() => {
        if (!active || !onEscape) return undefined;
        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onEscape();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onEscape, active]);
}
