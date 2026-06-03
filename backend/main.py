import os
import sys
import io
import wave
import json
import base64
import shutil
import logging
import tempfile
import threading
import subprocess
import urllib.request
from typing import List
from fastapi import FastAPI, HTTPException, Response
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

# Configure Gemini
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
if not GOOGLE_API_KEY:
    logger.warning("GOOGLE_API_KEY not found in environment variables.")
else:
    genai.configure(api_key=GOOGLE_API_KEY)

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

    try:
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

    try:
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
        f"{GEMINI_TTS_MODEL}:generateContent?key={GOOGLE_API_KEY}"
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
    if not GOOGLE_API_KEY:
        raise HTTPException(status_code=503, detail="GOOGLE_API_KEY not configured")
    try:
        wav = _gemini_tts(text, req.voice)
        return Response(content=wav, media_type="audio/wav")
    except Exception as e:
        logger.error(f"TTS error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Whole-book offline audiobook (macOS `say`) ────────────────────────

class BookRequest(BaseModel):
    pages: List[str] = []
    voice: str = "Samantha"
    name: str = "audiobook"


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


def _generate_book(job_id, pages, voice, name):
    job = JOBS[job_id]
    tmp = tempfile.mkdtemp(prefix="gr_book_")
    try:
        chunks = _chunk_pages(pages)
        job["total"] = len(chunks)
        if not chunks:
            job.update(status="error", error="這份文件沒有可朗讀的文字。")
            return

        wavs = []
        for i, chunk in enumerate(chunks):
            if job.get("cancel"):
                job.update(status="error", error="已取消")
                return
            txt_path = os.path.join(tmp, f"c{i}.txt")
            wav_path = os.path.join(tmp, f"c{i}.wav")
            with open(txt_path, "w", encoding="utf-8") as f:
                f.write(chunk)
            subprocess.run(
                ["say", "-v", voice, "-o", wav_path,
                 "--file-format=WAVE", "--data-format=LEI16@22050", "-f", txt_path],
                check=True, capture_output=True, timeout=900,
            )
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
        job.update(status="error", error=str(e)[:300])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@app.post("/api/tts/book")
def tts_book(req: BookRequest):
    if not SAY_AVAILABLE:
        raise HTTPException(status_code=503, detail="離線有聲書生成僅在 macOS 上可用。")
    _job_counter[0] += 1
    job_id = f"book{_job_counter[0]}"
    JOBS[job_id] = {"status": "running", "done": 0, "total": 0, "path": None, "error": None, "bytes": 0}
    threading.Thread(
        target=_generate_book,
        args=(job_id, req.pages, req.voice or "Samantha", req.name),
        daemon=True,
    ).start()
    return {"jobId": job_id}


@app.get("/api/tts/book/{job_id}")
def tts_book_status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return job


if __name__ == "__main__":
    # Entry point for the bundled (PyInstaller) backend. The Electron main
    # process spawns this executable and waits for the port to respond.
    import uvicorn

    host = os.getenv("GR_HOST", "127.0.0.1")
    port = int(os.getenv("GR_PORT", "8000"))
    uvicorn.run(app, host=host, port=port, log_level="info")
