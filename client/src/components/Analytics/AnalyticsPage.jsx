/**
 * AnalyticsPage.jsx
 *
 * Pattern performance dashboard — surfaces three MongoDB-backed datasets:
 *
 *   1. Alert Frequency  — which patterns fire most often (from scan_alerts)
 *   2. Trade Win Rate   — pattern → paper-trade outcome correlation
 *   3. Daily P&L        — closed trade P&L grouped by IST date
 *
 * All data is fetched from GET /api/analytics/summary on mount and on
 * manual refresh. When MongoDB is not configured, a clear "DB not connected"
 * state is shown without breaking the rest of the app.
 */

import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import './AnalyticsPage.css';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt2(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toFixed(2);
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '—';
  return `${(Number(n) * 100).toFixed(0)}%`;
}

function fmtPnl(n) {
  if (n == null || isNaN(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function SignalBadge({ signal }) {
  if (!signal) return null;
  return (
    <span className={`an-signal-badge an-signal-badge--${signal}`}>
      {signal === 'bullish' ? '▲' : '▼'} {signal}
    </span>
  );
}

// ── Empty / loading / error states ───────────────────────────────────────────

function EmptyState({ icon, message }) {
  return (
    <div className="an-empty">
      <span className="an-empty-icon">{icon}</span>
      <span className="an-empty-msg">{message}</span>
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({ title, subtitle, children }) {
  return (
    <section className="an-section">
      <div className="an-section-header">
        <h2 className="an-section-title">{title}</h2>
        {subtitle && <span className="an-section-sub">{subtitle}</span>}
      </div>
      {children}
    </section>
  );
}

// ── 1. Pattern Alert Frequency table ─────────────────────────────────────────

function PatternStatsTable({ rows }) {
  if (!rows || rows.length === 0) {
    return <EmptyState icon="📭" message="No scan alerts in MongoDB yet. Run a scan or wait for the background scanner to fire." />;
  }

  // Max count for the relative bar width
  const maxCount = Math.max(...rows.map((r) => r.count), 1);

  return (
    <div className="an-table-wrap">
      <table className="an-table">
        <thead>
          <tr>
            <th>Pattern</th>
            <th>Signal</th>
            <th>Alerts</th>
            <th>Frequency</th>
            <th>Avg Score</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td className="an-td-pattern">{row._id?.patternId ?? '—'}</td>
              <td><SignalBadge signal={row._id?.signal} /></td>
              <td className="an-td-num">{row.count}</td>
              <td>
                <div className="an-bar-cell">
                  <div
                    className={`an-bar an-bar--${row._id?.signal ?? 'neutral'}`}
                    style={{ width: `${Math.round((row.count / maxCount) * 100)}%` }}
                  />
                  <span className="an-bar-label">{row.count}</span>
                </div>
              </td>
              <td className="an-td-num">{row.avgScore != null ? fmt2(row.avgScore) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── 2. Pattern Win Rate table ─────────────────────────────────────────────────

function WinRateTable({ rows }) {
  if (!rows || rows.length === 0) {
    return <EmptyState icon="📈" message="No closed paper trades linked to a pattern yet. Place and close some trades from the Scanner tab." />;
  }

  return (
    <div className="an-table-wrap">
      <table className="an-table">
        <thead>
          <tr>
            <th>Pattern</th>
            <th>Trades</th>
            <th>Wins</th>
            <th>Win Rate</th>
            <th>Avg P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const winPct = row.winRate ?? 0;
            const avgPnl = row.avgPnl ?? 0;
            return (
              <tr key={i}>
                <td className="an-td-pattern">{row._id ?? '—'}</td>
                <td className="an-td-num">{row.count}</td>
                <td className="an-td-num">{row.wins}</td>
                <td>
                  <div className="an-winbar-cell">
                    <div className="an-winbar-track">
                      <div
                        className="an-winbar-fill"
                        style={{ width: `${Math.round(winPct * 100)}%` }}
                      />
                    </div>
                    <span className="an-winbar-label">{fmtPct(winPct)}</span>
                  </div>
                </td>
                <td className={`an-td-num an-pnl ${avgPnl >= 0 ? 'an-pnl--pos' : 'an-pnl--neg'}`}>
                  {fmtPnl(avgPnl)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── 3. Daily P&L table ────────────────────────────────────────────────────────

function DailyPnlTable({ rows }) {
  if (!rows || rows.length === 0) {
    return <EmptyState icon="📅" message="No closed paper trades yet. P&L will appear here after trades are closed." />;
  }

  const maxAbsPnl = Math.max(...rows.map((r) => Math.abs(r.totalPnl ?? 0)), 1);

  return (
    <div className="an-table-wrap">
      <table className="an-table">
        <thead>
          <tr>
            <th>Date (IST)</th>
            <th>Trades</th>
            <th>Wins</th>
            <th>Losses</th>
            <th>Total P&amp;L</th>
            <th>Chart</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const pnl     = row.totalPnl ?? 0;
            const barPct  = Math.round((Math.abs(pnl) / maxAbsPnl) * 100);
            return (
              <tr key={i}>
                <td className="an-td-date">{row._id}</td>
                <td className="an-td-num">{row.count}</td>
                <td className="an-td-num an-pnl--pos">{row.wins}</td>
                <td className="an-td-num an-pnl--neg">{row.losses}</td>
                <td className={`an-td-num an-pnl ${pnl >= 0 ? 'an-pnl--pos' : 'an-pnl--neg'}`}>
                  {fmtPnl(pnl)}
                </td>
                <td>
                  <div className="an-bar-cell">
                    <div
                      className={`an-bar ${pnl >= 0 ? 'an-bar--bullish' : 'an-bar--bearish'}`}
                      style={{ width: `${barPct}%` }}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Summary stat cards ────────────────────────────────────────────────────────

function SummaryCards({ patternStats, winRate, dailyPnl }) {
  const totalAlerts = patternStats.reduce((s, r) => s + (r.count ?? 0), 0);
  const totalTrades = winRate.reduce((s, r) => s + (r.count ?? 0), 0);
  const totalWins   = winRate.reduce((s, r) => s + (r.wins ?? 0), 0);
  const overallWr   = totalTrades > 0 ? totalWins / totalTrades : null;
  const cumulativePnl = dailyPnl.reduce((s, r) => s + (r.totalPnl ?? 0), 0);

  return (
    <div className="an-cards">
      <div className="an-card">
        <div className="an-card-value">{totalAlerts.toLocaleString('en-IN')}</div>
        <div className="an-card-label">Scan Alerts (DB)</div>
      </div>
      <div className="an-card">
        <div className="an-card-value">{totalTrades}</div>
        <div className="an-card-label">Paper Trades (DB)</div>
      </div>
      <div className="an-card">
        <div className={`an-card-value ${overallWr != null ? (overallWr >= 0.5 ? 'an-pnl--pos' : 'an-pnl--neg') : ''}`}>
          {overallWr != null ? fmtPct(overallWr) : '—'}
        </div>
        <div className="an-card-label">Overall Win Rate</div>
      </div>
      <div className="an-card">
        <div className={`an-card-value ${cumulativePnl >= 0 ? 'an-pnl--pos' : 'an-pnl--neg'}`}>
          {fmtPnl(cumulativePnl)}
        </div>
        <div className="an-card-label">Cumulative P&amp;L</div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const EXCHANGES = [
  { key: 'all', label: 'All' },
  { key: 'NSE', label: 'NSE / NFO' },
  { key: 'MCX', label: 'MCX' },
];

export default function AnalyticsPage() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [exchange, setExchange] = useState('all'); // 'all' | 'NSE' | 'MCX'

  const fetchData = useCallback(async (exch = exchange) => {
    setLoading(true);
    setError(null);
    try {
      const params = exch !== 'all' ? { exchange: exch } : {};
      const res = await api.get('/analytics/summary', { params });
      setData(res.data);
    } catch (err) {
      setError(err.response?.data?.error ?? err.message ?? 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, [exchange]);

  useEffect(() => { fetchData(); }, [fetchData]);

  function handleExchangeChange(exch) {
    setExchange(exch);
    fetchData(exch);
  }

  return (
    <div className="an-page">
      {/* Header */}
      <div className="an-header">
        <div className="an-header-left">
          <h1 className="an-title">Pattern Analytics</h1>
          <span className="an-subtitle">MongoDB-backed performance data</span>
        </div>
        {/* Exchange filter tabs */}
        <div className="an-exchange-tabs">
          {EXCHANGES.map(e => (
            <button
              key={e.key}
              className={`an-exchange-tab${exchange === e.key ? ' an-exchange-tab--active' : ''}`}
              onClick={() => handleExchangeChange(e.key)}
              disabled={loading}
            >
              {e.label}
            </button>
          ))}
        </div>
        <button className="an-refresh-btn" onClick={() => fetchData(exchange)} disabled={loading} title="Refresh data">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={loading ? 'an-spin' : ''}
          >
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="an-error-banner">
          ⚠ {error}
        </div>
      )}

      {/* DB not connected notice */}
      {!loading && data && !data.dbReady && (
        <div className="an-db-notice">
          <strong>MongoDB not connected.</strong> Add <code>MONGODB_URI</code> to your server <code>.env</code> file
          and restart to enable pattern analytics persistence.
        </div>
      )}

      {/* Content */}
      {!loading && data?.dbReady && (
        <>
          <SummaryCards
            patternStats={data.patternStats}
            winRate={data.winRate}
            dailyPnl={data.dailyPnl}
          />

          <Section
            title="Alert Frequency"
            subtitle="How often each pattern fires — from all scan sources (manual, background, live)"
          >
            <PatternStatsTable rows={data.patternStats} />
          </Section>

          <Section
            title="Pattern Win Rate"
            subtitle="Paper trade outcomes grouped by the pattern that triggered the entry"
          >
            <WinRateTable rows={data.winRate} />
          </Section>

          <Section
            title="Daily P&L"
            subtitle="Closed paper trade P&L aggregated by IST date, newest first"
          >
            <DailyPnlTable rows={data.dailyPnl} />
          </Section>
        </>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="an-loading">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="an-skeleton" />
          ))}
        </div>
      )}
    </div>
  );
}
