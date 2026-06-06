import os
import re
import sys
import io
import time
import wave
import json
import base64
import shutil
import sqlite3
import logging
import tempfile
import threading
import subprocess
import urllib.request
import urllib.error
from typing import List, Optional
from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import google.generativeai as genai
from dotenv import load_dotenv

# Resolve the directory the app is running from. When packaged by PyInstaller
# (sys.frozen), files live next to the executable; otherwise next to this file.
if getattr(sys, "frozen", False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Load environment variables — prefer a .env shipped next to the executable,
# then fall back to the default search (project dir during development).
load_dotenv(os.path.join(BASE_DIR, ".env"))
load_dotenv()

# Configure Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── Gemini API key ────────────────────────────────────────────────────
# The key is supplied by the user (stored locally) so no key is shipped in the
# app. Resolution order: a key set this session → the saved config file → an
# env var (dev / opt-in bundled builds).
CONFIG_DIR = os.path.expanduser("~/.gravityreader")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.json")


def _read_config_key():
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            return (json.load(f) or {}).get("google_api_key") or None
    except Exception:
        return None


def _write_config_key(key):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    data = {}
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                data = json.load(f) or {}
        except Exception:
            data = {}
    data["google_api_key"] = key
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f)


_runtime_key = [_read_config_key() or os.getenv("GOOGLE_API_KEY")]


def get_api_key():
    return _runtime_key[0]


def set_api_key(key):
    _runtime_key[0] = key or None
    _write_config_key(key or "")


if not get_api_key():
    logger.warning("No Gemini API key configured yet — user must set one in the app.")

# Use a stable alias by default so a retired model version (e.g. the old
# gemini-2.0-flash) never breaks the app. Override with GEMINI_MODEL if needed.
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "models/gemini-flash-latest")

# Text-to-speech (Phase 1: Gemini cloud TTS for paragraph/page read-aloud).
GEMINI_TTS_MODEL = os.getenv("GEMINI_TTS_MODEL", "gemini-2.5-flash-preview-tts")

# Curated English prebuilt voices (Gemini exposes ~30; these read English well).
GEMINI_VOICES = [
    {"id": "Kore", "label": "Kore · 沉穩女聲"},
    {"id": "Aoede", "label": "Aoede · 輕快女聲"},
    {"id": "Leda", "label": "Leda · 明亮女聲"},
    {"id": "Puck", "label": "Puck · 活潑男聲"},
    {"id": "Charon", "label": "Charon · 低沉男聲"},
    {"id": "Orus", "label": "Orus · 穩重男聲"},
]

# Offline whole-book TTS (Phase 2) uses the macOS `say` engine + `afconvert`.
SAY_AVAILABLE = sys.platform == "darwin"
BOOK_DIR = os.path.expanduser("~/Music/GravityReader Audiobooks")
# Surface the better system voices first if they are installed.
PREFERRED_SAY = ["Samantha", "Alex", "Daniel", "Karen", "Moira", "Tessa", "Rishi", "Serena", "Fred"]
JOBS = {}            # jobId -> progress dict (in-memory, process lifetime)
_job_counter = [0]


def _list_say_voices():
    if not SAY_AVAILABLE:
        return []
    try:
        out = subprocess.run(["say", "-v", "?"], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return []
    voices = []
    for line in out.splitlines():
        head = line.split("#")[0].rstrip()
        if not head:
            continue
        parts = head.split()
        if len(parts) < 2:
            continue
        lang = parts[-1]
        name = " ".join(parts[:-1])
        if lang.startswith("en"):
            voices.append({"id": name, "label": f"{name} · {lang}"})
    voices.sort(key=lambda v: (PREFERRED_SAY.index(v["id"]) if v["id"] in PREFERRED_SAY else 999, v["id"]))
    return voices

app = FastAPI()

# CORS Configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, replace with specific origin
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class AnalyzeRequest(BaseModel):
    text: str
    mode: str = "sentence"  # "sentence" or "paragraph"

class SummarizeRequest(BaseModel):
    text: str
    length: int

@app.post("/api/analyze")
async def analyze_text(request: AnalyzeRequest):
    logger.info(f"🔥 Received Text Analysis Request (Mode: {request.mode})...")
    
    if not request.text:
        raise HTTPException(status_code=400, detail="No text provided")

    key = get_api_key()
    if not key:
        raise HTTPException(status_code=503, detail="尚未設定 Gemini API 金鑰,請在 app 設定中填入。")

    try:
        genai.configure(api_key=key)
        model = genai.GenerativeModel(GEMINI_MODEL)

        instruction = ""
        if request.mode == "paragraph":
            instruction = "Split the text by PARAGRAPHS. Translate each paragraph as a whole unit."
        else:
            instruction = "Split the text by SENTENCES. Translate each sentence individually."

        prompt = f"""
        You are a professional translator. Translate the following English text into fluent Traditional Chinese (Taiwan).
        
        Instruction: {instruction}
        
        Strict Output Format: Return a raw JSON list of objects. Each object must have ONLY two fields:
        
        en: The original English text segment (sentence or paragraph).
        zh: The Traditional Chinese translation. DO NOT provide any grammar notes, vocabulary lists, or explanations. Just the translation.
        
        Text to analyze:
        {request.text}
        """
        
        response = model.generate_content(prompt)
        
        # Simple cleanup to ensure we get just the JSON part if the model adds markdown
        text_response = response.text
        if text_response.startswith("```json"):
            text_response = text_response[7:]
        if text_response.endswith("```"):
            text_response = text_response[:-3]
            
        return text_response.strip()

    except Exception as e:
        logger.error(f"Error analyzing text: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/summarize")
async def summarize_text(request: SummarizeRequest):
    logger.info("🔥 Received Summarization Request...")
    
    if not request.text:
        raise HTTPException(status_code=400, detail="No text provided")

    key = get_api_key()
    if not key:
        raise HTTPException(status_code=503, detail="尚未設定 Gemini API 金鑰,請在 app 設定中填入。")

    try:
        genai.configure(api_key=key)
        model = genai.GenerativeModel(GEMINI_MODEL)
        prompt = f"""
        You are a research assistant. Summarize the provided text into approximately {request.length} Traditional Chinese words. Capture the main arguments and conclusions.
        
        Text to summarize:
        {request.text}
        """
        
        response = model.generate_content(prompt)
        return {"summary": response.text}

    except Exception as e:
        logger.error(f"Error summarizing text: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/")
def read_root():
    return {"message": "GravityReader V2 Backend is running"}


# ── API key (user-supplied) ───────────────────────────────────────────

class KeyRequest(BaseModel):
    key: str = ""


@app.get("/api/key")
def key_status():
    k = get_api_key()
    masked = f"{k[:4]}…{k[-4:]}" if k and len(k) > 8 else None
    return {"hasKey": bool(k), "masked": masked}


@app.post("/api/key")
def save_key(req: KeyRequest):
    key = (req.key or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="金鑰不可為空。")
    # Validate by a lightweight authenticated call before saving.
    try:
        genai.configure(api_key=key)
        next(iter(genai.list_models()))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"金鑰驗證失敗:{str(e)[:140]}")
    set_api_key(key)
    return {"ok": True, "hasKey": True}


# ── Text-to-Speech ────────────────────────────────────────────────────

class TtsRequest(BaseModel):
    text: str
    voice: str = "Kore"
    engine: str = "gemini"  # Phase 1: gemini


def _pcm_to_wav(pcm: bytes, rate: int = 24000, channels: int = 1, width: int = 2) -> bytes:
    """Wrap raw little-endian PCM (what Gemini returns) into a playable WAV."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def _gemini_tts(text: str, voice: str) -> bytes:
    """Synthesize one chunk of text with Gemini TTS, returning WAV bytes."""
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_TTS_MODEL}:generateContent?key={get_api_key()}"
    )
    body = {
        "contents": [{"parts": [{"text": text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice or "Kore"}}
            },
        },
    }
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    part = data["candidates"][0]["content"]["parts"][0]
    inline = part.get("inlineData") or part.get("inline_data")
    pcm = base64.b64decode(inline["data"])

    rate = 24000
    mime = inline.get("mimeType") or inline.get("mime_type") or ""
    if "rate=" in mime:
        try:
            rate = int(mime.split("rate=")[1].split(";")[0])
        except ValueError:
            pass
    return _pcm_to_wav(pcm, rate=rate)


def _say_tts(text, voice):
    """Synthesize one chunk with the macOS `say` engine, returning WAV bytes."""
    tmp = tempfile.mkdtemp(prefix="gr_say_")
    try:
        wav_path = os.path.join(tmp, "s.wav")
        txt_path = os.path.join(tmp, "s.txt")
        with open(txt_path, "w", encoding="utf-8") as f:
            f.write(text)
        subprocess.run(
            ["say", "-v", voice or "Samantha", "-o", wav_path,
             "--file-format=WAVE", "--data-format=LEI16@22050", "-f", txt_path],
            check=True, capture_output=True, timeout=120,
        )
        with open(wav_path, "rb") as f:
            return f.read()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@app.get("/api/tts/voices")
def tts_voices():
    return {"gemini": GEMINI_VOICES, "say": _list_say_voices()}


# Defined as a sync `def` so FastAPI runs it in a threadpool — the urllib call
# is blocking, and this keeps the event loop free for concurrent prefetches.
@app.post("/api/tts")
def tts(req: TtsRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="No text provided")
    engine = (req.engine or "gemini").lower()
    try:
        if engine == "say":
            if not SAY_AVAILABLE:
                raise HTTPException(status_code=503, detail="離線朗讀僅在 macOS 上可用。")
            wav = _say_tts(text, req.voice or "Samantha")
        else:
            if not get_api_key():
                raise HTTPException(status_code=503, detail="尚未設定 Gemini API 金鑰,請在 app 設定中填入。")
            wav = _gemini_tts(text, req.voice)
        return Response(content=wav, media_type="audio/wav")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"TTS error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Whole-book offline audiobook (macOS `say`) ────────────────────────

class BookRequest(BaseModel):
    pages: List[str] = []
    voice: str = "Samantha"
    name: str = "audiobook"
    engine: str = "say"  # "say" (offline) | "gemini" (cloud)


def _chunk_pages(pages, max_chars=3000):
    """Group page texts into ~max_chars chunks (one `say` call per chunk)."""
    chunks, cur = [], ""
    for p in pages:
        t = (p or "").strip()
        if not t:
            continue
        if cur and len(cur) + len(t) + 1 > max_chars:
            chunks.append(cur)
            cur = t
        else:
            cur = f"{cur}\n{t}" if cur else t
    if cur:
        chunks.append(cur)
    return chunks


def _safe_name(name):
    base = os.path.basename(name or "audiobook")
    base = "".join(c for c in base if c.isalnum() or c in " -_·()").strip()
    return (base or "audiobook")[:80]


def _say_chunk_to_wav(chunk, voice, wav_path, txt_path):
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(chunk)
    subprocess.run(
        ["say", "-v", voice, "-o", wav_path,
         "--file-format=WAVE", "--data-format=LEI16@22050", "-f", txt_path],
        check=True, capture_output=True, timeout=900,
    )


def _retry_after_seconds(err):
    """If this is a 429, how long Gemini asks us to wait (Retry-After header or
    the RetryInfo.retryDelay in the JSON body)."""
    try:
        if isinstance(err, urllib.error.HTTPError) and err.code == 429:
            ra = err.headers.get("Retry-After") if err.headers else None
            if ra and str(ra).isdigit():
                return int(ra)
            body = err.read().decode("utf-8", "ignore")
            m = re.search(r'"retryDelay"\s*:\s*"(\d+)s"', body)
            if m:
                return int(m.group(1))
            if "429" in body or "RESOURCE_EXHAUSTED" in body:
                return 30
    except Exception:
        pass
    return None


def _is_rate_limit(err):
    if isinstance(err, urllib.error.HTTPError) and err.code == 429:
        return True
    s = str(err)
    return "429" in s or "Too Many Requests" in s or "RESOURCE_EXHAUSTED" in s


def _friendly_error(e):
    if _is_rate_limit(e):
        return ("Gemini 免費額度或速率已達上限。請稍候再試,"
                "或改用「Apple 離線」引擎生成整本有聲書(免費、無速率限制)。")
    return str(e)[:300]


def _gemini_chunk_to_wav(chunk, voice, wav_path, job=None):
    # The preview TTS endpoint is rate-limited; honour Gemini's own retryDelay
    # (falling back to exponential backoff) so a long book rides through 429s
    # instead of failing the whole job.
    # Enough attempts to ride a transient per-minute limit, but bounded so a
    # genuinely-exhausted quota fails in a few minutes with a clear suggestion
    # to use the free, unlimited Apple offline engine for whole books.
    attempts = 4
    last = None
    for attempt in range(attempts):
        try:
            data = _gemini_tts(chunk, voice)
            with open(wav_path, "wb") as f:
                f.write(data)
            if job is not None:
                job["note"] = None
            return
        except Exception as e:
            last = e
            if not _is_rate_limit(e) and attempt >= 1:
                raise  # a non-rate-limit error that keeps failing — give up early
            if attempt == attempts - 1:
                break
            wait = _retry_after_seconds(e)
            wait = min(wait + 2, 70) if wait is not None else min(3 * (2 ** attempt), 45)
            if job is not None:
                job["note"] = f"Gemini 速率限制,等待 {wait}s…(剩餘重試 {attempts - 1 - attempt})"
            time.sleep(wait)
    raise last


def _generate_book(job_id, pages, voice, name, engine):
    job = JOBS[job_id]
    tmp = tempfile.mkdtemp(prefix="gr_book_")
    try:
        # Gemini caps audio length per call, so chunk it smaller than `say`.
        max_chars = 1500 if engine == "gemini" else 3000
        chunks = _chunk_pages(pages, max_chars=max_chars)
        job["total"] = len(chunks)
        if not chunks:
            job.update(status="error", error="這份文件沒有可朗讀的文字。")
            return

        wavs = []
        for i, chunk in enumerate(chunks):
            if job.get("cancel"):
                job.update(status="error", error="已取消")
                return
            wav_path = os.path.join(tmp, f"c{i}.wav")
            if engine == "gemini":
                _gemini_chunk_to_wav(chunk, voice, wav_path, job=job)
                time.sleep(1.0)  # gentle pacing to ease rate limits
            else:
                _say_chunk_to_wav(chunk, voice, wav_path, os.path.join(tmp, f"c{i}.txt"))
            wavs.append(wav_path)
            job["done"] = i + 1

        job["status"] = "combining"
        combined = os.path.join(tmp, "book.wav")
        with wave.open(wavs[0], "rb") as w0:
            params = w0.getparams()
        with wave.open(combined, "wb") as out:
            out.setparams(params)
            for wv in wavs:
                with wave.open(wv, "rb") as r:
                    out.writeframes(r.readframes(r.getnframes()))

        os.makedirs(BOOK_DIR, exist_ok=True)
        final = os.path.join(BOOK_DIR, _safe_name(name) + ".m4a")
        subprocess.run(
            ["afconvert", "-f", "m4af", "-d", "aac", combined, final],
            check=True, capture_output=True, timeout=900,
        )
        job.update(status="done", path=final, bytes=os.path.getsize(final))
    except subprocess.CalledProcessError as e:
        msg = (e.stderr.decode("utf-8", "ignore") if e.stderr else str(e)) or str(e)
        job.update(status="error", error=msg[:300])
    except Exception as e:
        job.update(status="error", error=_friendly_error(e))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@app.post("/api/tts/book")
def tts_book(req: BookRequest):
    engine = (req.engine or "say").lower()
    if engine not in ("say", "gemini"):
        engine = "say"
    if not SAY_AVAILABLE:
        # afconvert (used to write the .m4a) is macOS-only regardless of engine.
        raise HTTPException(status_code=503, detail="有聲書生成僅在 macOS 上可用。")
    if engine == "gemini" and not get_api_key():
        raise HTTPException(status_code=503, detail="尚未設定 Gemini API 金鑰,請在 app 設定中填入。")

    default_voice = "Kore" if engine == "gemini" else "Samantha"
    _job_counter[0] += 1
    job_id = f"book{_job_counter[0]}"
    JOBS[job_id] = {"status": "running", "done": 0, "total": 0, "path": None, "error": None, "bytes": 0}
    threading.Thread(
        target=_generate_book,
        args=(job_id, req.pages, req.voice or default_voice, req.name, engine),
        daemon=True,
    ).start()
    return {"jobId": job_id}


@app.get("/api/tts/book/{job_id}")
def tts_book_status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return job


# ── Zotero (read-only direct integration) ─────────────────────────────
# We never touch the live DB: we copy it (+WAL) to a temp file and query that,
# and serve attachment PDFs straight from Zotero's storage folder.

ZOTERO_DIR = os.getenv("GR_ZOTERO_DIR", os.path.expanduser("~/Zotero"))
_zt_cache = {"mtime": None, "path": None}


def _zotero_conn():
    src = os.path.join(ZOTERO_DIR, "zotero.sqlite")
    if not os.path.exists(src):
        return None
    mt = os.path.getmtime(src)
    tmp = _zt_cache.get("path")
    if not (tmp and _zt_cache.get("mtime") == mt and os.path.exists(tmp)):
        tmpdir = os.path.join(tempfile.gettempdir(), "gr_zotero")
        os.makedirs(tmpdir, exist_ok=True)
        tmp = os.path.join(tmpdir, "zotero.sqlite")
        shutil.copy2(src, tmp)
        for ext in ("-wal", "-shm"):
            if os.path.exists(src + ext):
                shutil.copy2(src + ext, tmp + ext)
            elif os.path.exists(tmp + ext):
                os.remove(tmp + ext)
        _zt_cache.update(mtime=mt, path=tmp)
    conn = sqlite3.connect(tmp)
    conn.row_factory = sqlite3.Row
    return conn


def _fetch_items(conn, collection_id=None, query=None, limit=3000):
    base = """
        SELECT pi.key AS pkey, pi.itemID AS iid, ai.key AS att_key, ia.path AS path,
          (SELECT idv.value FROM itemData d JOIN fields f ON f.fieldID=d.fieldID AND f.fieldName='title'
             JOIN itemDataValues idv ON idv.valueID=d.valueID WHERE d.itemID=pi.itemID) AS title,
          (SELECT idv.value FROM itemData d JOIN fields f ON f.fieldID=d.fieldID AND f.fieldName='date'
             JOIN itemDataValues idv ON idv.valueID=d.valueID WHERE d.itemID=pi.itemID) AS date
        FROM itemAttachments ia
        JOIN items ai ON ai.itemID = ia.itemID
        JOIN items pi ON pi.itemID = ia.parentItemID
    """
    where = [
        "ia.contentType='application/pdf'",
        "ia.path LIKE 'storage:%'",
        "pi.itemID NOT IN (SELECT itemID FROM deletedItems)",
        "ai.itemID NOT IN (SELECT itemID FROM deletedItems)",
    ]
    params = []
    if collection_id:
        base += " JOIN collectionItems ci ON ci.itemID = pi.itemID "
        where.append("ci.collectionID = ?")
        params.append(collection_id)
    sql = base + " WHERE " + " AND ".join(where) + " ORDER BY title COLLATE NOCASE LIMIT ?"
    params.append(limit)
    rows = conn.execute(sql, params).fetchall()

    # creators for the result set (first author + "et al.")
    ids = [r["iid"] for r in rows]
    creators = {}
    if ids:
        marks = ",".join("?" * len(ids))
        for cr in conn.execute(
            f"""SELECT ic.itemID AS iid, cr.lastName AS ln, cr.firstName AS fn
                FROM itemCreators ic JOIN creators cr ON cr.creatorID = ic.creatorID
                WHERE ic.itemID IN ({marks}) ORDER BY ic.orderIndex""", ids):
            creators.setdefault(cr["iid"], []).append(cr["ln"] or cr["fn"] or "")

    out = []
    ql = (query or "").strip().lower()
    for r in rows:
        names = creators.get(r["iid"], [])
        author = (names[0] + (" et al." if len(names) > 1 else "")) if names else ""
        year = ""
        if r["date"]:
            m = re.search(r"\d{4}", r["date"])
            year = m.group(0) if m else ""
        title = r["title"] or (r["path"][8:] if r["path"] else "(untitled)")
        if ql and ql not in title.lower() and ql not in author.lower():
            continue
        out.append({
            "key": r["pkey"], "attKey": r["att_key"],
            "title": title, "author": author, "year": year,
        })
    return out


@app.get("/api/zotero/status")
def zotero_status():
    conn = _zotero_conn()
    if not conn:
        return {"available": False}
    try:
        nc = conn.execute("SELECT COUNT(*) FROM collections").fetchone()[0]
        ni = conn.execute("SELECT COUNT(*) FROM itemAttachments WHERE contentType='application/pdf'").fetchone()[0]
        return {"available": True, "dataDir": ZOTERO_DIR, "collections": nc, "pdfs": ni}
    finally:
        conn.close()


@app.get("/api/zotero/collections")
def zotero_collections():
    conn = _zotero_conn()
    if not conn:
        raise HTTPException(status_code=503, detail="找不到 Zotero 資料庫。")
    try:
        rows = conn.execute(
            "SELECT collectionID AS id, collectionName AS name, IFNULL(parentCollectionID, 0) AS parent "
            "FROM collections ORDER BY name COLLATE NOCASE"
        ).fetchall()
        return {"collections": [dict(r) for r in rows]}
    finally:
        conn.close()


@app.get("/api/zotero/items")
def zotero_items(collection: Optional[int] = None, q: Optional[str] = None):
    conn = _zotero_conn()
    if not conn:
        raise HTTPException(status_code=503, detail="找不到 Zotero 資料庫。")
    try:
        return {"items": _fetch_items(conn, collection, q)}
    finally:
        conn.close()


@app.get("/api/zotero/file/{att_key}")
def zotero_file(att_key: str):
    if not att_key.isalnum():
        raise HTTPException(status_code=400, detail="bad key")
    folder = os.path.join(ZOTERO_DIR, "storage", att_key)
    if not os.path.isdir(folder):
        raise HTTPException(status_code=404, detail="attachment not found")
    pdf = next((os.path.join(folder, fn) for fn in sorted(os.listdir(folder)) if fn.lower().endswith(".pdf")), None)
    if not pdf:
        raise HTTPException(status_code=404, detail="no pdf in attachment")
    return FileResponse(pdf, media_type="application/pdf")


if __name__ == "__main__":
    # Entry point for the bundled (PyInstaller) backend. The Electron main
    # process spawns this executable and waits for the port to respond.
    import uvicorn

    host = os.getenv("GR_HOST", "127.0.0.1")
    port = int(os.getenv("GR_PORT", "8000"))
    uvicorn.run(app, host=host, port=port, log_level="info")
