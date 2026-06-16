"""Shared phrasebook (片語本) backed by a Markdown file in the user's Obsidian vault.

Yun's Reader and Typer both read/write the same `<vault>/Glossary.md`, so a
中文 ↔ 英文 pair you look up in one app shows up in the other. The file is plain
Markdown so you can also edit it directly in Obsidian when neither app is open.

Line format (human-readable, Obsidian-searchable):

    - 退讓於環境 → deferring to the environment  · ×4 · 最近 2026-06-05

The vault is the source of truth; this module only parses/upserts that one file.
"""

import os
import re
import json
import datetime

# ── Obsidian vault detection ──────────────────────────────────────────
# Obsidian records every known vault in this JSON. We pick the one currently
# open, else the most recently used. `GR_VAULT_DIR` overrides everything.
_OBSIDIAN_JSON = os.path.expanduser(
    "~/Library/Application Support/obsidian/obsidian.json"
)


def find_vault():
    """Return the absolute path of the user's Obsidian vault, or None."""
    override = os.getenv("GR_VAULT_DIR")
    if override:
        return override if os.path.isdir(override) else None
    try:
        with open(_OBSIDIAN_JSON, "r", encoding="utf-8") as f:
            vaults = (json.load(f) or {}).get("vaults", {}) or {}
    except Exception:
        return None
    # Prefer the open vault; fall back to the most recently touched.
    candidates = [v for v in vaults.values() if isinstance(v, dict) and v.get("path")]
    if not candidates:
        return None
    candidates.sort(key=lambda v: (bool(v.get("open")), v.get("ts", 0)), reverse=True)
    path = candidates[0]["path"]
    return path if os.path.isdir(path) else None


def glossary_path():
    """Path to `<vault>/Glossary.md`, or None when no vault is found."""
    vault = find_vault()
    return os.path.join(vault, "Glossary.md") if vault else None


_HEADER = (
    "# Glossary · 共用片語本\n\n"
    "> Yun's Reader 與 Typer 共用。翻譯命中既有中文就 +1,新中文追加一行。\n"
    "> 純 Markdown,你也可以直接在 Obsidian 編修。\n\n"
)

# Tolerant: arrow may be → or ->, the `· ×N · 最近 DATE` tail is optional
# (so hand-typed `- zh → en` lines still parse).
_LINE_RE = re.compile(
    r"^- (?P<zh>.+?)\s*(?:→|->)\s*(?P<en>.+?)"
    r"(?:\s*·\s*×(?P<count>\d+))?"
    r"(?:\s*·\s*最近\s*(?P<last>\S+))?\s*$"
)


def _today():
    return datetime.date.today().isoformat()


def parse(text):
    """Parse glossary Markdown into a list of {zh, en, count, last} dicts."""
    entries = []
    for line in text.splitlines():
        m = _LINE_RE.match(line.rstrip())
        if not m:
            continue
        entries.append({
            "zh": m.group("zh").strip(),
            "en": m.group("en").strip(),
            "count": int(m.group("count")) if m.group("count") else 1,
            "last": (m.group("last") or "").strip(),
        })
    return entries


def _format_line(e):
    return f"- {e['zh']} → {e['en']}  · ×{e['count']} · 最近 {e['last']}"


def _render(entries):
    return _HEADER + "\n".join(_format_line(e) for e in entries) + "\n"


def load():
    """Return all entries (empty list if no vault / no file)."""
    path = glossary_path()
    if not path or not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            return parse(f.read())
    except Exception:
        return []


def status():
    vault = find_vault()
    path = glossary_path()
    if not vault:
        return {"available": False}
    return {
        "available": True,
        "vault": vault,
        "path": path,
        "count": len(load()) if path and os.path.exists(path) else 0,
    }


def _norm_zh(s):
    return (s or "").strip()


def record(zh, en):
    """Upsert a pair. Same 中文 → count+1 & refresh date; new 中文 → append.

    Returns the resulting entry, or raises RuntimeError if no vault is found.
    """
    zh, en = _norm_zh(zh), (en or "").strip()
    if not zh or not en:
        raise ValueError("zh and en are both required")
    path = glossary_path()
    if not path:
        raise RuntimeError("找不到 Obsidian vault,無法寫入片語本。")

    entries = load()
    today = _today()
    hit = next((e for e in entries if _norm_zh(e["zh"]) == zh), None)
    if hit:
        hit["count"] += 1
        hit["last"] = today
        hit["en"] = en  # keep the latest phrasing the user accepted
        result = hit
    else:
        result = {"zh": zh, "en": en, "count": 1, "last": today}
        entries.append(result)

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(_render(entries))
    return result
