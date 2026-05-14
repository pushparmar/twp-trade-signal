import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import useAppStore from '../../store/appStore';
import api from '../../api';
import ScanChartModal from './ScanChartModal';

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

// ── Column comparators ────────────────────────────────────────────────────────
// Each returns ascending order (a - b). The sort logic flips sign for desc.
// Tie-breakers fall back to composite rank desc inside the useMemo sort below.

const _num = (v) => (v == null || Number.isNaN(v) ? -Infinity : Number(v));
const _str = (v) => String(v ?? '').toLowerCase();

const COL_COMPARATORS = {
  // 'rank' = composite (score → strength → TF). Asc sorts weakest first.
  rank:     (a, b) => alertRank(a) - alertRank(b),
  symbol:   (a, b) => _str(a.label).localeCompare(_str(b.label)),
  // LTP/Time live in the global store on the row component — sort by static fields only here
  tf:       (a, b) => (TF_RANK[a.interval] ?? 0) - (TF_RANK[b.interval] ?? 0),
  signal:   (a, b) => _str(a.signal).localeCompare(_str(b.signal)),
  pattern:  (a, b) => _str(a.patternLabel).localeCompare(_str(b.patternLabel)),
  strength: (a, b) => (STRENGTH_RANK[a.strength] ?? 0) - (STRENGTH_RANK[b.strength] ?? 0),
  score:    (a, b) => _num(a.score) - _num(b.score),
  price:    (a, b) => _num(a.close) - _num(b.close),
  time:     (a, b) => _num(a.ts) - _num(b.ts),
};

/**
 * Sortable table header cell.
 * Shows ▲ for asc, ▼ for desc on the active column; nothing when inactive.
 * Clicking cycles: inactive → desc → asc → default (rank desc).
 */
function SortHeader({ col, label, sort, onClick }) {
  const active = sort.col === col;
  const arrow  = !active ? '' : sort.dir === 'desc' ? '▼' : '▲';
  return (
    <th
      className={`scan-th scan-th--sortable ${active ? 'scan-th--active' : ''}`}
      onClick={() => onClick(col)}
      title="Click to sort"
    >
      <span className="scan-th-label">{label}</span>
      <span className="scan-th-arrow">{arrow}</span>
    </th>
  );
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
const ALL_INTERVALS = ['15minute', '60minute', '4h', 'day'];

// Status pill per TF — shown while scan runs
//   'queued'  → grey
//   'running' → blue spinner
//   'done'    → green check + match count
//   'failed'  → red ✗ + error message
function TfPill({ interval, state, matches, error }) {
  const label = TF_LABEL[interval];
  let icon = '', cls = '';
  if (state === 'queued')  { icon = '…'; cls = 'tf-pill--queued';  }
  if (state === 'running') { icon = '⟳'; cls = 'tf-pill--running'; }
  if (state === 'done')    { icon = '✓'; cls = 'tf-pill--done';    }
  if (state === 'failed')  { icon = '✗'; cls = 'tf-pill--failed';  }
  const title = state === 'failed' ? error : state === 'done' ? `${matches} match${matches !== 1 ? 'es' : ''}` : state;
  return (
    <span className={`tf-pill ${cls}`} title={title}>
      <span className="tf-pill__icon">{icon}</span>
      <span className="tf-pill__label">{label}</span>
      {state === 'done' && matches > 0 && (
        <span className="tf-pill__count">{matches}</span>
      )}
    </span>
  );
}

function ScreenerToolbar({ onTfResults, onClear }) {
  const [patterns,   setPatterns]   = useState([]);
  const [patternId,  setPatternId]  = useState('');
  const [universe,   setUniverse]   = useState(null);   // { macros, watchlist, futures, all }
  const [tfFilter,   setTfFilter]   = useState('all');  // 'all' | interval id
  const [running,    setRunning]    = useState(false);
  const [status,     setStatus]     = useState('');     // overall status line
  const [statusKind, setStatusKind] = useState('');     // '' | 'ok' | 'err'
  // Per-TF state map: { [interval]: { state, matches, error } }
  const [tfState,    setTfState]    = useState({});

  const autoRunRef = useRef(false); // guard so auto-run fires only once per mount

  // Load pattern list + universe counts on mount
  useEffect(() => {
    api.get('/scan/patterns')
      .then((r) => {
        const list = r.data;
        setPatterns(list);
        // Default to "all" so the first auto-scan covers every pattern at once
        if (list.length) setPatternId('all');
      })
      .catch(() => {});

    api.get('/scan/universe')
      .then((r) => setUniverse(r.data))
      .catch(() => {});
  }, []);

  // 'all' is a synthetic option; otherwise look up the real pattern record
  const selectedPattern = patternId === 'all'
    ? { id: 'all', label: 'All patterns', description: `Runs every registered pattern (${patterns.length}) against each candle set. Candles are fetched once per instrument×timeframe and reused across patterns, so this is almost free.` }
    : patterns.find((p) => p.id === patternId);

  /**
   * Run the scan: one request per (timeframe × pattern), in parallel.
   *
   * When patternId === 'all', we expand into N_patterns × N_intervals requests
   * — each request is single-pattern, single-TF. This keeps the request size
   * tiny and works regardless of whether the server supports the synthetic
   * 'all' pattern keyword. The historicalCache dedupes candle fetches across
   * patterns so the actual Kite API cost stays the same.
   *
   * Per-TF pills aggregate matches across all patterns scanned for that TF.
   */
  const runScan = useCallback(async () => {
    if (!patternId || running) return;

    const intervals  = tfFilter === 'all' ? ALL_INTERVALS : [tfFilter];

    // Resolve list of pattern IDs to scan. If user picked 'all' but the
    // pattern list hasn't loaded yet, abort with a clear status.
    const patternIds = patternId === 'all'
      ? (patterns.length ? patterns.map((p) => p.id) : null)
      : [patternId];

    if (!patternIds) {
      setStatus('Pattern list not loaded yet — refresh and try again');
      setStatusKind('err');
      return;
    }

    setRunning(true);
    setStatusKind('');
    setStatus(
      patternIds.length > 1
        ? `Scanning ${intervals.length} TF × ${patternIds.length} patterns…`
        : intervals.length > 1
          ? `Scanning ${intervals.length} timeframes in parallel…`
          : `Scanning ${TF_LABEL[intervals[0]]}…`
    );
    onClear();   // clear previous screener results from the table

    // Initialise pill state: first TF running, rest queued
    const initial = {};
    intervals.forEach((iv, idx) => {
      initial[iv] = { state: idx === 0 ? 'running' : 'queued', matches: 0 };
    });
    setTfState(initial);

    let totalMatches  = 0;
    let totalScanned  = 0;
    let totalTfOk     = 0;
    let totalTfFailed = 0;

    // One async block per TF — runs all N patterns for that TF in parallel,
    // aggregates results, then updates the pill once everything is in.
    const tfTasks = intervals.map((interval, idx) => new Promise((resolve) => {
      setTimeout(async () => {
        // Mark this TF as running (it may already be 'running' if idx===0)
        setTfState((prev) => ({ ...prev, [interval]: { ...prev[interval], state: 'running' } }));

        const patternPromises = patternIds.map((pid) =>
          api.post('/scan', {
            patternId:      pid,
            intervals:      [interval],
            scope:          'all',
            interTfDelayMs: 0,
            batchSize:      12,
          }, { timeout: 90_000 })
        );

        const results = await Promise.allSettled(patternPromises);

        let ivMatches = 0;
        let ivScanned = 0;
        let anySucceeded = false;
        let lastErr = null;

        for (const r of results) {
          if (r.status === 'fulfilled') {
            anySucceeded = true;
            const data    = r.value.data;
            const matches = data.matches || [];
            ivMatches    += matches.length;
            ivScanned    += data.scannedCount ?? 0;
            // Merge this pattern's matches into the table immediately
            if (matches.length) onTfResults(matches);
          } else {
            const err = r.reason;
            lastErr = err.response?.data?.error || err.message || 'Request failed';
            console.warn(`[Scan] ${interval} pattern failed:`, lastErr);
          }
        }

        totalMatches += ivMatches;
        totalScanned += ivScanned;

        if (anySucceeded) {
          totalTfOk++;
          setTfState((prev) => ({
            ...prev,
            [interval]: { state: 'done', matches: ivMatches },
          }));
        } else {
          totalTfFailed++;
          setTfState((prev) => ({
            ...prev,
            [interval]: { state: 'failed', matches: 0, error: lastErr || 'all patterns failed' },
          }));
        }

        resolve();
      }, idx * 400); // 400 ms stagger between TFs
    }));

    await Promise.all(tfTasks);

    // Renamed locals so the summary code below stays unchanged
    const totalSucceeded = totalTfOk;
    const totalFailed    = totalTfFailed;

    // Build final summary
    if (totalSucceeded === 0) {
      setStatus(`All ${intervals.length} timeframes failed — check server logs`);
      setStatusKind('err');
    } else if (totalFailed > 0) {
      setStatus(`${totalMatches} match${totalMatches !== 1 ? 'es' : ''} — ${totalSucceeded} TF ok, ${totalFailed} failed`);
      setStatusKind('ok');
    } else if (totalMatches === 0) {
      setStatus(`No matches — scanned ${totalScanned} pairs across ${intervals.length} timeframe${intervals.length !== 1 ? 's' : ''}`);
      setStatusKind('');
    } else {
      setStatus(`${totalMatches} match${totalMatches !== 1 ? 'es' : ''} — ${totalScanned} pairs scanned`);
      setStatusKind('ok');
    }

    setRunning(false);
  }, [patternId, running, tfFilter, patterns, onTfResults, onClear]);

  // Auto-run once after patterns load — gives the user fresh results without a click.
  // Wait until BOTH patternId is set AND patterns list is loaded, otherwise an
  // 'all' fan-out has nothing to iterate over.
  useEffect(() => {
    if (autoRunRef.current) return;
    if (!patternId)        return;
    if (patternId === 'all' && patterns.length === 0) return;
    autoRunRef.current = true;
    const t = setTimeout(() => { runScan(); }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patternId, patterns]);

  const universeHint = universe
    ? `~${universe.all} instruments  (${universe.futures} futures + macros)`
    : '';

  const intervalsInUse = tfFilter === 'all' ? ALL_INTERVALS : [tfFilter];

  return (
    <div className="screener-toolbar">
      {/* Left: pattern picker + TF picker + run button */}
      <div className="screener-toolbar__left">
        <select
          className="screener-pattern-select"
          value={patternId}
          onChange={(e) => setPatternId(e.target.value)}
          disabled={running}
          title="Pattern to scan for"
        >
          <option value="all">★ All patterns ({patterns.length || 9})</option>
          {patterns.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>

        <select
          className="screener-tf-select"
          value={tfFilter}
          onChange={(e) => setTfFilter(e.target.value)}
          disabled={running}
          title="Timeframe to scan"
        >
          <option value="all">All timeframes</option>
          {ALL_INTERVALS.map((iv) => (
            <option key={iv} value={iv}>{TF_LABEL[iv]}</option>
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
              Scanning…
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

      {/* Right: universe hint OR status */}
      <div className="screener-toolbar__right">
        {universeHint && !running && !status && (
          <span className="screener-universe-hint">{universeHint}</span>
        )}
        {(running || status) && (
          <span className={`screener-status ${statusKind === 'ok' ? 'screener-status--ok' : statusKind === 'err' ? 'screener-status--err' : ''}`}>
            {status || 'Starting…'}
          </span>
        )}
      </div>

      {/* Per-TF pill row — shown while running or right after a run */}
      {(running || Object.keys(tfState).length > 0) && (
        <div className="screener-tf-pills">
          {intervalsInUse.map((iv) => (
            <TfPill
              key={iv}
              interval={iv}
              state={tfState[iv]?.state ?? 'queued'}
              matches={tfState[iv]?.matches ?? 0}
              error={tfState[iv]?.error}
            />
          ))}
        </div>
      )}

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

  // Column sort: { col: 'score'|'symbol'|..., dir: 'asc'|'desc' }
  // Default is 'rank' desc which preserves the "strongest first" ordering.
  const [sort, setSort] = useState({ col: 'rank', dir: 'desc' });

  /** Toggle sort: clicking same column flips direction, new column starts desc. */
  const toggleSort = useCallback((col) => {
    setSort((prev) => {
      if (prev.col !== col) return { col, dir: 'desc' };
      // Same column — flip direction, with a third click cycling back to default 'rank' desc
      if (prev.dir === 'desc') return { col, dir: 'asc' };
      return { col: 'rank', dir: 'desc' };
    });
  }, []);

  const clearScreenerAlerts = useAppStore((s) => s.clearScreenerAlerts);

  /**
   * Called by the screener once per timeframe as each parallel /api/scan
   * call resolves. Matches are merged into the shared scanAlerts store so
   * they appear in the live table immediately (tagged source:'screener').
   */
  const handleTfResults = useCallback((matches) => {
    if (!matches?.length) return;
    const now = Date.now();
    for (const m of matches) {
      addScanAlert({
        token:           m.token,
        label:           m.tradingsymbol || m.name || `Token ${m.token}`,
        interval:        m.interval,
        tfLabel:         TF_LABEL[m.interval] || m.interval,
        patternId:       m.patternId  ?? 'screener',
        patternLabel:    m.patternLabel ?? '—',
        signal:          m.signal,
        score:           m.score          ?? null,
        close:           m.close          ?? null,
        strength:        m.strength       ?? null,
        cloudPosition:   m.cloudPosition  ?? null,
        barsAgo:         m.barsAgo        ?? null,
        consecutiveBars: m.consecutiveBars ?? null,
        cloudThickness:  m.cloudThickness  ?? null,
        ts:              now,
        source:          'screener',
      });
    }
  }, [addScanAlert]);

  /** Called when a new scan starts — wipes previous screener results from the table. */
  const handleClearScreener = useCallback(() => {
    clearScreenerAlerts();
  }, [clearScreenerAlerts]);

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

    // 3. Sort by the selected column.
    //    Default ('rank' desc) preserves the "strongest first" ordering.
    //    Any other column sorts on its raw value with rank as the tie-breaker.
    const cmp = COL_COMPARATORS[sort.col] || COL_COMPARATORS.rank;
    const dir = sort.dir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      const primary = cmp(a, b) * dir;
      if (primary !== 0) return primary;
      // Tie-breaker: always fall back to composite rank desc, then recency
      const rd = alertRank(b) - alertRank(a);
      if (rd !== 0) return rd;
      return (b.ts ?? 0) - (a.ts ?? 0);
    });

    return list;
  }, [scanAlerts, signalFilter, intervalFilter, dedup, sort]);

  // Modal: alert currently being shown in the chart popup (null = closed)
  const [chartAlert, setChartAlert] = useState(null);

  function handleSelect(alert) {
    // Open the chart modal pre-loaded at the alert's timeframe
    setChartAlert(alert);
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
      <ScreenerToolbar onTfResults={handleTfResults} onClear={handleClearScreener} />

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
                <SortHeader col="symbol"   label="Symbol"        sort={sort} onClick={toggleSort} />
                <th className="scan-th">LTP</th>
                <SortHeader col="tf"       label="TF"            sort={sort} onClick={toggleSort} />
                <SortHeader col="signal"   label="Signal"        sort={sort} onClick={toggleSort} />
                <SortHeader col="pattern"  label="Pattern"       sort={sort} onClick={toggleSort} />
                <SortHeader col="strength" label="Strength"      sort={sort} onClick={toggleSort} />
                <SortHeader col="score"    label="Score"         sort={sort} onClick={toggleSort} />
                <SortHeader col="price"    label="Price @ Alert" sort={sort} onClick={toggleSort} />
                <SortHeader col="time"     label="Time"          sort={sort} onClick={toggleSort} />
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

      {/* ── Chart modal (opens on row click) ────────────────────────────── */}
      {chartAlert && (
        <ScanChartModal alert={chartAlert} onClose={() => setChartAlert(null)} />
      )}
    </div>
  );
}
