import { useState, useRef, useEffect, useCallback } from "react";
import api from "../../api";
import useAppStore from "../../store/appStore";

// ── Timeframe display order (most important first in the UI) ──────────────────
const TF_ORDER = ["1d", "4h", "1h", "15m"];
const TF_LABEL_MAP = { "1d": "Daily", "4h": "4-Hour", "1h": "1-Hour", "15m": "15-Min" };

// IST offset in milliseconds (UTC+5:30)
const IST_MS = 5.5 * 60 * 60 * 1000;

/** Convert a millisecond timestamp to an IST date string "YYYY-MM-DD". */
function toIstDateStr(ts) {
    if (!ts) return "Unknown";
    return new Date(ts + IST_MS).toISOString().slice(0, 10);
}

/** Format "YYYY-MM-DD" → "21 May 2026 (Wednesday)" */
function fmtDateLabel(dateStr) {
    if (dateStr === "Unknown") return "Unknown Date";
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    const day = date.toLocaleDateString("en-IN", { weekday: "short" });
    const full = date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    return `${full} · ${day}`;
}

/**
 * Group closed trades by IST date, most recent first.
 * Returns [{ dateStr, label, trades, totalPnl, wins, losses }]
 */
function groupByDate(trades) {
    const groups = {};
    for (const t of trades) {
        const key = toIstDateStr(t.closedTs);
        if (!groups[key]) groups[key] = [];
        groups[key].push(t);
    }
    return Object.keys(groups)
        .sort((a, b) => b.localeCompare(a)) // newest first
        .map(dateStr => {
            const dayTrades = groups[dateStr];
            const totalPnl = dayTrades.reduce((s, t) => s + (t.pnl || 0), 0);
            const wins     = dayTrades.filter(t => (t.pnl || 0) > 0).length;
            const losses   = dayTrades.filter(t => (t.pnl || 0) < 0).length;
            return { dateStr, label: fmtDateLabel(dateStr), trades: dayTrades, totalPnl, wins, losses };
        });
}

/** Group an array of trades by their tfLabel, preserving TF_ORDER. */
function groupByTF(trades) {
    const groups = {};
    for (const t of trades) {
        const tf = t.tfLabel ?? "Other";
        if (!groups[tf]) groups[tf] = [];
        groups[tf].push(t);
    }
    // Sort by TF_ORDER; unknown TFs go last
    const ordered = [...TF_ORDER, "Other"].filter(tf => groups[tf]);
    return ordered.map(tf => ({ tf, label: TF_LABEL_MAP[tf] ?? tf, trades: groups[tf] }));
}

function fmt(ts) {
    return new Date(ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtPrice(n) {
    if (n == null || isNaN(n)) return "—";
    return Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pnlColor(pnl) {
    if (pnl === null) return "";
    return pnl >= 0 ? "pnl-positive" : "pnl-negative";
}

function SortTh({ label, field, sort, onSort, className }) {
    const active = sort.field === field;
    const arrow = active ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
    return (
        <th
            className={`${className || ""} th-sortable`}
            style={{ cursor: "pointer", userSelect: "none" }}
            onClick={() =>
                onSort({
                    field,
                    dir: active && sort.dir === "asc" ? "desc" : "asc"
                })
            }
        >
            {label}
            {arrow}
        </th>
    );
}

function sortTrades(trades, sort, getValue) {
    if (!sort.field) return trades;
    const sorted = [...trades].sort((a, b) => {
        const va = getValue(a, sort.field);
        const vb = getValue(b, sort.field);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        if (typeof va === "string") return va.localeCompare(vb);
        return va - vb;
    });
    return sort.dir === "desc" ? sorted.reverse() : sorted;
}

function CloseTradeModal({ trade, currentLtp, onClose, onConfirm }) {
    const [exitPrice, setExitPrice] = useState(currentLtp ?? trade.entryPrice ?? "");
    const suggested = trade.target || trade.sl || trade.entryPrice;

    const pnl = exitPrice
        ? trade.action === "BUY"
            ? (Number(exitPrice) - trade.entryPrice) * trade.quantity
            : (trade.entryPrice - Number(exitPrice)) * trade.quantity
        : null;

    return (
        <div className="modal-overlay">
            <div className="modal-card" style={{ width: 380 }}>
                <div className="modal-header">
                    <span>Close Trade — {trade.symbol}</span>
                    <button className="modal-close" onClick={onClose}>
                        ✕
                    </button>
                </div>
                <div className="modal-body">
                    <div className="close-trade-info">
                        <span className={`pill ${trade.action === "BUY" ? "pill-green" : "pill-red"}`}>
                            {trade.action}
                        </span>
                        <span style={{ fontWeight: 600 }}>{trade.symbol}</span>
                        <span style={{ color: "var(--txt2)" }}>Entry: {trade.entryPrice}</span>
                        <span style={{ color: "var(--txt2)" }}>
                            {trade.lots != null && trade.lotSize > 1
                                ? `${trade.lots} lot${trade.lots > 1 ? "s" : ""} (${trade.quantity} qty)`
                                : `Qty: ${trade.quantity}`}
                        </span>
                    </div>
                    <div className="close-trade-hints">
                        {trade.target && (
                            <button className="hint-btn" onClick={() => setExitPrice(trade.target)}>
                                Target: {trade.target}
                            </button>
                        )}
                        {trade.sl && (
                            <button className="hint-btn hint-btn--sl" onClick={() => setExitPrice(trade.sl)}>
                                SL: {trade.sl}
                            </button>
                        )}
                    </div>
                    <div className="field" style={{ marginTop: "12px" }}>
                        <label>Exit Price</label>
                        <input
                            type="number"
                            value={exitPrice}
                            onChange={e => setExitPrice(e.target.value)}
                            placeholder={suggested}
                            autoFocus
                        />
                    </div>
                    {pnl !== null && (
                        <div className={`pnl-preview ${pnl >= 0 ? "pnl-preview--profit" : "pnl-preview--loss"}`}>
                            {pnl >= 0 ? "+" : ""}₹{pnl.toFixed(2)} P&L
                        </div>
                    )}
                </div>
                <div className="modal-footer">
                    <button className="btn btn-ghost" onClick={onClose}>
                        Cancel
                    </button>
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

function BalanceCard({ balance }) {
    const totalBalance = balance.available + balance.invested;
    const intPart = Math.floor(totalBalance).toLocaleString("en-IN");
    const decPart = (totalBalance % 1).toFixed(2).slice(2);
    const pnlCls = balance.realizedPnl >= 0 ? "pnl-positive" : "pnl-negative";

    return (
        <div className="lc-balance-hero">
            <div className="lc-balance-label">Total Balance</div>
            <div className="lc-balance-amount">
                ₹{intPart}
                <span className="lc-balance-decimal">.{decPart}</span>
            </div>
            {balance.realizedPnl !== 0 && (
                <div className={`lc-balance-change ${pnlCls}`}>
                    {balance.realizedPnl >= 0 ? "↑ +" : "↓ −"}₹
                    {Math.abs(balance.realizedPnl).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                    <span className="lc-balance-change-label">· Realized P&L</span>
                </div>
            )}
            <div className="lc-balance-cards">
                <div className="lc-balance-card">
                    <span className="lc-balance-card-label">Available</span>
                    <span className="lc-balance-card-value">
                        ₹{balance.available.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                    </span>
                </div>
                <div className="lc-balance-card">
                    <span className="lc-balance-card-label">Deployed</span>
                    <span className="lc-balance-card-value">
                        ₹{balance.invested.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
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
    const tradeTick = useAppStore(s => s.tradeTicks[trade.id]);
    const tick = useAppStore(s => s.ticks[trade.token]);

    const spotLtp = tick?.lastPrice ?? null;
    const ltp = tradeTick?.ltp ?? spotLtp;
    const monitorLtp = ltp;

    const priceRef = useRef(null);
    const prevRef = useRef(null);

    // Flash animation on any LTP change (source-agnostic).
    useEffect(() => {
        if (ltp == null || !priceRef.current) return;
        if (prevRef.current == null) {
            prevRef.current = ltp;
            return;
        }
        const dir = ltp > prevRef.current ? "flash-up" : ltp < prevRef.current ? "flash-down" : null;
        prevRef.current = ltp;
        if (!dir) return;
        priceRef.current.classList.remove("flash-up", "flash-down");
        void priceRef.current.offsetWidth;
        priceRef.current.classList.add(dir);
    }, [ltp]);

    // Prefer server-calculated P&L; client-side fallback only for non-options
    let unrealizedPnl = null;
    if (tradeTick?.unrealizedPnl != null) {
        unrealizedPnl = tradeTick.unrealizedPnl;
    } else if (ltp != null) {
        unrealizedPnl = (trade.action === "BUY" ? ltp - trade.entryPrice : trade.entryPrice - ltp) * trade.quantity;
    }

    const pnlCls = unrealizedPnl == null ? "" : unrealizedPnl >= 0 ? "pnl-positive" : "pnl-negative";

    // SL / target breach indicators (always spot-based for options)
    const slHit =
        monitorLtp != null &&
        trade.sl != null &&
        (trade.action === "BUY" ? monitorLtp <= trade.sl : monitorLtp >= trade.sl);
    const targetHit =
        monitorLtp != null &&
        trade.target != null &&
        (trade.action === "BUY" ? monitorLtp >= trade.target : monitorLtp <= trade.target);

    return (
        <tr className={slHit ? "paper-row--sl" : targetHit ? "paper-row--target" : ""}>
            <td className="td-mono mob-hide">{fmt(trade.ts)}</td>
            <td className="mob-hide">
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span className={`pill ${trade.action === "BUY" ? "pill-green" : "pill-red"}`}>{trade.action}</span>
                    {trade.source === "auto" && (
                        <span className="paper-auto-badge" title={`Auto-placed from ${trade.autoSource ?? "scanner"}`}>
                            AUTO
                        </span>
                    )}
                </div>
            </td>
            <td className="td-symbol flex">
                <span>
                    {trade.source === "auto" && (
                        <span className="td-sym-bot" title="Auto trade">
                            🤖
                        </span>
                    )}
                    <span className={`td-sym-side td-sym-side--${trade.action === "BUY" ? "b" : "s"}`}>
                        {trade.action === "BUY" ? "B" : "S"}
                    </span>

                    {trade.symbol}
                </span>
                {trade.patternLabel && (
                    <span className="td-sym-pattern" title={trade.patternId ?? trade.patternLabel}>
                        {trade.patternLabel}
                    </span>
                )}
                {trade.sl != null && (
                    <span className="td-sym-sl mob-only">
                        {trade.tslActivated ? "🔒" : "SL"} ₹{fmtPrice(trade.sl)}
                        {slHit && " 🛑"}
                    </span>
                )}
            </td>
            <td className="td-tf">
                {trade.tfLabel ? (
                    <span className={`pill-tf pill-tf--${trade.tfLabel}`}>{trade.tfLabel}</span>
                ) : "—"}
            </td>
            <td className="td-num td-entry mob-hide">{fmtPrice(trade.entryPrice)}</td>
            <td className="td-num">
                <span ref={priceRef} className="td-ltp">
                    {fmtPrice(ltp ?? trade.entryPrice)}
                </span>
            </td>
            <td className="td-num">
                {trade.lots != null && trade.lotSize > 1 ? (
                    <span title={`${trade.lots} lot${trade.lots > 1 ? "s" : ""} × ${trade.lotSize}`}>
                        {trade.lots}L<span style={{ color: "var(--txt3)", fontSize: 11 }}> /{trade.quantity}</span>
                    </span>
                ) : (
                    trade.quantity
                )}
            </td>
            <td className="td-num td-sl mob-hide">
                {trade.tslActivated && (
                    <span className="paper-tsl-tag" title={`TSL armed — original SL ₹${trade.initialSl ?? "—"}`}>
                        🔒{" "}
                    </span>
                )}
                {trade.sl != null ? <>{fmtPrice(trade.sl)}</> : "—"}
                {slHit && <span className="paper-hit-tag paper-hit-tag--sl"> 🛑</span>}
            </td>
            <td className="td-num td-tgt mob-hide">
                {trade.target != null ? <>{fmtPrice(trade.target)}</> : "—"}
                {targetHit && <span className="paper-hit-tag paper-hit-tag--target"> 🎯</span>}
            </td>
            <td className={`td-num ${pnlCls}`}>
                {unrealizedPnl != null ? `${unrealizedPnl >= 0 ? "+" : ""}₹${unrealizedPnl.toFixed(2)}` : "—"}
            </td>
            <td>
                <button className="btn btn-ghost btn-sm paper-close-btn" onClick={() => onClose(trade, ltp)}>
                    <span className="paper-close-label">Close</span>
                    <span className="paper-close-icon">×</span>
                </button>
            </td>
        </tr>
    );
}

// ── Pending order row ─────────────────────────────────────────────────────────
function PendingOrderRow({ trade, onCancel }) {
    const tick = useAppStore(s => s.ticks[trade.token]);
    const ltp = tick?.lastPrice ?? null;

    const dirLabel = trade.triggerDir === 'above' ? '↑ ≥' : '↓ ≤';
    const dist = ltp != null ? Math.abs(ltp - trade.triggerPrice).toFixed(2) : null;

    return (
        <tr className="paper-row--pending">
            <td className="td-mono mob-hide">{fmt(trade.ts)}</td>
            <td className="td-symbol">
                <span className={`td-sym-side td-sym-side--${trade.action === "BUY" ? "b" : "s"}`}>
                    {trade.action === "BUY" ? "B" : "S"}
                </span>
                {trade.symbol}
                <span className="paper-pending-badge">⏳</span>
            </td>
            <td className="td-num">
                <span title={`Triggers when price ${trade.triggerDir === 'above' ? '≥' : '≤'} ₹${fmtPrice(trade.triggerPrice)}`}>
                    {dirLabel} ₹{fmtPrice(trade.triggerPrice)}
                </span>
                {ltp != null && dist != null && (
                    <span style={{ fontSize: 10, color: "var(--txt3)", display: "block" }}>
                        LTP ₹{fmtPrice(ltp)} · ₹{dist} away
                    </span>
                )}
            </td>
            <td className="td-num mob-hide">{trade.sl != null ? fmtPrice(trade.sl) : "—"}</td>
            <td className="td-num mob-hide">{trade.target != null ? fmtPrice(trade.target) : "—"}</td>
            <td className="td-num">
                {trade.lots != null && trade.lotSize > 1
                    ? <span title={`${trade.lots} lot${trade.lots > 1 ? "s" : ""} × ${trade.lotSize}`}>{trade.lots}L</span>
                    : trade.quantity
                }
            </td>
            <td>
                <button
                    className="btn btn-ghost btn-sm paper-close-btn"
                    onClick={() => onCancel(trade.id)}
                    title="Cancel pending order"
                >
                    <span className="paper-close-label">Cancel</span>
                    <span className="paper-close-icon">×</span>
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
    const [saving, setSaving] = useState(false);
    const [editing, setEditing] = useState(false);
    const [profitStr, setProfitStr] = useState("");
    const [trigStr, setTrigStr] = useState("");
    const [distStr, setDistStr] = useState("");

    const load = useCallback(async () => {
        try {
            const r = await api.get("/auto-trader/settings");
            setSettings(r.data);
        } catch {
            /* server may not have this endpoint yet — ignore */
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    async function patch(updates) {
        setSaving(true);
        try {
            const r = await api.post("/auto-trader/settings", updates);
            setSettings(r.data);
        } catch (err) {
            console.error("[AutoTrader] settings update failed:", err.message);
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
        const profit = Number(profitStr);
        const trig   = Number(trigStr);
        const dist   = Number(distStr);
        const risk   = Number(riskStr);
        const updates = {};
        if (profit > 0) updates.minProfit = profit;
        if (trig > 0)   updates.tslTriggerR  = trig;
        if (dist > 0)   updates.tslDistanceR = dist;
        if (risk > 0)   updates.riskPerTrade = risk;
        if (Object.keys(updates).length) await patch(updates);
        setEditing(false);
    }

    const [riskStr, setRiskStr] = useState("");

    function startEdit() {
        if (!settings) return;
        setProfitStr(String(settings.minProfit));
        setTrigStr(String(settings.tslTriggerR));
        setDistStr(String(settings.tslDistanceR));
        setRiskStr(String(settings.riskPerTrade));
        setEditing(true);
    }

    if (!settings) return null;

    return (
        <div className={`at-settings-bar ${settings.enabled ? "at-settings-bar--on" : ""}`}>
            <div className="at-settings-left">
                <span className="at-settings-icon">🤖</span>
                <span className="at-settings-label">Auto Trader</span>
                <span
                    className={`at-settings-pill ${
                        settings.enabled ? "at-settings-pill--on" : "at-settings-pill--off"
                    }`}
                >
                    {settings.enabled ? "ON" : "OFF"}
                </span>
                {settings.enabled && (
                    <span
                        className="at-sizing-hint"
                        title={`NSE: risk-based (₹${settings.riskPerTrade}/trade, ≥₹${settings.minProfit} profit) · MCX: 1 lot per trade`}
                        style={{ fontSize: 11, color: "var(--txt3)" }}
                    >
                        NSE risk ₹{(settings.riskPerTrade / 1000).toFixed(0)}k · MCX 1 lot
                    </span>
                )}
            </div>

            {settings.enabled && !editing && (
                <div className="at-settings-risk">
                    <span className="at-risk-label">Min profit</span>
                    <span className="at-risk-val">₹{(settings.minProfit / 1000).toFixed(0)}k</span>
                    <span className="at-risk-sep">·</span>
                    <span className="at-risk-label">TSL</span>
                    <button
                        className={`at-tsl-pill ${settings.tslEnabled ? "at-tsl-pill--on" : ""}`}
                        onClick={toggleTsl}
                        disabled={saving}
                        title="Toggle Trailing Stop Loss"
                    >
                        {settings.tslEnabled ? `ON · ${settings.tslTriggerR}R / ${settings.tslDistanceR}R` : "OFF"}
                    </button>
                    <button className="at-edit-btn" onClick={startEdit} title="Edit thresholds">
                        <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                    </button>
                </div>
            )}

            {editing && (
                <div className="at-settings-edit">
                    <label className="at-edit-label">Risk/Trade (₹)</label>
                    <input
                        className="at-edit-input"
                        type="number"
                        step="500"
                        value={riskStr}
                        onChange={e => setRiskStr(e.target.value)}
                        placeholder="10000"
                    />
                    <label className="at-edit-label">Min Profit (₹)</label>
                    <input
                        className="at-edit-input"
                        type="number"
                        step="500"
                        value={profitStr}
                        onChange={e => setProfitStr(e.target.value)}
                        placeholder="20000"
                    />
                    <label className="at-edit-label">TSL trig (R)</label>
                    <input
                        className="at-edit-input"
                        type="number"
                        step="0.1"
                        value={trigStr}
                        onChange={e => setTrigStr(e.target.value)}
                        placeholder="1.0"
                    />
                    <label className="at-edit-label">TSL dist (R)</label>
                    <input
                        className="at-edit-input"
                        type="number"
                        step="0.1"
                        value={distStr}
                        onChange={e => setDistStr(e.target.value)}
                        placeholder="0.5"
                    />
                    <button className="btn btn-primary btn-sm" onClick={saveEdits} disabled={saving}>
                        Save
                    </button>
                    <button className="btn btn-ghost   btn-sm" onClick={() => setEditing(false)}>
                        Cancel
                    </button>
                </div>
            )}

            <button
                className={`at-toggle-btn ${settings.enabled ? "at-toggle-btn--on" : ""}`}
                onClick={toggleAuto}
                disabled={saving}
                title={settings.enabled ? "Disable auto-trader" : "Enable auto-trader"}
            >
                {saving ? "…" : settings.enabled ? "Disable" : "Enable"}
            </button>
        </div>
    );
}

const MCX_RE = /^(CRUDE|NATURAL|BRENT|GOLD|SILVER|COPPER|ZINC|LEAD|NICKEL|ALUMIN|MENTHA|CASTOR|COTTON|CARDAM)/i;

function tradeExchange(t) {
    const ex = (t.exchange || t.derivativeExchange || "").toUpperCase();
    if (ex === "MCX") return "MCX";
    if (ex === "NSE" || ex === "NFO" || ex === "BSE" || ex === "BFO" || ex === "CDS") return "NSE";
    return MCX_RE.test(t.symbol ?? "") ? "MCX" : "NSE";
}

export default function PaperTradingPanel() {
    const paperTrades = useAppStore(s => s.paperTrades);
    const paperBalance = useAppStore(s => s.paperBalance);

    const updatePaperTrade = useAppStore(s => s.updatePaperTrade);
    const removePaperTrade = useAppStore(s => s.removePaperTrade);
    const clearPaperTrades = useAppStore(s => s.clearPaperTrades);
    const [closingTrade, setClosingTrade] = useState(null);
    const [sourceFilter, setSourceFilter] = useState("all");
    const [exchFilter, setExchFilter] = useState("all");
    const [openSort, setOpenSort] = useState({ field: "ts", dir: "desc" });
    const [closedSort, setClosedSort] = useState({ field: "closedTs", dir: "desc" });

    // Historical trades fetched from MongoDB — merged with live store for display.
    const [dbTrades, setDbTrades]       = useState([]);
    const [loadingDb, setLoadingDb]     = useState(false);
    const [dbLoaded, setDbLoaded]       = useState(false);
    const [dbLimit, setDbLimit]         = useState(200);

    // Which date groups are collapsed — today starts expanded, older dates collapsed.
    const todayIst = toIstDateStr(Date.now());
    const [collapsedDates, setCollapsedDates] = useState(new Set());

    function toggleDate(dateStr) {
        setCollapsedDates(prev => {
            const next = new Set(prev);
            if (next.has(dateStr)) next.delete(dateStr);
            else next.add(dateStr);
            return next;
        });
    }

    function collapseAll()  { setCollapsedDates(new Set(dateGroups.map(g => g.dateStr))); }
    function expandAll()    { setCollapsedDates(new Set()); }

    /** Fetch recent trades from MongoDB and merge into the display list. */
    async function handleLoadHistory(limit = dbLimit) {
        setLoadingDb(true);
        try {
            const r = await api.get(`/paper/recent-from-db?limit=${limit}`);
            // Server also restores OPEN trades into memory via this endpoint.
            // For display we keep the full result including CLOSED ones.
            setDbTrades(r.data);
            setDbLoaded(true);
            setDbLimit(limit);
        } catch (err) {
            console.error("[PaperPanel] load history failed:", err.message);
        } finally {
            setLoadingDb(false);
        }
    }

    // Merge live store with DB history — deduplicate by trade id, store wins on conflict.
    const storeIds = new Set(paperTrades.map(t => t.id));
    const mergedTrades = dbLoaded
        ? [...paperTrades, ...dbTrades.filter(t => !storeIds.has(t.id))]
        : paperTrades;

    let filtered = sourceFilter === "all" ? mergedTrades : mergedTrades.filter(t => t.source === sourceFilter);
    if (exchFilter !== "all") {
        filtered = filtered.filter(t => tradeExchange(t) === exchFilter);
    }
    const pendingTrades = filtered.filter(t => t.status === "PENDING");
    const openTrades = filtered.filter(t => t.status === "OPEN");
    const closedTrades = filtered.filter(t => t.status === "CLOSED");

    async function handleCancelPending(id) {
        try {
            await api.delete(`/paper/${id}`);
        } catch { /* server may be unreachable — still remove locally */ }
        removePaperTrade(id);
    }

    const invested = openTrades.reduce((sum, t) => sum + t.entryPrice * t.quantity, 0);
    const realizedPnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const unrealizedTarget = openTrades.reduce((sum, t) => {
        if (!t.target) return sum;
        const potential =
            t.action === "BUY" ? (t.target - t.entryPrice) * t.quantity : (t.entryPrice - t.target) * t.quantity;
        return sum + potential;
    }, 0);

    async function handleCloseTrade(exitPrice) {
        if (!closingTrade) return;
        try {
            const r = await api.post(`/paper/${closingTrade.trade.id}/close`, { exitPrice });
            updatePaperTrade(r.data);
        } catch (err) {
            console.error("Failed to close trade:", err.message);
        }
        setClosingTrade(null);
    }

    async function handleClearAll() {
        if (!window.confirm("Clear all paper trades?")) return;
        await api.delete("/paper").catch(() => {});
        clearPaperTrades();
    }

    const openGetVal = (t, f) => {
        if (f === "ts") return t.ts;
        if (f === "symbol") return t.symbol;
        if (f === "entry") return t.entryPrice;
        if (f === "qty") return t.quantity;
        if (f === "sl") return t.sl;
        if (f === "target") return t.target;
        return null;
    };
    const sortedOpen = sortTrades(openTrades, openSort, openGetVal);

    const closedGetVal = (t, f) => {
        if (f === "closedTs") return t.closedTs;
        if (f === "symbol") return t.symbol;
        if (f === "entry") return t.entryPrice;
        if (f === "exit") return t.exitPrice;
        if (f === "qty") return t.quantity;
        if (f === "pnl") return t.pnl;
        return null;
    };
    const sortedClosed = sortTrades(closedTrades, closedSort, closedGetVal);
    // Date groups derived from sortedClosed — used by the date-wise history view.
    const dateGroups = groupByDate(sortedClosed);

    return (
        <div className="paper-trading-panel">
            <AutoTraderSettings />
            <BalanceCard balance={paperBalance} />

            <div className="paper-source-filter">
                {/* Pills — hidden on mobile */}
                <div className="paper-filter-pills">
                    {[
                        { id: "all", label: "All" },
                        { id: "auto", label: "Auto" },
                        { id: "scan", label: "Manual" }
                    ].map(({ id, label }) => (
                        <button
                            key={id}
                            className={`paper-source-btn ${sourceFilter === id ? "paper-source-btn--active" : ""}`}
                            onClick={() => setSourceFilter(id)}
                        >
                            {label}
                        </button>
                    ))}
                    <span style={{ borderLeft: "1px solid var(--border)", margin: "0 4px" }} />
                    {[
                        { id: "all", label: "All" },
                        { id: "NSE", label: "NSE" },
                        { id: "MCX", label: "MCX" }
                    ].map(({ id, label }) => (
                        <button
                            key={`ex-${id}`}
                            className={`paper-source-btn ${exchFilter === id ? "paper-source-btn--active" : ""}`}
                            onClick={() => setExchFilter(id)}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                {/* Dropdowns — shown only on mobile */}
                <div className="paper-filter-selects">
                    <select
                        className="paper-filter-select"
                        value={sourceFilter}
                        onChange={e => setSourceFilter(e.target.value)}
                    >
                        <option value="all">All Sources</option>
                        <option value="auto">Auto</option>
                        <option value="scan">Manual</option>
                    </select>
                    <select
                        className="paper-filter-select"
                        value={exchFilter}
                        onChange={e => setExchFilter(e.target.value)}
                    >
                        <option value="all">All Exchanges</option>
                        <option value="NSE">NSE</option>
                        <option value="MCX">MCX</option>
                    </select>
                </div>
            </div>

            {/* Stats */}
            <div className="paper-stats-row">
                <div className="paper-stat-card">
                    <span className="paper-stat-value">{openTrades.length}</span>
                    <span className="paper-stat-label">Active Trades</span>
                </div>
                <div className="paper-stat-card">
                    <span className="paper-stat-value">
                        ₹{invested.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                    </span>
                    <span className="paper-stat-label">Invested</span>
                </div>
                <div
                    className={`paper-stat-card ${
                        realizedPnl !== 0
                            ? realizedPnl >= 0
                                ? "paper-stat-card--profit"
                                : "paper-stat-card--loss"
                            : ""
                    }`}
                >
                    <span className="paper-stat-value">
                        {realizedPnl >= 0 ? "+" : ""}₹{realizedPnl.toFixed(2)}
                    </span>
                    <span className="paper-stat-label">Realized P&L</span>
                </div>
                <div className="paper-stat-card paper-stat-card--muted">
                    <span className="paper-stat-value">
                        {unrealizedTarget >= 0 ? "+" : ""}₹{unrealizedTarget.toFixed(2)}
                    </span>
                    <span className="paper-stat-label">Potential (at target)</span>
                </div>
            </div>

            {/* Pending orders — waiting for trigger price to be hit */}
            {pendingTrades.length > 0 && (
                <div className="dash-section">
                    <h3 className="section-title">
                        Pending Orders <span className="count-badge">{pendingTrades.length}</span>
                    </h3>
                    <div className="kite-table-wrap">
                        <table className="kite-table">
                            <thead>
                                <tr>
                                    <th className="mob-hide">Time</th>
                                    <th>Symbol</th>
                                    <th className="th-num">Trigger ₹</th>
                                    <th className="th-num mob-hide">SL</th>
                                    <th className="th-num mob-hide">Target</th>
                                    <th className="th-num">Qty</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {pendingTrades.map(t => (
                                    <PendingOrderRow key={t.id} trade={t} onCancel={handleCancelPending} />
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Active trades — grouped by timeframe, live LTP and unrealized P&L per row */}
            {openTrades.length > 0 && (
                <div className="dash-section">
                    <h3 className="section-title">
                        Active Trades <span className="count-badge">{openTrades.length}</span>
                    </h3>
                    <div className="kite-table-wrap">
                        <table className="kite-table">
                            <thead>
                                <tr>
                                    <SortTh
                                        label="Time"
                                        field="ts"
                                        sort={openSort}
                                        onSort={setOpenSort}
                                        className="mob-hide"
                                    />
                                    <th className="mob-hide">Action</th>
                                    <SortTh label="Symbol" field="symbol" sort={openSort} onSort={setOpenSort} />
                                    <th className="th-tf">TF</th>
                                    <SortTh
                                        label={
                                            <>
                                                <span className="mob-hide">Entry</span>
                                                <span className="mob-show">LTP</span>
                                            </>
                                        }
                                        field="entry"
                                        sort={openSort}
                                        onSort={setOpenSort}
                                        className="th-num"
                                    />
                                    <th className="th-num mob-hide">LTP</th>
                                    <SortTh
                                        label="Qty"
                                        field="qty"
                                        sort={openSort}
                                        onSort={setOpenSort}
                                        className="th-num"
                                    />
                                    <SortTh
                                        label="SL"
                                        field="sl"
                                        sort={openSort}
                                        onSort={setOpenSort}
                                        className="th-num mob-hide"
                                    />
                                    <SortTh
                                        label="Target"
                                        field="target"
                                        sort={openSort}
                                        onSort={setOpenSort}
                                        className="th-num mob-hide"
                                    />
                                    <th className="th-num">Live P&amp;L</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {sortedOpen.map(t => (
                                    <OpenTradeRow key={t.id} trade={t} onClose={(t, ltp) => setClosingTrade({ trade: t, ltp })} />
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Closed trades — grouped by IST date */}
            {closedTrades.length > 0 && (
                <div className="dash-section">
                    <div className="section-header">
                        <h3 className="section-title">
                            Closed Trades <span className="count-badge">{closedTrades.length}</span>
                        </h3>
                        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                            {/* Collapse / Expand all date groups */}
                            <button className="btn btn-ghost btn-sm" onClick={expandAll} title="Expand all dates">▼ All</button>
                            <button className="btn btn-ghost btn-sm" onClick={collapseAll} title="Collapse all dates">▶ All</button>
                            {!dbLoaded ? (
                                <button
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => handleLoadHistory(500)}
                                    disabled={loadingDb}
                                    title="Fetch full trade history from MongoDB"
                                >
                                    {loadingDb ? "Loading…" : "📂 History"}
                                </button>
                            ) : (
                                <>
                                    {dbLimit < 1000 && (
                                        <button
                                            className="btn btn-ghost btn-sm"
                                            onClick={() => handleLoadHistory(1000)}
                                            disabled={loadingDb}
                                            title="Load up to 1000 trades"
                                        >
                                            {loadingDb ? "…" : "Load More"}
                                        </button>
                                    )}
                                    <span style={{ fontSize: 11, color: "var(--txt3)" }}>DB {dbTrades.length}</span>
                                </>
                            )}
                            <button className="btn btn-ghost btn-sm" onClick={handleClearAll}>Clear all</button>
                        </div>
                    </div>

                    {/* One table per date */}
                    {dateGroups.map(({ dateStr, label, trades: dayTrades, totalPnl, wins, losses }) => {
                        const isCollapsed = collapsedDates.has(dateStr);
                        const pnlCls      = totalPnl >= 0 ? "pnl-positive" : "pnl-negative";
                        return (
                            <div key={dateStr} className="closed-date-group">
                                {/* ── Date header ── */}
                                <button
                                    className="closed-date-header"
                                    onClick={() => toggleDate(dateStr)}
                                    aria-expanded={!isCollapsed}
                                >
                                    <span className="cdh-arrow">{isCollapsed ? "▶" : "▼"}</span>
                                    <span className="cdh-date">{label}</span>
                                    <span className="cdh-meta">
                                        <span className="cdh-count">{dayTrades.length} trade{dayTrades.length !== 1 ? "s" : ""}</span>
                                        <span className="cdh-wr">
                                            <span style={{ color: "var(--green)" }}>W:{wins}</span>
                                            {" / "}
                                            <span style={{ color: "var(--red)" }}>L:{losses}</span>
                                        </span>
                                        <span className={`cdh-pnl ${pnlCls}`}>
                                            {totalPnl >= 0 ? "+" : ""}₹{totalPnl.toFixed(0)}
                                        </span>
                                    </span>
                                </button>

                                {/* ── Trades table for this date ── */}
                                {!isCollapsed && (
                                    <div className="kite-table-wrap">
                                        <table className="kite-table">
                                            <thead>
                                                <tr>
                                                    <SortTh label="Time" field="closedTs" sort={closedSort} onSort={setClosedSort} className="mob-hide" />
                                                    <th className="mob-hide">Action</th>
                                                    <SortTh label="Symbol" field="symbol" sort={closedSort} onSort={setClosedSort} />
                                                    <th className="th-tf">TF</th>
                                                    <SortTh label="Entry" field="entry" sort={closedSort} onSort={setClosedSort} className="th-num" />
                                                    <SortTh label="Exit"  field="exit"  sort={closedSort} onSort={setClosedSort} className="th-num mob-hide" />
                                                    <SortTh label="Qty"   field="qty"   sort={closedSort} onSort={setClosedSort} className="th-num" />
                                                    <SortTh label="P&L"   field="pnl"   sort={closedSort} onSort={setClosedSort} className="th-num" />
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {sortTrades(dayTrades, closedSort, closedGetVal).map(t => (
                                                    <tr key={t.id}>
                                                        <td className="td-mono mob-hide">{fmt(t.closedTs)}</td>
                                                        <td className="mob-hide">
                                                            <span className={`pill ${t.action === "BUY" ? "pill-green" : "pill-red"}`}>
                                                                {t.action}
                                                            </span>
                                                        </td>
                                                        <td className="td-symbol">
                                                            {t.source === "auto" && <span className="td-sym-bot" title="Auto trade">🤖</span>}
                                                            {t.symbol}
                                                            {t.patternLabel && (
                                                                <span className="td-sym-pattern" title={t.patternId ?? t.patternLabel}>
                                                                    {t.patternLabel}
                                                                </span>
                                                            )}
                                                        </td>
                                                        <td className="td-tf">
                                                            {t.tfLabel ? (
                                                                <span className={`pill-tf pill-tf--${t.tfLabel}`}>{t.tfLabel}</span>
                                                            ) : "—"}
                                                        </td>
                                                        <td className="td-num">{t.entryPrice}</td>
                                                        <td className="td-num mob-hide">{t.exitPrice}</td>
                                                        <td className="td-num">
                                                            {t.lots != null && t.lotSize > 1 ? (
                                                                <span title={`${t.lots} lot${t.lots > 1 ? "s" : ""} × ${t.lotSize}`}>
                                                                    {t.lots}L
                                                                    <span style={{ color: "var(--txt3)", fontSize: 11 }}> /{t.quantity}</span>
                                                                </span>
                                                            ) : t.quantity}
                                                        </td>
                                                        <td className={`td-num ${pnlColor(t.pnl)}`}>
                                                            {t.pnl !== null ? `${t.pnl >= 0 ? "+" : ""}₹${t.pnl.toFixed(2)}` : "—"}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {paperTrades.length === 0 && (
                <div className="empty-card">
                    <p>No paper trades yet — send a signal to get started.</p>
                </div>
            )}

            {/* Load History — shown when no closed trades are visible yet */}
            {closedTrades.length === 0 && !dbLoaded && (
                <div style={{ padding: "8px 0 4px", display: "flex", justifyContent: "center" }}>
                    <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => handleLoadHistory(500)}
                        disabled={loadingDb}
                        title="Fetch full trade history from MongoDB"
                    >
                        {loadingDb ? "Loading…" : "📂 Load History from DB"}
                    </button>
                </div>
            )}

            {closingTrade && (
                <CloseTradeModal
                    trade={closingTrade.trade}
                    currentLtp={closingTrade.ltp}
                    onClose={() => setClosingTrade(null)}
                    onConfirm={handleCloseTrade}
                />
            )}

            {/* ── Date-wise Order History from DB ── */}
            <OrderHistoryPanel />
        </div>
    );
}

// ── Order History Panel — fetch any date's trades directly from MongoDB ───────
function OrderHistoryPanel() {
    const todayStr = toIstDateStr(Date.now());
    const [selectedDate, setSelectedDate] = useState(todayStr);
    const [trades,       setTrades]       = useState(null);   // null = not fetched yet
    const [loading,      setLoading]      = useState(false);
    const [error,        setError]        = useState('');
    const [tradingDates, setTradingDates] = useState([]);     // all dates that have trades in DB

    // Load available trading dates once so we can navigate prev/next.
    useEffect(() => {
        api.get('/paper/trading-dates')
            .then(r => setTradingDates(r.data))
            .catch(() => {});
    }, []);

    async function fetchDate(date) {
        setLoading(true);
        setError('');
        try {
            const r = await api.get(`/paper/by-date?date=${date}`);
            setTrades(r.data.trades);
            setSelectedDate(date);
        } catch (err) {
            setError(err.response?.data?.error || err.message);
            setTrades([]);
        } finally {
            setLoading(false);
        }
    }

    /** Step to the previous or next trading date that exists in DB. */
    function stepDate(dir) {
        if (!tradingDates.length) {
            // No date list yet — just add/subtract one calendar day.
            const d = new Date(selectedDate);
            d.setDate(d.getDate() + dir);
            const next = d.toISOString().slice(0, 10);
            fetchDate(next);
            return;
        }
        const idx = tradingDates.indexOf(selectedDate);
        // tradingDates is newest-first, so "previous day" = higher index.
        const nextIdx = idx === -1
            ? (dir === -1 ? 0 : tradingDates.length - 1)
            : idx - dir; // dir +1 = newer (lower idx), dir -1 = older (higher idx)
        if (nextIdx >= 0 && nextIdx < tradingDates.length) {
            fetchDate(tradingDates[nextIdx]);
        }
    }

    const closedHistory  = (trades ?? []).filter(t => t.status === 'CLOSED');
    const openHistory    = (trades ?? []).filter(t => t.status === 'OPEN' || t.status === 'PENDING');
    const totalPnl       = closedHistory.reduce((s, t) => s + (t.pnl || 0), 0);
    const wins           = closedHistory.filter(t => (t.pnl || 0) > 0).length;
    const losses         = closedHistory.filter(t => (t.pnl || 0) < 0).length;

    return (
        <div className="dash-section oh-panel">
            {/* ── Header ── */}
            <div className="section-header">
                <h3 className="section-title">📅 Order History</h3>
                <div className="oh-controls">
                    <button
                        className="btn btn-ghost btn-sm oh-nav-btn"
                        onClick={() => stepDate(-1)}
                        title="Previous trading day"
                        disabled={loading}
                    >‹</button>
                    <input
                        type="date"
                        className="oh-date-input"
                        value={selectedDate}
                        max={todayStr}
                        onChange={e => setSelectedDate(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && fetchDate(selectedDate)}
                    />
                    <button
                        className="btn btn-ghost btn-sm oh-nav-btn"
                        onClick={() => stepDate(1)}
                        title="Next trading day"
                        disabled={loading || selectedDate >= todayStr}
                    >›</button>
                    <button
                        className="btn btn-primary btn-sm"
                        onClick={() => fetchDate(selectedDate)}
                        disabled={loading}
                    >
                        {loading ? 'Loading…' : 'Fetch'}
                    </button>
                </div>
            </div>

            {/* ── Summary strip (only when trades loaded) ── */}
            {trades !== null && !loading && (
                <div className="oh-summary">
                    <span className="oh-sum-label">{fmtDateLabel(selectedDate)}</span>
                    <span className="oh-sum-item">{trades.length} trade{trades.length !== 1 ? 's' : ''}</span>
                    {closedHistory.length > 0 && (
                        <>
                            <span className="oh-sum-item">
                                <span style={{ color: 'var(--green)' }}>W:{wins}</span>
                                {' / '}
                                <span style={{ color: 'var(--red)' }}>L:{losses}</span>
                            </span>
                            <span className={`oh-sum-pnl ${totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
                                {totalPnl >= 0 ? '+' : ''}₹{totalPnl.toFixed(2)}
                            </span>
                        </>
                    )}
                    {openHistory.length > 0 && (
                        <span style={{ fontSize: 11, color: 'var(--yellow)' }}>
                            {openHistory.length} still open
                        </span>
                    )}
                </div>
            )}

            {error && <div className="oh-error">{error}</div>}

            {/* ── Trade table ── */}
            {trades !== null && trades.length > 0 && (
                <div className="kite-table-wrap">
                    <table className="kite-table">
                        <thead>
                            <tr>
                                <th className="mob-hide td-mono">Time</th>
                                <th className="mob-hide">Action</th>
                                <th>Symbol</th>
                                <th className="th-tf">TF</th>
                                <th className="th-num">Entry</th>
                                <th className="th-num mob-hide">Exit</th>
                                <th className="th-num">Qty</th>
                                <th className="th-num">P&L</th>
                                <th className="th-num mob-hide">Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {trades.map(t => (
                                <tr key={t.id}>
                                    <td className="td-mono mob-hide">{fmt(t.ts)}</td>
                                    <td className="mob-hide">
                                        <span className={`pill ${t.action === 'BUY' ? 'pill-green' : 'pill-red'}`}>
                                            {t.action}
                                        </span>
                                    </td>
                                    <td className="td-symbol">
                                        {t.source === 'auto' && <span className="td-sym-bot" title="Auto trade">🤖</span>}
                                        {t.symbol}
                                        {t.patternLabel && (
                                            <span className="td-sym-pattern" title={t.patternId ?? t.patternLabel}>
                                                {t.patternLabel}
                                            </span>
                                        )}
                                    </td>
                                    <td className="td-tf">
                                        {t.tfLabel
                                            ? <span className={`pill-tf pill-tf--${t.tfLabel}`}>{t.tfLabel}</span>
                                            : '—'}
                                    </td>
                                    <td className="td-num">{fmtPrice(t.entryPrice)}</td>
                                    <td className="td-num mob-hide">{t.exitPrice != null ? fmtPrice(t.exitPrice) : '—'}</td>
                                    <td className="td-num">
                                        {t.lots != null && t.lotSize > 1
                                            ? <span title={`${t.lots}L × ${t.lotSize}`}>{t.lots}L</span>
                                            : t.quantity}
                                    </td>
                                    <td className={`td-num ${pnlColor(t.pnl)}`}>
                                        {t.pnl != null ? `${t.pnl >= 0 ? '+' : ''}₹${t.pnl.toFixed(2)}` : '—'}
                                    </td>
                                    <td className="mob-hide">
                                        <span className={`oh-status oh-status--${(t.status ?? '').toLowerCase()}`}>
                                            {t.status}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {trades !== null && trades.length === 0 && !loading && (
                <div className="oh-empty">No trades found for {fmtDateLabel(selectedDate)}</div>
            )}

            {trades === null && !loading && (
                <div className="oh-hint">Select a date and press <strong>Fetch</strong> to load order history from DB.</div>
            )}
        </div>
    );
}
