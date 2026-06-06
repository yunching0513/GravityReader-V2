import React, { useEffect, useRef, useState } from 'react';
import { X, Download, Copy, Check } from 'lucide-react';
import { renderCard, canvasToBlob, CARD_SIZES } from '../utils/cardRenderer';

const SIZES = ['square', 'portrait', 'story'];
const THEMES = [
    { id: 'paper', label: '宣紙' },
    { id: 'sumi', label: '墨' },
];

const ShareCard = ({ note, docName, onClose }) => {
    const canvasRef = useRef(null);
    const [size, setSize] = useState('square');
    const [theme, setTheme] = useState('paper');
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const draw = async () => {
            try { await document.fonts.ready; } catch (_) { /* ignore */ }
            if (cancelled || !canvasRef.current) return;
            renderCard(canvasRef.current, note, { size, theme, docName });
        };
        draw();
        return () => { cancelled = true; };
    }, [note, size, theme, docName]);

    const filename = () => {
        const base = (docName || 'note').replace(/\.pdf$/i, '').slice(0, 40).replace(/[^\w一-鿿 -]/g, '');
        return `gravityreader-card-${base || 'note'}.png`;
    };

    const download = async () => {
        const blob = await canvasToBlob(canvasRef.current);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename();
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const copy = async () => {
        try {
            const blob = await canvasToBlob(canvasRef.current);
            await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
        } catch (e) {
            alert('複製失敗,請改用下載。');
        }
    };

    return (
        <div className="gr-share-backdrop" onMouseDown={onClose}>
            <div className="gr-share" onMouseDown={(e) => e.stopPropagation()}>
                <div className="gr-share-head">
                    <div className="gr-share-title">分享字卡 · Share card</div>
                    <button className="gr-share-x" onClick={onClose}><X size={18} /></button>
                </div>

                <div className="gr-share-preview">
                    <canvas ref={canvasRef} className="gr-share-canvas" />
                </div>

                <div className="gr-share-controls">
                    <div className="gr-share-group">
                        <span className="gr-share-label">版型</span>
                        <div className="gr-seg">
                            {SIZES.map((s) => (
                                <button key={s} className={size === s ? 'is-active' : ''} onClick={() => setSize(s)}>
                                    {CARD_SIZES[s].label}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="gr-share-group">
                        <span className="gr-share-label">主題</span>
                        <div className="gr-seg">
                            {THEMES.map((t) => (
                                <button key={t.id} className={theme === t.id ? 'is-active' : ''} onClick={() => setTheme(t.id)}>
                                    {t.label}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="gr-share-actions">
                        <button className="gr-btn" onClick={copy}>
                            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? '已複製' : '複製圖片'}
                        </button>
                        <button className="gr-btn gr-btn--accent" onClick={download}>
                            <Download size={14} /> 下載 PNG
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ShareCard;
