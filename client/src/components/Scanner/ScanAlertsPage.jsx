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

// ── Market-hours helpers ──────────────────────────────────────────────────────
// Used to decide cache validity for the auto-screener. When the market is
// closed, the underlying candle data is frozen, so a scan run during off-hours
// stays valid until the next session opens — no point re-running it on every
// tab switch through the weekend.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * True if any Indian market session is open right now (Mon-Fri only):
 *   NSE  — 9:15 AM to  3:30 PM IST (mins 555 – 930)
 *   MCX  — 9:00 AM to 11:30 PM IST (mins 540 – 1410)
 *
 * MCX extends the "live data" window all the way to 11:30 PM, so the
 * 5-min auto-refresh TTL stays active until MCX closes.
 */
function isMarketHours(now = Date.now()) {
  const ist = new Date(now + IST_OFFSET_MS);
  const dow = ist.getUTCDay();
  if (dow === 0 || dow === 6) return false;           // weekends always closed
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const nseOpen = mins >= 555 && mins <= 930;         // 9:15 – 15:30
  const mcxOpen = mins >= 540 && mins <= 1410;        // 9:00 – 23:30
  return nseOpen || mcxOpen;
}

/**
 * Returns the UTC ms timestamp of the most recent market close on a trading
 * day. We use MCX close (23:30 IST) as the latest session boundary — it closes
 * after NSE, so the cache only freezes once MCX is done for the day.
 *
 * If the current time is before 23:30 IST today (i.e. MCX is still open or
 * the day hasn't closed yet), we look back to the previous trading day's
 * 23:30 IST close. Weekends are skipped back to Friday.
 */
function lastMarketCloseMs(now = Date.now()) {
  // Work in an IST-shifted Date so UTC accessors read IST values.
  const ist = new Date(now + IST_OFFSET_MS);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  // MCX closes at 23:30 IST (mins = 1410). If we're past that, today's
  // close counts; otherwise go back to the previous trading day.
  const daysBack = mins >= 1410 ? 0 : 1;
  const candidate = new Date(ist);
  candidate.setUTCDate(candidate.getUTCDate() - daysBack);
  candidate.setUTCHours(23, 30, 0, 0);               // 23:30 IST = MCX close
  // Walk back through weekends to land on the last trading day (Friday).
  while (candidate.getUTCDay() === 0 || candidate.getUTCDay() === 6) {
    candidate.setUTCDate(candidate.getUTCDate() - 1);
  }
  return candidate.getTime() - IST_OFFSET_MS;
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

function ScanRow({ alert, onSelect, onBuy }) {
  const tick     = useAppStore((s) => s.ticks[alert.token]);
  const testMode = useAppStore((s) => s.testMode);
  const ltp      = tick?.lastPrice ?? null;
  const change   = tick?.change    ?? null;
  const chgCls   = change > 0 ? 'mw-up' : change < 0 ? 'mw-down' : '';

  // Action follows the signal direction: bullish → BUY, bearish → SELL
  const action = alert.signal === 'bullish' ? 'BUY' : 'SELL';

  function handleBuy(e) {
    e.stopPropagation();
    onBuy({ alert, entryPrice: ltp ?? alert.close, action });
  }

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
        {/* Volume confirmation badge — only shown when volume is above-average (≥1.2×) */}
        {alert.volumeConfirmed && alert.volumeRatio != null && (
          <span className="scan-vol-badge" title={`Volume ${Number(alert.volumeRatio).toFixed(1)}× 20-bar average`}>
            📈 {Number(alert.volumeRatio).toFixed(1)}×
          </span>
        )}
        {/* MTF confluence badge — signal fired on multiple timeframes in the same scan */}
        {alert.confluenceCount > 1 && (
          <span className="scan-mtf-badge" title={`MTF Confluence: ${alert.confluenceTfs?.join(' + ')}`}>
            ⚡ MTF
          </span>
        )}
      </td>
      <td className="scan-cell scan-cell--score">
        <ScoreDots score={alert.score} signal={alert.signal} />
      </td>
      <td className="scan-cell scan-cell--price">{alert.close != null ? fmt(alert.close) : '—'}</td>
      <td className="scan-cell scan-cell--time">{relativeTime(alert.ts)}</td>
      <td className="scan-cell scan-cell--action">
        {/* Paper BUY / SELL only visible when Paper Mode is active */}
        {testMode && (
          <button
            className={`scan-buy-btn ${action === 'SELL' ? 'scan-buy-btn--sell' : ''}`}
            onClick={handleBuy}
            title={`Paper ${action} @ ₹${ltp != null ? fmt(ltp) : alert.close ?? '?'}`}
          >
            Paper {action}
          </button>
        )}
      </td>
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

// ── Paper Buy Modal ───────────────────────────────────────────────────────────
// Shown when user clicks "Paper BUY" on a scan row. Lets them set entry price,
// quantity, SL and target before confirming. Shows live LTP and balance impact.

function PaperBuyModal({ alert, action = 'BUY', suggestedEntry, onClose, onConfirm }) {
  const tick            = useAppStore((s) => s.ticks[alert.token]);
  const paperBalance    = useAppStore((s) => s.paperBalance);
  const tradingDefaults = useAppStore((s) => s.tradingDefaults);
  const watchlist       = useAppStore((s) => s.watchlist);

  // Look up lot size for this instrument from the watchlist.
  // Falls back to 1 for indices / instruments not in the FO watchlist.
  const watchItem = watchlist.find((w) => w.instrumentToken === alert.token);
  const lotSize   = watchItem?.lotSize ?? 1;

  const ltp = tick?.lastPrice ?? null;

  // Entry price — auto-follows LTP until user edits it
  const [entryStr,    setEntryStr]    = useState(String(suggestedEntry ?? ltp ?? ''));
  const [entryEdited, setEntryEdited] = useState(false);
  // Lots (number of lots) — actual quantity = lots * lotSize
  const [lotsStr,     setLotsStr]     = useState(String(tradingDefaults.quantity || 1));
  // Pre-fill SL and target from the pattern's computed Ichimoku levels (2:1 R:R)
  // so the user doesn't need to enter them manually — they can still override.
  const [slStr,       setSlStr]       = useState(alert.sl     != null ? String(alert.sl)     : '');
  const [targetStr,   setTargetStr]   = useState(alert.target != null ? String(alert.target) : '');

  // Keep entry synced with live LTP until user touches the field
  useEffect(() => {
    if (!entryEdited && ltp != null) setEntryStr(String(ltp));
  }, [ltp, entryEdited]);

  const entry      = parseFloat(entryStr)  || 0;
  const lots       = Math.max(1, parseInt(lotsStr, 10) || 1);
  // Actual number of shares traded — this is what P&L is calculated on
  const actualQty  = lots * lotSize;
  const sl         = parseFloat(slStr)     || null;
  const target     = parseFloat(targetStr) || null;

  // Capital required for this trade (entry × actual shares)
  const cost      = entry * actualQty;
  const available = paperBalance?.available ?? 0;
  const canAfford = cost <= available;

  // Risk / reward preview — direction-aware (BUY vs SELL)
  // BUY:  SL is below entry (price going down is loss), target is above (profit up)
  // SELL: SL is above entry (price going up is loss),  target is below (profit down)
  const maxRisk   = sl != null     ? Math.abs(entry - sl)     * actualQty : null;
  const potProfit = target != null ? Math.abs(entry - target) * actualQty : null;
  const rrRatio   = maxRisk && potProfit && maxRisk > 0
    ? (potProfit / maxRisk).toFixed(1)
    : null;

  const valid = entry > 0 && lots > 0 && canAfford;

  function handleConfirm() {
    if (!valid) return;
    // Pass both lots/lotSize (for display) and actual quantity (for P&L)
    onConfirm({ entryPrice: entry, lots, lotSize, quantity: actualQty, sl, target });
  }

  function handleOverlayClick(e) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal-card paper-buy-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <span>
            Paper {action} — {alert.label}
            <span className={`scan-signal-badge scan-signal-badge--${alert.signal}`} style={{ marginLeft: 8, fontSize: 11 }}>
              {alert.signal === 'bullish' ? '🟢 Bullish' : '🔴 Bearish'}
            </span>
          </span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {/* Live LTP strip */}
          <div className="pbm-ltp-row">
            <span className="pbm-ltp-label">Live LTP</span>
            <span className="pbm-ltp-val">{ltp != null ? `₹${fmt(ltp)}` : '—'}</span>
            <span className="pbm-ltp-hint">(updates live · click entry to lock)</span>
          </div>

          {/* Entry + Lots */}
          <div className="pbm-fields">
            <div className="pbm-field">
              <label className="pbm-label">Entry Price ₹</label>
              <input
                className="pbm-input"
                type="number"
                value={entryStr}
                step="0.05"
                min="0"
                onChange={(e) => { setEntryEdited(true); setEntryStr(e.target.value); }}
                onFocus={() => setEntryEdited(true)}
                autoFocus
              />
            </div>
            <div className="pbm-field">
              <label className="pbm-label">
                Lots
                {lotSize > 1 && (
                  <span className="pbm-lot-hint"> (1 lot = {lotSize} qty)</span>
                )}
              </label>
              <input
                className="pbm-input"
                type="number"
                value={lotsStr}
                min="1"
                step="1"
                onChange={(e) => setLotsStr(e.target.value)}
              />
              {lotSize > 1 && (
                <span className="pbm-actual-qty">= {actualQty} shares</span>
              )}
            </div>
          </div>

          {/* SL + Target */}
          <div className="pbm-fields">
            <div className="pbm-field">
              <label className="pbm-label">
                Stop Loss ₹{' '}
                {alert.sl != null
                  ? <span className="pbm-prefilled">(Ichimoku level)</span>
                  : <span className="pbm-optional">(optional)</span>
                }
              </label>
              <input
                className="pbm-input pbm-input--sl"
                type="number"
                value={slStr}
                step="0.05"
                min="0"
                placeholder="e.g. 21800"
                onChange={(e) => setSlStr(e.target.value)}
              />
            </div>
            <div className="pbm-field">
              <label className="pbm-label">
                Target ₹{' '}
                {alert.target != null
                  ? <span className="pbm-prefilled">(2:1 R:R)</span>
                  : <span className="pbm-optional">(optional)</span>
                }
              </label>
              <input
                className="pbm-input pbm-input--target"
                type="number"
                value={targetStr}
                step="0.05"
                min="0"
                placeholder="e.g. 22500"
                onChange={(e) => setTargetStr(e.target.value)}
              />
            </div>
          </div>

          {/* Balance / P&L preview */}
          <div className="pbm-preview">
            <div className="pbm-preview-row">
              <span>
                Capital required
                {lotSize > 1 && (
                  <span className="pbm-calc-note">
                    {' '}({lots} lot{lots > 1 ? 's' : ''} × {lotSize} qty × ₹{fmt(entry)})
                  </span>
                )}
              </span>
              <span className={canAfford ? 'pbm-val' : 'pbm-val pbm-val--danger'}>
                ₹{cost.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
              </span>
            </div>
            <div className="pbm-preview-row">
              <span>Available balance</span>
              <span className="pbm-val">₹{available.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
            </div>
            {maxRisk !== null && (
              <div className="pbm-preview-row pbm-preview-row--loss">
                <span>Max risk at SL</span>
                <span className="pbm-val">−₹{Math.abs(maxRisk).toFixed(2)}</span>
              </div>
            )}
            {potProfit !== null && (
              <div className="pbm-preview-row pbm-preview-row--profit">
                <span>Potential profit at target</span>
                <span className="pbm-val">+₹{potProfit.toFixed(2)}</span>
              </div>
            )}
            {rrRatio !== null && (
              <div className="pbm-preview-row pbm-preview-row--rr">
                <span>Risk : Reward</span>
                <span className="pbm-val">1 : {rrRatio}</span>
              </div>
            )}
          </div>

          {!canAfford && (
            <div className="pbm-warn">
              ⚠ Insufficient balance — reduce quantity or increase starting balance in the Dashboard
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className={`btn ${action === 'SELL' ? 'btn-danger' : 'btn-primary'}`}
            disabled={!valid}
            onClick={handleConfirm}
          >
            Confirm {action}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Active paper trade row — shows live LTP and unrealized P&L ────────────────

function ActiveTradeRow({ trade, onManualClose }) {
  const tick = useAppStore((s) => s.ticks[trade.token]);
  const ltp  = tick?.lastPrice ?? null;

  const unrealizedPnl = ltp != null
    ? (trade.action === 'BUY'
        ? (ltp - trade.entryPrice)
        : (trade.entryPrice - ltp)) * trade.quantity
    : null;

  // Visual flags when SL or target has been breached
  const slHit     = ltp != null && trade.sl     != null && trade.action === 'BUY' && ltp <= trade.sl;
  const targetHit = ltp != null && trade.target != null && trade.action === 'BUY' && ltp >= trade.target;
  const rowMod    = slHit ? 'active-trade-row--sl' : targetHit ? 'active-trade-row--target' : '';

  const pnlClass = unrealizedPnl == null ? '' : unrealizedPnl >= 0 ? 'pnl-positive' : 'pnl-negative';

  return (
    <div className={`active-trade-row ${rowMod}`}>
      <div className="active-trade-main">
        <span className="active-trade-symbol">{trade.symbol}</span>
        <span className="active-trade-meta">
          Entry ₹{fmt(trade.entryPrice)} · Qty {trade.quantity}
          {trade.sl     != null && <> · SL <span className="td-sl">₹{fmt(trade.sl)}</span></>}
          {trade.target != null && <> · Tgt <span className="td-tgt">₹{fmt(trade.target)}</span></>}
        </span>
        {slHit     && <span className="active-trade-hit active-trade-hit--sl">🛑 SL Hit</span>}
        {targetHit && <span className="active-trade-hit active-trade-hit--target">🎯 Target Hit</span>}
      </div>
      <div className="active-trade-right">
        <span className="active-trade-ltp">
          {ltp != null ? `₹${fmt(ltp)}` : '—'}
        </span>
        <span className={`active-trade-pnl ${pnlClass}`}>
          {unrealizedPnl != null
            ? `${unrealizedPnl >= 0 ? '+' : ''}₹${unrealizedPnl.toFixed(2)}`
            : '—'}
        </span>
        <button
          className="btn btn-ghost btn-sm active-trade-close-btn"
          onClick={() => onManualClose(trade)}
        >
          Close
        </button>
      </div>
    </div>
  );
}

// ── Active paper trades panel ─────────────────────────────────────────────────
// Shown above the alerts table whenever there are open scan-sourced trades.

function ActivePaperTrades() {
  const paperTrades          = useAppStore((s) => s.paperTrades);
  const ticks                = useAppStore((s) => s.ticks);
  const closeScanPaperTrade  = useAppStore((s) => s.closeScanPaperTrade);
  const addToast             = useAppStore((s) => s.addToast);

  const openTrades = paperTrades.filter((t) => t.status === 'OPEN' && t.source === 'scan');
  if (openTrades.length === 0) return null;

  function handleManualClose(trade) {
    const ltp = ticks[trade.token]?.lastPrice ?? trade.entryPrice;
    closeScanPaperTrade(trade.id, ltp);
    addToast({ type: 'info', message: `Closed ${trade.symbol} @ ₹${fmt(ltp)}` });
  }

  // Total unrealized P&L across all open trades
  const totalPnl = openTrades.reduce((sum, t) => {
    const ltp = ticks[t.token]?.lastPrice;
    if (ltp == null) return sum;
    const pnl = t.action === 'BUY'
      ? (ltp - t.entryPrice) * t.quantity
      : (t.entryPrice - ltp) * t.quantity;
    return sum + pnl;
  }, 0);

  return (
    <div className="active-paper-panel">
      <div className="active-paper-header">
        <span className="active-paper-title">📝 Paper Trades</span>
        <span className="count-badge">{openTrades.length} open</span>
        <span className={`active-paper-total-pnl ${totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
          {totalPnl >= 0 ? '+' : ''}₹{totalPnl.toFixed(2)} unrealized
        </span>
      </div>
      {openTrades.map((t) => (
        <ActiveTradeRow key={t.id} trade={t} onManualClose={handleManualClose} />
      ))}
    </div>
  );
}

// ── Filter bar ────────────────────────────────────────────────────────────────

function FilterBar({ signal, onSignal, interval, onInterval, pattern, onPattern, patternOptions, dedup, onDedup }) {
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

      <div className="scan-filter-group">
        <span className="scan-filter-label">Pattern</span>
        <select
          className={`scan-filter-select ${pattern !== 'all' ? 'scan-filter-select--active' : ''}`}
          value={pattern}
          onChange={(e) => onPattern(e.target.value)}
        >
          <option value="all">All patterns</option>
          {patternOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
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

  // Reset button: two-step guard — first click arms it, second click within 3 s fires.
  // confirmReset=true means the button is in the "Confirm?" red state.
  const [confirmReset,  setConfirmReset]  = useState(false);
  const [resetting,     setResetting]     = useState(false);
  const confirmTimerRef = useRef(null);

  // Status, per-TF state, and last-run timestamp are persisted in the global
  // store so switching tabs doesn't wipe the screener's "last run" view.
  const status               = useAppStore((s) => s.screenerStatus);
  const statusKind           = useAppStore((s) => s.screenerStatusKind);
  const setStatus            = useAppStore((s) => s.setScreenerStatus);
  const setStatusKind        = useAppStore((s) => s.setScreenerStatusKind);
  const tfState              = useAppStore((s) => s.screenerTfState);
  const setTfState           = useAppStore((s) => s.setScreenerTfState);
  const screenerLastRunAt    = useAppStore((s) => s.screenerLastRunAt);
  const setScreenerLastRunAt = useAppStore((s) => s.setScreenerLastRunAt);
  const clearScreenerAlerts  = useAppStore((s) => s.clearScreenerAlerts);
  const addToast             = useAppStore((s) => s.addToast);

  // ── Reset handler ───────────────────────────────────────────────────────────
  // Two-step: first click arms the confirmation; second click within 3 s fires.
  // Calls POST /api/scan/reset then wipes all client-side screener state so the
  // UI reflects the truly empty server-side caches.
  const handleResetClick = useCallback(() => {
    if (!confirmReset) {
      // Arm the confirmation — auto-disarm after 3 s if user doesn't follow through
      setConfirmReset(true);
      confirmTimerRef.current = setTimeout(() => setConfirmReset(false), 3000);
      return;
    }

    // Second click — execute the reset
    clearTimeout(confirmTimerRef.current);
    setConfirmReset(false);
    setResetting(true);

    api.post('/scan/reset')
      .then((r) => {
        const d = r.data;
        // Wipe all client-side screener state so nothing stale is displayed
        clearScreenerAlerts();
        onClear();
        setTfState({});
        setStatus('');
        setStatusKind('');
        setScreenerLastRunAt(0);

        const msg =
          `✅ Reset complete — candle buffers: ${d.candleStoreKeys} cleared,` +
          ` dedup: ${d.bgScannerDedup + d.liveScannerDedup} entries cleared.` +
          ` Next scan fetches fresh data.`;
        addToast({ type: 'info', message: msg });
        console.log('[Reset]', d);
      })
      .catch((err) => {
        const errMsg = err.response?.data?.error || err.message || 'Reset failed';
        addToast({ type: 'error', message: `⚠ Reset failed: ${errMsg}` });
        console.error('[Reset] Error:', errMsg);
      })
      .finally(() => setResetting(false));
  }, [confirmReset, clearScreenerAlerts, onClear, setTfState, setStatus, setStatusKind, setScreenerLastRunAt, addToast]);

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
   *
   * @param {string[]} [overrideIntervals]  Explicit interval list (overrides tfFilter)
   * @param {object}   [opts]
   * @param {boolean}  [opts.keep]   If true, don't call onClear at start
   *                                 (used by the background fan-out so the
   *                                 prior 15m results stay visible)
   * @param {boolean}  [opts.silent] If true, don't update the top status line
   *                                 (background phase shouldn't overwrite
   *                                 the foreground summary)
   */
  const runScan = useCallback(async (overrideIntervals = null, opts = {}) => {
    if (!patternId || running) return;

    const intervals = overrideIntervals
      ?? (tfFilter === 'all' ? ALL_INTERVALS : [tfFilter]);

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
    if (!opts.silent) {
      setStatusKind('');
      setStatus(
        patternIds.length > 1
          ? `Scanning ${intervals.length} TF × ${patternIds.length} patterns…`
          : intervals.length > 1
            ? `Scanning ${intervals.length} timeframes in parallel…`
            : `Scanning ${TF_LABEL[intervals[0]]}…`
      );
    }
    if (!opts.keep) onClear();   // clear previous screener results from the table

    // Initialise pill state for this batch: first TF running, rest queued.
    // When `opts.keep` is set (background phase), MERGE with existing state so
    // the foreground TF's 'done' pill is preserved.
    if (opts.keep) {
      setTfState((prev) => {
        const next = { ...prev };
        intervals.forEach((iv, idx) => {
          next[iv] = { state: idx === 0 ? 'running' : 'queued', matches: 0 };
        });
        return next;
      });
    } else {
      const initial = {};
      intervals.forEach((iv, idx) => {
        initial[iv] = { state: idx === 0 ? 'running' : 'queued', matches: 0 };
      });
      setTfState(initial);
    }

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

    // Build final summary — skipped in silent mode (background phase) so the
    // user keeps seeing the foreground summary while the rest fans out.
    if (!opts.silent) {
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
    } // end if (!opts.silent)

    // Mark the scan as recently completed so a tab switch within the next
    // AUTO_RUN_TTL_MS window reuses these results instead of re-scanning.
    // Background phase also updates this so the timestamp reflects the
    // most recent scan activity, not just the foreground one.
    setScreenerLastRunAt(Date.now());

    setRunning(false);
  }, [patternId, running, tfFilter, patterns, onTfResults, onClear, setScreenerLastRunAt]);

  /**
   * Manual "Run Screener" click handler.
   *
   * When the market is closed the candle data is frozen — results will be the
   * same as the last run — but we still execute the scan so the user can see
   * fresh output and verify the pipeline. An info banner is shown to make the
   * context clear. Shift-click bypasses even that message.
   */
  const handleManualRunScan = useCallback((e) => {
    const forceRun = e?.shiftKey;
    if (!forceRun && screenerLastRunAt) {
      const now    = Date.now();
      const isOpen = isMarketHours(now);
      if (!isOpen) {
        // Market is closed — data is from last close, but still allow the scan
        setStatus('Market closed — scanning with last-close candle data');
        setStatusKind('info');
      }
    }
    runScan();
  }, [screenerLastRunAt, runScan, setStatus, setStatusKind]);

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
          onClick={handleManualRunScan}
          disabled={running || !patternId}
          title="Run screener — Shift+click to force re-scan during off-market hours"
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

        {/* Reset button — two-step guard prevents accidental wipes */}
        <button
          className={`screener-reset-btn${confirmReset ? ' screener-reset-btn--confirm' : ''}${resetting ? ' screener-reset-btn--loading' : ''}`}
          onClick={handleResetClick}
          disabled={running || resetting}
          title={
            confirmReset
              ? 'Click again within 3 s to wipe all caches and dedup state'
              : 'Reset all candle caches and pattern dedup — next scan fetches fresh data from Kite'
          }
        >
          {resetting ? (
            <>
              <span className="screener-spinner" />
              Resetting…
            </>
          ) : confirmReset ? (
            '⚠ Confirm Reset?'
          ) : (
            <>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.5"/>
              </svg>
              Reset Cache
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
          <span className={`screener-status ${statusKind === 'ok' ? 'screener-status--ok' : statusKind === 'err' ? 'screener-status--err' : statusKind === 'info' ? 'screener-status--info' : ''}`}>
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
  const scanAlerts             = useAppStore((s) => s.scanAlerts);
  const addScanAlert           = useAppStore((s) => s.addScanAlert);
  const setSelectedInstrument  = useAppStore((s) => s.setSelectedInstrument);
  const addPaperTrade          = useAppStore((s) => s.addPaperTrade);
  const tradingDefaults        = useAppStore((s) => s.tradingDefaults);
  const addToast               = useAppStore((s) => s.addToast);
  const testMode               = useAppStore((s) => s.testMode);
  const setTestMode            = useAppStore((s) => s.setTestMode);

  const [signalFilter,   setSignalFilter]   = useState('all');
  const [intervalFilter, setIntervalFilter] = useState('all');
  const [patternFilter,  setPatternFilter]  = useState('all');
  // Dedup: ON by default — show the single strongest alert per symbol
  const [dedup, setDedup] = useState(true);

  // Buy modal state — set to { alert, entryPrice, action } when user clicks Paper BUY/SELL
  const [buyModalData, setBuyModalData] = useState(null);

  // ── Live tick subscription for scanner alert tokens ───────────────────────
  // Scanner alerts (both live SSE and screener results) come from tokens that
  // are NOT in the watchlist and therefore not subscribed to the Kite ticker.
  // Without subscribing them, ticks[alert.token] stays null and the LTP column
  // always shows "—".
  //
  // Strategy: keep a ref of already-subscribed tokens so we never re-subscribe
  // the same token, batch any newly seen tokens in one API call, and on unmount
  // release everything via peek-unsubscribe (which is smart enough to skip
  // tokens still needed by the watchlist or open paper trades).
  const subscribedScanTokensRef = useRef(new Set());

  useEffect(() => {
    const allTokens = scanAlerts
      .map((a) => Number(a.token))
      .filter(Boolean);
    const newTokens = [...new Set(allTokens)].filter(
      (t) => !subscribedScanTokensRef.current.has(t),
    );
    if (newTokens.length === 0) return;
    api.post('/instruments/peek-subscribe', { tokens: newTokens }).catch(() => {});
    newTokens.forEach((t) => subscribedScanTokensRef.current.add(t));
  }, [scanAlerts]);

  // Release all scanner-subscribed tokens when the Scanner tab unmounts
  useEffect(() => {
    return () => {
      const tokens = [...subscribedScanTokensRef.current];
      if (tokens.length > 0) {
        api.post('/instruments/peek-unsubscribe', { tokens }).catch(() => {});
        subscribedScanTokensRef.current.clear();
      }
    };
  }, []);

  // Auto-close watcher has been moved to App.jsx (usePaperAutoClose) so it
  // remains active across all tabs — not just when the Scanner is mounted.

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
        // Risk management — Ichimoku natural SL + 2:1 R:R target
        sl:              m.sl             ?? null,
        target:          m.target         ?? null,
        // Volume context
        volumeRatio:     m.volumeRatio    ?? null,
        volumeConfirmed: m.volumeConfirmed ?? null,
        // MTF confluence — other TFs where same signal fired in this scan
        confluenceTfs:   m.confluenceTfs  ?? [],
        confluenceCount: m.confluenceCount ?? 1,
        ts:              now,
        source:          'screener',
      });
    }
  }, [addScanAlert]);

  /** Called when a new scan starts — wipes previous screener results from the table. */
  const handleClearScreener = useCallback(() => {
    clearScreenerAlerts();
  }, [clearScreenerAlerts]);

  // Unique patterns present in current alerts — drives the pattern filter dropdown.
  // Sorted by label so the list is stable and easy to scan.
  const patternOptions = useMemo(() => {
    const seen = new Map();
    for (const a of scanAlerts) {
      if (a.patternId && a.patternLabel && !seen.has(a.patternId)) {
        seen.set(a.patternId, { id: a.patternId, label: a.patternLabel });
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [scanAlerts]);

  const filtered = useMemo(() => {
    // 1. Apply signal + interval + pattern filters
    let list = scanAlerts.filter((a) => {
      if (signalFilter   !== 'all' && a.signal    !== signalFilter)   return false;
      if (intervalFilter !== 'all' && a.interval  !== intervalFilter) return false;
      if (patternFilter  !== 'all' && a.patternId !== patternFilter)  return false;
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
  }, [scanAlerts, signalFilter, intervalFilter, patternFilter, dedup, sort]);

  // Modal: alert currently being shown in the chart popup (null = closed)
  const [chartAlert, setChartAlert] = useState(null);

  function handleSelect(alert) {
    // Open the chart modal pre-loaded at the alert's timeframe
    setChartAlert(alert);
  }

  // Opens the buy/sell modal — called when user clicks "Paper BUY/SELL" on a scan row.
  const handleBuy = useCallback(({ alert, entryPrice, action }) => {
    setBuyModalData({ alert, entryPrice, action });
  }, []);

  // Called when the modal's "Confirm BUY" button is clicked.
  // Creates the paper trade with all user-specified fields.
  // quantity = lots × lotSize (actual number of shares for P&L calculation)
  const handleConfirmBuy = useCallback(({ entryPrice, lots, lotSize, quantity, sl, target }) => {
    const alert = buyModalData?.alert;
    if (!alert) return;

    const action = buyModalData?.action ?? 'BUY';
    const trade = {
      id:           `scan-${Date.now()}-${alert.token}`,
      ts:           Date.now(),
      signalId:     null,
      symbol:       alert.label,
      token:        alert.token,
      action,
      entryPrice,
      lots:         lots    ?? 1,
      lotSize:      lotSize ?? 1,
      quantity,             // actual shares = lots * lotSize
      sl,
      target,
      targets:      [],
      status:       'OPEN',
      exitPrice:    null,
      pnl:          null,
      closedTs:     null,
      source:       'scan',
      // Pattern metadata — stored for end-of-day archive analysis
      patternId:    alert.patternId    ?? null,
      patternLabel: alert.patternLabel ?? null,
      signal:       alert.signal       ?? null,
      interval:     alert.interval     ?? null,
      tfLabel:      alert.tfLabel      ?? null,
    };

    addPaperTrade(trade);
    addToast({ type: 'buy', message: `Paper ${action} — ${alert.label} @ ₹${fmt(entryPrice)}` });
    setBuyModalData(null);

    // Persist to server so trades-current.json stays current for the daily 6 AM archive.
    // Fire-and-forget — a network failure does NOT block the UI.
    api.post('/paper', trade).catch((err) =>
      console.warn('[Paper] Server sync failed for new trade:', err.message)
    );
  }, [buyModalData, addPaperTrade, addToast]);

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
        {/* Paper Mode toggle */}
        <button
          className={`paper-mode-toggle ${testMode ? 'paper-mode-toggle--on' : ''}`}
          onClick={() => setTestMode(!testMode)}
          title={testMode ? 'Paper Mode ON — click to turn off' : 'Turn on Paper Mode to simulate trades'}
        >
          📝 {testMode ? 'Paper Mode ON' : 'Paper Mode'}
        </button>
      </div>

      {/* ── Screener toolbar ────────────────────────────────────────────── */}
      <ScreenerToolbar onTfResults={handleTfResults} onClear={handleClearScreener} />

      {/* ── Filters ─────────────────────────────────────────────────────── */}
      <FilterBar
        signal={signalFilter}     onSignal={setSignalFilter}
        interval={intervalFilter} onInterval={setIntervalFilter}
        pattern={patternFilter}   onPattern={setPatternFilter}
        patternOptions={patternOptions}
        dedup={dedup}             onDedup={setDedup}
      />

      {/* Paper trades are shown exclusively on the Dashboard tab */}

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
                <SortHeader col="score"    label="Score"         sort={sort} onClick={toggleSort} />
                <SortHeader col="price"    label="Price @ Alert" sort={sort} onClick={toggleSort} />
                <SortHeader col="time"     label="Time"          sort={sort} onClick={toggleSort} />
                <th className="scan-th">Trade</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((alert) => (
                <ScanRow
                  key={`${alert.token}:${alert.interval}:${alert.patternId}:${alert.source ?? 'live'}`}
                  alert={alert}
                  onSelect={handleSelect}
                  onBuy={handleBuy}
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

      {/* ── Paper buy modal (opens on Paper BUY click in paper mode) ─────── */}
      {buyModalData && (
        <PaperBuyModal
          alert={buyModalData.alert}
          action={buyModalData.action ?? 'BUY'}
          suggestedEntry={buyModalData.entryPrice}
          onClose={() => setBuyModalData(null)}
          onConfirm={handleConfirmBuy}
        />
      )}
    </div>
  );
}
