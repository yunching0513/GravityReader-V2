"""Obsidian vault access for associative notes.

The previous integration was write-only: one machine-format file
(Glossary.md). This module also *reads* the vault, to suggest distant
associations, and writes a note per captured thought. That is a real
escalation, so the write path is built around one rule:

    This module only ever rewrites files it created itself.

Three independent checks enforce it, and every one must pass:

  1. Path confinement. Targets are resolved with realpath() and must stay
     inside the vault (for reads) or the app's own folder (for writes). That
     defeats both "../" and a symlink pointing out of the vault.
  2. Ownership. An existing file is only rewritten if its frontmatter carries
     a `gr_id` AND `gr_app: Yun's Reader`. A hand-written note that happens to
     share a name is never touched — creating a note picks a free name instead,
     and updating a file you don't own is refused.
  3. No deletion, append-only hubs. There is no os.remove / unlink / rmtree
     anywhere in this file — not even to clean up a failed temp write. A hub
     note is extended by inserting under its `## Captures` heading, never
     regenerated, so anything you edit by hand in it survives.

That is stricter than glossary.py, which regenerates Glossary.md wholesale.
Acceptable for one machine-format file; not for arbitrary notes.
"""

import os
import re
import json
import time
import datetime
import tempfile
import threading

APP = "Yun's Reader"
SKIP_DIRS = {".obsidian", ".trash", ".git", "node_modules"}
MAX_FILES = 20000
MAX_BYTES = 512 * 1024      # skip anything larger: not a note
EXCERPT = 400
INDEX_TTL = 60              # seconds between full re-index passes
DORMANT_DAYS = 30


class VaultError(Exception):
    """Base error. `status` maps onto an HTTP status code."""
    status = 400


class NoVault(VaultError):
    status = 503


class OutsideVault(VaultError):
    status = 400


class NotOwned(VaultError):
    status = 409


# ── vault detection ───────────────────────────────────────────────────

def _obsidian_configs():
    """Where Obsidian keeps its vault list, on each platform.

    The original detection only knew the macOS path, so the Windows build
    could never find a vault.
    """
    home = os.path.expanduser("~")
    paths = [os.path.join(home, "Library", "Application Support", "obsidian", "obsidian.json")]
    appdata = os.getenv("APPDATA")
    if appdata:
        paths.append(os.path.join(appdata, "obsidian", "obsidian.json"))
    xdg = os.getenv("XDG_CONFIG_HOME") or os.path.join(home, ".config")
    paths.append(os.path.join(xdg, "obsidian", "obsidian.json"))
    return paths


def find_vault():
    """Absolute path of the user's Obsidian vault, or None.

    GR_VAULT_DIR overrides everything. Otherwise the open vault wins, then the
    most recently used one.
    """
    override = os.getenv("GR_VAULT_DIR")
    if override:
        return override if os.path.isdir(override) else None
    for cfg in _obsidian_configs():
        try:
            with open(cfg, "r", encoding="utf-8") as f:
                vaults = (json.load(f) or {}).get("vaults", {}) or {}
        except Exception:
            continue
        candidates = [v for v in vaults.values() if isinstance(v, dict) and v.get("path")]
        if not candidates:
            continue
        candidates.sort(key=lambda v: (bool(v.get("open")), v.get("ts", 0)), reverse=True)
        path = candidates[0]["path"]
        if os.path.isdir(path):
            return path
    return None


def _require_vault():
    vault = find_vault()
    if not vault:
        raise NoVault("找不到 Obsidian vault。")
    return vault


def _safe_folder(folder):
    """The app's folder name comes from settings, so treat it as input."""
    name = (folder or APP).replace("/", "").replace("\\", "").strip(". ")
    return name or APP


def notes_root(folder=None):
    vault = find_vault()
    return os.path.join(vault, _safe_folder(folder)) if vault else None


def _write_root(folder):
    """The app's folder, resolved — and refused if it resolves outside the vault.

    Without this, a "Yun's Reader" folder that is itself a symlink pointing
    elsewhere would quietly carry every write out of the vault.
    """
    vault = os.path.realpath(_require_vault())
    root = os.path.realpath(os.path.join(vault, _safe_folder(folder)))
    if root != vault and not root.startswith(vault + os.sep):
        raise OutsideVault("App 的資料夾指到 vault 外面,不會寫入。")
    return root


def _confine(root, rel):
    """Resolve `rel` under `root`, refusing anything that escapes it."""
    base = os.path.realpath(root)
    target = os.path.realpath(os.path.join(base, rel))
    if target != base and not target.startswith(base + os.sep):
        raise OutsideVault("路徑超出允許的範圍。")
    return target


# Characters Obsidian rejects in filenames, plus ones that break [[wikilinks]].
_BAD_NAME = re.compile(r'[\\/:*?"<>|#^\[\]\n\r\t]')


def safe_name(name, limit=80):
    cleaned = _BAD_NAME.sub(" ", name or "").strip().strip(".")
    cleaned = re.sub(r"\s+", " ", cleaned)
    return (cleaned or "untitled")[:limit].rstrip()


# ── frontmatter ───────────────────────────────────────────────────────
# A deliberately small YAML subset — `key: value`, inline `[a, b]` lists and
# block `- item` lists — so we don't add a YAML dependency to the bundled
# backend. Unknown shapes are kept as raw strings rather than rejected.

def split_frontmatter(text):
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    head = text[3:end].strip("\n")
    body = text[end + 4:].lstrip("\n")

    fm, key = {}, None
    for line in head.splitlines():
        if not line.strip():
            continue
        item = re.match(r"^\s*-\s+(.*)$", line)
        if item and key is not None:
            if not isinstance(fm.get(key), list):
                fm[key] = []
            fm[key].append(_unquote(item.group(1)))
            continue
        kv = re.match(r"^([A-Za-z0-9_\-]+)\s*:\s*(.*)$", line)
        if not kv:
            continue
        key, value = kv.group(1), kv.group(2).strip()
        if value.startswith("[") and value.endswith("]"):
            fm[key] = [_unquote(v) for v in value[1:-1].split(",") if v.strip()]
        elif value == "":
            fm[key] = []
        else:
            fm[key] = _unquote(value)
    return fm, body


def _unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    return v


def is_owned(fm):
    return bool(fm.get("gr_id")) and fm.get("gr_app") == APP


def _read(path, limit=None):
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        return f.read(limit) if limit else f.read()


def _atomic_write(path, text):
    """Write via a temp file + os.replace, so a crash can't truncate a note.

    If the write fails, the hidden `.gr-*.tmp` file is left behind rather than
    removed. That is deliberate: this module contains no delete calls at all,
    and a stray temp file is a far smaller cost than any deletion code path in
    something that writes into your notes.
    """
    folder = os.path.dirname(path)
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".gr-", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


# ── status ────────────────────────────────────────────────────────────

def status(folder=None, count=False):
    """Whether a vault is reachable, and where.

    Reports the note count only when asked. Counting means indexing, which
    reads every note — and the app calls this on startup, before you have
    agreed to let it read your vault. So it doesn't, until you have.
    """
    vault = find_vault()
    if not vault:
        return {"available": False}
    out = {"available": True, "vault": vault, "root": notes_root(folder)}
    if count:
        out["noteCount"] = len(build_index())
    return out


# ── writing ───────────────────────────────────────────────────────────

def write_note(markdown, filename, gr_id, source="", page=None, folder=None, path=None):
    """Create or update one atomic note, then record it in the source's hub.

    The markdown is rendered by the frontend (one renderer, shared with the
    browser build's download path). This function's job is safety: it checks
    the markdown declares the gr_id it claims, so every file we write stays
    recognisably ours and therefore updatable later.

    - path given  -> update. The file must be ours and carry this gr_id.
    - no path     -> create. Never overwrites: a taken name gets " 2", " 3"…

    Returns {"path": <vault-relative>, "gr_id": ..., "created": bool}.
    """
    vault = _require_vault()
    root = _write_root(folder)

    fm, _ = split_frontmatter(markdown or "")
    if fm.get("gr_id") != gr_id or not is_owned(fm):
        # Refuse to write a file we couldn't later recognise as our own.
        raise VaultError("筆記內容缺少正確的 gr_id / gr_app。")

    # Check the hub BEFORE writing the note. Otherwise a hand-written file
    # squatting on the hub's name would make us write the note, then fail the
    # hub append — reporting an error while leaving an orphan note behind, and
    # another one on every retry.
    if not path and source:
        _check_hub_writable(root, source)

    if path:
        target = _confine(vault, path)
        if not target.startswith(root + os.sep):
            raise OutsideVault("只能更新 App 自己資料夾裡的筆記。")
        if not os.path.exists(target):
            raise VaultError("要更新的筆記不存在。")
        existing, _ = split_frontmatter(_read(target, 8192))
        if not is_owned(existing) or existing.get("gr_id") != gr_id:
            raise NotOwned("這不是 App 建立的筆記,不會修改。")
        _atomic_write(target, markdown)
        created = False
    else:
        base = safe_name(filename)
        target = _confine(root, base + ".md")
        n = 2
        while os.path.exists(target):
            target = _confine(root, "%s %d.md" % (base, n))
            n += 1
        _atomic_write(target, markdown)
        created = True

    rel = os.path.relpath(target, vault)
    if created and source:
        note_title = os.path.splitext(os.path.basename(target))[0]
        line = "- [[%s]]%s" % (note_title, (" · p%s" % page) if page else "")
        append_capture(source, line, folder=folder)

    _invalidate_index()
    return {"path": rel, "gr_id": gr_id, "created": created}


_CAPTURES = "## Captures"


def _check_hub_writable(root, source_title):
    hub = _confine(root, os.path.join("Sources", safe_name(source_title) + ".md"))
    if os.path.exists(hub):
        fm, _ = split_frontmatter(_read(hub, 8192))
        if not is_owned(fm):
            raise NotOwned("Sources 裡同名的筆記不是 App 建立的,不會修改。")


def append_capture(source_title, line, folder=None):
    """Add one line under the hub's `## Captures` heading.

    Inserted, never regenerated: anything else in the hub — including edits
    you made by hand — is left exactly as it was.
    """
    root = _write_root(folder)
    hub = _confine(root, os.path.join("Sources", safe_name(source_title) + ".md"))

    if os.path.exists(hub):
        text = _read(hub)
        fm, _ = split_frontmatter(text)
        if not is_owned(fm):
            raise NotOwned("Sources 裡同名的筆記不是 App 建立的,不會修改。")
        lines = text.split("\n")
        try:
            start = next(i for i, l in enumerate(lines) if l.strip() == _CAPTURES)
        except StopIteration:
            # Heading removed by hand: add it back at the end, touch nothing else.
            text = text.rstrip("\n") + "\n\n" + _CAPTURES + "\n" + line + "\n"
        else:
            end = next((i for i in range(start + 1, len(lines))
                        if lines[i].startswith("## ")), len(lines))
            # Insert after the last non-blank line of the section.
            insert = end
            while insert > start + 1 and not lines[insert - 1].strip():
                insert -= 1
            lines.insert(insert, line)
            text = "\n".join(lines)
        _atomic_write(hub, text)
        return hub

    gr_id = "gr_hub_" + re.sub(r"[^0-9A-Za-z]", "", datetime.datetime.now().strftime("%Y%m%dT%H%M%S%f"))
    text = (
        "---\n"
        "gr_id: %s\n"
        "gr_app: %s\n"
        "gr_kind: source-hub\n"
        "tags: [yun-reader, source]\n"
        "---\n\n"
        "# %s\n\n"
        "%s\n%s\n"
    ) % (gr_id, APP, source_title, _CAPTURES, line)
    _atomic_write(hub, text)
    return hub


def read_note(rel_path):
    vault = _require_vault()
    target = _confine(vault, rel_path)
    if not target.endswith(".md") or not os.path.isfile(target):
        raise VaultError("找不到這則筆記。")
    if os.path.getsize(target) > MAX_BYTES:
        raise VaultError("筆記太大。")
    fm, body = split_frontmatter(_read(target))
    return {"path": os.path.relpath(target, vault), "frontmatter": fm, "body": body}


# ── index + distant association ───────────────────────────────────────

_index = {"vault": None, "built": 0.0, "notes": []}
_lock = threading.Lock()


def _invalidate_index():
    with _lock:
        _index["built"] = 0.0


def _title_of(body, fallback):
    m = re.search(r"^#\s+(.+)$", body, re.M)
    return m.group(1).strip() if m else fallback


_INLINE_TAG = re.compile(r"(?<![\w#])#([A-Za-z0-9_/\-一-鿿]+)")


def build_index(force=False):
    """Title, tags, mtime and a short excerpt for every note. Local only."""
    vault = find_vault()
    if not vault:
        return []
    with _lock:
        fresh = _index["vault"] == vault and time.time() - _index["built"] < INDEX_TTL
        if fresh and not force:
            return _index["notes"]

    notes = []
    for dirpath, dirnames, filenames in os.walk(vault):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for fn in filenames:
            if not fn.endswith(".md") or fn.startswith("."):
                continue
            if len(notes) >= MAX_FILES:
                break
            full = os.path.join(dirpath, fn)
            try:
                st = os.stat(full)
                if st.st_size > MAX_BYTES:
                    continue
                raw = _read(full, 8192)
            except OSError:
                continue
            fm, body = split_frontmatter(raw)
            tags = fm.get("tags") or []
            if isinstance(tags, str):
                tags = [tags]
            tags = set(t.strip().lstrip("#") for t in tags if t.strip())
            tags |= set(_INLINE_TAG.findall(body))
            notes.append({
                "path": os.path.relpath(full, vault),
                "title": _title_of(body, fn[:-3]),
                "tags": sorted(tags),
                "mtime": st.st_mtime,
                "excerpt": re.sub(r"\s+", " ", body).strip()[:EXCERPT],
                "source": fm.get("source", "") if isinstance(fm.get("source", ""), str) else "",
                "owned": is_owned(fm),
            })

    with _lock:
        _index.update(vault=vault, built=time.time(), notes=notes)
    return notes


_STOP = {
    "the", "and", "for", "that", "this", "with", "are", "was", "were", "from",
    "has", "have", "had", "but", "not", "you", "your", "its", "his", "her",
    "they", "their", "which", "into", "than", "then", "also", "can", "will",
    "there", "these", "those", "such", "been", "being", "more", "most",
}


def tokens(text):
    """Latin words of 3+ letters, plus character bigrams for CJK runs.

    Bigrams instead of a segmenter (jieba) keeps the bundled backend free of a
    large dependency, and is more than enough for overlap scoring.
    """
    text = (text or "").lower()
    toks = set(re.findall(r"[a-z][a-z0-9\-]{2,}", text))
    for run in re.findall(r"[一-鿿]+", text):
        if len(run) == 1:
            toks.add(run)
        for i in range(len(run) - 1):
            toks.add(run[i:i + 2])
    return toks - _STOP


def candidates(text, tags=None, exclude_source="", limit=40, now=None):
    """Distant-association candidates, scored cheaply and locally.

    The obvious matches are the wrong answer here. The highest-scoring notes
    are almost always your own notes on the same source — related, and useless
    as an association. So we skip the top of the ranking, drop the same
    source, and prefer notes you haven't touched in a while. Dormant,
    moderately-overlapping notes are what "distant association" means.
    """
    notes = build_index()
    if not notes:
        return []
    now = now or time.time()
    q = tokens(text)
    qtags = set(t.lower().lstrip("#") for t in (tags or []))
    excl = (exclude_source or "").strip().lower()

    scored = []
    for n in notes:
        if excl and (excl in n["source"].lower()
                     or n["path"].lower().endswith(("/sources/%s.md" % excl))):
            continue
        tag_hits = len(qtags & set(t.lower() for t in n["tags"]))
        title_hits = len(q & tokens(n["title"]))
        body_hits = len(q & tokens(n["excerpt"]))
        score = 3 * tag_hits + 2 * title_hits + body_hits
        if score <= 0:
            continue
        scored.append((score, n))

    scored.sort(key=lambda s: s[0], reverse=True)
    scored = scored[:60]

    # Skip the most obvious matches. On a small vault, skipping a fixed five
    # would leave nothing, so scale it down.
    skip = 5 if len(scored) > 15 else len(scored) // 3
    scored = scored[skip:]

    dormant = now - DORMANT_DAYS * 86400

    def rank(item):
        score, n = item
        return score * (1.4 if n["mtime"] < dormant else 1.0)

    scored.sort(key=rank, reverse=True)
    out = []
    for score, n in scored[:limit]:
        out.append({
            "path": n["path"],
            "title": n["title"],
            "tags": n["tags"],
            "snippet": n["excerpt"][:200],
            "dormant": n["mtime"] < dormant,
            "score": score,
        })
    return out
