/**
 * EquityScanPanel.jsx
 *
 * On-demand, once-a-day full equity scan panel — shown in the Manage Stocks tab.
 *
 * Scans ALL NSE EQ stocks (F&O + non-F&O) across 4H / 1D / 1W timeframes.
 * Results are cached in MongoDB for the day — no re-fetching.
 *
 * Mirrors the table style of ScanAlertsPage but is completely standalone.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import useAppStore from "../../store/appStore";
import api from "../../api";
import useLocalState from "../../hooks/useLocalState";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n) {
    if (n == null || isNaN(n)) return "—";
    return Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function relativeTime(ts) {
    if (!ts) return "—";
    const diffSec = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
}

function fmtTime(isoStr) {
    if (!isoStr) return "—";
    // isoStr may be ISO date string from DB
    const d = new Date(isoStr);
    if (isNaN(d)) return "—";
    const IST_MS = 5.5 * 60 * 60 * 1000;
    const ist = new Date(d.getTime() + IST_MS);
    const h = String(ist.getUTCHours()).padStart(2, "0");
    const m = String(ist.getUTCMinutes()).padStart(2, "0");
    return `${h}:${m}`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ScoreDots({ score, signal }) {
    if (score == null) return <span style={{ color: "var(--text-muted)", fontSize: 12 }}>—</span>;
    const total = 5;
    const filled = Math.max(0, Math.min(total, Math.round(score)));
    const color = signal === "bullish" ? "#51cf66" : "#ff6b6b";
    return (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }} title={`Score: ${score}/5`}>
            {Array.from({ length: total }).map((_, i) => (
                <span
                    key={i}
                    style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: i < filled ? color : "var(--border)",
                        display: "inline-block"
                    }}
                />
            ))}
            <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: 3 }}>{score}/5</span>
        </span>
    );
}

function RRBadge({ entry, sl, target }) {
    if (!entry || !sl || !target) return null;
    const risk = Math.abs(entry - sl);
    if (risk < 0.01) return null;
    const reward = Math.abs(target - entry);
    const rr = reward / risk;
    const color = rr >= 3 ? "#51cf66" : rr >= 2 ? "#fab005" : "var(--text-muted)";
    return (
        <span
            style={{
                fontSize: 10,
                padding: "1px 5px",
                borderRadius: 3,
                background: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                color,
                marginLeft: 4,
                whiteSpace: "nowrap"
            }}
            title={`R:R = 1:${rr.toFixed(2)}`}
        >
            1:{rr.toFixed(1)}
        </span>
    );
}

// ── Table Row ─────────────────────────────────────────────────────────────────

function EqScanRow({ alert }) {
    const tick = useAppStore(s => s.ticks[alert.token]);
    const ltp = tick?.lastPrice ?? null;
    const change = tick?.change ?? null;
    const chgCls = change > 0 ? "mw-up" : change < 0 ? "mw-down" : "";

    return (
        <tr className={`scan-row scan-row--${alert.signal}`}>
            <td className="scan-cell scan-cell--symbol">
                <span className="scan-symbol">{alert.label || alert.tradingsymbol}</span>
                <span
                    style={{
                        fontSize: 10,
                        padding: "1px 4px",
                        borderRadius: 3,
                        marginLeft: 4,
                        background: "var(--bg-secondary)",
                        color: "var(--text-muted)",
                        border: "1px solid var(--border)"
                    }}
                >
                    {alert.exchange ?? "NSE"}
                </span>
            </td>
            <td className="scan-cell scan-cell--ltp">
                <span className="scan-ltp">{ltp != null ? fmt(ltp) : "—"}</span>
                {change != null && (
                    <span className={`scan-chg ${chgCls}`}>
                        {change > 0 ? "+" : ""}
                        {Number(change).toFixed(2)}%
                    </span>
                )}
            </td>
            <td className="scan-cell">
                <span className="scan-tf-badge">{alert.tfLabel || alert.interval}</span>
            </td>
            <td className="scan-cell">
                <span className={`scan-signal-badge scan-signal-badge--${alert.signal}`}>
                    {alert.signal === "bullish" ? "🟢 Bullish" : "🔴 Bearish"}
                </span>
            </td>
            <td className="scan-cell scan-cell--pattern">
                {alert.patternLabel}
                {alert.volumeConfirmed && alert.volumeRatio != null && (
                    <span className="scan-vol-badge" title={`Volume ${Number(alert.volumeRatio).toFixed(1)}× avg`}>
                        📈 {Number(alert.volumeRatio).toFixed(1)}×
                    </span>
                )}
            </td>
            <td className="scan-cell scan-cell--score">
                <ScoreDots score={alert.score} signal={alert.signal} />
                <RRBadge entry={alert.close} sl={alert.sl} target={alert.target} />
                {alert.rsi14 != null && (
                    <span
                        style={{
                            display: "inline-block",
                            marginLeft: 4,
                            fontSize: 10,
                            padding: "1px 4px",
                            borderRadius: 3,
                            background: "var(--bg-secondary)",
                            color: alert.rsi14 >= 50 ? "#51cf66" : "#ff6b6b",
                            border: "1px solid var(--border)",
                            whiteSpace: "nowrap"
                        }}
                        title={`RSI(14) = ${alert.rsi14}`}
                    >
                        RSI {alert.rsi14}
                    </span>
                )}
            </td>
            <td className="scan-cell scan-cell--price">{alert.close != null ? fmt(alert.close) : "—"}</td>
            <td className="scan-cell scan-cell--time">{relativeTime(alert.firedAt)}</td>
        </tr>
    );
}

// ── Main panel ────────────────────────────────────────────────────────────────

const TF_OPTIONS = [
    { id: "all", label: "All TF" },
    { id: "4h", label: "4H" },
    { id: "day", label: "1D" },
    { id: "week", label: "1W" }
];

// TF options for cache-scan dropdown (no "all" option — must select specific TF)
const CACHE_TF_OPTIONS = [
    { id: "4h", label: "4H" },
    { id: "day", label: "1D" },
    { id: "week", label: "1W" }
];

const MIN_RR_OPTIONS = [
    { value: 0, label: "Any R:R" },
    { value: 1.5, label: "≥ 1:1.5" },
    { value: 2, label: "≥ 1:2" },
    { value: 3, label: "≥ 1:3" }
];

/**
 * @param {boolean} [inline=false]  When true, renders without page chrome
 *   (used when embedded inside another panel like MarketWatch).
 *   When false (default), wraps in the standard page container.
 */
export default function EquityScanPanel({ inline = false }) {
    // ── Scan state ───────────────────────────────────────────────────────────
    const [scanStatus, setScanStatus] = useState(null); // server status object
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [universe, setUniverse] = useState(null); // equity universe info
    const pollRef = useRef(null);

    // ── Cache-scan state (filtered scan on cached data) ──────────────────────
    const [availablePatterns, setAvailablePatterns] = useState([]); // patterns from server
    const [cacheScanPattern, setCacheScanPattern] = useLocalState("eqscan:cacheScanPattern", "all");
    const [cacheScanTF, setCacheScanTF] = useLocalState("eqscan:cacheScanTF", "day");
    const [cacheScanLoading, setCacheScanLoading] = useState(false);

    // ── Filter state ─────────────────────────────────────────────────────────
    const [tfFilter, setTfFilter] = useLocalState("eqscan:tfFilter", "all");
    const [signalFilter, setSignalFilter] = useLocalState("eqscan:signalFilter", "all");
    const [patternFilter, setPatternFilter] = useLocalState("eqscan:patternFilter", "all");
    const [volOnly, setVolOnly] = useLocalState("eqscan:volOnly", false);
    const [minRR, setMinRR] = useLocalState("eqscan:minRR", 0);
    const [dedup, setDedup] = useLocalState("eqscan:dedup", false);

    // ── Token subscription for live LTP ──────────────────────────────────────
    const subscribedRef = useRef(new Set());
    useEffect(() => {
        const tokens = results.map(r => Number(r.token)).filter(Boolean);
        const newTokens = [...new Set(tokens)].filter(t => !subscribedRef.current.has(t));
        if (newTokens.length > 0) {
            api.post("/instruments/peek-subscribe", { tokens: newTokens }).catch(() => {});
            newTokens.forEach(t => subscribedRef.current.add(t));
        }
    }, [results]);

    useEffect(() => {
        return () => {
            const tokens = [...subscribedRef.current];
            if (tokens.length > 0) {
                api.post("/instruments/peek-unsubscribe", { tokens }).catch(() => {});
                subscribedRef.current.clear();
            }
        };
    }, []);

    // ── Load universe + status + results + patterns on mount ───────────────────
    useEffect(() => {
        async function init() {
            try {
                // Fetch patterns list for cache-scan dropdown
                const { data: patternsData } = await api.get("/equity-scan/patterns");
                setAvailablePatterns(patternsData || []);

                // Fetch the equity universe (all stocks to be scanned)
                const { data: universeData } = await api.get("/equity-scan/universe");
                setUniverse(universeData);

                const { data: status } = await api.get("/equity-scan/status");
                setScanStatus(status);
                if (status.cachedToday) {
                    const { data: rows } = await api.get("/equity-scan/results");
                    setResults(rows);
                }
                if (status.running) {
                    startPolling();
                }
            } catch {
                // Server not reachable — show neutral state
            }
        }
        init();
        return () => stopPolling();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Polling ───────────────────────────────────────────────────────────────
    function startPolling() {
        if (pollRef.current) return;
        pollRef.current = setInterval(async () => {
            try {
                const { data: status } = await api.get("/equity-scan/status");
                setScanStatus(status);
                if (!status.running) {
                    stopPolling();
                    if (status.cachedToday) {
                        const { data: rows } = await api.get("/equity-scan/results");
                        setResults(rows);
                    }
                }
            } catch {
                stopPolling();
            }
        }, 2000);
    }

    function stopPolling() {
        if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
        }
    }

    // ── Handlers ──────────────────────────────────────────────────────────────
    const handleRun = useCallback(async () => {
        if (loading) return;
        setLoading(true);
        try {
            const { data } = await api.post("/equity-scan/run");
            setScanStatus(prev => ({ ...prev, running: data.status === "started" || data.status === "running" }));
            if (data.status === "started") {
                startPolling();
            } else if (data.status === "cached") {
                const { data: rows } = await api.get("/equity-scan/results");
                setResults(rows);
            }
        } catch {
            // ignore
        } finally {
            setLoading(false);
        }
    }, [loading]); // eslint-disable-line react-hooks/exhaustive-dep

    const handleRerun = useCallback(async () => {
        try {
            await api.post("/equity-scan/rerun");
            const { data } = await api.post("/equity-scan/run");
            setScanStatus(prev => ({ ...prev, running: true }));
            if (data.status === "started") {
                setResults([]);
                startPolling();
            }
        } catch {
            // ignore
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Cache-only scan handler (no Kite API calls) ───────────────────────────
    const handleCacheScan = useCallback(async () => {
        if (cacheScanLoading) return;
        setCacheScanLoading(true);
        try {
            const body = {
                intervals: [cacheScanTF],
                patternIds: cacheScanPattern === "all" ? null : [cacheScanPattern]
            };
            const { data } = await api.post("/equity-scan/cache-scan", body);
            if (data.error) {
                console.warn("[EquityScanPanel] Cache scan error:", data.error);
                alert(data.error);
            } else {
                setResults(data.results || []);
                console.log(`[EquityScanPanel] Cache scan: ${data.count} results`);
            }
        } catch (err) {
            console.error("[EquityScanPanel] Cache scan failed:", err);
        } finally {
            setCacheScanLoading(false);
        }
    }, [cacheScanLoading, cacheScanTF, cacheScanPattern]);

    // ── Derived state ─────────────────────────────────────────────────────────
    const isRunning = scanStatus?.running ?? false;
    const isPrefetching = scanStatus?.prefetching ?? false;
    const isCached = scanStatus?.cachedToday ?? false;
    const progress = scanStatus?.progress ?? { done: 0, total: 0 };
    const resultCount = scanStatus?.resultCount ?? results.length;
    const completedAt = scanStatus?.completedAt;

    // Pattern options for dropdown
    const patternOptions = useMemo(() => {
        const seen = new Map();
        for (const r of results) {
            if (r.patternId && r.patternLabel && !seen.has(r.patternId)) {
                seen.set(r.patternId, { id: r.patternId, label: r.patternLabel });
            }
        }
        return [
            { id: "all", label: "All patterns" },
            ...Array.from(seen.values()).sort((a, b) => a.label.localeCompare(b.label))
        ];
    }, [results]);

    // Filter results
    const filtered = useMemo(() => {
        let list = results.filter(r => {
            if (tfFilter !== "all" && r.interval !== tfFilter) return false;
            if (signalFilter !== "all" && r.signal !== signalFilter) return false;
            if (patternFilter !== "all" && r.patternId !== patternFilter) return false;
            if (volOnly && !r.volumeConfirmed) return false;
            if (minRR > 0) {
                if (!r.close || !r.sl || !r.target) return false;
                const risk = Math.abs(r.close - r.sl);
                if (risk < 0.01) return false;
                if (Math.abs(r.target - r.close) / risk < minRR) return false;
            }
            return true;
        });

        if (dedup) {
            const best = new Map();
            for (const r of list) {
                const key = `${r.token}:${r.signal}`;
                const prev = best.get(key);
                if (!prev || (r.score ?? 0) > (prev.score ?? 0)) best.set(key, r);
            }
            list = [...best.values()];
        }

        list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        return list;
    }, [results, tfFilter, signalFilter, patternFilter, volOnly, minRR, dedup]);

    // ── Status chip ───────────────────────────────────────────────────────────
    function renderStatusChip() {
        if (isRunning) {
            // Phase 1: downloading candles for all stocks (may take several minutes)
            if (isPrefetching || progress.total === 0) {
                return (
                    <span
                        style={{
                            padding: "3px 10px",
                            borderRadius: 12,
                            fontSize: 12,
                            fontWeight: 600,
                            background: "#f08c001a",
                            color: "#fab005",
                            border: "1px solid #fab00540"
                        }}
                    >
                        ⟳ Downloading candles for all NSE stocks…
                    </span>
                );
            }
            // Phase 2: pattern matching (progress counter active)
            const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
            return (
                <span
                    style={{
                        padding: "3px 10px",
                        borderRadius: 12,
                        fontSize: 12,
                        fontWeight: 600,
                        background: "#f08c001a",
                        color: "#fab005",
                        border: "1px solid #fab00540"
                    }}
                >
                    ⟳ Scanning patterns… {progress.done}/{progress.total} stocks ({pct}%)
                </span>
            );
        }
        if (isCached) {
            return (
                <span
                    style={{
                        padding: "3px 10px",
                        borderRadius: 12,
                        fontSize: 12,
                        fontWeight: 600,
                        background: "#2f9e441a",
                        color: "#51cf66",
                        border: "1px solid #51cf6640"
                    }}
                >
                    ✓ {resultCount} signals · Scanned today {completedAt ? fmtTime(completedAt) : ""}
                </span>
            );
        }
        return (
            <span
                style={{
                    padding: "3px 10px",
                    borderRadius: 12,
                    fontSize: 12,
                    fontWeight: 500,
                    background: "var(--bg-secondary)",
                    color: "var(--text-muted)",
                    border: "1px solid var(--border)"
                }}
            >
                Not scanned today
            </span>
        );
    }

    // ── Render ────────────────────────────────────────────────────────────────
    const inner = (
        <div style={{ paddingBottom: 32 }}>
            {/* ── Header ── */}
            <div style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                    <span className="mw-detail-name" style={{ fontSize: 16, fontWeight: 700 }}>
                        Equity Scan
                    </span>
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>All NSE + BSE EQ · 4H / 1D / 1W</span>
                </div>

                {/* Universe Info */}
                {universe && (
                    <div style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 12,
                        marginBottom: 12,
                        padding: "10px 14px",
                        borderRadius: 8,
                        background: "var(--bg-secondary)",
                        border: "1px solid var(--border)"
                    }}>
                        <div style={{ textAlign: "center", minWidth: 70 }}>
                            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--accent)" }}>{universe.total}</div>
                            <div style={{ fontSize: 10, color: "var(--text-muted)" }}>Total Stocks</div>
                        </div>
                        <div style={{ textAlign: "center", minWidth: 70 }}>
                            <div style={{ fontSize: 18, fontWeight: 700, color: "#4dabf7" }}>{universe.nseCount}</div>
                            <div style={{ fontSize: 10, color: "var(--text-muted)" }}>NSE</div>
                        </div>
                        <div style={{ textAlign: "center", minWidth: 70 }}>
                            <div style={{ fontSize: 18, fontWeight: 700, color: "#fab005" }}>{universe.bseCount}</div>
                            <div style={{ fontSize: 10, color: "var(--text-muted)" }}>BSE</div>
                        </div>
                        <div style={{ textAlign: "center", minWidth: 70 }}>
                            <div style={{ fontSize: 18, fontWeight: 700, color: "#51cf66" }}>{universe.foCount}</div>
                            <div style={{ fontSize: 10, color: "var(--text-muted)" }}>F&O</div>
                        </div>
                        <div style={{ textAlign: "center", minWidth: 70 }}>
                            <div style={{ fontSize: 18, fontWeight: 700, color: "#ff6b6b" }}>{universe.nonFoCount}</div>
                            <div style={{ fontSize: 10, color: "var(--text-muted)" }}>Non-F&O</div>
                        </div>
                    </div>
                )}

                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    {renderStatusChip()}

                    {!isRunning && !isCached && (
                        <button
                            className="mw-subscribe-btn"
                            onClick={handleRun}
                            disabled={loading}
                            style={{ fontWeight: 600 }}
                        >
                            {loading ? "…" : "▶ Run Full Equity Scan"}
                        </button>
                    )}

                    {!isRunning && isCached && (
                        <button
                            onClick={handleRerun}
                            style={{
                                fontSize: 11,
                                background: "none",
                                border: "none",
                                color: "var(--text-muted)",
                                cursor: "pointer",
                                textDecoration: "underline",
                                padding: 0
                            }}
                            title="Force re-run today's scan"
                        >
                            Re-run
                        </button>
                    )}
                </div>

                {/* ── Cache-only scan section ── */}
                <div style={{
                    marginTop: 16,
                    padding: "12px 14px",
                    borderRadius: 8,
                    background: "var(--bg-secondary)",
                    border: "1px solid var(--border)"
                }}>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: "var(--text-secondary)" }}>
                        Quick Scan (from cached data — no API calls)
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                        {/* Pattern dropdown */}
                        <select
                            value={cacheScanPattern}
                            onChange={e => setCacheScanPattern(e.target.value)}
                            style={{
                                fontSize: 12,
                                padding: "6px 10px",
                                borderRadius: 6,
                                border: "1px solid var(--border)",
                                background: "var(--bg-tertiary)",
                                color: "var(--text-primary)",
                                cursor: "pointer",
                                minWidth: 160
                            }}
                        >
                            <option value="all">All Patterns</option>
                            {availablePatterns.map(p => (
                                <option key={p.id} value={p.id}>{p.label}</option>
                            ))}
                        </select>

                        {/* TF dropdown */}
                        <select
                            value={cacheScanTF}
                            onChange={e => setCacheScanTF(e.target.value)}
                            style={{
                                fontSize: 12,
                                padding: "6px 10px",
                                borderRadius: 6,
                                border: "1px solid var(--border)",
                                background: "var(--bg-tertiary)",
                                color: "var(--text-primary)",
                                cursor: "pointer",
                                minWidth: 80
                            }}
                        >
                            {CACHE_TF_OPTIONS.map(tf => (
                                <option key={tf.id} value={tf.id}>{tf.label}</option>
                            ))}
                        </select>

                        {/* Run button */}
                        <button
                            onClick={handleCacheScan}
                            disabled={cacheScanLoading}
                            style={{
                                fontSize: 12,
                                padding: "6px 14px",
                                borderRadius: 6,
                                border: "none",
                                background: cacheScanLoading ? "var(--border)" : "var(--accent)",
                                color: "#fff",
                                cursor: cacheScanLoading ? "wait" : "pointer",
                                fontWeight: 600
                            }}
                        >
                            {cacheScanLoading ? "Scanning…" : "▶ Run"}
                        </button>

                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                            Scans {universe?.total || "~1200"} stocks from MongoDB cache
                        </span>
                    </div>
                </div>
            </div>

            {/* ── Filters (only show when results exist) ── */}
            {(results.length > 0 || isCached) && (
                <div
                    style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 8,
                        marginBottom: 14,
                        padding: "10px 12px",
                        borderRadius: 8,
                        background: "var(--bg-secondary)",
                        border: "1px solid var(--border)"
                    }}
                >
                    {/* TF tabs */}
                    <div style={{ display: "flex", gap: 4 }}>
                        {TF_OPTIONS.map(tf => (
                            <button
                                key={tf.id}
                                onClick={() => setTfFilter(tf.id)}
                                style={{
                                    fontSize: 11,
                                    padding: "3px 9px",
                                    borderRadius: 6,
                                    cursor: "pointer",
                                    border: "1px solid var(--border)",
                                    background: tfFilter === tf.id ? "var(--accent)" : "var(--bg-tertiary)",
                                    color: tfFilter === tf.id ? "#fff" : "var(--text-secondary)",
                                    fontWeight: tfFilter === tf.id ? 600 : 400
                                }}
                            >
                                {tf.label}
                            </button>
                        ))}
                    </div>

                    {/* Signal */}
                    <div style={{ display: "flex", gap: 4 }}>
                        {["all", "bullish", "bearish"].map(s => (
                            <button
                                key={s}
                                onClick={() => setSignalFilter(s)}
                                style={{
                                    fontSize: 11,
                                    padding: "3px 9px",
                                    borderRadius: 6,
                                    cursor: "pointer",
                                    border: "1px solid var(--border)",
                                    background:
                                        signalFilter === s
                                            ? s === "bullish"
                                                ? "#2f9e4433"
                                                : s === "bearish"
                                                ? "#e0324233"
                                                : "var(--accent)"
                                            : "var(--bg-tertiary)",
                                    color:
                                        signalFilter === s
                                            ? s === "bullish"
                                                ? "#51cf66"
                                                : s === "bearish"
                                                ? "#ff6b6b"
                                                : "#fff"
                                            : "var(--text-secondary)",
                                    fontWeight: signalFilter === s ? 600 : 400,
                                    textTransform: "capitalize"
                                }}
                            >
                                {s === "all" ? "All Signals" : s}
                            </button>
                        ))}
                    </div>

                    {/* Pattern dropdown */}
                    <select
                        value={patternFilter}
                        onChange={e => setPatternFilter(e.target.value)}
                        style={{
                            fontSize: 11,
                            padding: "3px 8px",
                            borderRadius: 6,
                            border: "1px solid var(--border)",
                            background: "var(--bg-tertiary)",
                            color: "var(--text-primary)",
                            cursor: "pointer"
                        }}
                    >
                        {patternOptions.map(p => (
                            <option key={p.id} value={p.id}>
                                {p.label}
                            </option>
                        ))}
                    </select>

                    {/* Min R:R */}
                    <select
                        value={minRR}
                        onChange={e => setMinRR(Number(e.target.value))}
                        style={{
                            fontSize: 11,
                            padding: "3px 8px",
                            borderRadius: 6,
                            border: "1px solid var(--border)",
                            background: "var(--bg-tertiary)",
                            color: "var(--text-primary)",
                            cursor: "pointer"
                        }}
                    >
                        {MIN_RR_OPTIONS.map(o => (
                            <option key={o.value} value={o.value}>
                                {o.label}
                            </option>
                        ))}
                    </select>

                    {/* Volume toggle */}
                    <button
                        onClick={() => setVolOnly(v => !v)}
                        style={{
                            fontSize: 11,
                            padding: "3px 9px",
                            borderRadius: 6,
                            cursor: "pointer",
                            border: "1px solid var(--border)",
                            background: volOnly ? "#f080001a" : "var(--bg-tertiary)",
                            color: volOnly ? "#fab005" : "var(--text-secondary)",
                            fontWeight: volOnly ? 600 : 400
                        }}
                    >
                        📈 Volume
                    </button>

                    {/* Best per symbol */}
                    <button
                        onClick={() => setDedup(v => !v)}
                        style={{
                            fontSize: 11,
                            padding: "3px 9px",
                            borderRadius: 6,
                            cursor: "pointer",
                            border: "1px solid var(--border)",
                            background: dedup ? "var(--accent)" : "var(--bg-tertiary)",
                            color: dedup ? "#fff" : "var(--text-secondary)",
                            fontWeight: dedup ? 600 : 400
                        }}
                    >
                        ✦ Best per symbol
                    </button>

                    {/* Result count */}
                    <span style={{ fontSize: 11, color: "var(--text-muted)", alignSelf: "center", marginLeft: "auto" }}>
                        {filtered.length} / {results.length} signals
                    </span>
                </div>
            )}

            {/* ── Progress bar ── */}
            {isRunning && (
                <div
                    style={{
                        height: 4,
                        borderRadius: 2,
                        background: "var(--border)",
                        marginBottom: 16,
                        overflow: "hidden"
                    }}
                >
                    {/* Indeterminate pulse during prefetch, determinate during scan */}
                    {isPrefetching || progress.total === 0 ? (
                        <div
                            style={{
                                height: "100%",
                                borderRadius: 2,
                                background: "#fab005",
                                width: "40%",
                                animation: "eq-scan-indeterminate 1.5s ease-in-out infinite"
                            }}
                        />
                    ) : (
                        <div
                            style={{
                                height: "100%",
                                borderRadius: 2,
                                background: "#fab005",
                                width: `${Math.round((progress.done / progress.total) * 100)}%`,
                                transition: "width 0.3s ease"
                            }}
                        />
                    )}
                </div>
            )}

            {/* ── Empty state ── */}
            {!isRunning && results.length === 0 && (
                <div className="scan-empty">
                    <div className="scan-empty-icon">
                        <svg
                            width="48"
                            height="48"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            opacity="0.3"
                        >
                            <circle cx="11" cy="11" r="8" />
                            <line x1="21" y1="21" x2="16.65" y2="16.65" />
                            <line x1="11" y1="8" x2="11" y2="14" />
                            <line x1="8" y1="11" x2="14" y2="11" />
                        </svg>
                    </div>
                    <p className="scan-empty-text">
                        {isCached
                            ? "No signals matched today. Try different filters."
                            : 'Click "Run Full Equity Scan" above to scan all NSE stocks across 4H / 1D / 1W timeframes. Results are cached for the day.'}
                    </p>
                </div>
            )}

            {/* ── Scanning placeholder ── */}
            {isRunning && results.length === 0 && (
                <div style={{ textAlign: "center", padding: "32px 0", color: "var(--text-muted)" }}>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>⟳</div>
                    {isPrefetching || progress.total === 0 ? (
                        <>
                            <div style={{ fontSize: 14 }}>Downloading candles for all NSE stocks…</div>
                            <div style={{ fontSize: 12, marginTop: 4 }}>
                                This may take 5–9 minutes for the first run (non-F&O stocks need historical data)
                            </div>
                        </>
                    ) : (
                        <>
                            <div style={{ fontSize: 14 }}>
                                Scanning patterns… {progress.done} / {progress.total} stocks
                            </div>
                            <div style={{ fontSize: 12, marginTop: 4 }}>Results will appear here when complete</div>
                        </>
                    )}
                </div>
            )}

            {/* ── Results table ── */}
            {filtered.length > 0 && (
                <div className="scan-table-wrap">
                    <table className="scan-table">
                        <thead>
                            <tr>
                                <th className="scan-th">Symbol</th>
                                <th className="scan-th">LTP</th>
                                <th className="scan-th">TF</th>
                                <th className="scan-th">Signal</th>
                                <th className="scan-th">Pattern</th>
                                <th className="scan-th">Score</th>
                                <th className="scan-th">Price @ Alert</th>
                                <th className="scan-th">Time</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map(r => (
                                <EqScanRow
                                    key={`${r.token}:${r.interval}:${r.patternId}:${r.signal}:${r._id ?? r.firedAtIST}`}
                                    alert={r}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );

    if (inline) return inner;

    return (
        <div className="page scanner-page">
            <div className="page-header">
                <div>
                    <h2 className="page-title">Equity Scan</h2>
                    <p className="page-sub">On-demand scan · All NSE + BSE stocks · 4H / 1D / 1W · Cached daily</p>
                </div>
            </div>
            {inner}
        </div>
    );
}
