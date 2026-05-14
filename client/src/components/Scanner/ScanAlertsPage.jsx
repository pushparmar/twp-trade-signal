import { useState, useMemo } from 'react';
import useAppStore from '../../store/appStore';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function relativeTime(ts) {
  if (!ts) return '—';
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60)  return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

// ── Score dots ────────────────────────────────────────────────────────────────

function ScoreDots({ score, signal }) {
  if (score == null) return <span className="scan-score-na">—</span>;
  const total = 5;
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

// ── Filter bar ────────────────────────────────────────────────────────────────

function FilterBar({ signal, onSignal, interval, onInterval }) {
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
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ScanAlertsPage() {
  const scanAlerts          = useAppStore((s) => s.scanAlerts);
  const setSelectedInstrument = useAppStore((s) => s.setSelectedInstrument);

  const [signalFilter,   setSignalFilter]   = useState('all');
  const [intervalFilter, setIntervalFilter] = useState('all');

  const filtered = useMemo(() => {
    return scanAlerts.filter((a) => {
      if (signalFilter   !== 'all' && a.signal   !== signalFilter)   return false;
      if (intervalFilter !== 'all' && a.interval !== intervalFilter) return false;
      return true;
    });
  }, [scanAlerts, signalFilter, intervalFilter]);

  function handleSelect(alert) {
    setSelectedInstrument({
      type:     'stock',
      token:    alert.token,
      label:    alert.label,
      sublabel: alert.interval,
    });
  }

  return (
    <div className="page scanner-page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Scanner</h2>
          <p className="page-sub">
            Real-time Ichimoku pattern alerts for subscribed instruments
            {scanAlerts.length > 0 && (
              <span className="scan-count-badge">{scanAlerts.length} alert{scanAlerts.length !== 1 ? 's' : ''}</span>
            )}
          </p>
        </div>
      </div>

      <FilterBar
        signal={signalFilter}   onSignal={setSignalFilter}
        interval={intervalFilter} onInterval={setIntervalFilter}
      />

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
              ? 'No pattern alerts yet. Alerts appear here when an Ichimoku pattern fires on any subscribed instrument.'
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
                  key={`${alert.token}:${alert.interval}:${alert.patternId}`}
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
