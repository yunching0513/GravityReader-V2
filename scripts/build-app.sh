#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
# Build the GravityReader macOS app (.app + .dmg).
#
#   1. Build the React frontend            -> frontend/dist
#   2. Copy it into the Electron app       -> desktop/renderer
#   3. Build the standalone Python backend -> backend/dist/GravityReaderBackend
#   4. Bundle backend + .env into Electron -> desktop/backend
#   5. Package with electron-builder       -> desktop/release/*.dmg
#
# Env toggles:
#   SKIP_BACKEND=1   reuse an existing backend build (skip slow PyInstaller)
#   SKIP_FRONTEND=1  reuse an existing frontend build
# ════════════════════════════════════════════════════════════════════
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "✗ This builds the macOS app and must run on a Mac." >&2
  echo "  For a Windows installer use the 'Build Windows' GitHub Action." >&2
  exit 1
fi

echo "▸ [1/5] Building frontend…"
if [ "${SKIP_FRONTEND:-0}" != "1" ]; then
  (
    cd frontend
    [ -d node_modules ] || npm install
    npm run build
  )
fi

echo "▸ [2/5] Copying renderer into Electron app…"
rm -rf desktop/renderer
cp -R frontend/dist desktop/renderer

echo "▸ [3/5] Building standalone backend (PyInstaller)…"
if [ "${SKIP_BACKEND:-0}" != "1" ]; then
  ( cd backend && ./build_backend.sh )
fi

echo "▸ [4/5] Bundling backend…"
# Keyless by default — users enter their own Gemini key in the app (stored in
# ~/.gravityreader/config.json). Set BUNDLE_KEY=1 to bake backend/.env in for a
# personal build (do NOT share such a build — it contains your key).
rm -f "backend/dist/GravityReaderBackend/.env"
if [ "${BUNDLE_KEY:-0}" = "1" ] && [ -f backend/.env ]; then
  echo "  ⚠️  BUNDLE_KEY=1 — baking backend/.env into the app (personal build, do not share)."
  cp backend/.env "backend/dist/GravityReaderBackend/.env"
fi
rm -rf desktop/backend
mkdir -p desktop/backend
cp -R backend/dist/GravityReaderBackend desktop/backend/GravityReaderBackend

echo "▸ [5/5] Packaging with electron-builder…"
cd desktop
if [ ! -d node_modules ]; then
  npm install
fi
npm run dist

echo ""
echo "✅ Done. Artifacts in desktop/release/:"
ls -1 release/*.dmg release/*.zip 2>/dev/null || true
echo ""
echo "To install: open the .dmg and drag「Yun's Reader」to Applications, then run"
echo "  xattr -dr com.apple.quarantine \"/Applications/Yun's Reader.app\""
echo "(the app is ad-hoc signed, not notarized, so Gatekeeper quarantines it)"
