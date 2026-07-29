import { useState, useEffect, useCallback } from 'react';
import api from '../../api';
import './Phase2.css';

const INTERVALS = ['5minute', '15minute', '60minute'];
const TF_LABELS = { '5minute': '5 Min', '15minute': '15 Min', '60minute': '1 Hour' };
const BUCKET_LABELS = { current: 'Current Expiry', next: 'Next Week', monthly: 'Monthly' };
const BUCKET_ORDER = ['current', 'next', 'monthly'];
const INDEX_ORDER = ['NIFTY', 'BANKNIFTY', 'SENSEX'];
const PATTERN_LABELS = { 'kumo-breakout': 'Kumo Breakout', 'tk-reversion': 'TK Reversion' };

function fmt(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function relativeTime(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function countdown(ts) {
  if (!ts) return '—';
  const s = Math.floor((ts - Date.now()) / 1000);
  if (s <= 0) return 'now';
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m`;
}

function MatchCard({ m }) {
  return (
    <div className={`p2-card p2-card--${m.signal}`}>
      <div className="p2-card-head">
        <span className={`p2-signal p2-signal--${m.signal}`}>{m.signal === 'bullish' ? '▲' : '▼'}</span>
        <span className="p2-symbol">{m.tradingsymbol}</span>
        <span className="p2-pattern">{PATTERN_LABELS[m.pattern] || m.pattern}</span>
        <span className="p2-tf">{m.tfLabel}</span>
      </div>
      <div className="p2-card-sub">
        {m.index} {m.strike} {m.optionType} · {BUCKET_LABELS[m.expiryBucket]} ({m.expiry})
      </div>
      <div className="p2-card-body">
        <div className="p2-row"><span>Entry</span><b>{fmt(m.entry)}</b></div>
        <div className="p2-row"><span>SL</span><b className="p2-sl">{fmt(m.sl)}</b></div>
        <div className="p2-row"><span>Target</span><b className="p2-target">{fmt(m.target)}</b></div>
        <div className="p2-row"><span>R:R</span><b>1:{m.rr?.toFixed(1) ?? '—'}</b></div>
        <div className="p2-row"><span>Score</span><b>{m.score ?? '—'}/5</b></div>
      </div>
      <div className="p2-card-foot">
        <span>{m.exchange}</span>
        <span>{relativeTime(m.ts)}</span>
      </div>
    </div>
  );
}

export default function Phase2StrikesPage() {
  const [universe, setUniverse] = useState(null);
  const [results, setResults] = useState({});
  const [status, setStatus] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState({ index: 'all', bucket: 'all', pattern: 'all', signal: 'all' });
  const [, tick] = useState(0);

  const loadAll = useCallback(() => {
    api.get('/phase2/results').then(r => setResults(r.data || {})).catch(() => {});
    api.get('/phase2/status').then(r => setStatus(r.data)).catch(() => {});
    api.get('/phase2/strikes').then(r => setUniverse(r.data)).catch(() => {});
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Refresh countdown labels + status every 15s
  useEffect(() => {
    const t = setInterval(() => {
      tick(n => n + 1);
      api.get('/phase2/status').then(r => setStatus(r.data)).catch(() => {});
    }, 15_000);
    return () => clearInterval(t);
  }, []);

  // SSE — refresh results when a scan cycle completes
  useEffect(() => {
    const streamUrl = import.meta.env.VITE_API_URL
      ? `${import.meta.env.VITE_API_URL}/api/stream`
      : '/api/stream';
    const es = new EventSource(streamUrl);
    es.addEventListener('phase2_scan_complete', () => {
      api.get('/phase2/results').then(r => setResults(r.data || {})).catch(() => {});
    });
    return () => es.close();
  }, []);

  const runNow = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      await api.post('/phase2/run');
      loadAll();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setRunning(false);
    }
  }, [loadAll]);

  const toggleScheduler = useCallback(async () => {
    const endpoint = status?.running ? '/phase2/stop' : '/phase2/start';
    try {
      const r = await api.post(endpoint);
      setStatus(r.data.status);
    } catch { /* ignore */ }
  }, [status]);

  // Flatten and filter matches across intervals
  const allMatches = INTERVALS.flatMap(iv => results[iv]?.matches || []);
  const filtered = allMatches.filter(m => {
    if (filter.index !== 'all' && m.index !== filter.index) return false;
    if (filter.bucket !== 'all' && m.expiryBucket !== filter.bucket) return false;
    if (filter.pattern !== 'all' && m.pattern !== filter.pattern) return false;
    if (filter.signal !== 'all' && m.signal !== filter.signal) return false;
    return true;
  });

  const totalInstruments = universe?.instruments?.length ?? 0;

  return (
    <div className="p2-page">
      <div className="p2-toolbar">
        <div className="p2-toolbar-left">
          <h2>Index Option Strikes</h2>
          {universe && (
            <span className="p2-universe-hint">
              {totalInstruments} strikes · ATM ±5 ITM / 2 OTM · current + next week + monthly
            </span>
          )}
        </div>
        <div className="p2-toolbar-right">
          {status && (
            <button
              className={`p2-btn ${status.running ? 'p2-btn--stop' : 'p2-btn--start'}`}
              onClick={toggleScheduler}
            >
              {status.running ? '⏸ Auto-scan ON' : '▶ Auto-scan OFF'}
            </button>
          )}
          <button className="p2-btn p2-btn--run" onClick={runNow} disabled={running}>
            {running ? 'Scanning…' : 'Run Scan Now'}
          </button>
        </div>
      </div>

      {/* Scheduler status per TF */}
      {status?.intervals && (
        <div className="p2-sched">
          {INTERVALS.map(iv => {
            const info = status.intervals[iv];
            if (!info) return null;
            const r = results[iv];
            return (
              <div key={iv} className="p2-sched-item">
                <b>{TF_LABELS[iv]}</b>
                <span>{info.scanning ? 'scanning…' : info.lastScanAt ? `scanned ${relativeTime(info.lastScanAt)}` : 'not scanned yet'}</span>
                {status.running && <span className="p2-sched-next">next: {countdown(info.nextScanAt)}</span>}
                <span className="p2-sched-count">
                  {r ? `${r.matches.length} matches / ${r.scannedCount} scanned${r.shortHistoryCount ? ` · ${r.shortHistoryCount} too new` : ''}${r.fetchFailCount ? ` · ${r.fetchFailCount} fetch failed` : ''}` : ''}
                </span>
                {info.lastError && <span className="p2-sched-error" title={info.lastError}>⚠ {info.lastError}</span>}
              </div>
            );
          })}
        </div>
      )}

      {error && <div className="p2-error">{error}</div>}

      {/* ATM summary per index */}
      {universe?.byIndex && (
        <div className="p2-atm-strip">
          {INDEX_ORDER.map(idx => {
            const info = universe.byIndex[idx];
            if (!info) return null;
            return (
              <div key={idx} className="p2-atm-chip">
                <b>{idx}</b> ATM {info.atmStrike ?? '—'} · {info.count} strikes
              </div>
            );
          })}
        </div>
      )}

      {/* Filters */}
      <div className="p2-filters">
        <select value={filter.index} onChange={e => setFilter(f => ({ ...f, index: e.target.value }))}>
          <option value="all">All Indices</option>
          {INDEX_ORDER.map(i => <option key={i} value={i}>{i}</option>)}
        </select>
        <select value={filter.bucket} onChange={e => setFilter(f => ({ ...f, bucket: e.target.value }))}>
          <option value="all">All Expiries</option>
          {BUCKET_ORDER.map(b => <option key={b} value={b}>{BUCKET_LABELS[b]}</option>)}
        </select>
        <select value={filter.pattern} onChange={e => setFilter(f => ({ ...f, pattern: e.target.value }))}>
          <option value="all">All Patterns</option>
          <option value="kumo-breakout">Kumo Breakout</option>
          <option value="tk-reversion">TK Reversion</option>
        </select>
        <select value={filter.signal} onChange={e => setFilter(f => ({ ...f, signal: e.target.value }))}>
          <option value="all">All Signals</option>
          <option value="bullish">Bullish</option>
          <option value="bearish">Bearish</option>
        </select>
        <span className="p2-count">{filtered.length} signal{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Results */}
      <div className="p2-grid">
        {filtered.length === 0 ? (
          <div className="p2-empty">
            {allMatches.length === 0
              ? 'No scan results yet — auto-scan runs every 15 min (15m TF) and hourly (1h TF) during market hours.'
              : 'No signals match the current filters.'}
          </div>
        ) : (
          filtered.map((m, i) => <MatchCard key={`${m.token}-${m.pattern}-${m.interval}-${i}`} m={m} />)
        )}
      </div>
    </div>
  );
}
