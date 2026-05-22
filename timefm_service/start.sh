#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# timefm_service/start.sh
#
# Starts the TimeFM FastAPI microservice in a local Python virtualenv.
# Safe to run multiple times — skips venv creation and pip install when
# everything is already in place.
#
# Usage:
#   bash timefm_service/start.sh          # from project root
#   ./start.sh                            # from inside timefm_service/
#
# Environment overrides:
#   PORT=5050           Override listen port (default: 5050)
#   TIMEFM_BACKEND=cpu  Force CPU inference (default: cpu)
#                       Set to "gpu" if you have a CUDA-capable GPU.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Resolve the directory this script lives in, regardless of where it is called from
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
REQUIREMENTS="$SCRIPT_DIR/requirements.txt"

echo ""
echo "┌─────────────────────────────────────────┐"
echo "│  TimeFM local service                   │"
echo "│  Forecast microservice for the chart UI │"
echo "└─────────────────────────────────────────┘"
echo ""

# ── 1. Verify Python 3.9+ is available ───────────────────────────────────────
PYTHON_BIN="${PYTHON_BIN:-python3}"

if ! command -v "$PYTHON_BIN" &>/dev/null; then
    echo "✗  python3 not found. Install Python 3.9+ and re-run."
    exit 1
fi

PY_VERSION=$("$PYTHON_BIN" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PY_MAJOR=$(echo "$PY_VERSION" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VERSION" | cut -d. -f2)

if [[ "$PY_MAJOR" -lt 3 || ( "$PY_MAJOR" -eq 3 && "$PY_MINOR" -lt 9 ) ]]; then
    echo "✗  Python $PY_VERSION found, but 3.9+ is required."
    echo "   Set PYTHON_BIN=/path/to/python3.11 to override."
    exit 1
fi

echo "✓  Python $PY_VERSION ($PYTHON_BIN)"

# ── 2. Create virtualenv if missing ──────────────────────────────────────────
if [[ ! -d "$VENV_DIR" ]]; then
    echo "→  Creating virtualenv at $VENV_DIR …"
    "$PYTHON_BIN" -m venv "$VENV_DIR"
    echo "✓  Virtualenv created"
else
    echo "✓  Virtualenv exists ($VENV_DIR)"
fi

# Activate
# shellcheck source=/dev/null
source "$VENV_DIR/bin/activate"

# ── 3. Install / sync dependencies ───────────────────────────────────────────
# Use a stamp file so we only re-run pip when requirements.txt changes.
STAMP_FILE="$VENV_DIR/.pip_stamp"
REQS_HASH=$(md5 -q "$REQUIREMENTS" 2>/dev/null || md5sum "$REQUIREMENTS" 2>/dev/null | awk '{print $1}')

if [[ ! -f "$STAMP_FILE" || "$(cat "$STAMP_FILE")" != "$REQS_HASH" ]]; then
    echo "→  Installing dependencies (this may take a while on first run) …"
    pip install --quiet --upgrade pip
    pip install --quiet --timeout 120 --retries 5 -r "$REQUIREMENTS"
    echo "$REQS_HASH" > "$STAMP_FILE"
    echo "✓  Dependencies installed"
else
    echo "✓  Dependencies up-to-date (requirements.txt unchanged)"
fi

# ── 4. Launch the service ─────────────────────────────────────────────────────
PORT="${PORT:-5050}"
TIMEFM_BACKEND="${TIMEFM_BACKEND:-cpu}"

echo ""
echo "→  Starting TimeFM service on port $PORT (backend=$TIMEFM_BACKEND)"
echo "   First inference downloads ~800 MB model weights to ~/.cache/huggingface"
echo "   Subsequent starts reuse the cache — no re-download."
echo "   Press Ctrl+C to stop."
echo ""

cd "$SCRIPT_DIR"
PORT="$PORT" TIMEFM_BACKEND="$TIMEFM_BACKEND" python main.py
