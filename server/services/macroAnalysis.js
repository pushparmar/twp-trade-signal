/**
 * Macro analysis — VIX, Crude Oil, Gold, Silver, USDINR.
 * Uses candleStore (live ticks) for real-time data.
 * Shared by both the REST route and macroWatcher (SSE push).
 */

const candleStore      = require('./candleStore');
const instrumentCache  = require('./instrumentCache');
const { getSignals, to4H } = require('./ichimoku');

const VIX_TOKEN = 264969; // NSE:INDIA VIX

// Session-aware 4h synthesis — see ichimoku.js to4H for full explanation.
const _to4H = to4H;

function _sma(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function _analyze(candles, label) {
  if (!candles || candles.length < 5) return null;
  const closes  = candles.map((c) => c.close);
  const current = closes[closes.length - 1];
  const prev    = closes[closes.length - 2];
  const ma10    = _sma(closes, Math.min(10, closes.length));
  const change  = Math.round((current - prev) * 100) / 100;
  const trend   = ma10 == null ? 'flat'
    : current > ma10 * 1.005 ? 'rising'
    : current < ma10 * 0.995 ? 'falling'
    : 'flat';
  return {
    label,
    current: Math.round(current * 100) / 100,
    change,
    trend,
    ma10: ma10 != null ? Math.round(ma10 * 100) / 100 : null,
  };
}

function _vixZone(v) {
  return v < 13 ? 'complacency'
    : v < 16 ? 'calm'
    : v < 20 ? 'normal'
    : v < 25 ? 'elevated'
    : v < 30 ? 'fear'
    : 'extreme';
}

function _ichiSignal(candles) {
  if (candles.length < 26) return { signal: 'neutral', ichi: null };
  const raw = getSignals(candles);
  if (!raw) return { signal: 'neutral', ichi: null };

  const ichi = {
    cloud:  raw.cloudSignal,
    kijun:  raw.kijunSignal,
    chikou: raw.chikouSignal,
    tenkan: raw.tenkanSignal,
  };
  const votes = [ichi.cloud, ichi.kijun, ichi.chikou, ichi.tenkan];
  const bull = votes.filter((v) => v === 'bullish').length;
  const bear = votes.filter((v) => v === 'bearish').length;
  return { signal: bull > bear ? 'bullish' : bear > bull ? 'bearish' : 'neutral', ichi };
}

function _direction(timeframes) {
  const bull = timeframes.filter((t) => t.signal === 'bullish').length;
  const bear = timeframes.filter((t) => t.signal === 'bearish').length;
  return {
    direction:  bull > bear ? 'bullish' : bear > bull ? 'bearish' : 'neutral',
    confidence: timeframes.length ? Math.round((Math.max(bull, bear) / timeframes.length) * 100) : 0,
  };
}

function getFrontMonthFutures(name, exchange) {
  if (!instrumentCache.isLoaded()) return null;
  // Use exact-name lookup — avoids GOLDM/GOLDGUINEA when searching for GOLD
  return instrumentCache.getFrontMonthFuture(name, exchange);
}

async function _analyzeVix() {
  const tfs = [];

  const c15m = await candleStore.getCandles(VIX_TOKEN, '15minute');
  const a15m = _analyze(c15m, '15m');
  if (a15m) {
    const { signal, ichi } = _ichiSignal(c15m);
    tfs.push({ key: '15m', ...a15m, signal, ichi, zone: _vixZone(a15m.current) });
  }

  const c1h = await candleStore.getCandles(VIX_TOKEN, '60minute');
  const a1h = _analyze(c1h, '1h');
  if (a1h) {
    const { signal, ichi } = _ichiSignal(c1h);
    tfs.push({ key: '1h', ...a1h, signal, ichi, zone: _vixZone(a1h.current) });
  }

  if (c1h && c1h.length >= 8) {
    const c4h = _to4H(c1h);
    const a4h = _analyze(c4h, '4h');
    if (a4h) {
      const { signal, ichi } = _ichiSignal(c4h);
      tfs.push({ key: '4h', ...a4h, signal, ichi, zone: _vixZone(a4h.current) });
    }
  }

  const c1d = await candleStore.getCandles(VIX_TOKEN, 'day');
  const a1d = _analyze(c1d, '1d');
  if (a1d) {
    const { signal, ichi } = _ichiSignal(c1d);
    tfs.push({ key: '1d', ...a1d, signal, ichi, zone: _vixZone(a1d.current) });
  }

  return {
    ...(_direction(tfs)),
    instrumentToken: VIX_TOKEN,
    currentVix: (a1d || a1h || a15m)?.current ?? null,
    timeframes:  tfs,
  };
}

async function _analyzeCrude() {
  const inst = getFrontMonthFutures('CRUDEOIL', 'MCX');
  if (!inst) return { error: 'Instrument cache not loaded or CRUDEOIL not found on MCX', timeframes: [] };

  const tfs = [];

  const c15m = await candleStore.getCandles(inst.instrumentToken, '15minute');
  const a15m = _analyze(c15m, '15m');
  if (a15m) {
    const { signal, ichi } = _ichiSignal(c15m);
    tfs.push({ key: '15m', ...a15m, signal, ichi });
  }

  const c1h = await candleStore.getCandles(inst.instrumentToken, '60minute');
  const a1h = _analyze(c1h, '1h');
  if (a1h) {
    const { signal, ichi } = _ichiSignal(c1h);
    tfs.push({ key: '1h', ...a1h, signal, ichi });
  }

  if (c1h && c1h.length >= 8) {
    const c4h = _to4H(c1h);
    const a4h = _analyze(c4h, '4h');
    if (a4h) {
      const { signal, ichi } = _ichiSignal(c4h);
      tfs.push({ key: '4h', ...a4h, signal, ichi });
    }
  }

  const c1d = await candleStore.getCandles(inst.instrumentToken, 'day');
  const a1d = _analyze(c1d, '1d');
  if (a1d) {
    const { signal, ichi } = _ichiSignal(c1d);
    tfs.push({ key: '1d', ...a1d, signal, ichi });
  }

  return {
    ...(_direction(tfs)),
    instrumentToken: inst.instrumentToken,
    currentPrice:    (a1d || a1h || a15m)?.current ?? null,
    tradingsymbol:   inst.tradingsymbol,
    expiry:          inst.expiry,
    timeframes:      tfs,
  };
}

async function _analyzeGold() {
  const inst = getFrontMonthFutures('GOLD', 'MCX');
  if (!inst) return { error: 'Instrument cache not loaded or GOLD not found on MCX', timeframes: [] };

  const tfs = [];

  const c15m = await candleStore.getCandles(inst.instrumentToken, '15minute');
  const a15m = _analyze(c15m, '15m');
  if (a15m) {
    const { signal, ichi } = _ichiSignal(c15m);
    tfs.push({ key: '15m', ...a15m, signal, ichi });
  }

  const c1h = await candleStore.getCandles(inst.instrumentToken, '60minute');
  const a1h = _analyze(c1h, '1h');
  if (a1h) {
    const { signal, ichi } = _ichiSignal(c1h);
    tfs.push({ key: '1h', ...a1h, signal, ichi });
  }

  if (c1h && c1h.length >= 8) {
    const c4h = _to4H(c1h);
    const a4h = _analyze(c4h, '4h');
    if (a4h) {
      const { signal, ichi } = _ichiSignal(c4h);
      tfs.push({ key: '4h', ...a4h, signal, ichi });
    }
  }

  const c1d = await candleStore.getCandles(inst.instrumentToken, 'day');
  const a1d = _analyze(c1d, '1d');
  if (a1d) {
    const { signal, ichi } = _ichiSignal(c1d);
    tfs.push({ key: '1d', ...a1d, signal, ichi });
  }

  return {
    ...(_direction(tfs)),
    instrumentToken: inst.instrumentToken,
    currentPrice:    (a1d || a1h || a15m)?.current ?? null,
    tradingsymbol:   inst.tradingsymbol,
    expiry:          inst.expiry,
    timeframes:      tfs,
  };
}

async function _analyzeSilver() {
  const inst = getFrontMonthFutures('SILVER', 'MCX');
  if (!inst) return { error: 'Instrument cache not loaded or SILVER not found on MCX', timeframes: [] };

  const tfs = [];

  const c15m = await candleStore.getCandles(inst.instrumentToken, '15minute');
  const a15m = _analyze(c15m, '15m');
  if (a15m) {
    const { signal, ichi } = _ichiSignal(c15m);
    tfs.push({ key: '15m', ...a15m, signal, ichi });
  }

  const c1h = await candleStore.getCandles(inst.instrumentToken, '60minute');
  const a1h = _analyze(c1h, '1h');
  if (a1h) {
    const { signal, ichi } = _ichiSignal(c1h);
    tfs.push({ key: '1h', ...a1h, signal, ichi });
  }

  if (c1h && c1h.length >= 8) {
    const c4h = _to4H(c1h);
    const a4h = _analyze(c4h, '4h');
    if (a4h) {
      const { signal, ichi } = _ichiSignal(c4h);
      tfs.push({ key: '4h', ...a4h, signal, ichi });
    }
  }

  const c1d = await candleStore.getCandles(inst.instrumentToken, 'day');
  const a1d = _analyze(c1d, '1d');
  if (a1d) {
    const { signal, ichi } = _ichiSignal(c1d);
    tfs.push({ key: '1d', ...a1d, signal, ichi });
  }

  return {
    ...(_direction(tfs)),
    instrumentToken: inst.instrumentToken,
    currentPrice:    (a1d || a1h || a15m)?.current ?? null,
    tradingsymbol:   inst.tradingsymbol,
    expiry:          inst.expiry,
    timeframes:      tfs,
  };
}

async function _analyzeNaturalgas() {
  const inst = getFrontMonthFutures('NATURALGAS', 'MCX');
  if (!inst) return { error: 'Instrument cache not loaded or NATURALGAS not found on MCX', timeframes: [] };

  const tfs = [];

  const c15m = await candleStore.getCandles(inst.instrumentToken, '15minute');
  const a15m = _analyze(c15m, '15m');
  if (a15m) {
    const { signal, ichi } = _ichiSignal(c15m);
    tfs.push({ key: '15m', ...a15m, signal, ichi });
  }

  const c1h = await candleStore.getCandles(inst.instrumentToken, '60minute');
  const a1h = _analyze(c1h, '1h');
  if (a1h) {
    const { signal, ichi } = _ichiSignal(c1h);
    tfs.push({ key: '1h', ...a1h, signal, ichi });
  }

  if (c1h && c1h.length >= 8) {
    const c4h = _to4H(c1h);
    const a4h = _analyze(c4h, '4h');
    if (a4h) {
      const { signal, ichi } = _ichiSignal(c4h);
      tfs.push({ key: '4h', ...a4h, signal, ichi });
    }
  }

  const c1d = await candleStore.getCandles(inst.instrumentToken, 'day');
  const a1d = _analyze(c1d, '1d');
  if (a1d) {
    const { signal, ichi } = _ichiSignal(c1d);
    tfs.push({ key: '1d', ...a1d, signal, ichi });
  }

  return {
    ...(_direction(tfs)),
    instrumentToken: inst.instrumentToken,
    currentPrice:    (a1d || a1h || a15m)?.current ?? null,
    tradingsymbol:   inst.tradingsymbol,
    expiry:          inst.expiry,
    timeframes:      tfs,
  };
}

async function _analyzeUsdinr() {
  const inst = getFrontMonthFutures('USDINR', 'CDS');
  if (!inst) return { error: 'Instrument cache not loaded or USDINR not found on CDS', timeframes: [] };

  const tfs = [];

  const c15m = await candleStore.getCandles(inst.instrumentToken, '15minute');
  const a15m = _analyze(c15m, '15m');
  if (a15m) {
    const { signal, ichi } = _ichiSignal(c15m);
    tfs.push({ key: '15m', ...a15m, signal, ichi });
  }

  const c1h = await candleStore.getCandles(inst.instrumentToken, '60minute');
  const a1h = _analyze(c1h, '1h');
  if (a1h) {
    const { signal, ichi } = _ichiSignal(c1h);
    tfs.push({ key: '1h', ...a1h, signal, ichi });
  }

  if (c1h && c1h.length >= 8) {
    const c4h = _to4H(c1h);
    const a4h = _analyze(c4h, '4h');
    if (a4h) {
      const { signal, ichi } = _ichiSignal(c4h);
      tfs.push({ key: '4h', ...a4h, signal, ichi });
    }
  }

  const c1d = await candleStore.getCandles(inst.instrumentToken, 'day');
  const a1d = _analyze(c1d, '1d');
  if (a1d) {
    const { signal, ichi } = _ichiSignal(c1d);
    tfs.push({ key: '1d', ...a1d, signal, ichi });
  }

  return {
    ...(_direction(tfs)),
    instrumentToken: inst.instrumentToken,
    currentPrice:    (a1d || a1h || a15m)?.current ?? null,
    tradingsymbol:   inst.tradingsymbol,
    expiry:          inst.expiry,
    timeframes:      tfs,
  };
}

async function analyze() {
  // allSettled — one instrument's historical-API failure (e.g. user has no MCX
  // segment access) shouldn't kill the entire macro response.
  const results = await Promise.allSettled([
    _analyzeVix(), _analyzeCrude(), _analyzeGold(), _analyzeSilver(), _analyzeUsdinr(), _analyzeNaturalgas(),
  ]);
  const [vixR, crudeR, goldR, silverR, usdinrR, naturalgasR] = results;
  const unwrap = (r, label) => {
    if (r.status === 'fulfilled') return r.value;
    console.warn(`[MacroAnalysis] ${label} failed:`, r.reason?.message || r.reason);
    return { error: r.reason?.message || String(r.reason), timeframes: [] };
  };
  return {
    vix:         unwrap(vixR,         'VIX'),
    crude:       unwrap(crudeR,       'Crude'),
    gold:        unwrap(goldR,        'Gold'),
    silver:      unwrap(silverR,      'Silver'),
    usdinr:      unwrap(usdinrR,      'USDINR'),
    naturalgas:  unwrap(naturalgasR,  'NaturalGas'),
  };
}

module.exports = { analyze, VIX_TOKEN, getFrontMonthFutures };
