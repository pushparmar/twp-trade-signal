import { useState, useRef, useEffect, useCallback } from 'react';
import api from '../../api';
import useAppStore from '../../store/appStore';

// ── Timeframe display order (most important first in the UI) ──────────────────
const TF_ORDER = ['1d', '4h', '1h', '15m'];
const TF_LABEL_MAP = { '1d': 'Daily', '4h': '4-Hour', '1h': '1-Hour', '15m': '15-Min' };

/** Group an array of trades by their tfLabel, preserving TF_ORDER. */
function groupByTF(trades) {
  const groups = {};
  for (const t of trades) {
    const tf = t.tfLabel ?? 'Other';
    if (!groups[tf]) groups[tf] = [];
    groups[tf].push(t);
  }
  // Sort by TF_ORDER; unknown TFs go last
  const ordered = [...TF_ORDER, 'Other'].filter((tf) => groups[tf]);
  return ordered.map((tf) => ({ tf, label: TF_LABEL_MAP[tf] ?? tf, trades: groups[tf] }));
}

function fmt(ts) {
  return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtPrice(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pnlColor(pnl) {
  if (pnl === null) return '';
  return pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
}

function CloseTradeModal({ trade, onClose, onConfirm }) {
  const [exitPrice, setExitPrice] = useState(trade.entryPrice || '');
  const suggested = trade.target || trade.sl || trade.entryPrice;

  const pnl = exitPrice
    ? (trade.action === 'BUY'
        ? (Number(exitPrice) - trade.entryPrice) * trade.quantity
        : (trade.entryPrice - Number(exitPrice)) * trade.quantity)
    : null;

  return (
    <div className="modal-overlay">
      <div className="modal-card" style={{ width: 380 }}>
        <div className="modal-header">
          <span>Close Trade — {trade.symbol}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="close-trade-info">
            <span className={`pill ${trade.action === 'BUY' ? 'pill-green' : 'pill-red'}`}>{trade.action}</span>
            <span style={{ fontWeight: 600 }}>{trade.symbol}</span>
            <span style={{ color: 'var(--txt2)' }}>Entry: {trade.entryPrice}</span>
            <span style={{ color: 'var(--txt2)' }}>
              {trade.lots != null && trade.lotSize > 1
                ? `${trade.lots} lot${trade.lots > 1 ? 's' : ''} (${trade.quantity} qty)`
                : `Qty: ${trade.quantity}`}
            </span>
          </div>
          <div className="close-trade-hints">
            {trade.target && <button className="hint-btn" onClick={() => setExitPrice(trade.target)}>Target: {trade.target}</button>}
            {trade.sl && <button className="hint-btn hint-btn--sl" onClick={() => setExitPrice(trade.sl)}>SL: {trade.sl}</button>}
          </div>
          <div className="field" style={{ marginTop: '12px' }}>
            <label>Exit Price</label>
            <input
              type="number"
              value={exitPrice}
              onChange={(e) => setExitPrice(e.target.value)}
              placeholder={suggested}
              autoFocus
            />
          </div>
          {pnl !== null && (
            <div className={`pnl-preview ${pnl >= 0 ? 'pnl-preview--profit' : 'pnl-preview--loss'}`}>
              {pnl >= 0 ? '+' : ''}₹{pnl.toFixed(2)} P&L
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={() => onConfirm(Number(exitPrice))}
            disabled={!exitPrice || isNaN(exitPrice)}
          >
            Close Trade
          </button>
        </div>
      </div>
    </div>
  );
}

function BalanceCard({ balance, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const inputRef = useRef(null);

  function startEdit() {
    setInputVal(String(balance.initial));
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }

  async function confirm() {
    const amount = Number(inputVal);
    if (!amount || isNaN(amount) || amount <= 0) { setEditing(false); return; }
    await onUpdate(amount);
    setEditing(false);
  }

  function handleKey(e) {
    if (e.key === 'Enter') confirm();
    if (e.key === 'Escape') setEditing(false);
  }

  return (
    <div className="paper-balance-card">
      <div className="paper-balance-row">
        <div className="paper-balance-item">
          <span className="paper-balance-label">Starting Balance</span>
          {editing ? (
            <div className="paper-balance-edit">
              <span className="paper-balance-currency">₹</span>
              <input
                ref={inputRef}
                type="number"
                className="paper-balance-input"
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                onKeyDown={handleKey}
                onBlur={confirm}
              />
            </div>
          ) : (
            <div className="paper-balance-value-row">
              <span className="paper-balance-value">₹{balance.initial.toLocaleString('en-IN')}</span>
              <button className="paper-balance-edit-btn" onClick={startEdit} title="Edit starting balance">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </button>
            </div>
          )}
        </div>
        <div className="paper-balance-item paper-balance-item--available">
          <span className="paper-balance-label">Available</span>
          <span className="paper-balance-value">₹{balance.available.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
        </div>
        <div className="paper-balance-item">
          <span className="paper-balance-label">Invested</span>
          <span className="paper-balance-value">₹{balance.invested.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
        </div>
        <div className={`paper-balance-item ${balance.realizedPnl >= 0 ? 'paper-balance-item--profit' : 'paper-balance-item--loss'}`}>
          <span className="paper-balance-label">Realized P&L</span>
          <span className="paper-balance-value">
            {balance.realizedPnl >= 0 ? '+' : ''}₹{balance.realizedPnl.toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Live open trade row ───────────────────────────────────────────────────────
// Subscribes to the tick for this trade's token so LTP and unrealized P&L
// update every second without re-rendering the whole panel.
function OpenTradeRow({ trade, onClose }) {
  const tick    = useAppStore((s) => s.ticks[trade.token]);
  const ltp     = tick?.lastPrice ?? null;
  const priceRef = useRef(null);
  const prevRef  = useRef(null);

  // Flash animation when price changes
  useEffect(() => {
    if (!tick || !priceRef.current) return;
    const curr = tick.lastPrice;
    if (prevRef.current == null) { prevRef.current = curr; return; }
    const dir = curr > prevRef.current ? 'flash-up' : curr < prevRef.current ? 'flash-down' : null;
    prevRef.current = curr;
    if (!dir) return;
    priceRef.current.classList.remove('flash-up', 'flash-down');
    void priceRef.current.offsetWidth;
    priceRef.current.classList.add(dir);
  }, [tick?.lastPrice]); // eslint-disable-line react-hooks/exhaustive-deps

  const unrealizedPnl = ltp != null
    ? (trade.action === 'BUY'
        ? (ltp - trade.entryPrice)
        : (trade.entryPrice - ltp)) * trade.quantity
    : null;

  const pnlCls = unrealizedPnl == null ? '' : unrealizedPnl >= 0 ? 'pnl-positive' : 'pnl-negative';

  // SL / target breach indicators
  const slHit     = ltp != null && trade.sl     != null
    && (trade.action === 'BUY' ? ltp <= trade.sl     : ltp >= trade.sl);
  const targetHit = ltp != null && trade.target != null
    && (trade.action === 'BUY' ? ltp >= trade.target : ltp <= trade.target);

  return (
    <tr className={slHit ? 'paper-row--sl' : targetHit ? 'paper-row--target' : ''}>
      <td className="td-mono">{fmt(trade.ts)}</td>
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span className={`pill ${trade.action === 'BUY' ? 'pill-green' : 'pill-red'}`}>
            {trade.action}
          </span>
          {trade.source === 'auto' && (
            <span className="paper-auto-badge" title={`Auto-placed from ${trade.autoSource ?? 'scanner'}`}>AUTO</span>
          )}
        </div>
      </td>
      <td className="td-symbol">{trade.symbol}</td>
      <td className="td-num">{fmtPrice(trade.entryPrice)}</td>
      <td className="td-num">
        <span ref={priceRef}>
          {ltp != null ? fmtPrice(ltp) : '—'}
        </span>
      </td>
      <td className="td-num">
        {trade.lots != null && trade.lotSize > 1
          ? <span title={`${trade.lots} lot${trade.lots > 1 ? 's' : ''} × ${trade.lotSize}`}>{trade.lots}L<span style={{ color: 'var(--txt3)', fontSize: 11 }}> /{trade.quantity}</span></span>
          : trade.quantity}
      </td>
      <td className="td-num td-sl">
        {trade.tslActivated && (
          <span className="paper-tsl-tag" title={`TSL armed — original SL ₹${trade.initialSl ?? '—'}`}>🔒 </span>
        )}
        {trade.sl != null ? fmtPrice(trade.sl) : '—'}
        {slHit && <span className="paper-hit-tag paper-hit-tag--sl"> 🛑</span>}
      </td>
      <td className="td-num td-tgt">
        {trade.target != null ? fmtPrice(trade.target) : '—'}
        {targetHit && <span className="paper-hit-tag paper-hit-tag--target"> 🎯</span>}
      </td>
      <td className={`td-num ${pnlCls}`}>
        {unrealizedPnl != null
          ? `${unrealizedPnl >= 0 ? '+' : ''}₹${unrealizedPnl.toFixed(2)}`
          : '—'}
      </td>
      <td>
        <button className="btn btn-ghost btn-sm" onClick={() => onClose(trade)}>
          Close
        </button>
      </td>
    </tr>
  );
}

// ── Auto-trader settings strip ────────────────────────────────────────────────
// Testing-mode UI: shows the simplified controls relevant for sampling every
// pattern firing (quantity is always 1, no rupee-risk filter applied).
function AutoTraderSettings() {
  const [settings, setSettings] = useState(null);
  const [saving, setSaving]     = useState(false);
  const [editing, setEditing]   = useState(false);
  const [rrStr, setRrStr]       = useState('');
  const [trigStr, setTrigStr]   = useState('');
  const [distStr, setDistStr]   = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.get('/auto-trader/settings');
      setSettings(r.data);
    } catch { /* server may not have this endpoint yet — ignore */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function patch(updates) {
    setSaving(true);
    try {
      const r = await api.post('/auto-trader/settings', updates);
      setSettings(r.data);
    } catch (err) {
      console.error('[AutoTrader] settings update failed:', err.message);
    } finally {
      setSaving(false);
    }
  }

  function toggleAuto() {
    if (!settings) return;
    patch({ enabled: !settings.enabled });
  }

  function toggleTsl() {
    if (!settings) return;
    patch({ tslEnabled: !settings.tslEnabled });
  }

  async function saveEdits() {
    const rr   = Number(rrStr);
    const trig = Number(trigStr);
    const dist = Number(distStr);
    const updates = {};
    if (rr   > 0) updates.minRR        = rr;
    if (trig > 0) updates.tslTriggerR  = trig;
    if (dist > 0) updates.tslDistanceR = dist;
    if (Object.keys(updates).length) await patch(updates);
    setEditing(false);
  }

  function startEdit() {
    if (!settings) return;
    setRrStr(String(settings.minRR));
    setTrigStr(String(settings.tslTriggerR));
    setDistStr(String(settings.tslDistanceR));
    setEditing(true);
  }

  if (!settings) return null;

  return (
    <div className={`at-settings-bar ${settings.enabled ? 'at-settings-bar--on' : ''}`}>
      <div className="at-settings-left">
        <span className="at-settings-icon">🤖</span>
        <span className="at-settings-label">Auto Trader</span>
        <span className={`at-settings-pill ${settings.enabled ? 'at-settings-pill--on' : 'at-settings-pill--off'}`}>
          {settings.enabled ? 'ON' : 'OFF'}
        </span>
        <span className="at-settings-mode" title="Testing mode — every qualifying alert places 1 unit">qty 1</span>
      </div>

      {settings.enabled && !editing && (
        <div className="at-settings-risk">
          <span className="at-risk-label">Min R:R</span>
          <span className="at-risk-val">1:{settings.minRR}</span>
          <span className="at-risk-sep">·</span>
          <span className="at-risk-label">TSL</span>
          <button
            className={`at-tsl-pill ${settings.tslEnabled ? 'at-tsl-pill--on' : ''}`}
            onClick={toggleTsl}
            disabled={saving}
            title="Toggle Trailing Stop Loss"
          >
            {settings.tslEnabled ? `ON · ${settings.tslTriggerR}R / ${settings.tslDistanceR}R` : 'OFF'}
          </button>
          <button className="at-edit-btn" onClick={startEdit} title="Edit thresholds">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
        </div>
      )}

      {editing && (
        <div className="at-settings-edit">
          <label className="at-edit-label">Min R:R</label>
          <input className="at-edit-input" type="number" step="0.1" value={rrStr}   onChange={(e) => setRrStr(e.target.value)}   placeholder="2.0" />
          <label className="at-edit-label">TSL trig (R)</label>
          <input className="at-edit-input" type="number" step="0.1" value={trigStr} onChange={(e) => setTrigStr(e.target.value)} placeholder="1.0" />
          <label className="at-edit-label">TSL dist (R)</label>
          <input className="at-edit-input" type="number" step="0.1" value={distStr} onChange={(e) => setDistStr(e.target.value)} placeholder="0.5" />
          <button className="btn btn-primary btn-sm" onClick={saveEdits} disabled={saving}>Save</button>
          <button className="btn btn-ghost   btn-sm" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      )}

      <button
        className={`at-toggle-btn ${settings.enabled ? 'at-toggle-btn--on' : ''}`}
        onClick={toggleAuto}
        disabled={saving}
        title={settings.enabled ? 'Disable auto-trader' : 'Enable auto-trader'}
      >
        {saving ? '…' : settings.enabled ? 'Disable' : 'Enable'}
      </button>
    </div>
  );
}

export default function PaperTradingPanel() {
  const paperTrades = useAppStore((s) => s.paperTrades);
  const paperBalance = useAppStore((s) => s.paperBalance);
  const setPaperBalance = useAppStore((s) => s.setPaperBalance);
  const updatePaperTrade = useAppStore((s) => s.updatePaperTrade);
  const clearPaperTrades = useAppStore((s) => s.clearPaperTrades);
  const [closingTrade, setClosingTrade] = useState(null);

  async function handleBalanceUpdate(amount) {
    try {
      const r = await api.post('/paper/balance', { amount });
      setPaperBalance(r.data);
    } catch (err) {
      console.error('Failed to update balance:', err.message);
    }
  }

  const openTrades = paperTrades.filter((t) => t.status === 'OPEN');
  const closedTrades = paperTrades.filter((t) => t.status === 'CLOSED');

  const invested = openTrades.reduce((sum, t) => sum + (t.entryPrice * t.quantity), 0);
  const realizedPnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const unrealizedTarget = openTrades.reduce((sum, t) => {
    if (!t.target) return sum;
    const potential = t.action === 'BUY'
      ? (t.target - t.entryPrice) * t.quantity
      : (t.entryPrice - t.target) * t.quantity;
    return sum + potential;
  }, 0);

  async function handleCloseTrade(exitPrice) {
    if (!closingTrade) return;
    try {
      const r = await api.post(`/paper/${closingTrade.id}/close`, { exitPrice });
      updatePaperTrade(r.data);
    } catch (err) {
      console.error('Failed to close trade:', err.message);
    }
    setClosingTrade(null);
  }

  async function handleClearAll() {
    if (!window.confirm('Clear all paper trades?')) return;
    await api.delete('/paper').catch(() => {});
    clearPaperTrades();
  }

  const openByTF = groupByTF(openTrades);

  return (
    <div className="paper-trading-panel">
      <AutoTraderSettings />
      <BalanceCard balance={paperBalance} onUpdate={handleBalanceUpdate} />

      {/* Stats */}
      <div className="paper-stats-row">
        <div className="paper-stat-card">
          <span className="paper-stat-value">{openTrades.length}</span>
          <span className="paper-stat-label">Active Trades</span>
        </div>
        <div className="paper-stat-card">
          <span className="paper-stat-value">₹{invested.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
          <span className="paper-stat-label">Invested</span>
        </div>
        <div className={`paper-stat-card ${realizedPnl !== 0 ? (realizedPnl >= 0 ? 'paper-stat-card--profit' : 'paper-stat-card--loss') : ''}`}>
          <span className="paper-stat-value">
            {realizedPnl >= 0 ? '+' : ''}₹{realizedPnl.toFixed(2)}
          </span>
          <span className="paper-stat-label">Realized P&L</span>
        </div>
        <div className="paper-stat-card paper-stat-card--muted">
          <span className="paper-stat-value">
            {unrealizedTarget >= 0 ? '+' : ''}₹{unrealizedTarget.toFixed(2)}
          </span>
          <span className="paper-stat-label">Potential (at target)</span>
        </div>
      </div>

      {/* Active trades — grouped by timeframe, live LTP and unrealized P&L per row */}
      {openTrades.length > 0 && (
        <div className="dash-section">
          <h3 className="section-title">
            Active Trades <span className="count-badge">{openTrades.length}</span>
          </h3>
          {openByTF.map(({ tf, label, trades: tfTrades }) => (
            <div key={tf} className="paper-tf-group">
              <div className="paper-tf-header">
                <span className="paper-tf-pill">{tf}</span>
                <span className="paper-tf-name">{label}</span>
                <span className="paper-tf-count">{tfTrades.length} trade{tfTrades.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="kite-table-wrap">
                <table className="kite-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Action</th>
                      <th>Symbol</th>
                      <th className="th-num">Entry</th>
                      <th className="th-num">LTP</th>
                      <th className="th-num">Qty</th>
                      <th className="th-num">SL</th>
                      <th className="th-num">Target</th>
                      <th className="th-num">Live P&amp;L</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {tfTrades.map((t) => (
                      <OpenTradeRow key={t.id} trade={t} onClose={setClosingTrade} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Closed trades */}
      {closedTrades.length > 0 && (
        <div className="dash-section">
          <div className="section-header">
            <h3 className="section-title">Closed Trades <span className="count-badge">{closedTrades.length}</span></h3>
            <button className="btn btn-ghost btn-sm" onClick={handleClearAll}>Clear all</button>
          </div>
          <div className="kite-table-wrap">
            <table className="kite-table">
              <thead>
                <tr>
                  <th>Closed</th>
                  <th>Action</th>
                  <th>Symbol</th>
                  <th className="th-num">Entry</th>
                  <th className="th-num">Exit</th>
                  <th className="th-num">Qty</th>
                  <th className="th-num">P&L</th>
                </tr>
              </thead>
              <tbody>
                {closedTrades.map((t) => (
                  <tr key={t.id}>
                    <td className="td-mono">{fmt(t.closedTs)}</td>
                    <td><span className={`pill ${t.action === 'BUY' ? 'pill-green' : 'pill-red'}`}>{t.action}</span></td>
                    <td className="td-symbol">{t.symbol}</td>
                    <td className="td-num">{t.entryPrice}</td>
                    <td className="td-num">{t.exitPrice}</td>
                    <td className="td-num">
                      {t.lots != null && t.lotSize > 1
                        ? <span title={`${t.lots} lot${t.lots > 1 ? 's' : ''} × ${t.lotSize}`}>{t.lots}L<span style={{ color: 'var(--txt3)', fontSize: 11 }}> /{t.quantity}</span></span>
                        : t.quantity}
                    </td>
                    <td className={`td-num ${pnlColor(t.pnl)}`}>
                      {t.pnl !== null ? `${t.pnl >= 0 ? '+' : ''}₹${t.pnl.toFixed(2)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {paperTrades.length === 0 && (
        <div className="empty-card">
          <p>No paper trades yet — send a signal to get started.</p>
        </div>
      )}

      {closingTrade && (
        <CloseTradeModal
          trade={closingTrade}
          onClose={() => setClosingTrade(null)}
          onConfirm={handleCloseTrade}
        />
      )}
    </div>
  );
}
