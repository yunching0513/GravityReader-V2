#!/usr/bin/env bash
# Build the standalone GravityReader backend with PyInstaller (onedir).
# Output: backend/dist/GravityReaderBackend/
#
# Creates backend/venv and installs the dependencies on first run, so this works
# from a fresh clone with nothing but Python 3 installed.
set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"

if [ ! -d venv ]; then
  echo "▸ Creating backend/venv…"
  "$PY" -m venv venv
fi

source venv/bin/activate

# Cheap to re-check, and it keeps a stale venv from silently building a backend
# that's missing a dependency added since the venv was made.
echo "▸ Installing backend dependencies…"
python -m pip install --upgrade pip --quiet
python -m pip install -r requirements.txt --quiet
python -m pip install pyinstaller --quiet

pyinstaller --noconfirm --clean --name GravityReaderBackend \
  --collect-all google.generativeai \
  --collect-all google.ai.generativelanguage \
  --collect-all google.api_core \
  --collect-all google.auth \
  --collect-all grpc \
  --collect-all grpc_status \
  --collect-all uvicorn \
  --collect-submodules google \
  main.py

echo "✅ Backend built at backend/dist/GravityReaderBackend/"
