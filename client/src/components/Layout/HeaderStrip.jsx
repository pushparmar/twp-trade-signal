/**
 * HeaderStrip.jsx
 *
 * Persistent top bar across every page.  Computes live trading state from the
 * Zustand store every render and surfaces:
 *
 *   ⏱  Today P&L      realized + unrealized of all scan/auto trades
 *   📂 Open trades    count, broken down by Auto vs Scan (manual)
 *   ⚠  Live risk      Σ |entry - currentSl| × qty across open positions
 *   🟢 Market         open / closed / pre-open / post-close
 *
 * NOTE: Auto-trader for equity is DISABLED. Users add trades manually from
 * Scanner UI. Index-trade module has its own auto-trade via orderManager.js.
 *
 * The bar is sticky inside .main-area so it stays visible while users scroll
 * long pages (Scanner, Analytics).  All math runs synchronously on tick state
 * — Zustand selectors keep React re-renders narrow.
 */

import { useEffect, useState } from "react";
// import api from "../../api";  // DISABLED — auto-trader status polling removed
import useAppStore from "../../store/appStore";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function fmtRupee(n) {
    if (n == null || isNaN(n)) return "—";
    const sign = n >= 0 ? "+" : "";
    return `${sign}₹${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function istNow() {
    return new Date(Date.now() + IST_OFFSET_MS);
}

function marketState() {
    const d = istNow();
    const day = d.getUTCDay();
    if (day === 0 || day === 6) return { label: "Closed (Weekend)", cls: "hdr-mkt--closed" };
    const min = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (min < 555) return { label: "Pre-open", cls: "hdr-mkt--preopen" }; // before 09:15
    if (min < 930) return { label: "OPEN", cls: "hdr-mkt--open" }; // 09:15–15:30
    return { label: "Closed", cls: "hdr-mkt--closed" };
}

/**
 * Today's realized P&L from CLOSED trades that closed since 06:00 IST
 * (the daily archive boundary — trades from earlier days are not counted).
 */
function _todaysRealized(trades) {
    // 6 AM IST cutoff = today's 00:30 UTC; if before that, use yesterday's 00:30
    const utcNow = new Date();
    const cutoff = new Date(utcNow);
    cutoff.setUTCHours(0, 30, 0, 0);
    if (cutoff.getTime() > utcNow.getTime()) cutoff.setUTCDate(cutoff.getUTCDate() - 1);
    const cutoffMs = cutoff.getTime();
    let sum = 0;
    for (const t of trades) {
        if (t.status !== "CLOSED") continue;
        if (!t.closedTs || t.closedTs < cutoffMs) continue;
        if (t.pnl != null) sum += Number(t.pnl);
    }
    return sum;
}

export default function HeaderStrip() {
    const paperTrades = useAppStore(s => s.paperTrades);
    // tradeTicks is server-throttled to 500 ms per trade — safe to use as a
    // React selector. Never subscribe to s.ticks here; it fires 50+ times/sec.
    const tradeTicks  = useAppStore(s => s.tradeTicks);
    const [mkt, setMkt] = useState(marketState());

    // Refresh market state once per minute (cheap; no need for ticker)
    useEffect(() => {
        const id = setInterval(() => setMkt(marketState()), 60_000);
        return () => clearInterval(id);
    }, []);

    // Auto-trader status loading — DISABLED (equity auto-trade removed)
    // useEffect(() => {
    //     let cancelled = false;
    //     function load() {
    //         api.get("/auto-trader/settings")
    //             .then(r => {
    //                 if (!cancelled) setAutoEnabled(!!r.data?.enabled);
    //             })
    //             .catch(() => {});
    //     }
    //     load();
    //     const id = setInterval(load, 30_000);
    //     return () => {
    //         cancelled = true;
    //         clearInterval(id);
    //     };
    // }, []);

    // ── Compute aggregates synchronously on every tick / trade change ──────────
    const openTrades = paperTrades.filter(t => t.status === "OPEN" && (t.source === "scan" || t.source === "auto"));
    const openAuto = openTrades.filter(t => t.source === "auto").length;
    const openScan = openTrades.length - openAuto;

    let unrealized = 0;
    let liveRisk = 0;
    for (const t of openTrades) {
        const qty = t.quantity ?? 1;
        // Use server-computed unrealizedPnl from tradeTicks (throttled 500 ms).
        // Falls back to 0 until the first tick arrives for this trade.
        const pnl = tradeTicks[t.id]?.unrealizedPnl;
        if (pnl != null) unrealized += pnl;
        if (t.sl != null && t.entryPrice != null) {
            // Risk now = distance from current SL (which may have trailed) to entry.
            // For an in-profit TSL-trailed trade this can go NEGATIVE — meaning we've
            // locked in profit; clamp to ≥ 0 so the strip never shows nonsense risk.
            const distance = Math.abs(t.entryPrice - t.sl);
            liveRisk += distance * qty;
        }
    }

    const realized = _todaysRealized(paperTrades);
    const totalPnl = realized + unrealized;
    const pnlCls = totalPnl > 0 ? "hdr-pnl--up" : totalPnl < 0 ? "hdr-pnl--down" : "";

    return (
        <div className="header-strip">
            <div className="hdr-item">
                <span className="hdr-label">Today P&amp;L</span>
                <span className={`hdr-value hdr-value--big ${pnlCls}`}>{fmtRupee(totalPnl)}</span>
            </div>

            <div className="hdr-divider" />

            <div className="hdr-item">
                <span className="hdr-label">Open</span>
                <span className="hdr-value">{openTrades.length}</span>
                <span className="hdr-sub">
                    {openAuto > 0 && <span className="hdr-pill hdr-pill--auto">Auto {openAuto}</span>}
                    {openScan > 0 && <span className="hdr-pill hdr-pill--scan">Scan {openScan}</span>}
                    {openTrades.length === 0 && <span style={{ opacity: 0.4 }}>idle</span>}
                </span>
            </div>

            <div className="hdr-divider" />

            <div className="hdr-item">
                <span className="hdr-label">Live Risk</span>
                <span className={`hdr-value ${liveRisk > 0 ? "hdr-risk--on" : ""}`}>{fmtRupee(liveRisk)}</span>
            </div>
        </div>
    );
}
