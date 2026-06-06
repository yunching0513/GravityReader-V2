// Render a note into a shareable, on-brand quote card (canvas → PNG).
// Pure canvas drawing: no dependencies, crisp output, full control over the
// 昀慶手拙 concrete + vermilion aesthetic.

export const CARD_SIZES = {
    square: { w: 1080, h: 1080, label: '方形 1:1' },
    portrait: { w: 1080, h: 1350, label: '直式 4:5' },
    story: { w: 1080, h: 1920, label: '限動 9:16' },
};

const THEMES = {
    paper: {
        bg: '#EAE8E2',
        ink: '#1F1D19',
        graphite: '#565347',
        ash: '#807C73',
        hair: '#BBB8AE',
        accent: '#C15F3C',
        sealText: '#F1EFE9',
        grain: '48,48,46',
        grainAlpha: 0.05,
    },
    sumi: {
        bg: '#0E0D0B',
        ink: '#F1EFE9',
        graphite: 'rgba(241,239,233,0.78)',
        ash: 'rgba(241,239,233,0.5)',
        hair: 'rgba(241,239,233,0.22)',
        accent: '#E0A188',
        sealBg: '#C15F3C',
        sealText: '#F1EFE9',
        grain: '255,255,255',
        grainAlpha: 0.035,
    },
};

const ZH_SERIF = "'Noto Serif TC', serif";
const EN_SERIF = "'EB Garamond', serif";
const MONO = "'JetBrains Mono', monospace";

const isCJK = (ch) => /[　-鿿぀-ヿ＀-￯]/.test(ch);

// Word-wrap that breaks between CJK characters and on Latin spaces.
function wrapLines(ctx, text, maxWidth) {
    const tokens = [];
    let buf = '';
    for (const ch of String(text)) {
        if (ch === '\n') { if (buf) { tokens.push(buf); buf = ''; } tokens.push('\n'); }
        else if (ch === ' ') { if (buf) { tokens.push(buf); buf = ''; } tokens.push(' '); }
        else if (isCJK(ch)) { if (buf) { tokens.push(buf); buf = ''; } tokens.push(ch); }
        else { buf += ch; }
    }
    if (buf) tokens.push(buf);

    const lines = [];
    let line = '';
    for (const tk of tokens) {
        if (tk === '\n') { lines.push(line); line = ''; continue; }
        const test = line + tk;
        if (line && ctx.measureText(test).width > maxWidth) {
            lines.push(line.replace(/\s+$/, ''));
            line = (tk === ' ') ? '' : tk;
        } else {
            line = test;
        }
    }
    if (line.trim() || lines.length === 0) lines.push(line);
    return lines;
}

function grain(ctx, w, h, theme) {
    ctx.save();
    for (let i = 0; i < Math.round((w * h) / 220); i++) {
        ctx.fillStyle = `rgba(${theme.grain},${theme.grainAlpha * Math.random()})`;
        ctx.fillRect(Math.random() * w, Math.random() * h, 1.4, 1.4);
    }
    ctx.restore();
}

/**
 * Draw a note card onto `canvas`. note = { text, en, zh, source, createdAt }.
 * opts = { size: 'square'|'portrait'|'story', theme: 'paper'|'sumi', docName }
 */
export function renderCard(canvas, note, opts = {}) {
    const size = CARD_SIZES[opts.size] || CARD_SIZES.square;
    const theme = THEMES[opts.theme] || THEMES.paper;
    const W = size.w, H = size.h;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'alphabetic';

    // background + grain + frame
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, W, H);
    grain(ctx, W, H, theme);
    const M = 96;
    ctx.strokeStyle = theme.hair;
    ctx.lineWidth = 2;
    ctx.strokeRect(M * 0.62, M * 0.62, W - M * 1.24, H - M * 1.24);

    // ── header: vermilion seal + wordmark ──
    const sealX = M, sealY = M, sealS = 92;
    ctx.fillStyle = theme.sealBg || theme.accent;
    ctx.fillRect(sealX, sealY, sealS, sealS);
    ctx.fillStyle = theme.sealText;
    ctx.font = `600 58px ${ZH_SERIF}`;
    ctx.textAlign = 'center';
    ctx.fillText('昀', sealX + sealS / 2, sealY + sealS / 2 + 21);
    ctx.textAlign = 'left';
    ctx.fillStyle = theme.ink;
    ctx.font = `italic 600 34px ${EN_SERIF}`;
    ctx.fillText('GravityReader', sealX + sealS + 26, sealY + 38);
    ctx.fillStyle = theme.ash;
    ctx.font = `400 20px ${ZH_SERIF}`;
    ctx.fillText('昀氏閱讀 · 精讀筆記', sealX + sealS + 28, sealY + 72);

    // ── big quote mark ──
    ctx.fillStyle = theme.accent;
    ctx.globalAlpha = 0.5;
    ctx.font = `italic 240px ${EN_SERIF}`;
    ctx.fillText('“', M - 12, M + 290);
    ctx.globalAlpha = 1;

    // ── body text area ──
    const isReading = note.source === 'reading' && (note.zh || note.en);
    const zhText = isReading ? note.zh : (note.text || '');
    const enText = isReading ? note.en : '';
    const extra = isReading ? (note.text || '') : '';

    const textX = M;
    const textW = W - M * 2;
    const bodyTop = M + 240;
    const bodyBottom = H - M - 150;
    const bodyH = bodyBottom - bodyTop;

    // auto-fit the main (zh / note) text
    let zhSize = Math.round(H / 16);
    let zhLines, zhLineH, enLines = [], enLineH = 0;
    for (; zhSize >= 26; zhSize -= 2) {
        ctx.font = `500 ${zhSize}px ${ZH_SERIF}`;
        zhLineH = Math.round(zhSize * 1.55);
        zhLines = wrapLines(ctx, zhText, textW);
        const enSize = Math.round(zhSize * 0.66);
        enLineH = Math.round(enSize * 1.4);
        if (enText) {
            ctx.font = `italic 400 ${enSize}px ${EN_SERIF}`;
            enLines = wrapLines(ctx, enText, textW);
        }
        const total = zhLines.length * zhLineH + (enText ? 28 + enLines.length * enLineH : 0)
            + (extra ? 24 + Math.ceil(ctx.measureText(extra).width / textW) * Math.round(zhSize * 0.6 * 1.5) : 0);
        if (total <= bodyH) break;
    }

    let y = bodyTop + zhSize;
    ctx.fillStyle = theme.ink;
    ctx.font = `500 ${zhSize}px ${ZH_SERIF}`;
    ctx.textAlign = 'left';
    for (const ln of zhLines) { ctx.fillText(ln, textX, y); y += zhLineH; }

    if (enText) {
        y += 18;
        const enSize = Math.round(zhSize * 0.66);
        ctx.font = `italic 400 ${enSize}px ${EN_SERIF}`;
        ctx.fillStyle = theme.ash;
        for (const ln of enLines) { ctx.fillText(ln, textX, y); y += enLineH; }
    }
    if (extra) {
        y += 20;
        const exSize = Math.round(zhSize * 0.6);
        ctx.font = `400 ${exSize}px ${ZH_SERIF}`;
        ctx.fillStyle = theme.graphite;
        const exLines = wrapLines(ctx, extra, textW);
        const exLineH = Math.round(exSize * 1.5);
        for (const ln of exLines) { ctx.fillText(ln, textX, y); y += exLineH; }
    }

    // ── attribution + footer ──
    const footY = H - M - 36;
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(M, footY - 54);
    ctx.lineTo(M + 54, footY - 54);
    ctx.stroke();

    if (opts.docName) {
        ctx.fillStyle = theme.graphite;
        ctx.font = `400 24px ${ZH_SERIF}`;
        const src = wrapLines(ctx, `《${opts.docName.replace(/\.pdf$/i, '')}》`, textW)[0];
        ctx.fillText(src, M, footY - 14);
    }

    ctx.fillStyle = theme.ash;
    ctx.font = `400 17px ${MONO}`;
    ctx.textAlign = 'right';
    ctx.fillText('GRAVITYREADER · 昀氏閱讀', W - M, footY - 14);
    ctx.textAlign = 'left';

    return canvas;
}

export function canvasToBlob(canvas) {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
