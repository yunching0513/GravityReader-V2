// The single renderer for a note as Obsidian Markdown.
//
// Both paths use it: the desktop build sends the result to the backend, which
// checks ownership and writes it into the vault; the browser build, which can't
// reach the disk, downloads the very same text as a .md file. One format, one
// source of truth.
//
// Shaped for an Obsidian AI plugin (Smart Connections / Copilot), which embed
// per file and per block:
//   - one atomic note per thought — a long log embeds into mush;
//   - `##` headings give clean chunk boundaries;
//   - the Chinese `#` title is the semantic anchor most plugins weight heavily;
//   - EN and ZH sit in one callout, so a query in either language finds it;
//   - [[wikilinks]] go in the body, which every plugin indexes, rather than only
//     in frontmatter, which plugins parse inconsistently;
//   - `yun-reader` is always a tag, so one query includes or excludes it all.

export const APP = "Yun's Reader";

// Mirrors backend/vault.py safe_name(): characters Obsidian rejects in a
// filename, plus the ones that break [[wikilinks]]. Kept identical so a
// [[Sources/…]] link resolves to the hub file the backend creates.
const BAD_NAME = /[\\/:*?"<>|#^[\]\n\r\t]/g;

export function safeName(name, limit = 80) {
    const cleaned = String(name || '')
        .replace(BAD_NAME, ' ')
        .trim()
        .replace(/^\.+|\.+$/g, '')
        .replace(/\s+/g, ' ');
    return (cleaned || 'untitled').slice(0, limit).trimEnd();
}

export function newGrId(now = new Date()) {
    const stamp = now.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
    const rand = Math.random().toString(36).slice(2, 8);
    return `gr_${stamp}_${rand}`;
}

export function sourceTitle(docName) {
    return safeName(String(docName || '').replace(/\.pdf$/i, '')) || 'Untitled source';
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function isoLocal(d) {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
        + `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** A short title for the note: your own words first, then the translation. */
export function noteTitle(note) {
    const pick = [note.text, note.zh, note.en]
        .map((s) => String(s || '').split('\n')[0].trim())
        .find(Boolean) || '閱讀筆記';
    const short = pick.length > 28 ? pick.slice(0, 28).trimEnd() + '…' : pick;
    return safeName(short, 60);
}

export function noteFilename(note) {
    const d = new Date(note.createdAt || Date.now());
    return `${ymd(d)} ${noteTitle(note)}`;
}

/** Link target for a vault path: Obsidian resolves [[name]] by file name. */
export function linkTarget(vaultPath) {
    const base = String(vaultPath || '').split(/[\\/]/).pop() || '';
    return base.replace(/\.md$/i, '');
}

const quoteBlock = (s) => String(s || '').split('\n').map((l) => `> ${l}`).join('\n');

/**
 * @param {object} n  { grId, en, zh, text, page, docName, createdAt, links:[{target, reason}] }
 */
export function renderNote(n) {
    const created = new Date(n.createdAt || Date.now());
    const src = n.docName ? sourceTitle(n.docName) : '';
    const title = noteTitle(n);

    const fm = [
        '---',
        `gr_id: ${n.grId}`,
        `gr_app: ${APP}`,
        'gr_kind: reading-note',
        `gr_created: ${isoLocal(created)}`,
        src ? `source: "[[Sources/${src}]]"` : null,
        n.page ? `page: ${n.page}` : null,
        `tags: [yun-reader, reading-note]`,
        '---',
    ].filter(Boolean).join('\n');

    const parts = [fm, '', `# ${title}`, ''];

    if (n.en || n.zh) {
        parts.push(`> [!quote]${n.page ? ` p.${n.page}` : ''}`);
        if (n.en) parts.push(quoteBlock(n.en));
        if (n.en && n.zh) parts.push('>');
        if (n.zh) parts.push(quoteBlock(n.zh));
        parts.push('');
    }

    if (n.text) parts.push(String(n.text).trim(), '');

    const links = (n.links || []).filter((l) => l && l.target);
    if (links.length) {
        parts.push('## 遠距聯想');
        for (const l of links) {
            parts.push(`- [[${l.target}]]${l.reason ? ` — ${l.reason}` : ''}`);
        }
        parts.push('');
    }

    if (src) {
        parts.push('## 出處', `[[Sources/${src}]]${n.page ? ` · p.${n.page}` : ''}`, '');
    }

    return parts.join('\n');
}
