import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useEscape } from '../utils/useEscape';

// Shared modal shell, generalised from the share-card markup.
//
// Closing is bound to onMouseDown rather than onClick on purpose: a text drag
// that starts inside the panel and ends outside it should not dismiss.

const Modal = ({
    title,
    onClose,          // omit to make the modal non-dismissable (the break lock)
    children,
    footer,
    width = 540,
    className = '',
    closeOnEscape = true,
}) => {
    const panelRef = useRef(null);
    const restoreRef = useRef(null);

    useEscape(onClose, Boolean(onClose) && closeOnEscape);

    useEffect(() => {
        restoreRef.current = document.activeElement;
        // Focus the panel so Escape and Tab land somewhere sensible.
        panelRef.current?.focus();
        return () => {
            const el = restoreRef.current;
            if (el && typeof el.focus === 'function' && document.contains(el)) el.focus();
        };
    }, []);

    // Keep Tab inside the panel while it is open.
    const onKeyDown = (e) => {
        if (e.key !== 'Tab') return;
        const focusable = panelRef.current?.querySelectorAll(
            'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable || !focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    };

    return (
        <div className="gr-modal-backdrop" onMouseDown={onClose}>
            <div
                ref={panelRef}
                className={`gr-modal ${className}`}
                style={{ width: `min(${width}px, 96vw)` }}
                role="dialog"
                aria-modal="true"
                aria-label={typeof title === 'string' ? title : undefined}
                tabIndex={-1}
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={onKeyDown}
            >
                {title && (
                    <div className="gr-modal-head">
                        <div className="gr-modal-title">{title}</div>
                        {onClose && (
                            <button className="gr-modal-x" onClick={onClose} title="關閉">
                                <X size={18} />
                            </button>
                        )}
                    </div>
                )}
                <div className="gr-modal-body gr-scroll">{children}</div>
                {footer && <div className="gr-modal-foot">{footer}</div>}
            </div>
        </div>
    );
};

export default Modal;
