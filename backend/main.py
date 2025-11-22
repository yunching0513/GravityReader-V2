import os
import logging
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import google.generativeai as genai
from dotenv import load_dotenv

# Load environment variables
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
        model = genai.GenerativeModel('models/gemini-2.0-flash')
        
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
        model = genai.GenerativeModel('models/gemini-2.0-flash')
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
