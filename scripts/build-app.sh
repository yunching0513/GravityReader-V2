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

echo "▸ [1/5] Building frontend…"
if [ "${SKIP_FRONTEND:-0}" != "1" ]; then
  ( cd frontend && npm run build )
fi

echo "▸ [2/5] Copying renderer into Electron app…"
rm -rf desktop/renderer
cp -R frontend/dist desktop/renderer

echo "▸ [3/5] Building standalone backend (PyInstaller)…"
if [ "${SKIP_BACKEND:-0}" != "1" ]; then
  ( cd backend && ./build_backend.sh )
fi

echo "▸ [4/5] Bundling backend + .env…"
if [ ! -f backend/.env ]; then
  echo "  ⚠️  backend/.env not found — the app will have no Google API key."
else
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
