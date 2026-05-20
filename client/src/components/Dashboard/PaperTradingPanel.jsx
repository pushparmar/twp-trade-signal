import { useState, useRef, useEffect, useCallback } from "react";
import api from "../../api";
import useAppStore from "../../store/appStore";

// ── Timeframe display order (most important first in the UI) ──────────────────
const TF_ORDER = ["1d", "4h", "1h", "15m"];
const TF_LABEL_MAP = { "1d": "Daily", "4h": "4-Hour", "1h": "1-Hour", "15m": "15-Min" };

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
    const derivativeTick = useAppStore(s => (trade.derivativeToken ? s.ticks[trade.derivativeToken] : null));

    const isOptions = trade.tradingMode === "options";
    const spotLtp = tick?.lastPrice ?? null;
    // For options: prefer live tradeTick (premium broadcast), fall back to seeded derivative price
    const premiumLtp = tradeTick?.ltp ?? derivativeTick?.lastPrice ?? null;
    // For futures: prefer live tick, then seeded derivative (futures) price, then spot
    const ltp = isOptions ? premiumLtp : tradeTick?.ltp ?? derivativeTick?.lastPrice ?? spotLtp;
    // SL/target always checked against spot price
    const monitorLtp = spotLtp;

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
                <span>
                    {(isOptions || trade.tradingMode === "futures") && (
                        <span
                            style={{
                                fontSize: 11,
                                color: spotLtp != null ? "var(--txt3)" : "var(--txt4, #555)",
                                marginLeft: 4
                            }}
                        >
                            ₹{fmtPrice(window.innerWidth < 767 ? trade.spotEntry : spotLtp ?? trade.spotEntry)}
                        </span>
                    )}
                </span>
                {trade.tradingMode === "options" && trade.optionType && (
                    <span
                        className={`pill pill-sm ${trade.optionType === "CE" ? "pill-green" : "pill-red"}`}
                        style={{ marginLeft: 4, fontSize: 10 }}
                    >
                        {trade.strike} {trade.optionType}
                    </span>
                )}
                {trade.tradingMode === "futures" && trade.derivativeSymbol && (
                    <span className="pill pill-sm pill-blue" style={{ marginLeft: 4, fontSize: 10 }}>
                        FUT
                    </span>
                )}
                {trade.sl != null && (
                    <span className="td-sym-sl mob-only">
                        {trade.tslActivated ? "🔒" : "SL"} ₹{fmtPrice(trade.sl)}
                        {slHit && " 🛑"}
                    </span>
                )}
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

// ── Auto-trader settings strip ────────────────────────────────────────────────
// Testing-mode UI: shows the simplified controls relevant for sampling every
// pattern firing (quantity is always 1, no rupee-risk filter applied).
function AutoTraderSettings() {
    const [settings, setSettings] = useState(null);
    const [saving, setSaving] = useState(false);
    const [editing, setEditing] = useState(false);
    const [rrStr, setRrStr] = useState("");
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
        const rr = Number(rrStr);
        const trig = Number(trigStr);
        const dist = Number(distStr);
        const risk = Number(riskStr);
        const updates = {};
        if (rr > 0) updates.minRR = rr;
        if (trig > 0) updates.tslTriggerR = trig;
        if (dist > 0) updates.tslDistanceR = dist;
        if (risk > 0) updates.riskPerTrade = risk;
        if (Object.keys(updates).length) await patch(updates);
        setEditing(false);
    }

    const [riskStr, setRiskStr] = useState("");

    function startEdit() {
        if (!settings) return;
        setRrStr(String(settings.minRR));
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
                    <>
                        <div className="at-mode-group" role="tablist">
                            {["futures", "options"].map(mode => (
                                <button
                                    key={mode}
                                    className={`at-mode-btn ${settings.tradingMode === mode ? "is-active" : ""}`}
                                    onClick={() => patch({ tradingMode: mode })}
                                    disabled={saving}
                                    type="button"
                                >
                                    {mode === "futures" ? "FUT" : "OPT"}
                                </button>
                            ))}
                        </div>
                        <div className="at-mode-group" role="tablist">
                            {["risk", "fixed"].map(mode => (
                                <button
                                    key={mode}
                                    className={`at-mode-btn ${settings.sizingMode === mode ? "is-active" : ""}`}
                                    onClick={() => patch({ sizingMode: mode })}
                                    disabled={saving}
                                    type="button"
                                    title={
                                        mode === "risk"
                                            ? `Risk-based sizing (₹${settings.riskPerTrade}/trade)`
                                            : "Fixed 1 lot per trade"
                                    }
                                >
                                    {mode === "risk" ? "RISK" : "1LOT"}
                                </button>
                            ))}
                        </div>
                    </>
                )}
            </div>

            {settings.enabled && !editing && (
                <div className="at-settings-risk">
                    <span className="at-risk-label">Min R:R</span>
                    <span className="at-risk-val">1:{settings.minRR}</span>
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
                    <label className="at-edit-label">Min R:R</label>
                    <input
                        className="at-edit-input"
                        type="number"
                        step="0.1"
                        value={rrStr}
                        onChange={e => setRrStr(e.target.value)}
                        placeholder="2.0"
                    />
                    <label className="at-edit-label">Risk/Trade (₹)</label>
                    <input
                        className="at-edit-input"
                        type="number"
                        step="100"
                        value={riskStr}
                        onChange={e => setRiskStr(e.target.value)}
                        placeholder="5000"
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
    const clearPaperTrades = useAppStore(s => s.clearPaperTrades);
    const [closingTrade, setClosingTrade] = useState(null);
    const [sourceFilter, setSourceFilter] = useState("all");
    const [exchFilter, setExchFilter] = useState("all");
    const [openSort, setOpenSort] = useState({ field: "ts", dir: "desc" });
    const [closedSort, setClosedSort] = useState({ field: "closedTs", dir: "desc" });

    let filtered = sourceFilter === "all" ? paperTrades : paperTrades.filter(t => t.source === sourceFilter);
    if (exchFilter !== "all") {
        filtered = filtered.filter(t => tradeExchange(t) === exchFilter);
    }
    const openTrades = filtered.filter(t => t.status === "OPEN");
    const closedTrades = filtered.filter(t => t.status === "CLOSED");

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

            {/* Closed trades */}
            {closedTrades.length > 0 && (
                <div className="dash-section">
                    <div className="section-header">
                        <h3 className="section-title">
                            Closed Trades <span className="count-badge">{closedTrades.length}</span>
                        </h3>
                        <button className="btn btn-ghost btn-sm" onClick={handleClearAll}>
                            Clear all
                        </button>
                    </div>
                    <div className="kite-table-wrap">
                        <table className="kite-table">
                            <thead>
                                <tr>
                                    <SortTh
                                        label="Closed"
                                        field="closedTs"
                                        sort={closedSort}
                                        onSort={setClosedSort}
                                        className="mob-hide"
                                    />
                                    <th className="mob-hide">Action</th>
                                    <SortTh label="Symbol" field="symbol" sort={closedSort} onSort={setClosedSort} />
                                    <SortTh
                                        label="Entry"
                                        field="entry"
                                        sort={closedSort}
                                        onSort={setClosedSort}
                                        className="th-num"
                                    />
                                    <SortTh
                                        label="Exit"
                                        field="exit"
                                        sort={closedSort}
                                        onSort={setClosedSort}
                                        className="th-num mob-hide"
                                    />
                                    <SortTh
                                        label="Qty"
                                        field="qty"
                                        sort={closedSort}
                                        onSort={setClosedSort}
                                        className="th-num"
                                    />
                                    <SortTh
                                        label="P&L"
                                        field="pnl"
                                        sort={closedSort}
                                        onSort={setClosedSort}
                                        className="th-num"
                                    />
                                </tr>
                            </thead>
                            <tbody>
                                {sortedClosed.map(t => (
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
                                        </td>
                                        <td className="td-num">{t.entryPrice}</td>
                                        <td className="td-num mob-hide">{t.exitPrice}</td>
                                        <td className="td-num">
                                            {t.lots != null && t.lotSize > 1 ? (
                                                <span title={`${t.lots} lot${t.lots > 1 ? "s" : ""} × ${t.lotSize}`}>
                                                    {t.lots}L
                                                    <span style={{ color: "var(--txt3)", fontSize: 11 }}>
                                                        {" "}
                                                        /{t.quantity}
                                                    </span>
                                                </span>
                                            ) : (
                                                t.quantity
                                            )}
                                        </td>
                                        <td className={`td-num ${pnlColor(t.pnl)}`}>
                                            {t.pnl !== null ? `${t.pnl >= 0 ? "+" : ""}₹${t.pnl.toFixed(2)}` : "—"}
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
                    trade={closingTrade.trade}
                    currentLtp={closingTrade.ltp}
                    onClose={() => setClosingTrade(null)}
                    onConfirm={handleCloseTrade}
                />
            )}
        </div>
    );
}
