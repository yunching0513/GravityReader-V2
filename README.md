# GravityReader V2

A full-stack application with FastAPI backend and React (Vite) frontend for PDF reading and AI analysis.

## Structure
- `backend/`: FastAPI application
- `frontend/`: React application

## Setup

### Backend
1. `cd backend`
2. `pip install -r requirements.txt`
3. `cp .env.example .env` (Add your GOOGLE_API_KEY)
4. `uvicorn main:app --reload`

### Frontend
1. `cd frontend`
2. `npm install`
3. `npm run dev`

## Features
- Split-view PDF Reader
- Text selection triggers Gemini 1.5 Flash analysis
- Cyberpunk/Antigravity theme
