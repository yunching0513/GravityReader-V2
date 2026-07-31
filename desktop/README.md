# GravityReader · Desktop (macOS)

Packages the React UI **and** the Python (FastAPI + Gemini) backend into one
double-clickable `.app`, using Electron + PyInstaller. Builds for both Apple
silicon (arm64) and Intel (x64).

## Install (no toolchain needed)

If you just want to run the app on your Mac, let GitHub build it:

1. **Actions** → **Build macOS** → **Run workflow**.
2. When it finishes, open the run and download the artifact for your Mac:
   - `YunsReader-macOS-arm64` — Apple silicon (M1/M2/M3/M4)
   - `YunsReader-macOS-x64` — Intel
   (Not sure which? `uname -m` → `arm64` or `x86_64`.)
3. Unzip it, open the `.dmg`, drag **Yun's Reader** to **Applications**.
4. **Clear the quarantine flag** — the app is ad-hoc signed but *not notarized*
   (that needs a paid Apple Developer account), so macOS blocks it on first
   open:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Yun's Reader.app"
   ```

   Then open it normally. Without this you'll get *"Yun's Reader is damaged and
   can't be opened"* or *"cannot be opened because the developer cannot be
   verified"* — that message is Gatekeeper, not a broken build. (On macOS 15+
   right-click → Open is no longer a reliable substitute for the `xattr`
   command.)
5. First launch takes ~10–20 s while the bundled backend warms up.
6. Open the sidebar → **05 API 金鑰** and paste a Gemini key (free, from
   <https://aistudio.google.com/app/apikey>). Reading, highlighting and the
   library work without one; translation, read-aloud and summaries need it.

Pushing a `v*` tag builds both architectures automatically.

## Build it yourself

On a Mac, from the repo root. You need Python 3 and Node 20 — the script creates
`backend/venv` and installs everything else itself:

```bash
./scripts/build-app.sh
```

It builds for the architecture of the Mac you run it on.

This will:

1. `vite build` the frontend → `frontend/dist`
2. Copy it into the app → `desktop/renderer`
3. Bundle the backend with PyInstaller → `backend/dist/GravityReaderBackend`
4. Copy the backend + `backend/.env` into the app → `desktop/backend`
5. Package with electron-builder → **`desktop/release/`**

Output in `desktop/release/`:

- `Yun's Reader-2.0.0-<arch>.dmg` — drag-to-install image
- `Yun's Reader-2.0.0-<arch>-mac.zip` — zipped `.app`

Install the `.dmg` as in **Install** above, including the `xattr` step.

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

The translation/summary/read-aloud features call **Google Gemini**. Builds are
**keyless by default**: you paste your own key into the app (sidebar →
**05 API 金鑰**) and it's stored in `~/.gravityreader/config.json`, never in the
app bundle. Get a free key at <https://aistudio.google.com/app/apikey>.

The UI (PDF reading, highlighting, notes, library) works without a key.

For a *personal* build with the key baked in, put `GOOGLE_API_KEY=...` in
`backend/.env` and build with `BUNDLE_KEY=1 ./scripts/build-app.sh`. Don't share
such a build — it contains your key.

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
Any Mac that didn't build it — including your own, when you download the CI
artifact — will quarantine it on first open:

```bash
xattr -dr com.apple.quarantine "/Applications/Yun's Reader.app"
```

For friction-free distribution (no `xattr` step for your users) you'd need a
paid Apple Developer ID plus notarization.

## Icon

`build/icon.icns` is generated from `build/icon-source.html` (rendered to PNG,
then `iconutil`). electron-builder picks it up automatically from `build/`.
