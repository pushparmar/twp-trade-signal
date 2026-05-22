"""
TimeFM forecast microservice.

Wraps Google's TimesFM-1.0-200M (PyTorch backend) in a FastAPI service so the
Node.js server can call it via HTTP without needing Python in the main process.

The model is loaded ONCE on startup and stays warm in memory.  All subsequent
forecast requests are pure in-memory inference — no disk reads, no re-loading.

─── Quick start ──────────────────────────────────────────────────────────────
    npm run timefm          # from project root (handles venv + deps)
    # or manually:
    cd timefm_service
    pip install -r requirements.txt
    python main.py          # listens on :5050

─── Environment ──────────────────────────────────────────────────────────────
    PORT=5050           Override the listen port (default: 5050)
    TIMEFM_BACKEND=cpu  Force CPU inference (default: cpu).

─── Endpoints ────────────────────────────────────────────────────────────────
    GET  /health       → { status, modelLoaded, inferenceMs (last call) }
    POST /forecast     → { direction, pctMove, point, q10, q90, lastClose, horizon }
"""

import os
import time
from contextlib import asynccontextmanager
from typing import List

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import timesfm

# ── Model hyper-parameters (TimesFM 1.0 / 200M PyTorch) ──────────────────────
CONTEXT_LEN  = 512    # max context the model was trained on
HORIZON_LEN  = 32     # maximum horizon we will ever return
INPUT_PATCH  = 32
OUTPUT_PATCH = 128
NUM_LAYERS   = 20
MODEL_DIMS   = 1280
# PyTorch checkpoint — different repo from the JAX version
REPO_ID      = "google/timesfm-1.0-200m-pytorch"

# Singleton model — loaded once, shared across all requests.
_model: timesfm.TimesFm | None = None
_last_inference_ms: float = 0.0


# ── Lifespan: load model on startup (replaces deprecated @on_event) ───────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load the TimeFM checkpoint from HuggingFace Hub on service startup.

    First call downloads ~800 MB and caches them in ~/.cache/huggingface.
    Subsequent starts skip the download and reuse the cached weights.
    """
    global _model

    backend = os.environ.get("TIMEFM_BACKEND", "cpu")
    print(f"[TimeFM] Loading {REPO_ID} (backend={backend}) …")

    # timesfm ≥1.2 uses TimesFmHparams + TimesFmCheckpoint instead of
    # passing kwargs directly to TimesFm().
    _model = timesfm.TimesFm(
        hparams=timesfm.TimesFmHparams(
            context_len=CONTEXT_LEN,
            horizon_len=HORIZON_LEN,
            input_patch_len=INPUT_PATCH,
            output_patch_len=OUTPUT_PATCH,
            num_layers=NUM_LAYERS,
            model_dims=MODEL_DIMS,
            backend=backend,
        ),
        checkpoint=timesfm.TimesFmCheckpoint(
            huggingface_repo_id=REPO_ID,
        ),
    )
    print("[TimeFM] Model ready — listening for forecast requests.")

    yield  # service is live here

    # Teardown (nothing needed — model is GC'd on process exit)
    _model = None


# ── FastAPI app ────────────────────────────────────────────────────────────────

app = FastAPI(
    title="TimeFM Forecast Service",
    description="Wraps Google TimeFM-1.0-200M-PyTorch for the Ichimoku trading dashboard.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request / Response schemas ─────────────────────────────────────────────────

class ForecastRequest(BaseModel):
    """Body sent by the Node.js proxy endpoint."""

    closes: List[float] = Field(
        ...,
        description="Historical close prices, oldest first (last N bars).",
        min_length=20,
    )
    horizon: int = Field(
        default=10,
        ge=1,
        le=32,
        description="Number of future bars to predict (capped at 32).",
    )


class ForecastResponse(BaseModel):
    direction:   str          # 'bullish' | 'bearish'
    pctMove:     float        # predicted % change from last close to last forecast bar
    point:       List[float]  # point-forecast values for each horizon bar
    q10:         List[float]  # 10th-percentile (lower confidence bound)
    q90:         List[float]  # 90th-percentile (upper confidence bound)
    lastClose:   float        # last close used as forecast anchor
    horizon:     int          # actual horizon returned (≤ requested)
    inferenceMs: float        # server-side inference time in ms


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.get("/health")
def health() -> dict:
    """Liveness + readiness check.  Node.js polls this to know if the model
    is loaded before showing the Forecast button."""
    return {
        "status":          "ok",
        "modelLoaded":     _model is not None,
        "lastInferenceMs": _last_inference_ms,
    }


@app.post("/forecast", response_model=ForecastResponse)
def forecast(req: ForecastRequest) -> ForecastResponse:
    """Run TimeFM inference on a single univariate close-price series.

    The Node.js proxy sends the last 128 close prices for the instrument + TF.
    Context is capped to CONTEXT_LEN internally so the model is never asked
    to handle more than it was trained on.

    Frequency code 0 = high-frequency (intraday / daily) — correct for both
    intraday and daily bars on Indian equity/commodity markets.
    """
    global _last_inference_ms

    if _model is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet.")

    closes = np.array(req.closes, dtype=np.float32)
    # Use the most-recent CONTEXT_LEN bars; drop the oldest if series is longer.
    ctx = closes[-CONTEXT_LEN:]

    t0 = time.perf_counter()
    point_fc, quantile_fc = _model.forecast(
        [ctx],
        freq=[0],   # 0 = high-frequency / intraday
    )
    _last_inference_ms = round((time.perf_counter() - t0) * 1000, 1)

    horizon = min(req.horizon, HORIZON_LEN)
    point   = point_fc[0, :horizon].tolist()
    q10     = quantile_fc[0, :horizon, 1].tolist()    # 10th-percentile column
    q90     = quantile_fc[0, :horizon, -2].tolist()   # 90th-percentile column

    last_close = float(closes[-1])
    # Guard against zero close (should never happen for real equity prices)
    pct_move   = round((point[-1] - last_close) / last_close * 100, 3) if last_close else 0.0
    direction  = "bullish" if point[-1] > last_close else "bearish"

    return ForecastResponse(
        direction   = direction,
        pctMove     = pct_move,
        point       = point,
        q10         = q10,
        q90         = q90,
        lastClose   = last_close,
        horizon     = horizon,
        inferenceMs = _last_inference_ms,
    )


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5050))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
