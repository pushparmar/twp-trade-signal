/**
 * EquityScanPanel.jsx
 *
 * Simple equity scan UI:
 *
 * 1. On mount → fetch cached results from /api/equity-scan/results
 * 2. Display results in table with client-side filters
 * 3. "Refresh" button → fetch latest cached results
 * 4. "Run Scan" button → trigger server scan (if no results today)
 *
 * All filtering is client-side — no server calls for filter changes.
 */

import { useState, useEffect, useMemo, useCallback } from "react";
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

// ── Scan Progress Indicator ───────────────────────────────────────────────────

function ScanProgressBanner({ status, onDismiss }) {
    // Show error state even when not running
    if (!status?.running && status?.phase !== "error") return null;

    const phaseLabels = {
        starting: "Starting scan...",
        updating_candles: "Fetching candles from Kite API...",
        scanning_patterns: "Running pattern analysis...",
        complete: "Scan complete!",
        error: `Error: ${status.error || "Unknown error"}`
    };

    const phaseEmoji = {
        starting: "🚀",
        updating_candles: "📊",
        scanning_patterns: "🔍",
        complete: "✅",
        error: "❌"
    };

    const isError = status.phase === "error";
    const label = phaseLabels[status.phase] || status.phase;
    const emoji = phaseEmoji[status.phase] || "⏳";

    return (
        <div
            style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 16px",
                marginBottom: 16,
                borderRadius: 8,
                background: isError
                    ? "linear-gradient(90deg, #ff6b6b20 0%, #fa525220 100%)"
                    : "linear-gradient(90deg, #228be620 0%, #4dabf720 100%)",
                border: `1px solid ${isError ? "#ff6b6b40" : "#4dabf740"}`,
                animation: isError ? "none" : "pulse 2s ease-in-out infinite"
            }}
        >
            {/* Spinner or error icon */}
            {isError ? (
                <div style={{ fontSize: 20 }}>❌</div>
            ) : (
                <div
                    style={{
                        width: 20,
                        height: 20,
                        border: "2px solid #4dabf740",
                        borderTopColor: "#4dabf7",
                        borderRadius: "50%",
                        animation: "spin 1s linear infinite"
                    }}
                />
            )}

            {/* Status text */}
            <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: isError ? "#ff6b6b" : "#4dabf7" }}>
                    {emoji} {isError ? "Scan Failed" : label}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                    {isError ? status.error : "Scanning ~1300 stocks across 3 timeframes (1H, 4H, 1D)"}
                </div>
            </div>

            {/* Phase indicator dots (hide on error) */}
            {!isError && (
                <div style={{ display: "flex", gap: 6 }}>
                    {["starting", "updating_candles", "scanning_patterns"].map((phase, i) => {
                        const phases = ["starting", "updating_candles", "scanning_patterns"];
                        const currentIdx = phases.indexOf(status.phase);
                        const isActive = i === currentIdx;
                        const isDone = i < currentIdx;
                        return (
                            <div
                                key={phase}
                                style={{
                                    width: 8,
                                    height: 8,
                                    borderRadius: "50%",
                                    background: isDone ? "#51cf66" : isActive ? "#4dabf7" : "var(--border)",
                                    boxShadow: isActive ? "0 0 6px #4dabf7" : "none",
                                    transition: "all 0.3s ease"
                                }}
                                title={phaseLabels[phase]}
                            />
                        );
                    })}
                </div>
            )}

            {/* Dismiss button for errors */}
            {isError && onDismiss && (
                <button
                    onClick={onDismiss}
                    style={{
                        background: "none",
                        border: "none",
                        color: "#ff6b6b",
                        cursor: "pointer",
                        fontSize: 18,
                        padding: "0 4px",
                        lineHeight: 1
                    }}
                    title="Dismiss"
                >
                    ×
                </button>
            )}
        </div>
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
                <span className="scan-ltp">{alert.close != null ? fmt(alert.close) : "—"}</span>
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
            <td className="scan-cell scan-cell--price" style={{ color: "var(--text-primary)" }}>
                {alert.close != null ? fmt(alert.close) : "—"}
            </td>
            <td className="scan-cell scan-cell--price" style={{ color: "#ff6b6b" }}>
                {alert.sl != null ? fmt(alert.sl) : "—"}
            </td>
            <td className="scan-cell scan-cell--price" style={{ color: "#51cf66" }}>
                {alert.target != null ? fmt(alert.target) : "—"}
            </td>
            <td className="scan-cell scan-cell--time">{relativeTime(alert.firedAt)}</td>
        </tr>
    );
}

// ── Main panel ────────────────────────────────────────────────────────────────

const TF_OPTIONS = [
    { id: "all", label: "All TF" },
    { id: "60minute", label: "1H" },
    { id: "4h", label: "4H" },
    { id: "day", label: "1D" }
];

const RR_OPTIONS = [
    { value: "all", label: "Any R:R", min: 0, max: Infinity },
    { value: "1", label: "> 1:1", min: 1, max: 2 },
    { value: "2", label: "> 1:2", min: 2, max: 3 },
    { value: "3", label: "> 1:3", min: 3, max: Infinity },
];

export default function EquityScanPanel({ inline = false }) {
    // ── State ─────────────────────────────────────────────────────────────────
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [universe, setUniverse] = useState(null);
    const [status, setStatus] = useState(null);

    // ── Filter state (all client-side) ────────────────────────────────────────
    // Default: 1D timeframe only (pattern=all) to show all daily signals without overload
    const [tfFilter, setTfFilter] = useLocalState("eqscan:tfFilter", "day");
    const [signalFilter, setSignalFilter] = useLocalState("eqscan:signalFilter", "all");
    const [patternFilter, setPatternFilter] = useLocalState("eqscan:patternFilter", "all");
    const [volOnly, setVolOnly] = useLocalState("eqscan:volOnly", false);
    const [rrFilter, setRrFilter] = useLocalState("eqscan:rrFilter", "all");
    const [dedup, setDedup] = useLocalState("eqscan:dedup", false);

    // No live tick subscription — equity scan is for daily/4H swing trades,
    // subscribing hundreds of tokens just for LTP display is wasteful.

    // ── Load cached results on mount ──────────────────────────────────────────
    useEffect(() => {
        async function loadData() {
            setLoading(true);
            try {
                const [resultsRes, universeRes, statusRes] = await Promise.all([
                    api.get("/equity-scan/results"),
                    api.get("/equity-scan/universe"),
                    api.get("/equity-scan/status"),
                ]);
                setResults(resultsRes.data || []);
                setUniverse(universeRes.data);
                setStatus(statusRes.data);
            } catch {
                // Server not reachable
            } finally {
                setLoading(false);
            }
        }
        loadData();
    }, []);

    // ── Handlers ──────────────────────────────────────────────────────────────

    // Refresh: just re-fetch cached results
    const handleRefresh = useCallback(async () => {
        setLoading(true);
        try {
            const { data } = await api.get("/equity-scan/results");
            setResults(data || []);
        } catch (err) {
            console.error("Refresh failed:", err);
        } finally {
            setLoading(false);
        }
    }, []);

    // Poll for scan completion
    const pollForCompletion = useCallback(async () => {
        const poll = async () => {
            try {
                const { data } = await api.get("/equity-scan/status");
                setStatus(data);
                if (data.running) {
                    // Still running, poll again
                    setTimeout(poll, 2000);
                } else if (data.phase === "complete" || data.hasResults) {
                    // Done, fetch results
                    setScanning(false);
                    setStatus(prev => ({ ...prev, phase: "complete" }));
                    await handleRefresh();
                } else if (data.phase === "error") {
                    // Error shown in banner, no alert needed
                    setScanning(false);
                }
            } catch {
                setScanning(false);
                setStatus({ phase: "error", error: "Connection lost during scan" });
            }
        };
        poll();
    }, [handleRefresh]);

    // Run scan: trigger server to update candles + run patterns (async)
    const handleRunScan = useCallback(async () => {
        if (scanning) return;
        setScanning(true);
        setStatus({ running: true, phase: "starting" });
        try {
            const { data } = await api.post("/equity-scan/run");
            if (data.error) {
                setScanning(false);
                setStatus({ phase: "error", error: data.error });
            } else if (data.status === "cached") {
                // Already have results, just refresh
                setScanning(false);
                setStatus(null);
                await handleRefresh();
            } else if (data.status === "started" || data.status === "running") {
                // Scan started in background, poll for completion
                pollForCompletion();
            }
        } catch (err) {
            setScanning(false);
            setStatus({ phase: "error", error: err.response?.data?.error || err.message || "Scan failed" });
        }
    }, [scanning, handleRefresh, pollForCompletion]);

    // Force re-run patterns (no Kite API)
    const handleRerun = useCallback(async () => {
        if (scanning) return;
        setScanning(true);
        setStatus({ running: true, phase: "scanning_patterns" });
        try {
            const { data } = await api.post("/equity-scan/rerun");
            if (data.error) {
                setScanning(false);
                setStatus({ phase: "error", error: data.error });
            } else if (data.status === "started" || data.status === "running") {
                pollForCompletion();
            }
        } catch (err) {
            setScanning(false);
            setStatus({ phase: "error", error: err.response?.data?.error || err.message || "Re-run failed" });
        }
    }, [scanning, pollForCompletion]);

    // Update candles from Kite API + run patterns (full refresh)
    const handleUpdateCandles = useCallback(async () => {
        if (scanning) return;
        if (!window.confirm("This will fetch fresh candles from Kite API (~5-10 min). Continue?")) return;
        setScanning(true);
        setStatus({ running: true, phase: "updating_candles" });
        try {
            const { data } = await api.post("/equity-scan/update-candles");
            if (data.error) {
                setScanning(false);
                setStatus({ phase: "error", error: data.error });
            } else if (data.status === "started" || data.status === "running") {
                pollForCompletion();
            }
        } catch (err) {
            setScanning(false);
            setStatus({ phase: "error", error: err.response?.data?.error || err.message || "Update failed" });
        }
    }, [scanning, pollForCompletion]);

    // ── Derived state ─────────────────────────────────────────────────────────

    const hasResults = results.length > 0;

    // Pattern options for dropdown (derived from results)
    const patternOptions = useMemo(() => {
        const seen = new Map();
        for (const r of results) {
            if (r.patternId && r.patternLabel && !seen.has(r.patternId)) {
                seen.set(r.patternId, { id: r.patternId, label: r.patternLabel });
            }
        }
        const sorted = Array.from(seen.values()).sort((a, b) => a.label.localeCompare(b.label));
        return [
            { id: "all", label: "All patterns" },
            ...sorted
        ];
    }, [results]);

    // Filter results (all client-side)
    const filtered = useMemo(() => {
        // Get R:R range for selected filter
        const rrOpt = RR_OPTIONS.find(o => o.value === rrFilter) || RR_OPTIONS[0];

        let list = results.filter(r => {
            if (tfFilter !== "all" && r.interval !== tfFilter) return false;
            if (signalFilter !== "all" && r.signal !== signalFilter) return false;
            if (patternFilter !== "all" && r.patternId !== patternFilter) return false;
            if (volOnly && !r.volumeConfirmed) return false;

            // R:R range filter (exact range, not >= )
            if (rrFilter !== "all") {
                if (!r.close || !r.sl || !r.target) return false;
                const risk = Math.abs(r.close - r.sl);
                if (risk < 0.01) return false;
                const rr = Math.abs(r.target - r.close) / risk;
                if (rr < rrOpt.min || rr >= rrOpt.max) return false;
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
    }, [results, tfFilter, signalFilter, patternFilter, volOnly, rrFilter, dedup]);

    // ── Render ────────────────────────────────────────────────────────────────

    const inner = (
        <div style={{ paddingBottom: 32 }}>
            {/* CSS for animations */}
            <style>{`
                @keyframes spin {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                }
                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.85; }
                }
            `}</style>

            {/* ── Scan Progress Banner ── */}
            <ScanProgressBanner status={status} onDismiss={() => setStatus(null)} />

            {/* ── Header ── */}
            <div style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                    <span className="mw-detail-name" style={{ fontSize: 16, fontWeight: 700 }}>
                        Equity Scan
                    </span>
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>All NSE + BSE EQ · 4H / 1D</span>
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

                {/* Action buttons */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    {/* Status chip */}
                    <span
                        style={{
                            padding: "3px 10px",
                            borderRadius: 12,
                            fontSize: 12,
                            fontWeight: 600,
                            background: scanning ? "#4dabf71a" : hasResults ? "#2f9e441a" : "var(--bg-secondary)",
                            color: scanning ? "#4dabf7" : hasResults ? "#51cf66" : "var(--text-muted)",
                            border: `1px solid ${scanning ? "#4dabf740" : hasResults ? "#51cf6640" : "var(--border)"}`
                        }}
                    >
                        {loading ? "Loading…" : scanning ? "🔄 Scanning…" : hasResults ? `✓ ${results.length} signals` : "No results"}
                    </span>

                    {/* Refresh button */}
                    <button
                        className="mw-subscribe-btn"
                        onClick={handleRefresh}
                        disabled={loading}
                        style={{ fontWeight: 500 }}
                    >
                        {loading ? "…" : "↻ Refresh"}
                    </button>

                    {/* Run scan button (only show if no results) */}
                    {!hasResults && (
                        <button
                            className="mw-subscribe-btn"
                            onClick={handleRunScan}
                            disabled={scanning || loading}
                            style={{ fontWeight: 600 }}
                        >
                            {scanning ? "Scanning…" : "▶ Run Scan"}
                        </button>
                    )}

                    {/* Re-run link */}
                    {hasResults && (
                        <button
                            onClick={handleRerun}
                            disabled={scanning}
                            style={{
                                fontSize: 11,
                                background: "none",
                                border: "none",
                                color: "var(--text-muted)",
                                cursor: scanning ? "wait" : "pointer",
                                textDecoration: "underline",
                                padding: 0
                            }}
                            title="Force re-run patterns on cached candles"
                        >
                            {scanning ? "Scanning…" : "Re-run"}
                        </button>
                    )}

                    {/* Update Candles link (fetch from Kite API) */}
                    <button
                        onClick={handleUpdateCandles}
                        disabled={scanning}
                        style={{
                            fontSize: 11,
                            background: "none",
                            border: "none",
                            color: "#fab005",
                            cursor: scanning ? "wait" : "pointer",
                            textDecoration: "underline",
                            padding: 0
                        }}
                        title="Fetch fresh candles from Kite API (takes 5-10 min)"
                    >
                        {scanning ? "…" : "⚡ Update Candles"}
                    </button>
                </div>
            </div>

            {/* ── Filters (only show when results exist) ── */}
            {hasResults && (
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

                    {/* R:R filter (exact range) */}
                    <select
                        value={rrFilter}
                        onChange={e => setRrFilter(e.target.value)}
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
                        {RR_OPTIONS.map(o => (
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

            {/* ── Empty state ── */}
            {!loading && !hasResults && (
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
                        No scan results for today. Click "Run Scan" to scan all stocks.
                    </p>
                    <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
                        Scans run automatically at 11:55 PM IST daily.
                    </p>
                </div>
            )}

            {/* ── Loading state ── */}
            {loading && results.length === 0 && (
                <div style={{ textAlign: "center", padding: "32px 0", color: "var(--text-muted)" }}>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>⟳</div>
                    <div style={{ fontSize: 14 }}>Loading scan results…</div>
                </div>
            )}

            {/* ── Results table ── */}
            {filtered.length > 0 && (
                <div className="scan-table-wrap">
                    <table className="scan-table">
                        <thead>
                            <tr>
                                <th className="scan-th">Symbol</th>
                                <th className="scan-th">Close</th>
                                <th className="scan-th">TF</th>
                                <th className="scan-th">Signal</th>
                                <th className="scan-th">Pattern</th>
                                <th className="scan-th">Score</th>
                                <th className="scan-th">Entry</th>
                                <th className="scan-th" style={{ color: "#ff6b6b" }}>SL</th>
                                <th className="scan-th" style={{ color: "#51cf66" }}>Target</th>
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
                    <p className="page-sub">Daily scan · All NSE + BSE stocks · 4H / 1D</p>
                </div>
            </div>
            {inner}
        </div>
    );
}
