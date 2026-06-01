import { useState, useEffect } from 'react';
import useIndexTrade from './useIndexTrade';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Inject mobile styles once
const MOBILE_STYLE_ID = 'idx-trade-mobile-css';
if (typeof document !== 'undefined' && !document.getElementById(MOBILE_STYLE_ID)) {
  const style = document.createElement('style');
  style.id = MOBILE_STYLE_ID;
  style.textContent = `
    @media (max-width: 768px) {
      .idx-ohl-cell { display: none !important; }
    }
  `;
  document.head.appendChild(style);
}

function fmtPrice(v) {
  if (v == null) return '—';
  return Number(v).toFixed(2);
}

function fmtPnl(v) {
  if (v == null) return '—';
  const n = Number(v);
  const sign = n >= 0 ? '+' : '';
  return `${sign}₹${n.toFixed(2)}`;
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// ── CSV Export ──────────────────────────────────────────────────────────────

/**
 * Serialise a cell value for CSV output.
 * Wraps in double-quotes if the value contains commas, quotes, or newlines.
 */
function _csvCell(value) {
  const s = String(value ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

/**
 * Build and trigger a CSV download for the supplied closed trades array.
 * Pure client-side — no server round-trip required.
 *
 * Columns:
 *   Date · Time · Index · Symbol · Strike · Type · Action
 *   Strategy · Pattern · TF
 *   Entry · AvgEntry (LP only) · Exit · Lots · LotSize
 *   PnL · ExitReason · RR · InitialSL · Target
 */
function exportToCSV(trades) {
  if (!trades || trades.length === 0) return;

  const HEADERS = [
    'Date', 'Time', 'Index', 'Symbol', 'Strike', 'Type',
    'Action', 'Strategy', 'Pattern', 'TF',
    'Entry', 'AvgEntry', 'Exit', 'Lots', 'LotSize',
    'PnL', 'ExitReason', 'RR', 'InitialSL', 'Target',
  ];

  const rows = trades
    // Most-recent first in the file
    .slice()
    .sort((a, b) => (b.closedTs || 0) - (a.closedTs || 0))
    .map(t => {
      const dateStr = t.closedTs
        ? new Date(t.closedTs + IST_OFFSET_MS).toISOString().slice(0, 10)
        : '';
      const timeStr = t.closedTs
        ? new Date(t.closedTs).toLocaleTimeString('en-IN', {
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
          })
        : '';

      const isLp   = t.strategyType === 'low-premium';
      const lots   = t.lotCount ?? t.quantity ?? 1;
      const symbol = `${t.strike ?? ''} ${t.optionType ?? ''}`.trim();

      return [
        dateStr,
        timeStr,
        t.index        ?? '',
        symbol,
        t.strike       ?? '',
        t.optionType   ?? '',
        t.action       ?? '',
        isLp ? 'Low Premium' : 'Pattern',
        isLp ? 'LP Scalper' : (t.patternLabel || t.patternId || ''),
        t.tfLabel      ?? '',
        t.entryPrice   ?? '',
        // AvgEntry: only meaningful after an avg-down; blank for pattern trades
        isLp && t.avgPrice != null ? t.avgPrice : '',
        t.exitPrice    ?? '',
        lots,
        t.lotSize      ?? 1,
        t.pnl          ?? '',
        t.exitReason   ?? '',
        t.rrRatio      ?? '',
        t.initialSl    ?? '',
        t.target       ?? '',
      ].map(_csvCell).join(',');
    });

  const csv  = [HEADERS.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);

  const anchor    = document.createElement('a');
  anchor.href     = url;
  anchor.download = `index-trades-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ── Status Bar ──────────────────────────────────────────────────────────────

function StatusBar({ status, config, onToggle, onRefreshStrikes, sseConnected }) {
  const [refreshing, setRefreshing] = useState(false);

  if (!status) return <div className="settings-group"><p className="diag-hint">Loading status…</p></div>;

  const subs = status.subscriptions || {};
  const scannerStats = status.scanner || {};
  const hasStrikes = Object.keys(subs).length > 0;

  async function handleRefreshStrikes() {
    setRefreshing(true);
    await onRefreshStrikes();
    setRefreshing(false);
  }

  return (
    <div className="settings-group" style={{ padding: '12px 16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div
            className={`conn-status-btn ${config?.enabled ? 'conn-status-btn--green' : 'conn-status-btn--red'}`}
            style={{ cursor: 'pointer' }}
            onClick={onToggle}
          >
            <span className="conn-dot" />
            <span>{config?.enabled ? 'Scanner ON' : 'Scanner OFF'}</span>
          </div>
          {scannerStats.scanning && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {scannerStats.tokenCount} instruments · {scannerStats.matchCount} matches
            </span>
          )}
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11,
            color: sseConnected ? '#51cf66' : '#ff6b6b' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%',
              background: sseConnected ? '#51cf66' : '#ff6b6b', display: 'inline-block' }} />
            {sseConnected ? 'Live' : 'Reconnecting…'}
          </span>
          {!hasStrikes && (
            <span style={{ fontSize: 12, color: '#ff6b6b' }}>
              ⚠ No strikes — Kite session may have expired
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 12, flexWrap: 'wrap' }}>
          {Object.entries(subs).map(([index, data]) => (
            <span key={index} style={{ color: 'var(--text-muted)' }}>
              <strong>{index}</strong> ATM {data.atmStrike} · {data.tokenCount} strikes
            </span>
          ))}
          <button
            className="btn btn-sm btn-secondary"
            onClick={handleRefreshStrikes}
            disabled={refreshing}
            style={{ fontSize: 11, padding: '2px 8px' }}
          >
            {refreshing ? '…' : '↻ Refresh Strikes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── PnL Summary ─────────────────────────────────────────────────────────────

function PnlSummary({ pnl }) {
  if (!pnl) return null;

  return (
    <div style={{
      display: 'flex', gap: 16, flexWrap: 'wrap', padding: '10px 16px',
      background: 'var(--bg-secondary)', borderRadius: 8, marginBottom: 12,
    }}>
      <StatBox label="Today's PnL" value={fmtPnl(pnl.totalPnl)} color={pnl.totalPnl >= 0 ? '#51cf66' : '#ff6b6b'} />
      <StatBox label="Wins" value={pnl.winCount} color="#51cf66" />
      <StatBox label="Losses" value={pnl.lossCount} color="#ff6b6b" />
      <StatBox label="Win Rate" value={`${pnl.winRate}%`} color="var(--text-primary)" />
      <StatBox label="Open" value={pnl.openCount} color="#4dabf7" />
    </div>
  );
}

function StatBox({ label, value, color }) {
  return (
    <div style={{ textAlign: 'center', minWidth: 60 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 600, color }}>{value}</div>
    </div>
  );
}

// ── Open Trades Panel ───────────────────────────────────────────────────────

function OpenTradesPanel({ trades, tradeTicks, onClose }) {
  if (trades.length === 0) {
    return (
      <div className="settings-group">
        <h3>Open Paper Trades</h3>
        <p className="diag-hint">No open trades</p>
      </div>
    );
  }

  return (
    <div className="settings-group">
      <h3>Open Paper Trades ({trades.length})</h3>
      <div style={{ overflowX: 'auto' }}>
        <table className="diag-table" style={{ fontSize: 12, width: '100%' }}>
          <thead>
            <tr>
              <th>Index</th>
              <th>Symbol</th>
              <th>Action</th>
              <th>Pattern</th>
              <th>TF</th>
              <th>Entry</th>
              <th>LTP</th>
              <th>PnL</th>
              <th>SL</th>
              <th>Target</th>
              <th>TSL</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {trades.map(t => {
              const tick = tradeTicks[t.id];
              const ltp = tick?.ltp ?? t.entryPrice;
              const unrealizedPnl = tick?.unrealizedPnl ?? 0;
              const isTsl = tick?.tslActivated || t.tslActivated;
              const isLp = t.strategyType === 'low-premium';
              // Live avg price from tick (updated after avg-down), fall back to trade field
              const displayAvg = tick?.avgPrice ?? t.avgPrice ?? null;
              const displayLots = tick?.lotCount ?? t.lotCount ?? 1;
              const hasAvgdDown = isLp && (t.avgDownCount ?? 0) > 0;

              return (
                <tr key={t.id}>
                  <td>{t.index}</td>
                  <td style={{ fontWeight: 500 }}>
                    {t.strike} {t.optionType}
                  </td>
                  <td>
                    <span style={{
                      color: t.action === 'BUY' ? '#51cf66' : '#ff6b6b',
                      fontWeight: 600,
                    }}>
                      {t.action}
                    </span>
                  </td>
                  <td>
                    {isLp
                      ? (
                        <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                          <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: '#fab00522', color: '#fab005', fontWeight: 700 }}>
                            💰 LP {displayLots > 1 ? `×${displayLots}` : ''}
                          </span>
                          {hasAvgdDown && displayAvg != null && (
                            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>avg ₹{fmtPrice(displayAvg)}</span>
                          )}
                        </span>
                      )
                      : (t.patternLabel || t.patternId)}
                  </td>
                  <td>{t.tfLabel}</td>
                  <td>
                    {fmtPrice(t.entryPrice)}
                    {hasAvgdDown && displayAvg != null && (
                      <div style={{ fontSize: 10, color: '#fab005' }}>avg ₹{fmtPrice(displayAvg)}</div>
                    )}
                  </td>
                  <td style={{ fontWeight: 500 }}>{fmtPrice(ltp)}</td>
                  <td style={{
                    fontWeight: 600,
                    color: unrealizedPnl >= 0 ? '#51cf66' : '#ff6b6b',
                  }}>
                    {fmtPnl(unrealizedPnl)}
                  </td>
                  <td>{fmtPrice(tick?.sl ?? t.sl)}</td>
                  <td>{fmtPrice(t.target)}</td>
                  <td>{isTsl ? '🔒' : isLp && !isTsl && (t.avgDownAt != null) ? '⏳' : '—'}</td>
                  <td>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => onClose(t.id, ltp)}
                      style={{ fontSize: 10, padding: '2px 6px' }}
                    >
                      Close
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Order History ───────────────────────────────────────────────────────────

/**
 * @param {object[]} trades       - Today's closed trades (for the table display)
 * @param {object[]} allTrades    - Full closed trade history (for CSV export)
 */
function OrderHistory({ trades, allTrades }) {
  const [expanded, setExpanded] = useState(true);

  if (trades.length === 0) {
    return (
      <div className="settings-group">
        <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Today&apos;s Closed Trades</span>
          {allTrades && allTrades.length > 0 && (
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => exportToCSV(allTrades)}
              style={{ fontSize: 11, padding: '2px 8px', fontWeight: 400 }}
              title={`Export all ${allTrades.length} closed trades to CSV`}
            >
              ⬇ Export CSV
            </button>
          )}
        </h3>
        <p className="diag-hint">No closed trades today</p>
      </div>
    );
  }

  const todayPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const wins   = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;

  return (
    <div className="settings-group">
      <h3
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
        onClick={() => setExpanded(prev => !prev)}
      >
        {/* Left side: title + today's stats */}
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
          <span>Today&apos;s Closed Trades ({trades.length})</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: todayPnl >= 0 ? '#51cf66' : '#ff6b6b' }}>
            {fmtPnl(todayPnl)}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            W:{wins} L:{losses}
          </span>
        </span>

        {/* Right side: export button + collapse chevron */}
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {allTrades && allTrades.length > 0 && (
            <button
              className="btn btn-sm btn-secondary"
              onClick={(e) => { e.stopPropagation(); exportToCSV(allTrades); }}
              style={{ fontSize: 11, padding: '2px 8px', fontWeight: 400 }}
              title={`Export all ${allTrades.length} closed trades to CSV`}
            >
              ⬇ Export CSV
            </button>
          )}
          <span style={{ fontSize: 12 }}>{expanded ? '▼' : '▶'}</span>
        </span>
      </h3>
      {expanded && (
        <div style={{ overflowX: 'auto' }}>
          <table className="diag-table" style={{ fontSize: 12, width: '100%' }}>
            <thead>
              <tr>
                <th>Time</th>
                <th>Index</th>
                <th>Symbol</th>
                <th>Action</th>
                <th>Pattern</th>
                <th>TF</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>PnL</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {trades.map(t => (
                <tr key={t.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(t.closedTs)}</td>
                  <td>{t.index}</td>
                  <td style={{ fontWeight: 500 }}>{t.strike} {t.optionType}</td>
                  <td>
                    <span style={{ color: t.action === 'BUY' ? '#51cf66' : '#ff6b6b' }}>
                      {t.action}
                    </span>
                  </td>
                  <td>
                    {t.strategyType === 'low-premium'
                      ? <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: '#fab00522', color: '#fab005', fontWeight: 700 }}>💰 LP</span>
                      : (t.patternLabel || t.patternId)}
                  </td>
                  <td>{t.tfLabel}</td>
                  <td>{fmtPrice(t.entryPrice)}</td>
                  <td>{fmtPrice(t.exitPrice)}</td>
                  <td style={{
                    fontWeight: 600,
                    color: (t.pnl || 0) >= 0 ? '#51cf66' : '#ff6b6b',
                  }}>
                    {fmtPnl(t.pnl)}
                  </td>
                  <td>
                    <span style={{
                      fontSize: 10, padding: '1px 4px', borderRadius: 3,
                      background: t.exitReason === 'target' ? '#51cf6622' : '#ff6b6b22',
                      color: t.exitReason === 'target' ? '#51cf66' : '#ff6b6b',
                    }}>
                      {(t.exitReason || 'manual').toUpperCase()}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Recent Alerts Feed ──────────────────────────────────────────────────────

function AlertFeed({ alerts }) {
  if (alerts.length === 0) return null;

  return (
    <div className="settings-group">
      <h3>Recent Signals ({alerts.length})</h3>
      <div style={{ maxHeight: 200, overflowY: 'auto' }}>
        {alerts.slice(0, 20).map((a, i) => (
          <div key={i} style={{
            display: 'flex', gap: 8, alignItems: 'center',
            padding: '4px 0', borderBottom: '1px solid var(--border)',
            fontSize: 12,
          }}>
            <span style={{
              color: a.signal === 'bullish' ? '#51cf66' : '#ff6b6b',
              fontWeight: 600, minWidth: 16,
            }}>
              {a.signal === 'bullish' ? '▲' : '▼'}
            </span>
            <span style={{ fontWeight: 500 }}>{a.index}</span>
            <span>{a.strike} {a.optionType}</span>
            <span style={{ color: 'var(--text-muted)' }}>{a.patternLabel}</span>
            <span style={{ color: 'var(--text-muted)' }}>{a.tfLabel}</span>
            <span>@{fmtPrice(a.close)}</span>
            {a.rsi14 != null && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                RSI <strong style={{ color: 'var(--text-primary)' }}>{a.rsi14}</strong>
              </span>
            )}
            <span style={{ color: 'var(--text-muted)', marginLeft: 'auto' }}>
              {fmtTime(a.ts)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Option Chain Table ─────────────────────────────────────────────────────

function OptionChainTable({ optionChain, onRefresh }) {
  const [expanded, setExpanded] = useState(true);
  const hasData = optionChain && Object.keys(optionChain).length > 0;

  return (
    <div className="settings-group">
      <h3
        style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        onClick={() => setExpanded(prev => !prev)}
      >
        <span>Subscribed Strikes</span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className="btn btn-sm btn-secondary"
            onClick={(e) => { e.stopPropagation(); onRefresh(); }}
            style={{ fontSize: 10, padding: '2px 8px' }}
          >
            Refresh
          </button>
          <span style={{ fontSize: 12 }}>{expanded ? '▼' : '▶'}</span>
        </span>
      </h3>
      {expanded && (
        hasData
          ? Object.entries(optionChain).map(([indexName, data]) => (
              <OptionChainIndex key={indexName} indexName={indexName} data={data} />
            ))
          : <p className="diag-hint">No subscriptions — strikes load during market hours (9:15–15:30 IST)</p>
      )}
    </div>
  );
}

function OptionChainIndex({ indexName, data }) {
  const { atmStrike, spotLtp, expiry, strikes } = data;
  if (!strikes || strikes.length === 0) return null;

  const expiryLabel = expiry
    ? new Date(expiry).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        display: 'flex', gap: 16, alignItems: 'center', padding: '6px 0',
        fontSize: 12, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)',
      }}>
        <strong style={{ color: 'var(--text-primary)', fontSize: 13 }}>{indexName}</strong>
        <span>Spot: <strong style={{ color: 'var(--text-primary)' }}>{fmtPrice(spotLtp)}</strong></span>
        <span>ATM: {atmStrike}</span>
        <span>Expiry: {expiryLabel}</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="diag-table" style={{ fontSize: 12, width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'right', color: '#51cf66' }}>Chg%</th>
              <th style={{ textAlign: 'right', color: '#51cf66' }}>CE LTP</th>
              <th className="idx-ohl-cell" style={{ textAlign: 'right', color: '#51cf66', fontSize: 10 }}>Open</th>
              <th className="idx-ohl-cell" style={{ textAlign: 'right', color: '#51cf66', fontSize: 10 }}>High</th>
              <th className="idx-ohl-cell" style={{ textAlign: 'right', color: '#51cf66', fontSize: 10 }}>Low</th>
              <th style={{ textAlign: 'center' }}>Strike</th>
              <th className="idx-ohl-cell" style={{ textAlign: 'left', color: '#ff6b6b', fontSize: 10 }}>Low</th>
              <th className="idx-ohl-cell" style={{ textAlign: 'left', color: '#ff6b6b', fontSize: 10 }}>High</th>
              <th className="idx-ohl-cell" style={{ textAlign: 'left', color: '#ff6b6b', fontSize: 10 }}>Open</th>
              <th style={{ textAlign: 'left', color: '#ff6b6b' }}>PE LTP</th>
              <th style={{ textAlign: 'left', color: '#ff6b6b' }}>Chg%</th>
            </tr>
          </thead>
          <tbody>
            {strikes.map(row => {
              const isAtm = row.strike === atmStrike;
              const rowStyle = isAtm
                ? { background: 'rgba(77, 171, 247, 0.1)', fontWeight: 600 }
                : {};
              const ceChg = row.ce?.changePct;
              const peChg = row.pe?.changePct;

              return (
                <tr key={row.strike} style={rowStyle}>
                  <td style={{
                    textAlign: 'right', fontSize: 11, fontWeight: 500,
                    color: ceChg > 0 ? '#51cf66' : ceChg < 0 ? '#ff6b6b' : 'var(--text-muted)',
                  }}>
                    {ceChg != null ? `${ceChg > 0 ? '+' : ''}${ceChg}%` : '—'}
                  </td>
                  <td style={{
                    textAlign: 'right', fontWeight: 600,
                    color: row.ce?.ltp != null ? '#51cf66' : 'var(--text-muted)',
                  }}>
                    {fmtPrice(row.ce?.ltp)}
                  </td>
                  <td className="idx-ohl-cell" style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-muted)' }}>
                    {fmtPrice(row.ce?.dayOpen)}
                  </td>
                  <td className="idx-ohl-cell" style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-muted)' }}>
                    {fmtPrice(row.ce?.dayHigh)}
                  </td>
                  <td className="idx-ohl-cell" style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-muted)' }}>
                    {fmtPrice(row.ce?.dayLow)}
                  </td>
                  <td style={{
                    textAlign: 'center', fontWeight: 600,
                    color: isAtm ? '#4dabf7' : 'var(--text-primary)',
                    borderLeft: '2px solid var(--border)',
                    borderRight: '2px solid var(--border)',
                  }}>
                    {row.strike}
                    {isAtm && <span style={{ fontSize: 9, marginLeft: 4, color: '#4dabf7' }}>ATM</span>}
                  </td>
                  <td className="idx-ohl-cell" style={{ textAlign: 'left', fontSize: 11, color: 'var(--text-muted)' }}>
                    {fmtPrice(row.pe?.dayLow)}
                  </td>
                  <td className="idx-ohl-cell" style={{ textAlign: 'left', fontSize: 11, color: 'var(--text-muted)' }}>
                    {fmtPrice(row.pe?.dayHigh)}
                  </td>
                  <td className="idx-ohl-cell" style={{ textAlign: 'left', fontSize: 11, color: 'var(--text-muted)' }}>
                    {fmtPrice(row.pe?.dayOpen)}
                  </td>
                  <td style={{
                    textAlign: 'left', fontWeight: 600,
                    color: row.pe?.ltp != null ? '#ff6b6b' : 'var(--text-muted)',
                  }}>
                    {fmtPrice(row.pe?.ltp)}
                  </td>
                  <td style={{
                    textAlign: 'left', fontSize: 11, fontWeight: 500,
                    color: peChg > 0 ? '#51cf66' : peChg < 0 ? '#ff6b6b' : 'var(--text-muted)',
                  }}>
                    {peChg != null ? `${peChg > 0 ? '+' : ''}${peChg}%` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Low Premium Scalper Config ──────────────────────────────────────────────

/**
 * Config panel for the Low Premium Scalper strategy.
 *
 * Strategy recap:
 *   • BUY any subscribed option in [lpEntryMin, lpEntryMax] range (e.g. ₹5–₹10)
 *   • Avg-down ONCE when price drops lpAvgDownPct (60%) from entry
 *     e.g. enter ₹10 → avg trigger = ₹4 → avgPrice = ₹7, lots = 2, SL = ₹4 × lpAvgDownSlPct
 *   • Max lpMaxPositions concurrent LP trades
 *   • TSL activates at lpTslTrigger → SL jumps to lpTslInitialSl, then trails at lpTslTrailPct × peak
 */

// ── Time Filter Config ────────────────────────────────────────────────────────

function TimeFilterConfig({ config, onUpdate }) {
  if (!config) return null;

  const startTime = config.tradeStartHHMM ?? '09:20';
  const endTime   = config.tradeEndHHMM   ?? '15:15';
  const eodTime   = config.eodCloseHHMM   ?? '15:25';

  function handleChange(key, val) {
    // Basic HH:MM validation before sending to server
    if (/^\d{2}:\d{2}$/.test(val)) onUpdate({ [key]: val });
  }

  return (
    <div className="settings-group">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        ⏰ Trading Time Window
        <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4,
                       background: '#51cf6622', color: '#51cf66' }}>
          {startTime} – {endTime} IST
        </span>
      </h3>
      <p style={{ fontSize: 12, color: 'var(--txt-muted)', marginBottom: 12 }}>
        No new entries (pattern or LP) will be placed outside this window. All open trades
        are force-closed at the EOD time regardless of SL/target status.
      </p>
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          <span style={{ color: 'var(--txt-muted)' }}>No entry before (IST)</span>
          <input
            type="time"
            className="screener-input"
            value={startTime}
            onChange={e => handleChange('tradeStartHHMM', e.target.value)}
            style={{ width: 120, fontSize: 13 }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          <span style={{ color: 'var(--txt-muted)' }}>No entry after (IST)</span>
          <input
            type="time"
            className="screener-input"
            value={endTime}
            onChange={e => handleChange('tradeEndHHMM', e.target.value)}
            style={{ width: 120, fontSize: 13 }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          <span style={{ color: 'var(--txt-muted)' }}>EOD force-close (IST)</span>
          <input
            type="time"
            className="screener-input"
            value={eodTime}
            onChange={e => handleChange('eodCloseHHMM', e.target.value)}
            style={{ width: 120, fontSize: 13 }}
          />
        </label>
      </div>
    </div>
  );
}

function LowPremiumConfig({ config, onUpdate }) {
  const [open, setOpen] = useState(false);

  if (!config) return null;

  const lp = {
    lowPremiumEnabled: config.lowPremiumEnabled ?? false,
    lpEntryMin:        config.lpEntryMin        ?? 5,
    lpEntryMax:        config.lpEntryMax        ?? 10,
    lpTarget:          config.lpTarget          ?? 15,
    lpTslTrigger:      config.lpTslTrigger      ?? 12,
    lpTslInitialSl:    config.lpTslInitialSl    ?? 8,
    lpTslTrailPct:     config.lpTslTrailPct     ?? 0.70,
    lpAvgDownPct:      config.lpAvgDownPct      ?? 0.60,
    lpAvgDownSlPct:    config.lpAvgDownSlPct    ?? 0.50,
    lpMaxPositions:    config.lpMaxPositions    ?? 4,
  };

  // Derived example values shown in the summary strip
  const exEntry    = lp.lpEntryMax;
  const exAvgAt    = +(exEntry * (1 - lp.lpAvgDownPct)).toFixed(2);
  const exAvgPrice = +((exEntry + exAvgAt) / 2).toFixed(2);
  const exSl       = +(exAvgAt * lp.lpAvgDownSlPct).toFixed(2);

  function handleField(key, raw) {
    const val = key === 'lowPremiumEnabled' ? raw : parseFloat(raw);
    if (key !== 'lowPremiumEnabled' && isNaN(val)) return;
    onUpdate({ [key]: val });
  }

  return (
    <div className="settings-group">
      <h3
        style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        onClick={() => setOpen(prev => !prev)}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          💰 Low Premium Scalper
          <span style={{
            fontSize: 10, padding: '2px 6px', borderRadius: 4,
            background: lp.lowPremiumEnabled ? '#51cf6622' : '#ff6b6b22',
            color: lp.lowPremiumEnabled ? '#51cf66' : '#ff6b6b',
          }}>
            {lp.lowPremiumEnabled ? 'ENABLED' : 'OFF'}
          </span>
          {lp.lowPremiumEnabled && (
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              ₹{lp.lpEntryMin}–₹{lp.lpEntryMax} · max {lp.lpMaxPositions} positions
            </span>
          )}
        </span>
        <span style={{ fontSize: 12 }}>{open ? '▼' : '▶'}</span>
      </h3>

      {open && (
        <div style={{ marginTop: 8 }}>
          {/* Master toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <label style={{ fontSize: 13, fontWeight: 500 }}>
              <input
                type="checkbox"
                checked={lp.lowPremiumEnabled}
                onChange={e => handleField('lowPremiumEnabled', e.target.checked)}
                style={{ marginRight: 6 }}
              />
              Enable Low Premium Scalper
            </label>
          </div>

          {/* Config sanity warning — shown when target ≤ entry max */}
          {lp.lpTarget <= lp.lpEntryMax && (
            <div style={{
              padding: '8px 12px', marginBottom: 16,
              background: 'rgba(255, 107, 107, 0.12)',
              border: '1px solid rgba(255, 107, 107, 0.4)',
              borderRadius: 6, fontSize: 11, color: '#ff6b6b',
            }}>
              ⚠️ <strong>Invalid config:</strong> Hard Target (₹{lp.lpTarget}) must be
              strictly above Entry Max (₹{lp.lpEntryMax}). LP entries are{' '}
              <strong>blocked</strong> until this is corrected — otherwise target hits
              produce negative PnL.
            </div>
          )}

          {/* ── Entry ── */}
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Entry
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
            <LpField label="Entry Min (₹)" hint="Skip options below this price"
              value={lp.lpEntryMin} onChange={v => handleField('lpEntryMin', v)} />
            <LpField label="Entry Max (₹)" hint="Skip options above this price"
              value={lp.lpEntryMax} onChange={v => handleField('lpEntryMax', v)} />
            <LpField label="Hard Target (₹)" hint="Close the full position at this price"
              value={lp.lpTarget} onChange={v => handleField('lpTarget', v)} />
            <LpField label="Max Positions" hint="Max concurrent LP trades (all tokens combined)"
              value={lp.lpMaxPositions} step="1" onChange={v => handleField('lpMaxPositions', v)} />
          </div>

          {/* ── Avg-Down ── */}
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Avg-Down (1× per position)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
            <LpField label="Drop % trigger" hint="Avg-down when price drops this % from entry (0.60 = 60%)"
              value={lp.lpAvgDownPct} step="0.05" onChange={v => handleField('lpAvgDownPct', v)} />
            <LpField label="Post-Avg SL factor" hint="SL = avg-down price × this  (e.g. 0.50 = half of avg-down price)"
              value={lp.lpAvgDownSlPct} step="0.05" onChange={v => handleField('lpAvgDownSlPct', v)} />
          </div>

          {/* ── TSL ── */}
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Trailing Stop Loss
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
            <LpField label="TSL Trigger (₹)" hint="Activate TSL when LTP reaches this"
              value={lp.lpTslTrigger} onChange={v => handleField('lpTslTrigger', v)} />
            <LpField label="TSL Initial SL (₹)" hint="SL jumps to this on activation"
              value={lp.lpTslInitialSl} onChange={v => handleField('lpTslInitialSl', v)} />
            <LpField label="Trail % of Peak" hint="SL = this × peak price (0.70 = 30% drawdown)"
              value={lp.lpTslTrailPct} step="0.05" onChange={v => handleField('lpTslTrailPct', v)} />
          </div>

          {/* Visual walkthrough */}
          <div style={{ padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 6, fontSize: 11, color: 'var(--text-muted)', lineHeight: 2 }}>
            <strong style={{ color: 'var(--text-primary)', display: 'block', marginBottom: 2 }}>
              Example with current settings (entry at max ₹{exEntry}):
            </strong>
            📥 Enter @₹{exEntry} — SL=₹0.5 (full-loss guard)
            <br />
            📉 Price falls to ₹{exAvgAt} ({Math.round(lp.lpAvgDownPct * 100)}% drop)
            {' '}→ ➕ Avg-Down: 2nd lot @₹{exAvgAt}
            {' '}→ avgPrice=₹{exAvgPrice}, lots=2, SL=₹{exSl}
            <br />
            📈 Recovery to ₹{lp.lpTslTrigger}
            {' '}→ 🔒 TSL on: SL=₹{lp.lpTslInitialSl}
            {' '}→ peak ₹{lp.lpTslTrigger + 2} → SL=₹{((lp.lpTslTrigger + 2) * lp.lpTslTrailPct).toFixed(2)}
            {' '}→ 🎯 Target ₹{lp.lpTarget}
          </div>
        </div>
      )}
    </div>
  );
}

// ── RSI Filter Config ────────────────────────────────────────────────────────

function RsiFilterConfig({ config, onUpdate }) {
  const [open, setOpen] = useState(false);

  if (!config) return null;

  const c = {
    rsiFilterEnabled: config.rsiFilterEnabled ?? false,
    rsiFilterScan:    config.rsiFilterScan    ?? true,
    rsiFilterOrder:   config.rsiFilterOrder   ?? true,
    rsiBullishMin:    config.rsiBullishMin     ?? 50,
    rsiBullishMax:    config.rsiBullishMax     ?? 65,
    rsiBearishMin:    config.rsiBearishMin     ?? 35,
    rsiBearishMax:    config.rsiBearishMax     ?? 50,
  };

  function handleToggle(key) {
    onUpdate({ [key]: !c[key] });
  }

  function handleNum(key, raw) {
    const val = parseFloat(raw);
    if (!isNaN(val)) onUpdate({ [key]: val });
  }

  // Visual indicator for which gates are active
  const activeParts = [];
  if (c.rsiFilterEnabled) {
    if (c.rsiFilterScan)  activeParts.push('scan');
    if (c.rsiFilterOrder) activeParts.push('order');
  }
  const gateLabel = activeParts.length > 0 ? activeParts.join(' + ') : null;

  return (
    <div className="settings-group">
      <h3
        style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        onClick={() => setOpen(prev => !prev)}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          📊 RSI Filter
          <span style={{
            fontSize: 10, padding: '2px 6px', borderRadius: 4,
            background: c.rsiFilterEnabled ? '#51cf6622' : '#ff6b6b22',
            color: c.rsiFilterEnabled ? '#51cf66' : '#ff6b6b',
          }}>
            {c.rsiFilterEnabled ? 'ON' : 'OFF'}
          </span>
          {c.rsiFilterEnabled && gateLabel && (
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              gates: {gateLabel}
            </span>
          )}
          {c.rsiFilterEnabled && (
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              · long {c.rsiBullishMin}–{c.rsiBullishMax} / short {c.rsiBearishMin}–{c.rsiBearishMax}
            </span>
          )}
        </span>
        <span style={{ fontSize: 12 }}>{open ? '▼' : '▶'}</span>
      </h3>

      {open && (
        <div style={{ marginTop: 8 }}>
          {/* Master toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <label style={{ fontSize: 13, fontWeight: 500 }}>
              <input
                type="checkbox"
                checked={c.rsiFilterEnabled}
                onChange={() => handleToggle('rsiFilterEnabled')}
                style={{ marginRight: 6 }}
              />
              Enable RSI Filter
            </label>
          </div>

          {/* Gate toggles — only meaningful when master is on */}
          <div style={{
            fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
            marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>
            Apply to
          </div>
          <div style={{ display: 'flex', gap: 20, marginBottom: 16, opacity: c.rsiFilterEnabled ? 1 : 0.4 }}>
            <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={c.rsiFilterScan}
                disabled={!c.rsiFilterEnabled}
                onChange={() => handleToggle('rsiFilterScan')}
              />
              <span>
                <strong>Scan / Alert</strong>
                <span style={{ color: 'var(--text-muted)', marginLeft: 4, fontSize: 11 }}>
                  — hides signal from feed &amp; history
                </span>
              </span>
            </label>
            <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={c.rsiFilterOrder}
                disabled={!c.rsiFilterEnabled}
                onChange={() => handleToggle('rsiFilterOrder')}
              />
              <span>
                <strong>Order Execution</strong>
                <span style={{ color: 'var(--text-muted)', marginLeft: 4, fontSize: 11 }}>
                  — blocks pattern trades &amp; LP entries
                </span>
              </span>
            </label>
          </div>

          {/* RSI range inputs */}
          <div style={{
            fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
            marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>
            Long (Bullish / BUY)
          </div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
            gap: 12, marginBottom: 16,
          }}>
            <LpField label="RSI Min" hint="RSI must be ≥ this to qualify"
              value={c.rsiBullishMin} step="1" onChange={v => handleNum('rsiBullishMin', v)} />
            <LpField label="RSI Max" hint="RSI must be ≤ this to qualify"
              value={c.rsiBullishMax} step="1" onChange={v => handleNum('rsiBullishMax', v)} />
          </div>

          <div style={{
            fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
            marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>
            Short (Bearish — reserved for future use)
          </div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
            gap: 12, marginBottom: 16, opacity: 0.55,
          }}>
            <LpField label="RSI Min" hint="RSI must be ≥ this to qualify"
              value={c.rsiBearishMin} step="1" onChange={v => handleNum('rsiBearishMin', v)} />
            <LpField label="RSI Max" hint="RSI must be ≤ this to qualify"
              value={c.rsiBearishMax} step="1" onChange={v => handleNum('rsiBearishMax', v)} />
          </div>

          {/* Context note */}
          <div style={{
            padding: '8px 12px', background: 'var(--bg-secondary)',
            borderRadius: 6, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.7,
          }}>
            <strong style={{ color: 'var(--text-primary)' }}>How it works:</strong>
            <br />
            📊 <strong>Scan gate</strong> — RSI is checked on the <em>same candle</em> the pattern fired on.
            Signals that fail are not stored in history or broadcast to the feed.
            They are also <em>not</em> dedup-marked, so if RSI moves into range on the next candle, the signal can still fire.
            <br />
            ⚡ <strong>Order gate</strong> — Checked independently at execution time.
            Useful when you want to see all signals but only trade momentum-confirmed ones.
            <br />
            💰 <strong>LP entries</strong> — RSI is computed from 5-minute candles of each option token.
          </div>
        </div>
      )}
    </div>
  );
}

function LpField({ label, hint, value, onChange, step = '0.5' }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 11, fontWeight: 500 }}>{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        min="0"
        onChange={e => onChange(e.target.value)}
        style={{
          padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border)',
          background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13, width: '100%',
        }}
      />
      {hint && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{hint}</span>}
    </label>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────

export default function IndexTradePage() {
  const {
    openTrades, closedTrades, todayClosed,
    tradeTicks, optionChain, sseConnected, status, config, pnl, alerts,
    updateConfig, manualClose, fetchStatus, fetchOptionChain, refreshStrikes,
  } = useIndexTrade();

  function handleToggle() {
    if (!config) return;
    updateConfig({ enabled: !config.enabled });
  }

  return (
    <div className="page">
      <div className="page-header" style={{ overflowX: 'auto', whiteSpace: 'nowrap' }}>
        <div style={{ minWidth: 0 }}>
          <h2 className="page-title">Index Trade</h2>
          <p className="page-sub" style={{ whiteSpace: 'nowrap' }}>NIFTY & SENSEX options — ATM ± 5 strikes — auto scan & paper trade</p>
        </div>
        <button className="btn btn-sm btn-secondary" onClick={fetchStatus} style={{ flexShrink: 0 }}>
          Refresh
        </button>
      </div>

      <div className="settings-panel">
        <StatusBar status={status} config={config} onToggle={handleToggle} onRefreshStrikes={refreshStrikes} sseConnected={sseConnected} />
        <PnlSummary pnl={pnl} />
        <TimeFilterConfig config={config} onUpdate={updateConfig} />
        <LowPremiumConfig config={config} onUpdate={updateConfig} />
        <RsiFilterConfig config={config} onUpdate={updateConfig} />
        <OpenTradesPanel trades={openTrades} tradeTicks={tradeTicks} onClose={manualClose} />
        <OrderHistory trades={todayClosed} allTrades={closedTrades} />
        <OptionChainTable optionChain={optionChain} onRefresh={fetchOptionChain} />
        <AlertFeed alerts={alerts} />
      </div>
    </div>
  );
}
