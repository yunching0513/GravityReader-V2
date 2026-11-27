// Render a note into a shareable, on-brand quote card (canvas → PNG).
// Pure canvas drawing: no dependencies, crisp output, full control over the
// 國際式樣 Swiss Style aesthetic — one red, one black, one white; flush-left;
// hairline rules; square corners; zero texture.

export const CARD_SIZES = {
    square: { w: 1080, h: 1080, label: '方形 1:1' },
    portrait: { w: 1080, h: 1350, label: '直式 4:5' },
    story: { w: 1080, h: 1920, label: '限動 9:16' },
};

const THEMES = {
    paper: {
        bg: '#FFFFFF',
        ink: '#111111',
        graphite: '#3C3C37',
        ash: '#6E6E66',
        hair: '#DADAD3',
        accent: '#E30613',
        sealBg: '#E30613',
        sealText: '#FFFFFF',
        grain: '0,0,0',
        grainAlpha: 0,
    },
    sumi: {
        bg: '#111111',
        ink: '#FFFFFF',
        graphite: 'rgba(255,255,255,0.80)',
        ash: 'rgba(255,255,255,0.52)',
        hair: 'rgba(255,255,255,0.24)',
        accent: '#E30613',
        sealBg: '#E30613',
        sealText: '#FFFFFF',
        grain: '255,255,255',
        grainAlpha: 0,
    },
};

// 全無襯線：Latin = Helvetica Neue / Inter Tight, 中文 = 昭源黑體 Chiron Hei HK.
const ZH_SANS = "'Chiron Hei HK','Noto Sans TC','PingFang TC',sans-serif";
const EN_SANS = "'Inter Tight','Helvetica Neue',Helvetica,Arial,sans-serif";
// Legacy names kept so the drawing code below stays untouched where generic.
const ZH_SERIF = ZH_SANS;
const EN_SERIF = EN_SANS;
const MONO = EN_SANS;

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
    if (!theme.grainAlpha) return; // Swiss: zero texture
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

    // ── header: red seal + wordmark (flush left, no italic) ──
    const sealX = M, sealY = M, sealS = 92;
    ctx.fillStyle = theme.sealBg || theme.accent;
    ctx.fillRect(sealX, sealY, sealS, sealS);
    ctx.fillStyle = theme.sealText;
    ctx.font = `700 58px ${ZH_SANS}`;
    ctx.textAlign = 'center';
    ctx.fillText('昀', sealX + sealS / 2, sealY + sealS / 2 + 21);
    ctx.textAlign = 'left';
    ctx.fillStyle = theme.ink;
    ctx.font = `700 34px ${EN_SANS}`;
    ctx.fillText("Yun's Reader", sealX + sealS + 26, sealY + 38);
    ctx.fillStyle = theme.ash;
    ctx.font = `500 20px ${ZH_SANS}`;
    ctx.fillText('昀氏閱讀 · 精讀筆記', sealX + sealS + 28, sealY + 72);

    // ── Swiss colour band (the only "illustration": a red bar) ──
    ctx.fillStyle = theme.accent;
    ctx.fillRect(M, M + 150, 120, 16);

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
        ctx.font = `700 ${zhSize}px ${ZH_SERIF}`;
        zhLineH = Math.round(zhSize * 1.55);
        zhLines = wrapLines(ctx, zhText, textW);
        const enSize = Math.round(zhSize * 0.66);
        enLineH = Math.round(enSize * 1.4);
        if (enText) {
            ctx.font = `400 ${enSize}px ${EN_SERIF}`;
            enLines = wrapLines(ctx, enText, textW);
        }
        const total = zhLines.length * zhLineH + (enText ? 28 + enLines.length * enLineH : 0)
            + (extra ? 24 + Math.ceil(ctx.measureText(extra).width / textW) * Math.round(zhSize * 0.6 * 1.5) : 0);
        if (total <= bodyH) break;
    }

    let y = bodyTop + zhSize;
    ctx.fillStyle = theme.ink;
    ctx.font = `700 ${zhSize}px ${ZH_SERIF}`;
    ctx.textAlign = 'left';
    for (const ln of zhLines) { ctx.fillText(ln, textX, y); y += zhLineH; }

    if (enText) {
        y += 18;
        const enSize = Math.round(zhSize * 0.66);
        ctx.font = `400 ${enSize}px ${EN_SERIF}`;
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
    ctx.fillText("YUN'S READER · 昀氏閱讀", W - M, footY - 14);
    ctx.textAlign = 'left';

    return canvas;
}

export function canvasToBlob(canvas) {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
