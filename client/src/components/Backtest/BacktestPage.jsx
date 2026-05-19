/**
 * BacktestPage.jsx
 *
 * Walk-forward backtester UI.  Lets the user:
 *   1. Pick patterns (multi-select or "all")
 *   2. Pick an instrument scope (watchlist / macros / all F&O)
 *   3. Pick a timeframe
 *   4. Pick a date window (from / to)
 *   5. Pick a minimum R:R
 *
 * Then renders the resulting report with:
 *   - Summary cards (P&L, win rate, profit factor, max drawdown, expectancy)
 *   - Per-pattern × signal table with sortable columns
 *   - Trade list with outcome chips
 *
 * Date defaults: last 90 days ending today.  Run button blocks while the
 * request is in flight (can take 30-60s for large universes).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api';
import './BacktestPage.css';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtRupee(n) {
  if (n == null || isNaN(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '—';
  return `${(Number(n) * 100).toFixed(1)}%`;
}

function fmtNum(n, digits = 2) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toFixed(digits);
}

function fmtDateShort(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  } catch { return iso.slice(0, 10); }
}

function toInputDate(d) {
  return d.toISOString().slice(0, 10);
}

// ── Small components ──────────────────────────────────────────────────────────

function StatCard({ label, value, sub, cls }) {
  return (
    <div className={`bt-stat ${cls ?? ''}`}>
      <div className="bt-stat-label">{label}</div>
      <div className="bt-stat-value">{value}</div>
      {sub && <div className="bt-stat-sub">{sub}</div>}
    </div>
  );
}

function OutcomeChip({ outcome }) {
  const map = {
    TARGET: { label: '🎯 Target', cls: 'bt-chip--win' },
    SL:     { label: '🛑 SL',     cls: 'bt-chip--loss' },
    OPEN:   { label: '⏳ Open',    cls: 'bt-chip--open' },
  };
  const m = map[outcome] ?? { label: outcome, cls: 'bt-chip--neutral' };
  return <span className={`bt-chip ${m.cls}`}>{m.label}</span>;
}

function SignalChip({ signal }) {
  if (!signal) return null;
  const isBull = signal === 'bullish';
  return (
    <span className={`bt-chip ${isBull ? 'bt-chip--bull' : 'bt-chip--bear'}`}>
      {isBull ? '▲' : '▼'} {signal}
    </span>
  );
}

// ── Configuration form ───────────────────────────────────────────────────────

function ConfigForm({ config, onChange, onRun, running, scopes, patterns }) {
  function update(field, value) {
    onChange({ ...config, [field]: value });
  }
  function togglePattern(id) {
    if (config.patternIds === 'all') {
      // Switch to multi-select with this one deselected
      const all = patterns.map((p) => p.id).filter((x) => x !== id);
      update('patternIds', all);
      return;
    }
    const current = Array.isArray(config.patternIds) ? config.patternIds : [];
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    update('patternIds', next.length === patterns.length ? 'all' : next);
  }
  function selectAllPatterns() {
    update('patternIds', 'all');
  }

  const isAll = config.patternIds === 'all';
  const selectedIds = isAll ? new Set(patterns.map((p) => p.id)) : new Set(config.patternIds);

  return (
    <div className="bt-form">
      {/* Patterns */}
      <div className="bt-field">
        <label className="bt-label">Patterns</label>
        <div className="bt-pattern-row">
          <button
            className={`bt-pattern-chip ${isAll ? 'bt-pattern-chip--active' : ''}`}
            onClick={selectAllPatterns}
          >
            All ({patterns.length})
          </button>
          {patterns.map((p) => (
            <button
              key={p.id}
              className={`bt-pattern-chip ${selectedIds.has(p.id) ? 'bt-pattern-chip--active' : ''}`}
              onClick={() => togglePattern(p.id)}
              title={p.description}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Scope */}
      <div className="bt-field">
        <label className="bt-label">Universe</label>
        <div className="bt-pattern-row">
          {scopes.map((s) => (
            <button
              key={s.id}
              className={`bt-pattern-chip ${config.scope === s.id ? 'bt-pattern-chip--active' : ''}`}
              onClick={() => update('scope', s.id)}
              disabled={s.count === 0}
              title={s.count === 0 ? `${s.label} is empty` : s.label}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Scan Mode */}
      <div className="bt-field">
        <label className="bt-label">Scan Mode</label>
        <div className="bt-scan-mode-group">
          <button
            className={`bt-scan-mode-btn ${config.scanMode === 'closed' ? 'is-active' : ''}`}
            onClick={() => update('scanMode', 'closed')}
          >Closed</button>
          <button
            className={`bt-scan-mode-btn ${config.scanMode === 'spot' ? 'is-active' : ''}`}
            onClick={() => update('scanMode', 'spot')}
          >Spot</button>
        </div>
      </div>

      {/* Interval + Dates + R:R */}
      <div className="bt-row">
        <div className="bt-field">
          <label className="bt-label">Timeframe</label>
          <select
            className="bt-input"
            value={config.interval}
            onChange={(e) => update('interval', e.target.value)}
          >
            <option value="day">Daily (1d)</option>
            <option value="4h">4 Hour</option>
            <option value="60minute">1 Hour</option>
            <option value="15minute">15 Min</option>
          </select>
        </div>

        <div className="bt-field">
          <label className="bt-label">From</label>
          <input
            className="bt-input"
            type="date"
            value={config.fromDate}
            max={config.toDate}
            onChange={(e) => update('fromDate', e.target.value)}
          />
        </div>

        <div className="bt-field">
          <label className="bt-label">To</label>
          <input
            className="bt-input"
            type="date"
            value={config.toDate}
            min={config.fromDate}
            max={toInputDate(new Date())}
            onChange={(e) => update('toDate', e.target.value)}
          />
        </div>

        <div className="bt-field">
          <label className="bt-label">Min R:R</label>
          <input
            className="bt-input"
            type="number"
            step="0.1"
            min="0"
            value={config.minRR}
            onChange={(e) => update('minRR', Number(e.target.value))}
          />
        </div>

        <div className="bt-field bt-field--run">
          <button className="btn btn-primary bt-run-btn" onClick={onRun} disabled={running}>
            {running ? 'Running…' : '▶ Run Backtest'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Summary cards ─────────────────────────────────────────────────────────────

function SummaryCards({ summary }) {
  if (!summary) return null;
  const pnlCls = summary.totalPnl > 0 ? 'bt-stat--up' : summary.totalPnl < 0 ? 'bt-stat--down' : '';
  const wrCls  = summary.winRate >= 0.5 ? 'bt-stat--up' : 'bt-stat--down';
  return (
    <div className="bt-cards">
      <StatCard
        label="Total P&L"
        value={fmtRupee(summary.totalPnl)}
        sub={`${summary.totalTrades} trades · ${summary.open} still open`}
        cls={pnlCls}
      />
      <StatCard
        label="Win Rate"
        value={fmtPct(summary.winRate)}
        sub={`${summary.wins} wins · ${summary.losses} losses`}
        cls={wrCls}
      />
      <StatCard
        label="Profit Factor"
        value={summary.profitFactor != null ? fmtNum(summary.profitFactor) : '∞'}
        sub={`Gross +${fmtRupee(summary.grossProfit)} / -${fmtRupee(-summary.grossLoss)}`}
      />
      <StatCard
        label="Max Drawdown"
        value={fmtRupee(summary.maxDrawdown)}
        sub="Peak-to-trough on cum. P&L"
        cls="bt-stat--down"
      />
      <StatCard
        label="Expectancy"
        value={fmtRupee(summary.expectancy)}
        sub={`per trade · avg R = ${fmtNum(summary.avgR)}`}
      />
    </div>
  );
}

// ── Pattern × Signal performance table ────────────────────────────────────────

function PatternTable({ rows }) {
  if (!rows?.length) return null;
  return (
    <div className="bt-table-wrap">
      <table className="bt-table">
        <thead>
          <tr>
            <th>Pattern</th>
            <th>Signal</th>
            <th>Trades</th>
            <th>Wins</th>
            <th>Losses</th>
            <th>Win %</th>
            <th>Total P&L</th>
            <th>Avg P&L</th>
            <th>Avg R</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const pnlCls = row.totalPnl > 0 ? 'bt-pnl--up' : row.totalPnl < 0 ? 'bt-pnl--down' : '';
            return (
              <tr key={i}>
                <td className="bt-td-pattern">{row.patternId}</td>
                <td><SignalChip signal={row.signal} /></td>
                <td className="bt-td-num">{row.count}</td>
                <td className="bt-td-num bt-pnl--up">{row.wins}</td>
                <td className="bt-td-num bt-pnl--down">{row.losses}</td>
                <td className="bt-td-num">{fmtPct(row.winRate)}</td>
                <td className={`bt-td-num ${pnlCls}`}>{fmtRupee(row.totalPnl)}</td>
                <td className={`bt-td-num ${pnlCls}`}>{fmtRupee(row.avgPnl)}</td>
                <td className="bt-td-num">{fmtNum(row.avgR)}R</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Trade list ────────────────────────────────────────────────────────────────

function TradeTable({ trades }) {
  const [limit, setLimit] = useState(50);
  if (!trades?.length) return null;
  const visible = trades.slice(0, limit);
  return (
    <div className="bt-table-wrap">
      <table className="bt-table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Pattern</th>
            <th>Signal</th>
            <th>Entry Date</th>
            <th>Entry</th>
            <th>SL</th>
            <th>Target</th>
            <th>Exit Date</th>
            <th>Exit</th>
            <th>Bars</th>
            <th>Outcome</th>
            <th>P&L</th>
            <th>R</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((t, i) => {
            const pnlCls = t.pnl > 0 ? 'bt-pnl--up' : t.pnl < 0 ? 'bt-pnl--down' : '';
            return (
              <tr key={i}>
                <td className="bt-td-symbol">{t.symbol}</td>
                <td className="bt-td-pattern">{t.patternId}</td>
                <td><SignalChip signal={t.signal} /></td>
                <td className="bt-td-date">{fmtDateShort(t.entryDate)}</td>
                <td className="bt-td-num">{fmtNum(t.entryPrice)}</td>
                <td className="bt-td-num bt-pnl--down">{fmtNum(t.sl)}</td>
                <td className="bt-td-num bt-pnl--up">{fmtNum(t.target)}</td>
                <td className="bt-td-date">{fmtDateShort(t.exitDate)}</td>
                <td className="bt-td-num">{fmtNum(t.exitPrice)}</td>
                <td className="bt-td-num">{t.barsHeld}</td>
                <td><OutcomeChip outcome={t.outcome} /></td>
                <td className={`bt-td-num ${pnlCls}`}>{fmtRupee(t.pnl)}</td>
                <td className={`bt-td-num ${pnlCls}`}>{fmtNum(t.rMultiple)}R</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {trades.length > limit && (
        <div className="bt-table-more">
          <button className="btn btn-ghost btn-sm" onClick={() => setLimit(limit + 100)}>
            Show 100 more ({trades.length - limit} remaining)
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function BacktestPage() {
  const today = useMemo(() => new Date(), []);
  const ninetyAgo = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return d;
  }, []);

  const [config, setConfig] = useState({
    patternIds: 'all',
    scope:      'watchlist',
    interval:   'day',
    fromDate:   toInputDate(ninetyAgo),
    toDate:     toInputDate(today),
    minRR:      2.0,
    scanMode:   'closed',
  });

  const [scopes,   setScopes]   = useState([]);
  const [patterns, setPatterns] = useState([]);
  const [running,  setRunning]  = useState(false);
  const [error,    setError]    = useState(null);
  const [report,   setReport]   = useState(null);

  // Load scopes + patterns on mount
  useEffect(() => {
    api.get('/backtest/scopes')
      .then((r) => {
        setScopes(r.data.scopes ?? []);
        setPatterns(r.data.patterns ?? []);
      })
      .catch((err) => setError(err.response?.data?.error ?? err.message));
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      const body = { ...config };
      const r = await api.post('/backtest/run', body);
      setReport(r.data);
    } catch (err) {
      setError(err.response?.data?.error ?? err.message ?? 'Backtest failed');
    } finally {
      setRunning(false);
    }
  }, [config]);

  return (
    <div className="bt-page">
      <div className="bt-header">
        <h1 className="bt-title">Backtest</h1>
        <span className="bt-subtitle">Walk-forward simulation of Ichimoku patterns over historical candles</span>
      </div>

      <ConfigForm
        config={config}
        onChange={setConfig}
        onRun={run}
        running={running}
        scopes={scopes}
        patterns={patterns}
      />

      {error && <div className="bt-error">⚠ {error}</div>}

      {running && (
        <div className="bt-running">
          <div className="bt-spinner" />
          <div>
            Running backtest — this can take 30–60 seconds for the F&O universe.
            <br/>
            <small>Check server logs for progress.</small>
          </div>
        </div>
      )}

      {report && !running && (
        <>
          <SummaryCards summary={report.summary} />

          {/* Params summary */}
          <div className="bt-params">
            <span><b>{report.params.fromDate}</b> → <b>{report.params.toDate}</b></span>
            <span>·</span>
            <span>{report.params.interval}</span>
            <span>·</span>
            <span>{report.params.instrumentCount} instruments</span>
            <span>·</span>
            <span>min R:R 1:{report.params.minRR}</span>
            <span>·</span>
            <span>{report.params.scanMode === 'spot' ? 'Spot candle' : 'Closed candle'}</span>
            <span>·</span>
            <span>{report.params.elapsedSec}s</span>
            {report.params.failed?.length > 0 && (
              <span className="bt-params-fail">
                · {report.params.failed.length} failed
              </span>
            )}
          </div>

          <section className="bt-section">
            <h2 className="bt-section-title">Pattern × Signal Performance</h2>
            <PatternTable rows={report.byPattern} />
          </section>

          <section className="bt-section">
            <h2 className="bt-section-title">Trade Log ({report.trades.length})</h2>
            <TradeTable trades={report.trades} />
          </section>
        </>
      )}
    </div>
  );
}
