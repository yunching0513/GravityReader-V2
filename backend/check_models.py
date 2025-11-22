import google.generativeai as genai
import os
from dotenv import load_dotenv

# 載入您的鑰匙
load_dotenv()
api_key = os.getenv("GOOGLE_API_KEY")

if not api_key:
    print("❌ Error: API Key not found in .env")
else:
    print(f"🔑 Key found: {api_key[:5]}...")
    genai.configure(api_key=api_key)

    print("\n🔍 Scanning available models for your API Key...")
    try:
        found_any = False
        for m in genai.list_models():
            # 我們只列出可以「產生文字」的模型
            if 'generateContent' in m.supported_generation_methods:
                print(f" - {m.name}")
                found_any = True
        
        if not found_any:
            print("⚠️ No models found. This might be a region restriction (EU) or billing issue.")
            print("Tip: Try enabling 'Pay-as-you-go' in Google Cloud Console if you are in the EU.")
            
    except Exception as e:
        print(f"❌ Error listing models: {e}")