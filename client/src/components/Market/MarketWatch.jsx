import { useState, useEffect, useRef } from "react";
import api from "../../api";
import useAppStore from "../../store/appStore";

function fmt(n) {
    if (n == null || isNaN(n)) return "—";
    return Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Constants ─────────────────────────────────────────────────────────────────
const ATM_OFFSETS = {
    NIFTY: [-2, -1, 0, 1, 2],
    BANKNIFTY: [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5],
    SENSEX: [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5]
};

const INTERVALS = [
    { value: "5minute", label: "5m" },
    { value: "15minute", label: "15m" },
    { value: "30minute", label: "30m" },
    { value: "60minute", label: "1h" },
    { value: "day", label: "D" }
];

// Timeframes shown on the INDEX tab
const INDEX_TFS = [
    { value: "minute", label: "1m" },
    { value: "3minute", label: "3m" },
    { value: "5minute", label: "5m" },
    { value: "15minute", label: "15m" }
];

// Timeframes shown on the Stocks tab
const STOCK_TFS = [
    { value: "minute", label: "1m" },
    { value: "5minute", label: "5m" },
    { value: "15minute", label: "15m" }
];

const TABS = [
    { id: "INDEX", label: "Index" },
    { id: "NIFTY", label: "Nifty" },
    { id: "BANKNIFTY", label: "Bank Nifty" },
    { id: "SENSEX", label: "Sensex" },
    { id: "STOCKS", label: "Stocks" }
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

const STATUS_TFS = [
    { value: "minute", label: "1m" },
    { value: "15minute", label: "15m" },
    { value: "30minute", label: "30m" }
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function getTabItems(watchlist, tabId) {
    const items =
        tabId === "STOCKS"
            ? watchlist.filter(i => !INDEX_NAMES.has(i.name) && !INDEX_SYMBOLS.has(i.tradingsymbol))
            : watchlist.filter(i => i.name === tabId || SYMBOL_TO_TAB[i.tradingsymbol] === tabId);

    return [...items].sort((a, b) => {
        const aD = ["CE", "PE", "FUT"].includes(a.instrumentType);
        const bD = ["CE", "PE", "FUT"].includes(b.instrumentType);
        if (aD !== bD) return aD ? 1 : -1;
        if (a.expiry !== b.expiry) return (a.expiry || "") < (b.expiry || "") ? -1 : 1;
        return (a.strike || 0) - (b.strike || 0);
    });
}

function sigClass(s) {
    return s === "bullish" ? "sig-bull" : s === "bearish" ? "sig-bear" : "";
}

function Dot({ signal }) {
    const bg = signal === "bullish" ? "var(--green)" : signal === "bearish" ? "var(--red)" : "var(--border2)";
    return <span className="sig-dot" style={{ background: bg }} />;
}

// ── Page-level spinner ────────────────────────────────────────────────────────
function PageLoader({ message }) {
    return (
        <div className="mw-page-loader">
            <span className="mw-page-loader-spinner" />
            <span className="mw-page-loader-msg">{message}</span>
        </div>
    );
}

// ── Index price bar ───────────────────────────────────────────────────────────
function IndexPriceBar() {
    const ticks = useAppStore(s => s.ticks);
    const watchlist = useAppStore(s => s.watchlist);

    return (
        <div className="mw-price-bar">
            {Object.entries(TAB_INDEX).map(([tabId, info]) => {
                const inst = watchlist.find(i => i.tradingsymbol === info.match);
                const tick = inst ? ticks[inst.instrumentToken] : null;
                const change = tick?.change ?? null;
                const chgCls = change > 0 ? "sig-bull" : change < 0 ? "sig-bear" : "td-muted";

                return (
                    <div key={tabId} className="mw-price-card">
                        <span className="mw-price-label">{info.label}</span>
                        <span className="mw-price-ltp">{tick ? fmt(tick.lastPrice) : "—"}</span>
                        <span className={`mw-price-change ${chgCls}`}>
                            {change != null ? `${change > 0 ? "+" : ""}${Number(change).toFixed(2)}%` : ""}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

// ── Ichimoku signal summary bar ───────────────────────────────────────────────
function IndexStatusBar({ tabId, watchlist }) {
    const info = TAB_INDEX[tabId];
    const ichiSignals = useAppStore(s => s.ichiSignals);
    const setIchiSignal = useAppStore(s => s.setIchiSignal);
    const [token, setToken] = useState(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!info) { setToken(null); return; }

        // If already in watchlist, use it immediately
        const found = watchlist.find(i => i.tradingsymbol === info.match);
        if (found) { setToken(found.instrumentToken); return; }

        // Otherwise search — retry every 5 s until cache is ready
        let cancelled = false;
        let retryTimer = null;

        async function trySearch() {
            if (cancelled) return;
            try {
                const r = await api.get("/instruments/search", {
                    params: { q: info.q, exchange: info.exchange }
                });
                const inst = r.data.find(i => i.tradingsymbol === info.match);
                if (inst) {
                    if (!cancelled) setToken(inst.instrumentToken);
                } else {
                    retryTimer = setTimeout(trySearch, 5000);
                }
            } catch {
                // 503 — cache not ready yet, retry
                retryTimer = setTimeout(trySearch, 5000);
            }
        }
        trySearch();
        return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
    }, [tabId, watchlist, info]);

    // Fetch only the timeframes not yet in the store; results written to store.
    useEffect(() => {
        if (!token) return;
        const stored = useAppStore.getState().ichiSignals;
        const missing = STATUS_TFS.filter(tf => !stored[`${token}:${tf.value}`]);
        if (!missing.length) return;

        let cancelled = false;
        setLoading(true);
        Promise.all(
            missing.map(tf =>
                api
                    .get(`/ichimoku/${token}`, { params: { interval: tf.value, bars: 100 } })
                    .then(r => ({ tf, data: r.data }))
                    .catch(() => null)
            )
        )
            .then(results => {
                if (cancelled) return;
                results.forEach(res => {
                    if (res?.data) setIchiSignal({ token, interval: res.tf.value, ...res.data });
                });
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [token, setIchiSignal]);

    // Derive display statuses directly from the store — no local statuses state needed
    const statuses = token
        ? (() => {
              const out = {};
              for (const tf of STATUS_TFS) {
                  const d = ichiSignals[`${token}:${tf.value}`];
                  if (!d) {
                      out[tf.value] = null;
                      continue;
                  }
                  const sigs = [d.chikouSignal, d.kijunSignal, d.cloudSignal, d.tenkanSignal];
                  out[tf.value] = {
                      bull: sigs.filter(s => s === "bullish").length,
                      bear: sigs.filter(s => s === "bearish").length,
                      signals: sigs
                  };
              }
              return out;
          })()
        : null;

    if (!info) return null;

    const totalBull = statuses ? STATUS_TFS.reduce((n, tf) => n + (statuses[tf.value]?.bull ?? 0), 0) : null;
    const totalBear = statuses ? STATUS_TFS.reduce((n, tf) => n + (statuses[tf.value]?.bear ?? 0), 0) : null;
    const bias =
        totalBull != null ? (totalBull > totalBear ? "bullish" : totalBull < totalBear ? "bearish" : "neutral") : null;

    return (
        <div className="mw-status-bar">
            <span className="mw-status-bar-label">{info.match}</span>
            {loading && !statuses && <span className="mw-status-bar-loading">loading…</span>}

            {statuses &&
                STATUS_TFS.map(tf => {
                    const s = statuses[tf.value];
                    return (
                        <div key={tf.value} className="mw-status-tf">
                            <span className="mw-status-tf-label">{tf.label}</span>
                            <span className="mw-status-dots">
                                {s ? (
                                    s.signals.map((sig, i) => <Dot key={i} signal={sig} />)
                                ) : (
                                    <span className="td-muted" style={{ fontSize: 11 }}>
                                        —
                                    </span>
                                )}
                            </span>
                            {s && (
                                <span className="mw-status-tf-count">
                                    <span className="sig-bull">{s.bull}↑</span>
                                    <span className="sig-bear">{s.bear}↓</span>
                                </span>
                            )}
                        </div>
                    );
                })}

            {totalBull != null && (
                <div className="mw-status-overall">
                    <span className="sig-bull">{totalBull}↑</span>
                    <span className="sig-bear">{totalBear}↓</span>
                    <span className={`mw-status-overall-label ${sigClass(bias)}`}>
                        {bias === "bullish" ? "Bullish" : bias === "bearish" ? "Bearish" : "Neutral"}
                    </span>
                </div>
            )}
        </div>
    );
}

// ── Index tab — multi-timeframe Ichimoku signal table ────────────────────────

function IndexSignalCell({ token, interval }) {
    const ichi = useAppStore(s => s.ichiSignals[`${token}:${interval}`]);
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

    if (!token || loading) return <td className="idx-sig-cell idx-sig-cell--loading">·</td>;
    if (!ichi) return <td className="idx-sig-cell">—</td>;

    if (ichi.putBuySignal)
        return (
            <td
                className="idx-sig-cell idx-sig-cell--put"
                title="Chikou&gt;Kijun · Kijun flat · Price crossed below Chikou"
            >
                PUT BUY
            </td>
        );
    if (ichi.callBuySignal)
        return (
            <td
                className="idx-sig-cell idx-sig-cell--call"
                title="Chikou&lt;Kijun · Kijun flat · Price crossed above Chikou"
            >
                CALL BUY
            </td>
        );

    // Fallback: show compact condition count e.g. "3↑ 1↓"
    const factors = [ichi.chikouSignal, ichi.kijunSignal, ichi.cloudSignal, ichi.tenkanSignal];
    const up   = factors.filter(s => s === 'bullish').length;
    const down = factors.filter(s => s === 'bearish').length;
    const title = [
        `Chikou: ${ichi.chikouSignal}`,
        `Kijun: ${ichi.kijunSignal}`,
        `Cloud: ${ichi.cloudSignal}`,
        `Tenkan: ${ichi.tenkanSignal}`,
    ].join(' · ');
    return (
        <td className="idx-sig-cell idx-sig-cell--cond" title={title}>
            <span className="idx-cond-up">{up}↑</span>
            {' '}
            <span className="idx-cond-down">{down}↓</span>
        </td>
    );
}

// ── Index tab test panel ──────────────────────────────────────────────────────

function IndexTab({ watchlist }) {
    const ticks = useAppStore(s => s.ticks);

    const rows = Object.entries(TAB_INDEX).map(([key, info]) => {
        const inst = watchlist.find(i => i.tradingsymbol === info.match);
        const tick = inst ? ticks[inst.instrumentToken] : null;
        const chg = tick?.change ?? null;
        const chgCls = chg > 0 ? "mw-up" : chg < 0 ? "mw-down" : "";
        return { key, info, token: inst?.instrumentToken ?? null, tick, chg, chgCls };
    });

    return (
        <>
            <div className="idx-table-wrap">
                <table className="idx-table">
                    <thead>
                        <tr>
                            <th className="idx-th-name">Index</th>
                            <th className="idx-th-ltp">LTP</th>
                            <th className="idx-th-chg">Chg%</th>
                            {INDEX_TFS.map(tf => (
                                <th key={tf.value} className="idx-th-tf">
                                    {tf.label}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(({ key, info, token, tick, chg, chgCls }) => (
                            <tr key={key}>
                                <td className="idx-td-name">{info.label}</td>
                                <td className="idx-td-ltp td-mono">{tick ? fmt(tick.lastPrice) : "—"}</td>
                                <td className={`idx-td-chg td-mono ${chgCls}`}>
                                    {chg != null ? `${chg > 0 ? "+" : ""}${Number(chg).toFixed(2)}%` : "—"}
                                </td>
                                {INDEX_TFS.map(tf => (
                                    <IndexSignalCell key={tf.value} token={token} interval={tf.value} />
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </>
    );
}

// ── Stock futures panel ───────────────────────────────────────────────────────
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
    const [maxPct, setMaxPct] = useState("8");
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
                <button
                    className="mw-movers-btn"
                    disabled={moversLoading}
                    onClick={handleSubscribeMovers}
                    title={`Subscribe stocks ${minPct}%${maxPct ? `–${maxPct}%` : "+"} up from today's open`}
                >
                    {moversLoading ? "…" : "↑ Subscribe Movers"}
                </button>
            </div>
        </div>
    );
}

// ── Inline symbol search (table footer row) ───────────────────────────────────
function InlineSearch({ onAdd, colSpan }) {
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
        <tfoot>
            <tr>
                <td colSpan={colSpan} style={{ padding: "6px 8px" }}>
                    <div className="mw-inline-search" ref={wrapRef}>
                        {/* <div className="mw-inline-search-row">
              <svg className="mw-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                className="mw-inline-search-input"
                type="text"
                placeholder="Add symbol…"
                value={query}
                onChange={handleChange}
                onFocus={() => results.length > 0 && setDropdownOpen(true)}
              />
              {searching && <span className="mw-search-spinner" />}
              <select
                className="mw-inline-exchange-select"
                value={exchange}
                onChange={(e) => { setExchange(e.target.value); doSearch(query, e.target.value); }}
              >
                <option value="">All</option>
                <option value="NSE">NSE</option>
                <option value="NFO">NFO</option>
                <option value="BSE">BSE</option>
                <option value="BFO">BFO</option>
                <option value="MCX">MCX</option>
              </select>
            </div> */}
                        {dropdownOpen && results.length > 0 && (
                            <div className="mw-dropdown mw-dropdown--up">
                                {results.map(r => (
                                    <div
                                        key={r.instrumentToken}
                                        className="mw-dropdown-item"
                                        onMouseDown={() => handleSelect(r)}
                                    >
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
                </td>
            </tr>
        </tfoot>
    );
}

// ── Signal cell ───────────────────────────────────────────────────────────────
// ── Watch row ─────────────────────────────────────────────────────────────────
// mode='signal' → NIFTY/BANKNIFTY/SENSEX option tabs: Symbol | LTP | Chg% | Signal badge | Remove
// mode='full'   → Stocks tab: Symbol | LTP | Chg% | 1m | 5m | 15m | Remove
function WatchRow({ item, interval, onRemove, mode = "full" }) {
    const tick = useAppStore(s => s.ticks[item.instrumentToken]);
    const ichi = useAppStore(s => s.ichiSignals[`${item.instrumentToken}:${interval}`]);
    const setIchiSignal = useAppStore(s => s.setIchiSignal);
    const prevRef = useRef(null);
    const priceRef = useRef(null);
    const [loading, setLoading] = useState(false);

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

    useEffect(() => {
        if (useAppStore.getState().ichiSignals[`${item.instrumentToken}:${interval}`]) return;
        let cancelled = false;
        setLoading(true);
        api.get(`/ichimoku/${item.instrumentToken}`, { params: { interval, bars: 100 } })
            .then(r => {
                if (!cancelled) setIchiSignal({ token: item.instrumentToken, interval, ...r.data });
            })
            .catch(() => {})
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [item.instrumentToken, interval, setIchiSignal]);

    const change = tick?.change ?? null;
    const changeClass = change > 0 ? "mw-up" : change < 0 ? "mw-down" : "";
    const optMatch = item.tradingsymbol.match(/^([A-Z&-]+)[A-Z0-9]{5}(\d+)(CE|PE)$/);
    const displayName = optMatch ? `${optMatch[1]} ${optMatch[2]}${optMatch[3]}` : item.tradingsymbol;
    const expiryBadge = item.expiry
        ? new Date(item.expiry + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
        : "";

    // ── signal mode (index option tabs) ──────────────────────────────────────
    if (mode === "signal") {
        const rowCls = ichi?.putBuySignal ? "row-put" : ichi?.callBuySignal ? "row-call" : "";
        return (
            <tr className={rowCls}>
                <td>
                    <div className="mw-sym-name">{displayName}</div>
                    <div className="mw-sym-meta" style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <span>{item.exchange}</span>
                        {expiryBadge && <span className="mw-expiry-badge">{expiryBadge}</span>}
                        {item.lotSize > 1 && <span>· Lot {item.lotSize}</span>}
                    </div>
                </td>
                <td className="td-mono td-right">
                    <span ref={priceRef} className="mw-ltp-val">
                        {tick ? fmt(tick.lastPrice) : "—"}
                    </span>
                </td>
                <td className={`td-right td-mono ${changeClass}`} style={{ fontSize: 12 }}>
                    {change != null ? `${change > 0 ? "+" : ""}${Number(change).toFixed(2)}%` : "—"}
                </td>
                <td className="td-center">
                    {loading ? (
                        <span className="mw-sig-loading">·</span>
                    ) : ichi?.putBuySignal ? (
                        <span className="mw-sig-badge mw-sig-badge--put">PUT BUY</span>
                    ) : ichi?.callBuySignal ? (
                        <span className="mw-sig-badge mw-sig-badge--call">CALL BUY</span>
                    ) : ichi ? (() => {
                        const factors = [ichi.chikouSignal, ichi.kijunSignal, ichi.cloudSignal, ichi.tenkanSignal];
                        const up   = factors.filter(s => s === 'bullish').length;
                        const down = factors.filter(s => s === 'bearish').length;
                        const title = `Chikou: ${ichi.chikouSignal} · Kijun: ${ichi.kijunSignal} · Cloud: ${ichi.cloudSignal} · Tenkan: ${ichi.tenkanSignal}`;
                        return (
                            <span className="mw-sig-cond" title={title}>
                                <span className="idx-cond-up">{up}↑</span>
                                {' '}
                                <span className="idx-cond-down">{down}↓</span>
                            </span>
                        );
                    })() : (
                        <span className="mw-sig-badge mw-sig-badge--none">—</span>
                    )}
                </td>
                <td className="td-center">
                    <button className="mw-remove-btn" onClick={() => onRemove(item.instrumentToken)} title="Remove">
                        ×
                    </button>
                </td>
            </tr>
        );
    }

    // ── stock mode (stocks tab) — Symbol | LTP | Chg% | 1m | 5m | 15m | Remove ─
    return (
        <tr>
            <td>
                <div className="mw-sym-name">{displayName}</div>
                <div className="mw-sym-meta" style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span>{item.exchange}</span>
                    {expiryBadge && <span className="mw-expiry-badge">{expiryBadge}</span>}
                    {item.lotSize > 1 && <span>· Lot {item.lotSize}</span>}
                </div>
            </td>
            <td className="td-mono td-right">
                <span ref={priceRef} className="mw-ltp-val">
                    {tick ? fmt(tick.lastPrice) : "—"}
                </span>
            </td>
            <td className={`td-right td-mono ${changeClass}`} style={{ fontSize: 12 }}>
                {change != null ? `${change > 0 ? "+" : ""}${Number(change).toFixed(2)}%` : "—"}
            </td>
            {STOCK_TFS.map(tf => (
                <IndexSignalCell key={tf.value} token={item.instrumentToken} interval={tf.value} />
            ))}
            <td className="td-center">
                <button className="mw-remove-btn" onClick={() => onRemove(item.instrumentToken)} title="Remove">
                    ×
                </button>
            </td>
        </tr>
    );
}

// Returns the smallest INDEX_TFS timeframe that currently has a PUT or CALL buy signal
// for the given index tab (reads directly from Zustand store — no React state needed)
function getActiveIndexTF(tabId) {
    const info = TAB_INDEX[tabId];
    if (!info) return "15minute";
    const { watchlist, ichiSignals } = useAppStore.getState();
    const inst = watchlist.find(i => i.tradingsymbol === info.match);
    if (!inst) return "15minute";
    const token = inst.instrumentToken;
    for (const tf of INDEX_TFS) {
        const sig = ichiSignals[`${token}:${tf.value}`];
        if (sig?.putBuySignal || sig?.callBuySignal) return tf.value;
    }
    return "15minute";
}

// Module-level state — survives component unmount/remount (tab switches)
let _initDone = false;
const _subscribedTabs = new Set();

// ── Main ──────────────────────────────────────────────────────────────────────
export default function MarketWatch() {
    const watchlist = useAppStore(s => s.watchlist);
    const setWatchlist = useAppStore(s => s.setWatchlist);
    const addToWatchlist = useAppStore(s => s.addToWatchlist);
    const removeFromWatchlist = useAppStore(s => s.removeFromWatchlist);
    const tickerConnected = useAppStore(s => s.tickerConnected);

    const [activeTab, setActiveTab] = useState("INDEX");
    const [interval, setInterval] = useState("15minute");
    const [status, setStatus] = useState(null);
    const [futLoading, setFutLoading] = useState(new Set());
    const [pageLoading, setPageLoading] = useState(true);
    const [pageLoadMsg, setPageLoadMsg] = useState("Initialising…");
    const [tabLoading, setTabLoading] = useState(false);
    const [stockFilter, setStockFilter] = useState("");

    // Module-level set used directly — no ref needed

    // On mount: load watchlist + subscribe all 3 index underlyings in parallel.
    // Retries every 5 s if the instrument cache isn't ready yet (503) so the
    // page self-heals after the owner authenticates without requiring a reload.
    useEffect(() => {
        let retryTimer = null;

        async function init() {
            if (_initDone) { setPageLoading(false); return; }
            setPageLoading(true);
            setPageLoadMsg("Loading indices…");
            try {
                const [wl] = await Promise.all([
                    api.get("/instruments/watchlist"),
                    api.get("/instruments/status").then(r => setStatus(r.data)).catch(() => {})
                ]);
                setWatchlist(wl.data);

                // Subscribe all 3 underlyings — if cache not ready yet, throws 503
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
                    // Cache not ready — reset flag and retry in 5 s
                    setPageLoadMsg("Waiting for instrument cache…");
                    retryTimer = setTimeout(() => { init(); }, 5000);
                    return;
                }

                _initDone = true;
            } catch {
                // Network error — retry
                retryTimer = setTimeout(() => { init(); }, 5000);
                return;
            } finally {
                setPageLoading(false);
            }
        }
        init();
        return () => { if (retryTimer) clearTimeout(retryTimer); };
    }, [setWatchlist]);

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

    // Hard reset — clears all module-level flags, empties the store, reloads page
    function handleHardReset() {
        _initDone = false;
        _subscribedTabs.clear();
        useAppStore.getState().setIchiSignal && useAppStore.setState({ ichiSignals: {} });
        window.location.reload();
    }

    // Tab click: switch tab, reset stock filter, subscribe ATM only if not already done
    async function handleTabClick(tabId) {
        setActiveTab(tabId);
        if (tabId !== "STOCKS") setStockFilter("");

        // Auto-select the interval that the index is signalling on
        if (TAB_INDEX[tabId]) setInterval(getActiveIndexTF(tabId));

        if (ATM_OFFSETS[tabId] && !_subscribedTabs.has(tabId)) {
            setTabLoading(true);
            try {
                const r = await api.post("/instruments/subscribe-atm", { index: tabId, offsets: ATM_OFFSETS[tabId] });
                setWatchlist(r.data.watchlist);
                _subscribedTabs.add(tabId);
            } catch {
            } finally {
                setTabLoading(false);
            }
        }
    }

    const allTabItems = activeTab === "INDEX" ? [] : getTabItems(watchlist, activeTab);
    const tabItems =
        activeTab === "STOCKS" && stockFilter
            ? allTabItems.filter(i => i.name.includes(stockFilter) || i.tradingsymbol.includes(stockFilter))
            : allTabItems;
    const tabCounts = Object.fromEntries(
        TABS.filter(t => t.id !== "INDEX").map(t => [t.id, getTabItems(watchlist, t.id).length])
    );

    // Page-level init loader
    if (pageLoading) {
        return (
            <div className="page">
                <IndexPriceBar />
                <PageLoader message={pageLoadMsg} />
            </div>
        );
    }

    return (
        <div className="page">
            {/* Top index price bar */}
            <IndexPriceBar />

            {/* Page header */}
            <div className="page-header" style={{ marginBottom: 16 }}>
                <div>
                    <h2 className="page-title">Market Watch</h2>
                    <p className="page-sub">Live prices via Kite WebSocket</p>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    {tickerConnected ? (
                        <span className="mw-ticker-badge mw-ticker-badge--on">
                            <span className="conn-dot" />
                            Live
                        </span>
                    ) : (
                        <span className="mw-ticker-badge mw-ticker-badge--idle">Offline</span>
                    )}
                    {status?.instrumentCount > 0 && (
                        <span className="page-sub">
                            {Number(status.instrumentCount).toLocaleString("en-IN")} instruments
                            {status.subscribedCount > 0 ? ` · ${status.subscribedCount} subscribed` : ""}
                        </span>
                    )}
                    <button
                        className="mw-reset-btn"
                        onClick={handleHardReset}
                        title="Hard reset — clears all state and reloads"
                    >
                        ↺ Reset
                    </button>
                </div>
            </div>

            {/* Tabs + interval */}
            <div className="mw-tab-bar">
                <div className="mw-tabs">
                    {TABS.map(t => (
                        <button
                            key={t.id}
                            className={`mw-tab ${activeTab === t.id ? "mw-tab--active" : ""}`}
                            onClick={() => handleTabClick(t.id)}
                            disabled={tabLoading}
                        >
                            {t.label}
                            {tabCounts[t.id] > 0 && <span className="mw-tab-count">{tabCounts[t.id]}</span>}
                            {tabLoading && activeTab === t.id && <span className="mw-tab-spinner" />}
                        </button>
                    ))}
                </div>
                {activeTab !== "INDEX" && activeTab !== "STOCKS" && (
                    <div className="mw-interval-pills">
                        {INTERVALS.map(i => (
                            <button
                                key={i.value}
                                className={`mw-interval-pill ${interval === i.value ? "mw-interval-pill--active" : ""}`}
                                onClick={() => setInterval(i.value)}
                            >
                                {i.label}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* INDEX tab — multi-timeframe signal table */}
            {activeTab === "INDEX" && <IndexTab watchlist={watchlist} />}

            {/* Ichimoku status bar — NIFTY/BANKNIFTY/SENSEX option tabs only */}
            {TAB_INDEX[activeTab] && <IndexStatusBar tabId={activeTab} watchlist={watchlist} />}

            {/* Full futures list — Stocks tab only */}
            {activeTab === "STOCKS" && (
                <StockFuturesPanel
                    watchlist={watchlist}
                    futLoading={futLoading}
                    onSubscribe={subscribeStockFuture}
                    bulkLoading={false}
                    filter={stockFilter}
                    onFilterChange={setStockFilter}
                    onSubscribeMovers={subscribeMovers}
                    onClearAll={unsubscribeAllFutures}
                />
            )}

            {/* Table — not shown for INDEX tab */}
            {activeTab !== "INDEX" &&
                (() => {
                    const isIndexTab = !!TAB_INDEX[activeTab];
                    const isStocksTab = activeTab === "STOCKS";
                    const colSpan = isIndexTab ? 5 : isStocksTab ? 7 : 8;
                    const rowMode = isIndexTab ? "signal" : "full";
                    return (
                        <div className="kite-table-wrap">
                            <table className="kite-table">
                                <thead>
                                    <tr>
                                        <th style={{ width: "28%" }}>Symbol</th>
                                        <th className="th-right" style={{ width: "13%" }}>
                                            LTP
                                        </th>
                                        <th className="th-right" style={{ width: "9%" }}>
                                            Chg%
                                        </th>
                                        {isIndexTab ? (
                                            <th className="td-center" style={{ width: "22%" }}>
                                                Signal
                                            </th>
                                        ) : isStocksTab ? (
                                            STOCK_TFS.map(tf => (
                                                <th key={tf.value} className="td-center" style={{ width: "13%" }}>
                                                    {tf.label}
                                                </th>
                                            ))
                                        ) : (
                                            <>
                                                <th className="th-right" style={{ width: "8%" }}>
                                                    Chikou
                                                </th>
                                                <th className="th-right" style={{ width: "11%" }}>
                                                    Kijun
                                                </th>
                                                <th className="th-right" style={{ width: "7%" }}>
                                                    Cloud
                                                </th>
                                                <th className="th-right" style={{ width: "11%" }}>
                                                    Tenkan
                                                </th>
                                            </>
                                        )}
                                        <th style={{ width: "5%" }}></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {tabItems.length === 0 ? (
                                        <tr>
                                            <td
                                                colSpan={colSpan}
                                                style={{
                                                    textAlign: "center",
                                                    padding: "20px",
                                                    color: "var(--txt3)",
                                                    fontSize: 13
                                                }}
                                            >
                                                No instruments — use the search below to add
                                            </td>
                                        </tr>
                                    ) : (
                                        tabItems.map(item => (
                                            <WatchRow
                                                key={item.instrumentToken}
                                                item={item}
                                                interval={interval}
                                                onRemove={handleRemove}
                                                mode={rowMode}
                                            />
                                        ))
                                    )}
                                </tbody>
                                <InlineSearch onAdd={handleAdd} colSpan={colSpan} />
                            </table>
                        </div>
                    );
                })()}
        </div>
    );
}
