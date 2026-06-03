#!/usr/bin/env bash
# Build the standalone GravityReader backend with PyInstaller (onedir).
# Output: backend/dist/GravityReaderBackend/
set -euo pipefail
cd "$(dirname "$0")"
source venv/bin/activate

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
