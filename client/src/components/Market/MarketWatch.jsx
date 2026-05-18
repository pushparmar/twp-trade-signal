import { useState, useEffect, useRef } from "react";
import api from "../../api";
import useAppStore from "../../store/appStore";
import IchimokuChart from "./IchimokuChart";

// ── Format helper ──────────────────────────────────────────────────────────────
function fmt(n) {
    if (n == null || isNaN(n)) return "—";
    return Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Constants ─────────────────────────────────────────────────────────────────

const INDEX_TFS = [
    { value: "15minute", label: "15m" },
    { value: "60minute", label: "1h" },
    { value: "4h", label: "4h" },
    { value: "day", label: "1d" }
];

const TAB_INDEX = {
    NIFTY: { q: "NIFTY 50", exchange: "NSE", match: "NIFTY 50", label: "Nifty 50" },
    BANKNIFTY: { q: "NIFTY BANK", exchange: "NSE", match: "NIFTY BANK", label: "Bank Nifty" },
    SENSEX: { q: "SENSEX", exchange: "BSE", match: "SENSEX", label: "Sensex" }
};

const SYMBOL_TO_TAB = {
    "NIFTY 50": "NIFTY",
    "NIFTY BANK": "BANKNIFTY",
    SENSEX: "SENSEX"
};

const INDEX_NAMES = new Set(["NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY", "BANKEX"]);
const INDEX_SYMBOLS = new Set(Object.keys(SYMBOL_TO_TAB));

/** Macro instrument keys — tokens resolved from macroData store at render time */
const MACRO_KEYS = [
    { key: "vix", label: "India VIX" },
    { key: "crude", label: "Crude Oil" },
    { key: "gold", label: "Gold" },
    { key: "silver", label: "Silver" },
    { key: "usdinr", label: "USD / INR" }
];

const SCAN_TFS = [
    { value: "15minute", label: "15m" },
    { value: "60minute", label: "1h" },
    { value: "4h", label: "4h" },
    { value: "day", label: "1d" }
];

// ── Module-level flags ────────────────────────────────────────────────────────
let _initDone = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function overallSig(ichi) {
    if (!ichi) return "neutral";
    if (ichi.callBuySignal) return "bullish";
    if (ichi.putBuySignal) return "bearish";
    const sigs = [ichi.chikouSignal, ichi.kijunSignal, ichi.cloudSignal, ichi.tenkanSignal];
    const bull = sigs.filter(s => s === "bullish").length;
    const bear = sigs.filter(s => s === "bearish").length;
    return bull > bear ? "bullish" : bear > bull ? "bearish" : "neutral";
}

function sigColor(sig) {
    return sig === "bullish" ? "var(--green)" : sig === "bearish" ? "var(--red)" : "var(--txt3)";
}

// ── PageLoader ────────────────────────────────────────────────────────────────
function PageLoader({ message }) {
    return (
        <div className="mw-page-loader">
            <span className="mw-page-loader-spinner" />
            <span className="mw-page-loader-msg">{message}</span>
        </div>
    );
}

// ── useIchiSignal ─────────────────────────────────────────────────────────────
function useIchiSignal(token, interval) {
    const ichi = useAppStore(s => (token ? s.ichiSignals[`${token}:${interval}`] : null));
    const setIchiSignal = useAppStore(s => s.setIchiSignal);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!token) return;
        if (useAppStore.getState().ichiSignals[`${token}:${interval}`]) return;
        let cancelled = false;
        setLoading(true);
        api.get(`/ichimoku/${token}`, { params: { interval, bars: 100 } })
            .then(r => {
                if (!cancelled) setIchiSignal({ token, interval, ...r.data });
            })
            .catch(() => {})
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [token, interval, setIchiSignal]);

    return { ichi, loading };
}

// ── TFCard ────────────────────────────────────────────────────────────────────
function TFCard({ token, interval, label, active = false, onClick }) {
    const { ichi, loading } = useIchiSignal(token, interval);
    const sig = overallSig(ichi);
    const color = sigColor(sig);
    const cardMod =
        !loading && ichi ? (sig === "bullish" ? "mw-tf-card--bull" : sig === "bearish" ? "mw-tf-card--bear" : "") : "";

    const factors = ichi ? [ichi.chikouSignal, ichi.kijunSignal, ichi.cloudSignal, ichi.tenkanSignal] : [];
    const bull = factors.filter(s => s === "bullish").length;
    const bear = factors.filter(s => s === "bearish").length;

    let sigLabel;
    if (loading) sigLabel = "·";
    else if (!ichi) sigLabel = "—";
    else if (ichi.callBuySignal) sigLabel = "CALL BUY";
    else if (ichi.putBuySignal) sigLabel = "PUT BUY";
    else sigLabel = sig.charAt(0).toUpperCase() + sig.slice(1);

    return (
        <div
            className={`mw-tf-card ${cardMod}${active ? " mw-tf-card--active" : ""}`}
            onClick={onClick}
            style={onClick ? { cursor: "pointer" } : undefined}
            title={onClick ? `View ${label} Ichimoku chart` : undefined}
        >
            <div className="mw-tf-card-label">{label}</div>
            <div className="mw-tf-card-signal" style={{ color }}>
                {sigLabel}
            </div>
            {ichi && !loading && (
                <div className="mw-tf-card-counts">
                    <span className="sig-bull">{bull}↑</span> <span className="sig-bear">{bear}↓</span>
                </div>
            )}
        </div>
    );
}

// ── OverallSignalCard — aggregates all 4 TF Ichimoku signals into one verdict ──
// Shows CALL BUY / PUT BUY when any TF fires that strong signal, otherwise
// computes majority of bullish/bearish across all timeframes.
function OverallSignalCard({ token }) {
    const tf15 = useIchiSignal(token, "15minute");
    const tf1h = useIchiSignal(token, "60minute");
    const tf4h = useIchiSignal(token, "4h");
    const tf1d = useIchiSignal(token, "day");

    const tfs = [
        { label: "15m", ...tf15 },
        { label: "1h", ...tf1h },
        { label: "4h", ...tf4h },
        { label: "1d", ...tf1d }
    ];

    const loading = tfs.some(tf => tf.loading);
    const anyData = tfs.some(tf => tf.ichi != null);

    // Strong signals: any timeframe firing CALL BUY / PUT BUY takes priority
    const hasCallBuy = tfs.some(tf => tf.ichi?.callBuySignal);
    const hasPutBuy = tfs.some(tf => tf.ichi?.putBuySignal);

    // Per-TF overall direction
    const tfSignals = tfs.map(tf => overallSig(tf.ichi));
    const bullCount = tfSignals.filter(s => s === "bullish").length;
    const bearCount = tfSignals.filter(s => s === "bearish").length;

    let finalSig, finalLabel;
    if (hasCallBuy && !hasPutBuy) {
        finalSig = "bullish";
        finalLabel = "CALL BUY";
    } else if (hasPutBuy && !hasCallBuy) {
        finalSig = "bearish";
        finalLabel = "PUT BUY";
    } else if (bullCount > bearCount) {
        finalSig = "bullish";
        finalLabel = "BULLISH";
    } else if (bearCount > bullCount) {
        finalSig = "bearish";
        finalLabel = "BEARISH";
    } else {
        finalSig = "neutral";
        finalLabel = "NEUTRAL";
    }

    const color = sigColor(finalSig);
    const cardMod =
        !loading && anyData
            ? finalSig === "bullish"
                ? "mw-tf-card--bull"
                : finalSig === "bearish"
                ? "mw-tf-card--bear"
                : ""
            : "";

    // Per-TF arrow/dot indicators for the breakdown row
    const breakdown = tfs.map(tf => {
        if (!tf.ichi) return { label: tf.label, symbol: "–", color: "var(--txt3)" };
        if (tf.ichi.callBuySignal) return { label: tf.label, symbol: "●", color: "var(--green)" };
        if (tf.ichi.putBuySignal) return { label: tf.label, symbol: "●", color: "var(--red)" };
        const s = overallSig(tf.ichi);
        return {
            label: tf.label,
            symbol: s === "bullish" ? "▲" : s === "bearish" ? "▼" : "–",
            color: sigColor(s)
        };
    });

    return (
        <div className={`mw-tf-card mw-overall-card ${cardMod}`}>
            <div className="mw-tf-card-label">Overall Bias</div>

            {loading && !anyData ? (
                <div className="mw-overall-signal" style={{ color: "var(--txt3)" }}>
                    ·
                </div>
            ) : !anyData ? (
                <div className="mw-overall-signal" style={{ color: "var(--txt3)" }}>
                    —
                </div>
            ) : (
                <>
                    <div className="mw-overall-signal" style={{ color }}>
                        {finalLabel}
                    </div>

                    {/* Per-TF arrow indicators */}
                    <div className="mw-overall-breakdown">
                        {breakdown.map(b => (
                            <span
                                key={b.label}
                                className="mw-overall-tf-dot"
                                style={{ color: b.color }}
                                title={b.label}
                            >
                                {b.symbol}
                            </span>
                        ))}
                    </div>

                    <div className="mw-tf-card-counts">
                        <span className="sig-bull">{bullCount}↑</span> <span className="sig-bear">{bearCount}↓</span>
                        {(bullCount > 0 || bearCount > 0) && (
                            <span style={{ marginLeft: 5, color: "var(--txt3)" }}>
                                ({finalSig === "bullish" ? bullCount : bearCount}/4)
                            </span>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

// ── Stock timeframe signal badges (1m / 5m / 15m) ────────────────────────────
const STOCK_TFS = [
    { value: "minute", label: "1m" },
    { value: "5minute", label: "5m" },
    { value: "15minute", label: "15m" }
];

// Ordered list of the 4 Ichimoku indicators shown per-TF
const ICHI_INDS = [
    { key: "chikou", title: "Chikou", sigFn: i => i.chikouSignal },
    { key: "kijun", title: "Kijun", sigFn: i => i.kijunSignal },
    { key: "cloud", title: "Cloud", sigFn: i => i.cloudSignal },
    { key: "tenkan", title: "Tenkan", sigFn: i => i.tenkanSignal }
];

function StockIchiBadges({ token }) {
    const tf1 = useIchiSignal(token, "minute");
    const tf5 = useIchiSignal(token, "5minute");
    const tf15 = useIchiSignal(token, "15minute");

    const tfs = [
        { label: "1m", ...tf1 },
        { label: "5m", ...tf5 },
        { label: "15m", ...tf15 }
    ];

    return (
        <div className="stock-ichi-badges">
            {tfs.map(tf => {
                const sig = overallSig(tf.ichi);
                const mod = !tf.ichi
                    ? tf.loading
                        ? "loading"
                        : "flat"
                    : sig === "bullish"
                    ? "bull"
                    : sig === "bearish"
                    ? "bear"
                    : "flat";

                return (
                    <div key={tf.label} className={`stock-ichi-tf-group stock-ichi-tf-group--${mod}`}>
                        {/* TF label */}
                        <span className="stock-ichi-tf-label">{tf.label}</span>

                        {/* 4 individual indicator arrows, or CB/PB badge for strong signals */}
                        {tf.ichi ? (
                            <div className="stock-ichi-arrows">
                                {tf.ichi.callBuySignal ? (
                                    <span
                                        className="stock-ichi-special stock-ichi-special--bull"
                                        title="Call Buy signal"
                                    >
                                        CB
                                    </span>
                                ) : tf.ichi.putBuySignal ? (
                                    <span
                                        className="stock-ichi-special stock-ichi-special--bear"
                                        title="Put Buy signal"
                                    >
                                        PB
                                    </span>
                                ) : (
                                    ICHI_INDS.map(ind => {
                                        const s = ind.sigFn(tf.ichi) ?? "neutral";
                                        return (
                                            <span
                                                key={ind.key}
                                                className={`stock-ichi-arrow stock-ichi-arrow--${s}`}
                                                title={`${ind.title}: ${s}`}
                                            >
                                                {s === "bullish" ? "▲" : s === "bearish" ? "▼" : "–"}
                                            </span>
                                        );
                                    })
                                )}
                            </div>
                        ) : (
                            <span className="stock-ichi-loading">·</span>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

// ── OhlcItem ──────────────────────────────────────────────────────────────────
function OhlcItem({ label, value, cls = "" }) {
    return (
        <div className="mw-detail-ohlc-item">
            <span className="mw-detail-ohlc-label">{label}</span>
            <span className={`mw-detail-ohlc-value ${cls}`}>{value}</span>
        </div>
    );
}

// ── InstrumentDetail — detail panel for a selected instrument ─────────────────
function InstrumentDetail({ token, label, sublabel }) {
    const [chartInterval, setChartInterval] = useState("15minute");
    const chartRef = useRef(null);
    const tick = useAppStore(s => (token ? s.ticks[token] : null));
    const ltp = tick?.lastPrice ?? null;
    const change = tick?.change ?? null;
    const ohlc = tick?.ohlc ?? {};

    const chgMod =
        change > 0 ? "mw-detail-chg-pill--up" : change < 0 ? "mw-detail-chg-pill--down" : "mw-detail-chg-pill--flat";

    const hasOhlc = ohlc.open != null || ohlc.high != null || ohlc.low != null;

    return (
        <>
            {/* ── Top row: price header (left) + Overall Bias card (right) ── */}
            <div className="mw-detail-top">
                <div className="mw-detail-header">
                    <div className="mw-detail-name-row">
                        <span className="mw-detail-name">{label}</span>
                        {sublabel && <span className="mw-detail-sublabel">{sublabel}</span>}
                    </div>

                    <div className="mw-detail-price-row">
                        <span className="mw-detail-ltp">{ltp != null ? fmt(ltp) : "—"}</span>
                        {change != null && (
                            <span className={`mw-detail-chg-pill ${chgMod}`}>
                                {change > 0 ? "+" : ""}
                                {Number(change).toFixed(2)}%
                            </span>
                        )}
                    </div>

                    {hasOhlc && (
                        <div className="mw-detail-ohlc-row">
                            {ohlc.open != null && <OhlcItem label="Open" value={fmt(ohlc.open)} />}
                            {ohlc.high != null && (
                                <OhlcItem label="High" value={fmt(ohlc.high)} cls="mw-detail-ohlc-value--high" />
                            )}
                            {ohlc.low != null && (
                                <OhlcItem label="Low" value={fmt(ohlc.low)} cls="mw-detail-ohlc-value--low" />
                            )}
                            {ohlc.close != null && <OhlcItem label="Prev Close" value={fmt(ohlc.close)} />}
                        </div>
                    )}
                </div>

                {/* Overall Bias card aligned to the right of the price header */}
                {token && <OverallSignalCard token={token} />}
            </div>

            {token && (
                /* ── TF Signal Bar: clicking a card switches the chart below ── */
                <div className="mw-tf-bar">
                    {INDEX_TFS.map(tf => (
                        <TFCard
                            key={tf.value}
                            token={token}
                            interval={tf.value}
                            label={tf.label}
                            active={chartInterval === tf.value}
                            onClick={() => setChartInterval(tf.value)}
                        />
                    ))}
                </div>
            )}

            {/* ── Ichimoku Cloud Chart — interval driven by selected TF card ── */}
            {token && (
                <>
                    {/* Zoom controls — mirrors ScanChartModal pattern */}

                    <IchimokuChart ref={chartRef} token={token} interval={chartInterval} label={label} />
                    <div className="chart-zoom-bar">
                        <span className="chart-zoom-label">Zoom</span>
                        {[50, 100, 200].map(n => (
                            <button
                                key={n}
                                className="chart-zoom-btn"
                                onClick={() => chartRef.current?.zoomToBars(n)}
                                title={`Show last ${n} bars`}
                            >
                                {n}
                            </button>
                        ))}
                        <button
                            className="chart-zoom-btn chart-zoom-btn--all"
                            onClick={() => chartRef.current?.fitAll()}
                            title="Fit all bars"
                        >
                            All
                        </button>
                    </div>
                </>
            )}
        </>
    );
}

// ── Mobile instrument strip — shown only on small screens where sidebar is hidden
function MobileInstStrip({ watchlist, macroData, selectedInstrument, setSelectedInstrument }) {
    function fmt2(n) {
        if (n == null || isNaN(n)) return "—";
        return Number(n).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }

    const indexItems = Object.entries(TAB_INDEX).map(([key, info]) => {
        const inst = watchlist.find(i => i.tradingsymbol === info.match);
        return { type: "index", key, label: info.label, token: inst?.instrumentToken ?? null };
    });

    const macroItems = MACRO_KEYS.map(m => {
        const md = macroData?.[m.key];
        const token = md?.instrumentToken ?? null;
        const sub = md?.tradingsymbol ?? "";
        return { type: "macro", key: m.key, label: m.label, token, sublabel: sub };
    });

    const stockItems = watchlist
        .filter(i => !INDEX_NAMES.has(i.name) && !INDEX_SYMBOLS.has(i.tradingsymbol))
        .map(i => ({
            type: "stock",
            token: i.instrumentToken,
            label: i.tradingsymbol,
            sublabel: `${i.exchange}${i.expiry ? ` · ${i.expiry}` : ""}`
        }));

    const allItems = [...indexItems, ...macroItems, ...stockItems];

    return (
        <div className="mw-mobile-strip">
            {allItems.map(item => (
                <MobileStripItem
                    key={item.token ?? item.key}
                    item={item}
                    active={
                        selectedInstrument?.type === item.type &&
                        (item.type === "stock"
                            ? selectedInstrument.token === item.token
                            : selectedInstrument.key === item.key)
                    }
                    onClick={() => setSelectedInstrument(item)}
                />
            ))}
            <button
                className={`mw-mobile-manage-btn ${
                    selectedInstrument?.type === "manage" ? "mw-mobile-manage-btn--active" : ""
                }`}
                onClick={() => setSelectedInstrument({ type: "manage" })}
            >
                Stocks ⚙
            </button>
        </div>
    );
}

function MobileStripItem({ item, active, onClick }) {
    const tick = useAppStore(s => (item.token ? s.ticks[item.token] : null));
    const change = tick?.change ?? null;
    const chgCls = change > 0 ? "mw-up" : change < 0 ? "mw-down" : "";

    return (
        <div className={`mw-mobile-strip-item ${active ? "mw-mobile-strip-item--active" : ""}`} onClick={onClick}>
            <div className="mw-mobile-strip-label">{item.label}</div>
            {change != null && (
                <div className={`mw-mobile-strip-chg ${chgCls}`}>
                    {change > 0 ? "+" : ""}
                    {Number(change).toFixed(2)}%
                </div>
            )}
        </div>
    );
}

// ── InlineSearch — standalone symbol search box ───────────────────────────────
function InlineSearch({ onAdd }) {
    const [query, setQuery] = useState("");
    const [exchange, setExchange] = useState("");
    const [results, setResults] = useState([]);
    const [searching, setSearching] = useState(false);
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const wrapRef = useRef(null);
    const debounceRef = useRef(null);

    async function doSearch(q, ex) {
        if (q.length < 2) {
            setResults([]);
            setDropdownOpen(false);
            return;
        }
        setSearching(true);
        try {
            const r = await api.get("/instruments/search", { params: { q, exchange: ex } });
            setResults(r.data);
            setDropdownOpen(r.data.length > 0);
        } catch {
            setResults([]);
        } finally {
            setSearching(false);
        }
    }

    function handleChange(e) {
        const q = e.target.value;
        setQuery(q);
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => doSearch(q, exchange), 300);
    }

    function handleSelect(instrument) {
        onAdd(instrument);
        setQuery("");
        setResults([]);
        setDropdownOpen(false);
    }

    useEffect(() => {
        function handler(e) {
            if (wrapRef.current && !wrapRef.current.contains(e.target)) setDropdownOpen(false);
        }
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, []);

    return (
        <div className="mw-search-box" ref={wrapRef}>
            <div className="mw-search-box-row">
                <input
                    className="mw-search-box-input"
                    type="text"
                    placeholder="Search symbol to add…"
                    value={query}
                    onChange={handleChange}
                    onFocus={() => results.length > 0 && setDropdownOpen(true)}
                />
                <select
                    className="mw-search-box-exchange"
                    value={exchange}
                    onChange={e => {
                        setExchange(e.target.value);
                        doSearch(query, e.target.value);
                    }}
                >
                    <option value="">All</option>
                    <option value="NSE">NSE</option>
                    <option value="NFO">NFO</option>
                    <option value="BSE">BSE</option>
                    <option value="MCX">MCX</option>
                    <option value="CDS">CDS</option>
                </select>
                {searching && <span className="mw-search-spinner" />}
            </div>
            {dropdownOpen && results.length > 0 && (
                <div className="mw-dropdown">
                    {results.map(r => (
                        <div key={r.instrumentToken} className="mw-dropdown-item" onMouseDown={() => handleSelect(r)}>
                            <div>
                                <div className="mw-dropdown-name">{r.tradingsymbol}</div>
                                <div className="mw-dropdown-meta">
                                    {r.exchange}
                                    {r.expiry ? ` · ${r.expiry}` : ""}
                                    {r.name ? ` · ${r.name}` : ""}
                                </div>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                {r.lotSize > 1 && <span className="mw-dropdown-lot">Lot {r.lotSize}</span>}
                                <span className="mw-dropdown-type">{r.instrumentType}</span>
                                <span className="mw-dropdown-add">+</span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── StockListRow ──────────────────────────────────────────────────────────────
function StockListRow({ item, onRemove }) {
    const tick = useAppStore(s => s.ticks[item.instrumentToken]);
    const prevRef = useRef(null);
    const priceRef = useRef(null);

    useEffect(() => {
        if (!tick || !priceRef.current) return;
        const curr = tick.lastPrice;
        if (prevRef.current == null) {
            prevRef.current = curr;
            return;
        }
        const dir = curr > prevRef.current ? "flash-up" : curr < prevRef.current ? "flash-down" : null;
        prevRef.current = curr;
        if (!dir) return;
        priceRef.current.classList.remove("flash-up", "flash-down");
        void priceRef.current.offsetWidth;
        priceRef.current.classList.add(dir);
    }, [tick?.lastPrice]);

    const change = tick?.change ?? null;
    const chgCls = change > 0 ? "mw-up" : change < 0 ? "mw-down" : "";

    return (
        <tr>
            <td>
                <div className="mw-sym-name">{item.tradingsymbol}</div>
                <div className="mw-sym-meta">
                    {item.exchange}
                    {item.expiry ? ` · ${item.expiry}` : ""}
                </div>
            </td>
            <td className="td-mono td-right">
                <span ref={priceRef} className="mw-ltp-val">
                    {tick ? fmt(tick.lastPrice) : "—"}
                </span>
            </td>
            <td className={`td-right td-mono ${chgCls}`} style={{ fontSize: 12 }}>
                {change != null ? `${change > 0 ? "+" : ""}${Number(change).toFixed(2)}%` : "—"}
            </td>
            <td>
                {/* Ichimoku bias for 1m / 5m / 15m */}
                <StockIchiBadges token={item.instrumentToken} />
            </td>
            <td className="td-center">
                <button className="mw-remove-btn" onClick={() => onRemove(item.instrumentToken)} title="Remove">
                    ×
                </button>
            </td>
        </tr>
    );
}

// ── StockFuturesPanel ─────────────────────────────────────────────────────────
function StockFuturesPanel({
    watchlist,
    futLoading,
    onSubscribe,
    bulkLoading,
    filter,
    onFilterChange,
    onSubscribeMovers,
    onClearAll
}) {
    const [names, setNames] = useState([]);
    const [minPct, setMinPct] = useState("6");
    const [maxPct, setMaxPct] = useState("");
    const [moversLoading, setMoversLoading] = useState(false);

    useEffect(() => {
        api.get("/instruments/futures-list")
            .then(r => setNames(r.data))
            .catch(() => {});
    }, []);

    const visible = filter ? names.filter(n => n.includes(filter)) : names;

    async function handleSubscribeMovers() {
        setMoversLoading(true);
        try {
            await onSubscribeMovers(Number(minPct) || 0, maxPct !== "" ? Number(maxPct) : null);
        } finally {
            setMoversLoading(false);
        }
    }

    return (
        <div className="mw-futures-panel">
            <div className="mw-futures-header">
                <span className="mw-futures-title">Futures</span>
                <input
                    className="mw-futures-filter"
                    placeholder="Filter stocks…"
                    value={filter}
                    onChange={e => onFilterChange(e.target.value.toUpperCase())}
                />
                <span className="mw-futures-count">{visible.length} stocks</span>
                {bulkLoading && <span className="mw-page-loader-spinner" style={{ width: 14, height: 14 }} />}
                {watchlist.filter(i => i.instrumentType === "FUT").length > 0 && (
                    <button className="mw-clear-btn" onClick={onClearAll} title="Unsubscribe all stock futures">
                        Clear All
                    </button>
                )}
            </div>
            <div className="mw-movers-wrap">
                <span className="mw-futures-title">Subscribe Movers</span>
                <input
                    className="mw-movers-input"
                    type="number"
                    placeholder="Min %"
                    value={minPct}
                    onChange={e => setMinPct(e.target.value)}
                    min="0"
                />
                <span className="td-muted" style={{ fontSize: 11 }}>
                    –
                </span>
                <input
                    className="mw-movers-input"
                    type="number"
                    placeholder="Max %"
                    value={maxPct}
                    onChange={e => setMaxPct(e.target.value)}
                    min="0"
                />
                <span className="td-muted" style={{ fontSize: 11 }}>
                    % from open (±both sides)
                </span>
                <button className="mw-movers-btn" disabled={moversLoading} onClick={handleSubscribeMovers}>
                    {moversLoading ? "…" : "↑ Subscribe Movers"}
                </button>
            </div>
        </div>
    );
}

// ── PatternScanner — kept for future use ──────────────────────────────────────
function PatternScanner({ onResults, instruments = null }) {
    const [patterns, setPatterns] = useState([]);
    const [patternId, setPatternId] = useState("");
    const [interval, setInterval] = useState("15minute");
    const [scanning, setScanning] = useState(false);
    const [summary, setSummary] = useState(null);
    const [error, setError] = useState("");

    useEffect(() => {
        api.get("/scan/patterns")
            .then(r => {
                setPatterns(r.data);
                if (r.data.length > 0) setPatternId(r.data[0].id);
            })
            .catch(() => setError("Could not load patterns"));
    }, []);

    async function handleScan() {
        if (!patternId || !interval) return;
        setScanning(true);
        setError("");
        try {
            const body = { patternId, intervals: [interval] };
            if (instruments) body.instruments = instruments;
            const r = await api.post("/scan", body);
            const { matches, scannedCount, totalInstruments, patternLabel } = r.data;
            onResults(new Set(matches.map(m => m.token)));
            setSummary({
                label: patternLabel,
                matched: matches.length,
                scanned: scannedCount,
                total: totalInstruments
            });
        } catch (e) {
            setError(e.response?.data?.error || e.message);
        } finally {
            setScanning(false);
        }
    }

    function handleClear() {
        onResults(null);
        setSummary(null);
        setError("");
    }

    const activePattern = patterns.find(p => p.id === patternId);
    const tfLabel = SCAN_TFS.find(t => t.value === interval)?.label ?? interval;

    return (
        <div style={{ padding: "10px 0 6px" }}>
            <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <select
                    value={patternId}
                    onChange={e => {
                        setPatternId(e.target.value);
                        handleClear();
                    }}
                    style={{
                        background: "#1e293b",
                        border: "1px solid #334155",
                        borderRadius: 6,
                        color: "#e2e8f0",
                        fontSize: 13,
                        padding: "6px 10px",
                        minWidth: 220
                    }}
                >
                    {patterns.length === 0 && <option value="">Loading…</option>}
                    {patterns.map(p => (
                        <option key={p.id} value={p.id}>
                            {p.label}
                        </option>
                    ))}
                </select>
                <div style={{ display: "flex", gap: 4 }}>
                    {SCAN_TFS.map(tf => {
                        const active = interval === tf.value;
                        return (
                            <button
                                key={tf.value}
                                onClick={() => {
                                    setInterval(tf.value);
                                    handleClear();
                                }}
                                style={{
                                    padding: "5px 10px",
                                    borderRadius: 5,
                                    fontSize: 12,
                                    fontWeight: 600,
                                    cursor: "pointer",
                                    background: active ? "#1e40af" : "#1e293b",
                                    border: `1px solid ${active ? "#3b82f6" : "#334155"}`,
                                    color: active ? "#93c5fd" : "#475569"
                                }}
                            >
                                {tf.label}
                            </button>
                        );
                    })}
                </div>
                <button
                    onClick={handleScan}
                    disabled={scanning || !patternId || !interval}
                    style={{
                        padding: "6px 20px",
                        borderRadius: 6,
                        fontSize: 13,
                        fontWeight: 700,
                        cursor: scanning || !patternId ? "not-allowed" : "pointer",
                        background: scanning ? "#1e293b" : "#2563eb",
                        border: `1px solid ${scanning ? "#334155" : "#3b82f6"}`,
                        color: scanning ? "#475569" : "#fff"
                    }}
                >
                    {scanning ? "Scanning…" : "⌖ Scan"}
                </button>
                {summary !== null && (
                    <button
                        onClick={handleClear}
                        style={{
                            padding: "5px 12px",
                            borderRadius: 6,
                            fontSize: 12,
                            background: "transparent",
                            border: "1px solid #334155",
                            color: "#64748b",
                            cursor: "pointer"
                        }}
                    >
                        ✕ Clear filter
                    </button>
                )}
            </div>
            {error ? (
                <div style={{ marginTop: 5, fontSize: 11, color: "#ef4444" }}>{error}</div>
            ) : summary !== null ? (
                <div style={{ marginTop: 5, fontSize: 11, color: "#64748b" }}>
                    <span style={{ color: summary.matched > 0 ? "#22c55e" : "#94a3b8", fontWeight: 600 }}>
                        {summary.matched} match{summary.matched !== 1 ? "es" : ""}
                    </span>{" "}
                    on {tfLabel} · {summary.total} instruments scanned
                </div>
            ) : activePattern?.description ? (
                <div style={{ marginTop: 5, fontSize: 11, color: "#475569" }}>{activePattern.description}</div>
            ) : null}
        </div>
    );
}

// ── ManageStocksPanel ─────────────────────────────────────────────────────────
function ManageStocksPanel({ watchlist, onAdd, onRemove, futLoading, onSubscribe, onSubscribeMovers, onClearAll }) {
    const [stockFilter, setStockFilter] = useState("");
    const stockItems = watchlist.filter(i => !INDEX_NAMES.has(i.name) && !INDEX_SYMBOLS.has(i.tradingsymbol));

    return (
        <div>
            <div style={{ marginBottom: 18 }}>
                <span className="mw-detail-name">Manage Stocks</span>
            </div>

            <InlineSearch onAdd={onAdd} />

            <StockFuturesPanel
                watchlist={watchlist}
                futLoading={futLoading}
                onSubscribe={onSubscribe}
                bulkLoading={false}
                filter={stockFilter}
                onFilterChange={setStockFilter}
                onSubscribeMovers={onSubscribeMovers}
                onClearAll={onClearAll}
            />

            {stockItems.length > 0 && (
                <>
                    <div className="section-title" style={{ marginTop: 16, marginBottom: 8 }}>
                        Subscribed <span className="count-badge">{stockItems.length}</span>
                    </div>
                    <div className="kite-table-wrap">
                        <table className="kite-table">
                            <thead>
                                <tr>
                                    <th>Symbol</th>
                                    <th className="th-right">LTP</th>
                                    <th className="th-right">Chg%</th>
                                    <th>
                                        <div
                                            style={{
                                                display: "flex",
                                                justifyContent: "space-between",
                                                width: "100%",
                                                gap: 10
                                            }}
                                        >
                                            <span style={{ flex: 1, textAlign: "center" }}>1m</span>
                                            <span style={{ flex: 1, textAlign: "center" }}>5m</span>
                                            <span style={{ flex: 1, textAlign: "center" }}>15m</span>
                                        </div>
                                    </th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {stockItems.map(item => (
                                    <StockListRow key={item.instrumentToken} item={item} onRemove={onRemove} />
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}
        </div>
    );
}

// ── Main MarketWatch component ────────────────────────────────────────────────
export default function MarketWatch() {
    const watchlist = useAppStore(s => s.watchlist);
    const setWatchlist = useAppStore(s => s.setWatchlist);
    const addToWatchlist = useAppStore(s => s.addToWatchlist);
    const removeFromWatchlist = useAppStore(s => s.removeFromWatchlist);
    const tickerConnected = useAppStore(s => s.tickerConnected);
    const macroData = useAppStore(s => s.macroData);
    const setMacroData = useAppStore(s => s.setMacroData);
    const selectedInstrument = useAppStore(s => s.selectedInstrument);
    const setSelectedInstrument = useAppStore(s => s.setSelectedInstrument);

    const [pageLoading, setPageLoading] = useState(true);
    const [pageLoadMsg, setPageLoadMsg] = useState("Initialising…");
    const [futLoading, setFutLoading] = useState(new Set());

    const _autoSelected = useRef(false);

    // ── Init: load watchlist and subscribe index underlyings ──────────────────
    useEffect(() => {
        let retryTimer = null;

        async function init() {
            if (_initDone) {
                setPageLoading(false);
                return;
            }
            setPageLoading(true);
            setPageLoadMsg("Loading indices…");
            try {
                const [wl] = await Promise.all([
                    api.get("/instruments/watchlist"),
                    api.get("/instruments/status").catch(() => {})
                ]);
                setWatchlist(wl.data);

                const results = await Promise.allSettled(
                    Object.entries(TAB_INDEX).map(async ([, info]) => {
                        const r = await api.get("/instruments/search", {
                            params: { q: info.q, exchange: info.exchange }
                        });
                        const inst = r.data.find(i => i.tradingsymbol === info.match);
                        if (inst) {
                            const sub = await api.post("/instruments/subscribe", inst);
                            setWatchlist(sub.data.watchlist);
                        }
                        return inst;
                    })
                );

                const anyFailed = results.some(r => r.status === "rejected");
                const anyMissing = results.some(r => r.status === "fulfilled" && !r.value);
                if (anyFailed || anyMissing) {
                    setPageLoadMsg("Waiting for instrument cache…");
                    retryTimer = setTimeout(init, 5000);
                    return;
                }

                _initDone = true;
            } catch {
                retryTimer = setTimeout(init, 5000);
                return;
            } finally {
                setPageLoading(false);
            }
        }

        init();
        return () => {
            if (retryTimer) clearTimeout(retryTimer);
        };
    }, [setWatchlist]);

    // ── Load macro data once (SSE macro_update keeps it fresh) ────────────────
    useEffect(() => {
        api.get("/macro/analysis")
            .then(r => setMacroData(r.data))
            .catch(() => {});
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Auto-select Nifty 50 after first successful init ──────────────────────
    useEffect(() => {
        if (!pageLoading && !_autoSelected.current && !selectedInstrument) {
            const inst = watchlist.find(i => i.tradingsymbol === "NIFTY 50");
            if (inst) {
                _autoSelected.current = true;
                setSelectedInstrument({ type: "index", key: "NIFTY", token: inst.instrumentToken, label: "Nifty 50" });
            }
        }
    }, [pageLoading, watchlist, selectedInstrument, setSelectedInstrument]);

    // ── Handlers ──────────────────────────────────────────────────────────────
    async function handleAdd(instrument) {
        try {
            const r = await api.post("/instruments/subscribe", instrument);
            setWatchlist(r.data.watchlist);
            addToWatchlist(instrument);
        } catch (err) {
            console.error("Subscribe failed:", err.message);
        }
    }

    async function handleRemove(instrumentToken) {
        try {
            const r = await api.post("/instruments/unsubscribe", { instrumentToken });
            setWatchlist(r.data.watchlist);
        } catch (err) {
            console.error("Unsubscribe failed:", err.message);
        }
        removeFromWatchlist(instrumentToken);
        if (selectedInstrument?.type === "stock" && selectedInstrument.token === instrumentToken) {
            setSelectedInstrument(null);
        }
    }

    async function unsubscribeAllFutures() {
        try {
            const r = await api.post("/instruments/unsubscribe-all-futures");
            setWatchlist(r.data.watchlist);
        } catch (err) {
            console.error("Unsubscribe all futures failed:", err.response?.data?.error || err.message);
        }
    }

    async function subscribeMovers(minPct, maxPct) {
        try {
            const body = { minPct };
            if (maxPct != null) body.maxPct = maxPct;
            const r = await api.post("/instruments/subscribe-movers", body);
            setWatchlist(r.data.watchlist);
        } catch (err) {
            console.error("Subscribe movers failed:", err.response?.data?.error || err.message);
        }
    }

    async function subscribeStockFuture(symbol) {
        setFutLoading(prev => new Set([...prev, symbol]));
        try {
            const r = await api.post("/instruments/subscribe-future", { symbol });
            setWatchlist(r.data.watchlist);
        } catch (err) {
            console.error(`Future subscribe failed for ${symbol}:`, err.response?.data?.error || err.message);
        } finally {
            setFutLoading(prev => {
                const s = new Set(prev);
                s.delete(symbol);
                return s;
            });
        }
    }

    function handleHardReset() {
        _initDone = false;
        _autoSelected.current = false;
        useAppStore.setState({ ichiSignals: {} });
        window.location.reload();
    }

    // ── Resolve token/label/sublabel for the detail panel ────────────────────
    let detailToken = null;
    let detailLabel = "";
    let detailSublabel = "";

    if (selectedInstrument && selectedInstrument.type !== "manage") {
        detailToken = selectedInstrument.token;
        detailLabel = selectedInstrument.label;
        detailSublabel = selectedInstrument.sublabel ?? "";

        // Macro tokens are resolved from macroData (loads asynchronously)
        if (selectedInstrument.type === "macro" && macroData) {
            const md = macroData[selectedInstrument.key];
            detailToken = md?.instrumentToken ?? null;
            detailSublabel = md?.tradingsymbol ?? selectedInstrument.sublabel ?? "";
        }
    }

    // ── Render ────────────────────────────────────────────────────────────────
    if (pageLoading) {
        return (
            <div className="page">
                <PageLoader message={pageLoadMsg} />
            </div>
        );
    }

    return (
        <div className="page" style={{ paddingTop: 16 }}>
            {/* ── Page header ── */}
            <div className="page-header" style={{ marginBottom: 16 }}>
                <h2 className="page-title">Market Watch</h2>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span
                        className={`mw-conn-dot ${tickerConnected ? "mw-conn-dot--on" : "mw-conn-dot--off"}`}
                        title={tickerConnected ? "Ticker connected" : "Ticker offline"}
                    />
                    <button
                        className="mw-reset-btn"
                        onClick={handleHardReset}
                        title="Hard reset — clears all state and reloads"
                    >
                        ↺ Reset
                    </button>
                </div>
            </div>

            {/* ── Mobile instrument strip (hidden on desktop via CSS) ── */}
            <MobileInstStrip
                watchlist={watchlist}
                macroData={macroData}
                selectedInstrument={selectedInstrument}
                setSelectedInstrument={setSelectedInstrument}
            />

            {/* ── Detail content ── */}
            {selectedInstrument?.type === "manage" ? (
                <ManageStocksPanel
                    watchlist={watchlist}
                    onAdd={handleAdd}
                    onRemove={handleRemove}
                    futLoading={futLoading}
                    onSubscribe={subscribeStockFuture}
                    onSubscribeMovers={subscribeMovers}
                    onClearAll={unsubscribeAllFutures}
                />
            ) : selectedInstrument ? (
                <InstrumentDetail token={detailToken} label={detailLabel} sublabel={detailSublabel} />
            ) : (
                <div className="mw-detail-empty">
                    <span style={{ fontSize: 28 }}>📊</span>
                    <span>Select an instrument from the sidebar</span>
                </div>
            )}
        </div>
    );
}
