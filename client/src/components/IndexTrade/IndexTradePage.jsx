import { useState, useEffect } from 'react';
import useIndexTrade from './useIndexTrade';
import ScanChartModal from '../Scanner/ScanChartModal';

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
  const [chartTrade, setChartTrade] = useState(null);

  if (trades.length === 0) {
    return (
      <div className="settings-group">
        <h3>Open Paper Trades</h3>
        <p className="diag-hint">No open trades</p>
      </div>
    );
  }

  return (
    <>
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
                <th>% from SL</th>
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

                // Calculate % distance from SL
                const currentSl = tick?.sl ?? t.sl;
                let distanceFromSl = null;
                let distanceColor = 'var(--text-muted)';
                if (currentSl != null && ltp != null) {
                  if (t.action === 'BUY') {
                    // BUY: SL is below LTP, show how far above SL we are
                    distanceFromSl = ((ltp - currentSl) / currentSl) * 100;
                  } else {
                    // SELL: SL is above LTP, show how far below SL we are
                    distanceFromSl = ((currentSl - ltp) / currentSl) * 100;
                  }
                  // Color: green if far from SL (safe), yellow/orange if close, red if very close
                  if (distanceFromSl > 5) {
                    distanceColor = '#51cf66'; // Green - safe
                  } else if (distanceFromSl > 2) {
                    distanceColor = '#fab005'; // Yellow - caution
                  } else {
                    distanceColor = '#ff6b6b'; // Red - danger
                  }
                }

                return (
                  <tr key={t.id}>
                    <td>{t.index}</td>
                    <td
                      style={{
                        fontWeight: 500,
                        cursor: t.token ? 'pointer' : 'default',
                        color: t.token ? '#4dabf7' : 'inherit',
                        textDecoration: t.token ? 'underline' : 'none'
                      }}
                      onClick={() => t.token && setChartTrade(t)}
                      title={t.token ? 'Click to view chart' : ''}
                    >
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
                    <td style={{
                      fontWeight: 600,
                      color: distanceColor,
                      fontSize: 11
                    }}>
                      {distanceFromSl != null ? `${distanceFromSl > 0 ? '+' : ''}${distanceFromSl.toFixed(1)}%` : '—'}
                    </td>
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

      {/* Chart Modal */}
      {chartTrade && (
        <ScanChartModal
          alert={{
            token: chartTrade.token,
            label: chartTrade.symbol || `${chartTrade.strike} ${chartTrade.optionType}`,
            interval: chartTrade.interval || '15minute',
            tfLabel: chartTrade.tfLabel || '15m',
            patternLabel: chartTrade.patternLabel || (chartTrade.strategyType === 'low-premium' ? '💰 LP Scalper' : null),
            patternId: chartTrade.patternId || null,
            signal: chartTrade.signalDirection || 'bullish',
            close: chartTrade.entryPrice || 0,
            sl: chartTrade.sl || null,
            target: chartTrade.target || null,
          }}
          onClose={() => setChartTrade(null)}
        />
      )}
    </>
  );
}

// ── Order History ───────────────────────────────────────────────────────────

/**
 * @param {object[]} trades       - Today's closed trades (for the table display)
 * @param {function} fetchHistoricalTrades - Function to fetch historical trades from MongoDB
 */
function OrderHistory({ trades, fetchHistoricalTrades }) {
  const [expanded, setExpanded] = useState(true);
  const [chartTrade, setChartTrade] = useState(null);
  const [viewMode, setViewMode] = useState('today'); // 'today' | 'all'
  const [historicalTrades, setHistoricalTrades] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Load historical trades from MongoDB
  const loadHistory = async () => {
    if (loadingHistory) return;
    setLoadingHistory(true);
    try {
      const data = await fetchHistoricalTrades();
      const closed = (data || [])
        .filter(t => t.status === 'CLOSED')
        .sort((a, b) => (b.closedTs || 0) - (a.closedTs || 0));
      setHistoricalTrades(closed);
      setViewMode('all');
    } catch (err) {
      console.error('Failed to load history:', err);
    } finally {
      setLoadingHistory(false);
    }
  };

  const displayTrades = viewMode === 'all' ? historicalTrades : trades;
  const displayPnl = displayTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const wins = displayTrades.filter(t => t.pnl > 0).length;
  const losses = displayTrades.filter(t => t.pnl <= 0).length;

  return (
    <>
      <div className="settings-group">
        {/* Header with view toggle buttons - ALWAYS VISIBLE */}
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <span style={{ fontWeight: 600 }}>Order History</span>

          {/* View toggle buttons - prominent styling */}
          <div style={{ display: 'flex', gap: 6, marginLeft: 12, padding: '4px 8px', background: 'var(--bg-tertiary)', borderRadius: 6 }}>
            <button
              onClick={() => setViewMode('today')}
              style={{
                fontSize: 12,
                padding: '6px 14px',
                borderRadius: 4,
                border: viewMode === 'today' ? '2px solid #4dabf7' : '1px solid var(--border)',
                background: viewMode === 'today' ? '#4dabf7' : 'var(--bg-secondary)',
                color: viewMode === 'today' ? '#fff' : 'var(--text-primary)',
                cursor: 'pointer',
                fontWeight: 600
              }}
            >
              📅 Today ({trades.length})
            </button>
            <button
              onClick={loadHistory}
              disabled={loadingHistory}
              style={{
                fontSize: 12,
                padding: '6px 14px',
                borderRadius: 4,
                border: viewMode === 'all' ? '2px solid #fab005' : '1px solid var(--border)',
                background: viewMode === 'all' ? '#fab005' : 'var(--bg-secondary)',
                color: viewMode === 'all' ? '#000' : 'var(--text-primary)',
                cursor: loadingHistory ? 'wait' : 'pointer',
                fontWeight: 600
              }}
            >
              {loadingHistory ? '⏳ Loading...' : `📜 All History${historicalTrades.length > 0 ? ` (${historicalTrades.length})` : ''}`}
            </button>
          </div>

          {/* Stats */}
          {displayTrades.length > 0 && (
            <>
              <span style={{ fontSize: 13, fontWeight: 600, color: displayPnl >= 0 ? '#51cf66' : '#ff6b6b' }}>
                {fmtPnl(displayPnl)}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                W:{wins} L:{losses}
              </span>
            </>
          )}

          {/* Export button */}
          {historicalTrades.length > 0 && (
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => exportToCSV(historicalTrades)}
              style={{ fontSize: 11, padding: '2px 8px', fontWeight: 400, marginLeft: 'auto' }}
              title={`Export all ${historicalTrades.length} closed trades to CSV`}
            >
              ⬇ Export CSV
            </button>
          )}
        </h3>
        {displayTrades.length === 0 ? (
          <p className="diag-hint">
            {viewMode === 'today' ? 'No closed trades today' : 'No trades in history. Click "All History" to load from database.'}
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="diag-table" style={{ fontSize: 12, width: '100%' }}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Time</th>
                  <th>Index</th>
                  <th>Symbol</th>
                  <th>Pattern</th>
                  <th>Entry</th>
                  <th>Exit</th>
                  <th>PnL</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {displayTrades.map(t => {
                  const dateStr = t.closedTs ? new Date(t.closedTs).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—';
                  const timeStr = t.closedTs ? new Date(t.closedTs).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';
                  return (
                    <tr key={t.id}>
                      <td style={{ whiteSpace: 'nowrap', fontSize: 11 }}>{dateStr}</td>
                      <td style={{ whiteSpace: 'nowrap', fontSize: 11 }}>{timeStr}</td>
                      <td>{t.index}</td>
                      <td
                        style={{
                          fontWeight: 500,
                          cursor: t.token ? 'pointer' : 'default',
                          color: t.token ? '#4dabf7' : 'inherit',
                          textDecoration: t.token ? 'underline' : 'none'
                        }}
                        onClick={() => t.token && setChartTrade(t)}
                        title={t.token ? 'Click to view chart' : ''}
                      >
                        {t.strike} {t.optionType}
                      </td>
                      <td>
                        {t.strategyType === 'low-premium'
                          ? <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: '#fab00522', color: '#fab005', fontWeight: 700 }}>💰 LP</span>
                          : (t.patternLabel || t.patternId || '—')}
                      </td>
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
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Chart Modal */}
      {chartTrade && (
        <ScanChartModal
          alert={{
            token: chartTrade.token,
            label: chartTrade.symbol || `${chartTrade.strike} ${chartTrade.optionType}`,
            interval: chartTrade.interval || '15minute',
            tfLabel: chartTrade.tfLabel || '15m',
            patternLabel: chartTrade.patternLabel || (chartTrade.strategyType === 'low-premium' ? '💰 LP Scalper' : null),
            patternId: chartTrade.patternId || null,
            signal: chartTrade.signalDirection || 'bullish',
            close: chartTrade.entryPrice || 0,
            sl: chartTrade.sl || null,
            target: chartTrade.target || null,
          }}
          onClose={() => setChartTrade(null)}
        />
      )}
    </>
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

// ── Main Page ───────────────────────────────────────────────────────────────

export default function IndexTradePage() {
  const {
    openTrades, todayClosed,
    tradeTicks, optionChain, sseConnected, status, config, pnl, alerts,
    updateConfig, manualClose, fetchStatus, fetchOptionChain, refreshStrikes, fetchHistoricalTrades,
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
        <OpenTradesPanel trades={openTrades} tradeTicks={tradeTicks} onClose={manualClose} />
        <OrderHistory trades={todayClosed} fetchHistoricalTrades={fetchHistoricalTrades} />
        <OptionChainTable optionChain={optionChain} onRefresh={fetchOptionChain} />
      </div>
    </div>
  );
}
