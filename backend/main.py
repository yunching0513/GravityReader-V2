import os
import sys
import io
import wave
import json
import base64
import logging
import urllib.request
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
    return {"gemini": GEMINI_VOICES}


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


if __name__ == "__main__":
    # Entry point for the bundled (PyInstaller) backend. The Electron main
    # process spawns this executable and waits for the port to respond.
    import uvicorn

    host = os.getenv("GR_HOST", "127.0.0.1")
    port = int(os.getenv("GR_PORT", "8000"))
    uvicorn.run(app, host=host, port=port, log_level="info")
