import { useState, useMemo, useEffect, useCallback } from 'react';
import useAppStore from '../../store/appStore';
import api from '../../api';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function relativeTime(ts) {
  if (!ts) return '—';
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60)   return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

// ── Score dots ────────────────────────────────────────────────────────────────

function ScoreDots({ score, signal }) {
  if (score == null) return <span className="scan-score-na">—</span>;
  const total  = 5;
  const filled = Math.max(0, Math.min(total, Math.round(score)));
  const colorClass = signal === 'bullish' ? 'scan-dot--bull' : 'scan-dot--bear';
  return (
    <span className="scan-score-dots">
      {Array.from({ length: total }).map((_, i) => (
        <span key={i} className={`scan-dot ${i < filled ? colorClass : 'scan-dot--empty'}`} />
      ))}
      <span className="scan-score-num">{score}/5</span>
    </span>
  );
}

// ── Strength badge ────────────────────────────────────────────────────────────

const STRENGTH_META = {
  strong:  { label: 'Strong',  emoji: '💪', cls: 'scan-strength--strong'  },
  neutral: { label: 'Neutral', emoji: '➡️', cls: 'scan-strength--neutral' },
  weak:    { label: 'Weak',    emoji: '⚠️', cls: 'scan-strength--weak'    },
};

function StrengthBadge({ strength }) {
  if (!strength) return <span className="scan-score-na">—</span>;
  const meta = STRENGTH_META[strength];
  if (!meta) return <span className="scan-score-na">{strength}</span>;
  return (
    <span className={`scan-strength-badge ${meta.cls}`}>
      {meta.emoji} {meta.label}
    </span>
  );
}

// ── Single row ────────────────────────────────────────────────────────────────

function ScanRow({ alert, onSelect }) {
  const tick   = useAppStore((s) => s.ticks[alert.token]);
  const ltp    = tick?.lastPrice ?? null;
  const change = tick?.change    ?? null;
  const chgCls = change > 0 ? 'mw-up' : change < 0 ? 'mw-down' : '';

  return (
    <tr className={`scan-row scan-row--${alert.signal}`} onClick={() => onSelect(alert)}>
      <td className="scan-cell scan-cell--symbol">
        <span className="scan-symbol">{alert.label}</span>
        {alert.source === 'screener' && (
          <span className="scan-source-tag">scan</span>
        )}
      </td>
      <td className="scan-cell scan-cell--ltp">
        <span className="scan-ltp">{ltp != null ? fmt(ltp) : '—'}</span>
        {change != null && (
          <span className={`scan-chg ${chgCls}`}>{change > 0 ? '+' : ''}{Number(change).toFixed(2)}%</span>
        )}
      </td>
      <td className="scan-cell">
        <span className="scan-tf-badge">{alert.tfLabel || alert.interval}</span>
      </td>
      <td className="scan-cell">
        <span className={`scan-signal-badge scan-signal-badge--${alert.signal}`}>
          {alert.signal === 'bullish' ? '🟢 Bullish' : '🔴 Bearish'}
        </span>
      </td>
      <td className="scan-cell scan-cell--pattern">
        {alert.patternLabel}
        {alert.consecutiveBars != null && (
          <span className="scan-meta-tag">{alert.consecutiveBars} bars</span>
        )}
      </td>
      <td className="scan-cell scan-cell--strength">
        <StrengthBadge strength={alert.strength} />
      </td>
      <td className="scan-cell scan-cell--score">
        <ScoreDots score={alert.score} signal={alert.signal} />
      </td>
      <td className="scan-cell scan-cell--price">{alert.close != null ? fmt(alert.close) : '—'}</td>
      <td className="scan-cell scan-cell--time">{relativeTime(alert.ts)}</td>
    </tr>
  );
}

// ── Alert ranking ─────────────────────────────────────────────────────────────
// Used when "Best per symbol" is on — pick the single strongest alert per token.
//
// Rank is a composite number (higher = stronger):
//   score     0–5  × 1000   (primary — explicit quality score)
//   strength  0–3  × 100    (strong=3 neutral=2 weak=1 none=0)
//   timeframe 1–4  × 10     (day=4 > 4h=3 > 1h=2 > 15m=1 — longer TF = more significant)
//
// Ties (same stock fires same pattern on same TF) are broken by recency (ts desc).

const STRENGTH_RANK = { strong: 3, neutral: 2, weak: 1 };
const TF_RANK       = { day: 4, '4h': 3, '60minute': 2, '15minute': 1 };

function alertRank(a) {
  const score    = (a.score    ?? 0) * 1000;
  const strength = (STRENGTH_RANK[a.strength] ?? 0) * 100;
  const tf       = (TF_RANK[a.interval]       ?? 0) * 10;
  return score + strength + tf;
}

/**
 * Reduce an alert list to at most one alert per (token, signal) pair,
 * keeping the highest-ranked one. Bullish and bearish alerts for the same
 * token are kept separately (a stock can have a bullish signal on 1d but a
 * bearish on 15m — both are meaningful).
 */
function bestPerSymbol(alerts) {
  const best = new Map(); // key: "token:signal"
  for (const a of alerts) {
    const key  = `${a.token}:${a.signal}`;
    const prev = best.get(key);
    if (!prev || alertRank(a) > alertRank(prev) ||
        (alertRank(a) === alertRank(prev) && (a.ts ?? 0) > (prev.ts ?? 0))) {
      best.set(key, a);
    }
  }
  return Array.from(best.values());
}

// ── Filter bar ────────────────────────────────────────────────────────────────

function FilterBar({ signal, onSignal, interval, onInterval, dedup, onDedup }) {
  const SIGNALS   = ['all', 'bullish', 'bearish'];
  const INTERVALS = ['all', '15minute', '60minute', '4h', 'day'];
  const TF_LABEL  = { '15minute': '15m', '60minute': '1h', '4h': '4h', 'day': '1d' };

  return (
    <div className="scan-filters">
      <div className="scan-filter-group">
        <span className="scan-filter-label">Signal</span>
        {SIGNALS.map((s) => (
          <button
            key={s}
            className={`scan-filter-btn ${signal === s ? 'scan-filter-btn--active' : ''}`}
            onClick={() => onSignal(s)}
          >
            {s === 'all' ? 'All' : s === 'bullish' ? '🟢 Bullish' : '🔴 Bearish'}
          </button>
        ))}
      </div>

      <div className="scan-filter-group">
        <span className="scan-filter-label">Interval</span>
        {INTERVALS.map((iv) => (
          <button
            key={iv}
            className={`scan-filter-btn ${interval === iv ? 'scan-filter-btn--active' : ''}`}
            onClick={() => onInterval(iv)}
          >
            {iv === 'all' ? 'All' : TF_LABEL[iv] || iv}
          </button>
        ))}
      </div>

      {/* Best-per-symbol dedup toggle */}
      <div className="scan-filter-group scan-filter-group--right">
        <button
          className={`scan-filter-btn scan-dedup-btn ${dedup ? 'scan-filter-btn--active' : ''}`}
          onClick={() => onDedup(!dedup)}
          title="Show only the strongest alert per symbol (highest score → strength → timeframe)"
        >
          {dedup ? '✦ Best per symbol' : '✦ Best per symbol'}
        </button>
      </div>
    </div>
  );
}

// ── Screener toolbar ──────────────────────────────────────────────────────────

const TF_LABEL = { '15minute': '15m', '60minute': '1h', '4h': '4h', 'day': '1d' };

function ScreenerToolbar({ onResults }) {
  const [patterns,    setPatterns]    = useState([]);
  const [patternId,   setPatternId]   = useState('');
  const [universe,    setUniverse]    = useState(null);   // { macros, watchlist, futures, all }
  const [running,     setRunning]     = useState(false);
  const [status,      setStatus]      = useState('');     // progress / result message
  const [statusKind,  setStatusKind]  = useState('');     // '' | 'ok' | 'err'
  const [phase,       setPhase]       = useState('');     // current TF being scanned

  // Load pattern list + universe counts on mount
  useEffect(() => {
    api.get('/scan/patterns')
      .then((r) => {
        const list = r.data;
        setPatterns(list);
        if (list.length) setPatternId(list[0].id);
      })
      .catch(() => {});

    api.get('/scan/universe')
      .then((r) => setUniverse(r.data))
      .catch(() => {});
  }, []);

  const selectedPattern = patterns.find((p) => p.id === patternId);

  const runScan = useCallback(async () => {
    if (!patternId || running) return;

    setRunning(true);
    setStatus('Starting scan…');
    setStatusKind('');
    setPhase('');
    onResults(null); // clear previous screener results

    const intervals = ['15minute', '60minute', '4h', 'day'];

    // Show phase progress labels while waiting (cosmetic — the real phases run server-side)
    let phaseIdx = 0;
    const phaseTimer = setInterval(() => {
      if (phaseIdx < intervals.length) {
        setPhase(TF_LABEL[intervals[phaseIdx]] || intervals[phaseIdx]);
        phaseIdx++;
      }
    }, 15_000); // rough estimate: each phase takes ~10-20 s on first run, ~2 s on cache hit

    try {
      const res = await api.post('/scan', {
        patternId, scope: 'all', interTfDelayMs: 500, batchSize: 12,
      });

      clearInterval(phaseTimer);
      setPhase('');

      const data = res.data;
      const { matches = [], scannedCount, totalInstruments, patternLabel } = data;

      onResults(matches);

      const bull = matches.filter((m) => m.signal === 'bullish').length;
      const bear = matches.filter((m) => m.signal === 'bearish').length;

      if (matches.length === 0) {
        setStatus(`No matches — scanned ${scannedCount} pairs across ${totalInstruments} instruments`);
        setStatusKind('');
      } else {
        setStatus(`${matches.length} match${matches.length !== 1 ? 'es' : ''} (🟢 ${bull}  🔴 ${bear})  —  ${scannedCount} pairs scanned`);
        setStatusKind('ok');
      }
    } catch (err) {
      clearInterval(phaseTimer);
      setPhase('');
      // axios wraps HTTP errors in err.response; plain network failures have only err.message
      const msg = err.response?.data?.error || err.message || 'Request failed';
      setStatus(`Error: ${msg}`);
      setStatusKind('err');
    } finally {
      setRunning(false);
    }
  }, [patternId, running, onResults]);

  const universeHint = universe
    ? `~${universe.all} instruments  (${universe.futures} futures + macros)`
    : '';

  return (
    <div className="screener-toolbar">
      {/* Left: pattern picker + run button */}
      <div className="screener-toolbar__left">
        <select
          className="screener-pattern-select"
          value={patternId}
          onChange={(e) => setPatternId(e.target.value)}
          disabled={running}
        >
          {patterns.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>

        <button
          className={`screener-run-btn ${running ? 'screener-run-btn--running' : ''}`}
          onClick={runScan}
          disabled={running || !patternId}
        >
          {running ? (
            <>
              <span className="screener-spinner" />
              {phase ? `Scanning ${phase}…` : 'Starting…'}
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              Run Screener
            </>
          )}
        </button>
      </div>

      {/* Right: universe hint + status */}
      <div className="screener-toolbar__right">
        {universeHint && !running && !status && (
          <span className="screener-universe-hint">{universeHint}</span>
        )}
        {(running || status) && (
          <span className={`screener-status ${statusKind === 'ok' ? 'screener-status--ok' : statusKind === 'err' ? 'screener-status--err' : ''}`}>
            {status || (phase ? `Scanning ${phase}…` : 'Starting…')}
          </span>
        )}
      </div>

      {/* Pattern description tooltip row */}
      {selectedPattern?.description && (
        <div className="screener-pattern-desc">{selectedPattern.description}</div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ScanAlertsPage() {
  const scanAlerts            = useAppStore((s) => s.scanAlerts);
  const addScanAlert          = useAppStore((s) => s.addScanAlert);
  const setSelectedInstrument = useAppStore((s) => s.setSelectedInstrument);

  const [signalFilter,   setSignalFilter]   = useState('all');
  const [intervalFilter, setIntervalFilter] = useState('all');
  // Dedup: ON by default — show the single strongest alert per symbol
  const [dedup, setDedup] = useState(true);

  // Screener results: array of match objects returned by POST /api/scan
  // Null means no screener run yet (don't show the "X results" banner).
  const [screenerResults, setScreenerResults] = useState(null);

  // When screener finishes, push every match into the shared scanAlerts store
  // so they appear in the live table immediately (tagged source:'screener').
  const handleScreenerResults = useCallback((matches) => {
    setScreenerResults(matches); // null = cleared, [] = no matches, [...] = results
    if (!matches) return;
    const now = Date.now();
    for (const m of matches) {
      addScanAlert({
        token:         m.token,
        label:         m.tradingsymbol || m.name || `Token ${m.token}`,
        interval:      m.interval,
        tfLabel:       TF_LABEL[m.interval] || m.interval,
        patternId:     m.patternId  ?? 'screener',
        patternLabel:  m.patternLabel ?? '—',
        signal:        m.signal,
        score:         m.score         ?? null,
        close:         m.close         ?? null,
        strength:      m.strength      ?? null,
        cloudPosition: m.cloudPosition ?? null,
        barsAgo:       m.barsAgo       ?? null,
        consecutiveBars: m.consecutiveBars ?? null,
        cloudThickness:  m.cloudThickness  ?? null,
        ts:            now,
        source:        'screener',
      });
    }
  }, [addScanAlert]);

  const filtered = useMemo(() => {
    // 1. Apply signal + interval filters
    let list = scanAlerts.filter((a) => {
      if (signalFilter   !== 'all' && a.signal   !== signalFilter)   return false;
      if (intervalFilter !== 'all' && a.interval !== intervalFilter) return false;
      return true;
    });

    // 2. When dedup is ON, reduce to the single best alert per (token, signal).
    //    This removes duplicate rows when the same stock fires on multiple
    //    timeframes or multiple patterns — only the strongest one is shown.
    if (dedup) list = bestPerSymbol(list);

    // 3. Sort: bullish first, then by rank descending, then recency
    list.sort((a, b) => {
      if (a.signal !== b.signal) return a.signal === 'bullish' ? -1 : 1;
      const rd = alertRank(b) - alertRank(a);
      if (rd !== 0) return rd;
      return (b.ts ?? 0) - (a.ts ?? 0);
    });

    return list;
  }, [scanAlerts, signalFilter, intervalFilter, dedup]);

  function handleSelect(alert) {
    setSelectedInstrument({
      type:     'stock',
      token:    alert.token,
      label:    alert.label,
      sublabel: alert.interval,
    });
  }

  const liveCount      = scanAlerts.filter((a) => a.source !== 'screener').length;
  const screenerCount  = scanAlerts.filter((a) => a.source === 'screener').length;

  return (
    <div className="page scanner-page">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <h2 className="page-title">Scanner</h2>
          <p className="page-sub">
            Real-time Ichimoku pattern alerts
            {liveCount > 0 && (
              <span className="scan-count-badge">{liveCount} live</span>
            )}
            {screenerCount > 0 && (
              <span className="scan-count-badge scan-count-badge--scan">{screenerCount} screener</span>
            )}
          </p>
        </div>
      </div>

      {/* ── Screener toolbar ────────────────────────────────────────────── */}
      <ScreenerToolbar onResults={handleScreenerResults} />

      {/* ── Filters ─────────────────────────────────────────────────────── */}
      <FilterBar
        signal={signalFilter}     onSignal={setSignalFilter}
        interval={intervalFilter} onInterval={setIntervalFilter}
        dedup={dedup}             onDedup={setDedup}
      />

      {/* ── Results table ───────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <div className="scan-empty">
          <div className="scan-empty-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.3">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="11" y1="8" x2="11" y2="14" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </div>
          <p className="scan-empty-text">
            {scanAlerts.length === 0
              ? 'No alerts yet. Click "Run Screener" to scan all F&O stocks now, or wait for live candle-close alerts during market hours.'
              : 'No alerts match the current filters.'}
          </p>
        </div>
      ) : (
        <div className="scan-table-wrap">
          <table className="scan-table">
            <thead>
              <tr>
                <th className="scan-th">Symbol</th>
                <th className="scan-th">LTP</th>
                <th className="scan-th">TF</th>
                <th className="scan-th">Signal</th>
                <th className="scan-th">Pattern</th>
                <th className="scan-th">Strength</th>
                <th className="scan-th">Score</th>
                <th className="scan-th">Price @ Alert</th>
                <th className="scan-th">Time</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((alert) => (
                <ScanRow
                  key={`${alert.token}:${alert.interval}:${alert.patternId}:${alert.source ?? 'live'}`}
                  alert={alert}
                  onSelect={handleSelect}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
