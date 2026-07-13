import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../api';
import './KumoBreakoutPage.css';

const TF_ORDER = ['15m', '1h', '4h', '1d'];
const TF_LABELS = { '15m': '15 Min', '1h': '1 Hour', '4h': '4 Hour', '1d': 'Daily' };
const TF_INTERVALS = { '15m': '15minute', '1h': '60minute', '4h': '4h', '1d': 'day' };
const INTERVAL_TO_TF = { '15minute': '15m', '60minute': '1h', '4h': '4h', 'day': '1d' };

function fmt(n, decimals = 2) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function relativeTime(ts) {
  if (!ts) return '—';
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  return `${Math.floor(diffSec / 3600)}h ago`;
}

function countdown(targetTs) {
  if (!targetTs) return '—';
  const diffSec = Math.floor((targetTs - Date.now()) / 1000);
  if (diffSec <= 0) return 'now';
  if (diffSec < 60) return `${diffSec}s`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  return `${Math.floor(diffSec / 3600)}h ${Math.floor((diffSec % 3600) / 60)}m`;
}

function ScoreDots({ score, signal }) {
  if (score == null) return <span className="kb-score-na">—</span>;
  const total = 5;
  const filled = Math.max(0, Math.min(total, Math.round(score)));
  const colorClass = signal === 'bullish' ? 'kb-dot--bull' : 'kb-dot--bear';
  return (
    <span className="kb-score-dots" title={`Score: ${score}/5`}>
      {Array.from({ length: total }).map((_, i) => (
        <span key={i} className={`kb-dot ${i < filled ? colorClass : 'kb-dot--empty'}`} />
      ))}
      <span className="kb-score-num">{score}/5</span>
    </span>
  );
}

function SignalBadge({ signal }) {
  return (
    <span className={`kb-signal kb-signal--${signal}`}>
      {signal === 'bullish' ? '▲' : '▼'}
    </span>
  );
}

function CategoryBadge({ category }) {
  const labels = { index: 'IDX', commodity: 'MCX', stock: 'STK' };
  return <span className={`kb-category kb-category--${category}`}>{labels[category] || category}</span>;
}

function MtfBadge({ alignedTfs }) {
  if (!alignedTfs?.length) return null;
  return <span className="kb-mtf" title={`MTF aligned: ${alignedTfs.join(', ')}`}>⚡{alignedTfs.join('+')}</span>;
}

function BreakoutCard({ match }) {
  const rrRatio = match.rrRatio ? match.rrRatio.toFixed(1) : '—';
  return (
    <div className={`kb-card kb-card--${match.signal}`}>
      <div className="kb-card-header">
        <div className="kb-card-left">
          <SignalBadge signal={match.signal} />
          <span className="kb-symbol">{match.name || match.symbol}</span>
          <CategoryBadge category={match.category} />
        </div>
        <div className="kb-card-right">
          <ScoreDots score={match.score} signal={match.signal} />
          <MtfBadge alignedTfs={match.alignedTfs} />
        </div>
      </div>

      <div className="kb-card-body">
        <div className="kb-row">
          <span className="kb-label">Close</span>
          <span className="kb-value">{fmt(match.close)}</span>
        </div>
        <div className="kb-row">
          <span className="kb-label">SL</span>
          <span className="kb-value kb-sl">{fmt(match.sl)}</span>
        </div>
        <div className="kb-row">
          <span className="kb-label">Target</span>
          <span className="kb-value kb-target">{fmt(match.target)}</span>
        </div>
        <div className="kb-row">
          <span className="kb-label">R:R</span>
          <span className="kb-value">{rrRatio}</span>
        </div>
        {match.futureCloudColor && (
          <div className="kb-row">
            <span className="kb-label">Future Cloud</span>
            <span className={`kb-value kb-cloud--${match.futureCloudColor}`}>{match.futureCloudColor}</span>
          </div>
        )}
      </div>

      <div className="kb-card-footer">
        <span className="kb-exchange">{match.exchange}</span>
        <span className="kb-time">{relativeTime(match.ts)}</span>
      </div>
    </div>
  );
}

function TimeframeSection({ tfLabel, matches, filter, isLoading, scanInfo }) {
  const filtered = matches.filter(m => {
    if (filter.signal !== 'all' && m.signal !== filter.signal) return false;
    if (filter.category !== 'all' && m.category !== filter.category) return false;
    if (filter.minScore > 0 && (m.score ?? 0) < filter.minScore) return false;
    return true;
  });

  return (
    <div className="kb-tf-section">
      <div className="kb-tf-header">
        <h3>{TF_LABELS[tfLabel]}</h3>
        <div className="kb-tf-meta">
          {scanInfo?.lastScanAt && (
            <span className="kb-tf-scanned">Scanned {relativeTime(scanInfo.lastScanAt)}</span>
          )}
          {scanInfo?.nextScanAt && (
            <span className="kb-tf-next">Next: {countdown(scanInfo.nextScanAt)}</span>
          )}
          {isLoading ? (
            <span className="kb-tf-loading">Scanning...</span>
          ) : (
            <span className="kb-tf-count">{filtered.length} signal{filtered.length !== 1 ? 's' : ''}</span>
          )}
        </div>
      </div>
      <div className="kb-tf-grid">
        {isLoading ? (
          <div className="kb-loading">Loading {TF_LABELS[tfLabel]} data...</div>
        ) : filtered.length === 0 ? (
          <div className="kb-empty">No breakouts found</div>
        ) : (
          filtered.map((m, i) => <BreakoutCard key={`${m.token}-${i}`} match={m} />)
        )}
      </div>
    </div>
  );
}

function SchedulerStatus({ status, onStart, onStop }) {
  if (!status) return null;
  return (
    <div className={`kb-scheduler ${status.running ? 'kb-scheduler--running' : 'kb-scheduler--stopped'}`}>
      <span className="kb-scheduler-dot" />
      <span className="kb-scheduler-label">
        {status.running ? 'Auto-scanning' : 'Scheduler stopped'}
      </span>
      {status.running ? (
        <button className="kb-scheduler-btn kb-scheduler-btn--stop" onClick={onStop}>Stop</button>
      ) : (
        <button className="kb-scheduler-btn kb-scheduler-btn--start" onClick={onStart}>Start</button>
      )}
    </div>
  );
}

export default function KumoBreakoutPage() {
  const [results, setResults] = useState({ '15m': [], '1h': [], '4h': [], '1d': [] });
  const [loading, setLoading] = useState({ '15m': false, '1h': false, '4h': false, '1d': false });
  const [error, setError] = useState(null);
  const [lastScan, setLastScan] = useState(null);
  const [universe, setUniverse] = useState(null);
  const [filter, setFilter] = useState({ signal: 'all', category: 'all', minScore: 0, timeframes: ['15m', '1h', '1d'] });
  const [schedulerStatus, setSchedulerStatus] = useState(null);
  const countdownRef = useRef(null);
  const [, forceUpdate] = useState(0);

  // Load cached results from DB on mount
  useEffect(() => {
    api.get('/kumo-breakout/results')
      .then(res => {
        const data = res.data;
        const newResults = { '15m': [], '1h': [], '4h': [], '1d': [] };
        let hasAny = false;
        for (const [interval, cached] of Object.entries(data)) {
          const tf = INTERVAL_TO_TF[interval];
          if (tf && cached?.matches) {
            newResults[tf] = cached.matches;
            hasAny = true;
          }
        }
        if (hasAny) {
          setResults(newResults);
          setLastScan(Date.now());
        }
      })
      .catch(() => {});

    api.get('/kumo-breakout/universe')
      .then(res => setUniverse(res.data))
      .catch(() => {});

    api.get('/kumo-breakout/status')
      .then(res => setSchedulerStatus(res.data))
      .catch(() => {});
  }, []);

  // Countdown timer refresh (every 10s to update "Next: Xm" labels)
  useEffect(() => {
    countdownRef.current = setInterval(() => {
      forceUpdate(n => n + 1);
      // Refresh scheduler status
      api.get('/kumo-breakout/status')
        .then(res => setSchedulerStatus(res.data))
        .catch(() => {});
    }, 10_000);
    return () => clearInterval(countdownRef.current);
  }, []);

  // Listen for SSE kumo_scan_complete events to auto-refresh results from DB
  useEffect(() => {
    const streamUrl = import.meta.env.VITE_API_URL
      ? `${import.meta.env.VITE_API_URL}/api/stream`
      : '/api/stream';
    const es = new EventSource(streamUrl);

    es.addEventListener('kumo_scan_complete', (event) => {
      try {
        const payload = JSON.parse(event.data);
        const tf = INTERVAL_TO_TF[payload.interval];
        if (tf) {
          // Refetch that interval's results from the cached API
          api.get(`/kumo-breakout/scan/${payload.interval}`)
            .then(res => {
              setResults(prev => ({ ...prev, [tf]: res.data.matches }));
              setLastScan(Date.now());
            })
            .catch(() => {});
        }
      } catch {}
    });

    return () => es.close();
  }, []);

  const runScan = useCallback(async () => {
    setError(null);
    setLoading({ '15m': true, '1h': true, '4h': true, '1d': true });

    // Fire all 4 timeframe scans in parallel
    const scanPromises = TF_ORDER.map(async (tf) => {
      const interval = TF_INTERVALS[tf];
      try {
        const res = await api.get(`/kumo-breakout/scan/${interval}`);
        setResults(prev => ({ ...prev, [tf]: res.data.matches }));
        setLoading(prev => ({ ...prev, [tf]: false }));
        return { tf, success: true, count: res.data.matches.length };
      } catch (err) {
        setLoading(prev => ({ ...prev, [tf]: false }));
        return { tf, success: false, error: err.response?.data?.error || err.message };
      }
    });

    const scanResults = await Promise.all(scanPromises);
    const failed = scanResults.filter(r => !r.success);
    if (failed.length > 0) {
      setError(`Some scans failed: ${failed.map(f => `${f.tf}: ${f.error}`).join(', ')}`);
    }
    setLastScan(Date.now());
  }, []);

  const startScheduler = useCallback(async () => {
    try {
      const res = await api.post('/kumo-breakout/start');
      setSchedulerStatus(res.data.status);
    } catch {}
  }, []);

  const stopScheduler = useCallback(async () => {
    try {
      const res = await api.post('/kumo-breakout/stop');
      setSchedulerStatus(res.data.status);
    } catch {}
  }, []);

  const totalMatches = TF_ORDER.reduce((sum, tf) => sum + (results[tf]?.length || 0), 0);
  const anyLoading = Object.values(loading).some(Boolean);
  const hasResults = totalMatches > 0 || lastScan;

  // Build scan info per interval from scheduler status
  const scanInfoMap = {};
  if (schedulerStatus?.intervals) {
    for (const [interval, info] of Object.entries(schedulerStatus.intervals)) {
      const tf = INTERVAL_TO_TF[interval];
      if (tf) scanInfoMap[tf] = info;
    }
  }

  return (
    <div className="kb-page">
      <div className="kb-toolbar">
        <div className="kb-toolbar-left">
          <h1>Kumo Breakout Scanner</h1>
          {universe && (
            <span className="kb-universe">
              {universe.total} instruments ({universe.index} indices, {universe.commodity} MCX, {universe.stock} stocks)
            </span>
          )}
        </div>
        <div className="kb-toolbar-right">
          <SchedulerStatus
            status={schedulerStatus}
            onStart={startScheduler}
            onStop={stopScheduler}
          />
          <button className="kb-scan-btn" onClick={runScan} disabled={anyLoading}>
            {anyLoading ? 'Scanning...' : 'Run Scan'}
          </button>
        </div>
      </div>

      {error && <div className="kb-error">{error}</div>}

      {hasResults && (
        <>
          <div className="kb-filters">
            <div className="kb-filter-group">
              <label>Signal</label>
              <select value={filter.signal} onChange={e => setFilter(f => ({ ...f, signal: e.target.value }))}>
                <option value="all">All</option>
                <option value="bullish">Bullish</option>
                <option value="bearish">Bearish</option>
              </select>
            </div>
            <div className="kb-filter-group">
              <label>Category</label>
              <select value={filter.category} onChange={e => setFilter(f => ({ ...f, category: e.target.value }))}>
                <option value="all">All</option>
                <option value="index">Indices</option>
                <option value="commodity">MCX</option>
                <option value="stock">Stocks</option>
              </select>
            </div>
            <div className="kb-filter-group">
              <label>Min Score</label>
              <select value={filter.minScore} onChange={e => setFilter(f => ({ ...f, minScore: Number(e.target.value) }))}>
                <option value={0}>Any</option>
                <option value={3}>3+</option>
                <option value={4}>4+</option>
                <option value={5}>5 only</option>
              </select>
            </div>
            <div className="kb-filter-group kb-tf-filter">
              <label>Timeframes</label>
              <div className="kb-tf-checkboxes">
                {TF_ORDER.map(tf => (
                  <label key={tf} className="kb-tf-checkbox">
                    <input
                      type="checkbox"
                      checked={filter.timeframes.includes(tf)}
                      onChange={e => {
                        setFilter(f => ({
                          ...f,
                          timeframes: e.target.checked
                            ? [...f.timeframes, tf]
                            : f.timeframes.filter(t => t !== tf)
                        }));
                      }}
                    />
                    {TF_LABELS[tf]}
                  </label>
                ))}
              </div>
            </div>
            <div className="kb-stats">
              <span>{totalMatches} total breakouts</span>
              {lastScan && <span className="kb-last-scan">Last scan: {relativeTime(lastScan)}</span>}
            </div>
          </div>

          <div className="kb-results">
            {TF_ORDER.filter(tf => filter.timeframes.includes(tf)).map(tf => (
              <TimeframeSection
                key={tf}
                tfLabel={tf}
                matches={results[tf] || []}
                filter={filter}
                isLoading={loading[tf]}
                scanInfo={scanInfoMap[tf]}
              />
            ))}
          </div>
        </>
      )}

      {!hasResults && !anyLoading && (
        <div className="kb-placeholder">
          <p>Click "Run Scan" to find Kumo Breakout signals across all timeframes.</p>
          <p className="kb-hint">Scans indices, MCX commodities, and all F&O stocks on 15m, 1h, 4h, and Daily charts.</p>
          {schedulerStatus?.running && (
            <p className="kb-hint">Auto-scanner is running — results will appear after the next scheduled scan.</p>
          )}
        </div>
      )}
    </div>
  );
}
