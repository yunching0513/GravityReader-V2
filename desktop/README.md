# GravityReader · Desktop (macOS)

Packages the React UI **and** the Python (FastAPI + Gemini) backend into one
double-clickable `.app`, using Electron + PyInstaller. Apple-silicon (arm64).

## Build

From the repo root:

```bash
./scripts/build-app.sh
```

This will:

1. `vite build` the frontend → `frontend/dist`
2. Copy it into the app → `desktop/renderer`
3. Bundle the backend with PyInstaller → `backend/dist/GravityReaderBackend`
4. Copy the backend + `backend/.env` into the app → `desktop/backend`
5. Package with electron-builder → **`desktop/release/`**

Output:

- `desktop/release/GravityReader-2.0.0-arm64.dmg` — drag-to-install image
- `desktop/release/GravityReader-2.0.0-arm64-mac.zip` — zipped `.app`

Faster rebuilds (reuse the slow PyInstaller / vite steps):

```bash
SKIP_BACKEND=1 ./scripts/build-app.sh     # reuse backend build
SKIP_BACKEND=1 SKIP_FRONTEND=1 ./scripts/build-app.sh   # only repackage
```

## How it runs

- `desktop/main.js` (Electron main) spawns the bundled backend on
  `127.0.0.1:8000`, shows `loading.html` while it warms up (cold start ~10–20 s),
  then loads the built UI. The backend is killed when the app quits.
- The backend reads its `GOOGLE_API_KEY` from a `.env` shipped next to the
  executable inside the app bundle.

## Google API key & model

The translation/summary features call **Google Gemini**. The build bundles
`backend/.env`, which must contain `GOOGLE_API_KEY=...` (get one at
<https://aistudio.google.com/app/apikey>). The UI (PDF reading, highlighting,
library) works without a key; only analyze/summarize need it.

The backend uses `models/gemini-flash-latest` by default — a stable alias, so a
retired model version won't break the app. Override with `GEMINI_MODEL` in
`backend/.env` if you want a specific model (e.g. `models/gemini-2.5-flash`).

## Dev mode (no packaging)

```bash
cd frontend && npm run dev          # UI on :5173
cd desktop  && npm install
GR_DEV_URL=http://localhost:5173 npm start
```

`npm start` still spawns the bundled backend from `desktop/backend/`, so run a
full `build-app.sh` once first (or point it at a running backend on :8000).

## Distribution note

The app is **ad-hoc signed**, not notarized (no Apple Developer account needed).
On first open on another Mac, Gatekeeper will warn — right-click → **Open**, or
`xattr -dr com.apple.quarantine /Applications/GravityReader.app`. For
friction-free distribution you'd need an Apple Developer ID + notarization.

## Icon

`build/icon.icns` is generated from `build/icon-source.html` (rendered to PNG,
then `iconutil`). electron-builder picks it up automatically from `build/`.
