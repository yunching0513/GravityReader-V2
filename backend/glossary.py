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
import datetime

# ── Obsidian vault detection ──────────────────────────────────────────
# Shared with the associative-notes module. It used to live here and only
# knew the macOS config path, so the Windows build could never find a vault.
from vault import find_vault  # noqa: E402


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
