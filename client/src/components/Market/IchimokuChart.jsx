/**
 * IchimokuChart
 *
 * Renders the full Ichimoku Kumo Breakout chart using lightweight-charts v5:
 *   • Candlestick series  (green up / red down)
 *   • Kumo cloud          (4-series erase technique — green band when A≥B, red when B>A)
 *   • Kijun-sen           (blue, lineWidth 2)
 *   • Tenkan-sen          (orange, lineWidth 1)
 *   • Chikou span         (lime, dashed)
 *   • TF selector         (15m / 1h / 4h / 1d)
 *   • Auto-resize via ResizeObserver
 */

import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react"; // useState kept for loading/error
import { createChart, CandlestickSeries, LineSeries, AreaSeries } from "lightweight-charts";
import api from "../../api";
import useAppStore from "../../store/appStore";

// ── Constants ─────────────────────────────────────────────────────────────────

const TF_BARS = {
    "15minute": 200,
    "60minute": 200,
    "4h": 200,
    day: 300
};

// Seconds per interval — used to detect new candle boundaries on live ticks.
// null = skip new-bar creation for that interval (day / 4h: non-uniform trading
// sessions make client-side slot alignment unreliable; re-fetch handles them).
const TICK_INTERVAL_SECS = {
    "minute":   60,
    "5minute":  5  * 60,
    "15minute": 15 * 60,
    "30minute": 30 * 60,
    "60minute": 60 * 60,
    "4h":       null,
    "day":      null,
};

// Dashed line style constant (lightweight-charts LineStyle.Dashed = 2)
const LINE_DASHED = 2;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Read a CSS variable from :root, with a fallback for when theme hasn't loaded */
function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

// ── IchimokuChart ─────────────────────────────────────────────────────────────

function IchimokuChartImpl({ token, interval = "15minute", defaultBars = null, label = null }, forwardedRef) {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const containerRef = useRef(null);
    const chartRef = useRef(null);
    // Holds references to each lightweight-charts series
    const seriesRef = useRef({});
    // Tracks the current open candle so live ticks can update it in-place
    const liveRef = useRef(null);
    // Mirrors the interval prop as a ref so the tick effect never closes over a
    // stale value when the user switches TF (interval is not in [tick] deps).
    const intervalRef = useRef(interval);
    intervalRef.current = interval; // updated on every render, no useEffect needed

    // Subscribe to live tick for this token from the global store
    const tick = useAppStore((s) => (token ? s.ticks[token] : null));

    // ── Create chart once on mount ───────────────────────────────────────────
    useEffect(() => {
        if (!containerRef.current) return;

        // ── Build chart with initial theme colours ────────────────────────────
        const bg = cssVar("--bg", "#06091a");
        const txt = cssVar("--txt", "#dde3f0");
        const grid = cssVar("--border", "#1e2340");

        // ── IST-aware time formatting ────────────────────────────────────────
        // Kite returns timestamps in Unix seconds (UTC). For an Indian-market
        // chart we want labels in IST (UTC+05:30), not the user's local zone.
        const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
        const _toIST = (unixSec) => new Date(unixSec * 1000 + IST_OFFSET_MS);
        const _pad   = (n) => String(n).padStart(2, '0');

        const tickMarkFormatter = (time, tickMarkType /* , locale */) => {
            const d = _toIST(time);
            // tickMarkType: 0=Year, 1=Month, 2=DayOfMonth, 3=Time, 4=TimeWithSeconds
            if (tickMarkType === 0) return String(d.getUTCFullYear());
            if (tickMarkType === 1) return d.toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' });
            if (tickMarkType === 2) return `${_pad(d.getUTCDate())} ${d.toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' })}`;
            return `${_pad(d.getUTCHours())}:${_pad(d.getUTCMinutes())}`;
        };

        // Crosshair tooltip / status line time format (full IST timestamp)
        const timeFormatter = (time) => {
            const d = _toIST(time);
            return `${_pad(d.getUTCDate())} ${d.toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' })} ${_pad(d.getUTCHours())}:${_pad(d.getUTCMinutes())} IST`;
        };

        const chart = createChart(containerRef.current, {
            layout: {
                background: { color: bg },
                textColor: txt,
                fontSize: 11,
                attributionLogo: false,   // hide TradingView branding
            },
            grid: {
                vertLines: { color: grid },
                horzLines: { color: grid }
            },
            crosshair: { mode: 1 },
            rightPriceScale: { borderColor: grid },
            leftPriceScale:  { visible: false },
            timeScale: {
                borderColor: grid,
                timeVisible: true,
                secondsVisible: false,
                rightOffset: 5,
                // Indian-session-aware label formatting (projection bars already
                // skip non-trading periods on the server, so labels always land
                // on a valid 9:15-15:30 IST slot).
                tickMarkFormatter,
                // Compact bar spacing — keeps consecutive trading-day bars
                // visually adjacent rather than spaced by overnight-hour gaps.
                barSpacing: 6,
            },
            localization: {
                timeFormatter,
            },
            width:  containerRef.current.clientWidth,
            height: 420,
        });

        chartRef.current = chart;

        // ── Cloud series (4 layers — upper fill + lower erase, for each colour) ──
        //
        // Technique: for a bullish cloud segment (SenkouA ≥ SenkouB)
        //   Layer 1 — bullUpper: fills from max(A,B) down with green gradient
        //   Layer 2 — bullLower: fills from min(A,B) down with solid bg (erases green below the cloud)
        //   Net result: only the band between upper and lower is green
        // Same idea for bearish (red). Series are rendered in creation order (later = on top).

        const sharedCloudOpts = {
            lineWidth: 0,
            lineColor: "transparent",
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false
        };

        // Bullish upper (green gradient fill — drawn first, below)
        const bullUpper = chart.addSeries(AreaSeries, {
            ...sharedCloudOpts,
            topColor: "rgba(89, 160, 92, 0.30)",
            bottomColor: "rgba(89, 160, 92, 0.05)"
        });

        // Bullish lower (solid bg erase — drawn second, covers area below cloud)
        const bullLower = chart.addSeries(AreaSeries, {
            ...sharedCloudOpts,
            topColor: bg,
            bottomColor: bg
        });

        // Bearish upper (red gradient fill)
        const bearUpper = chart.addSeries(AreaSeries, {
            ...sharedCloudOpts,
            topColor: "rgba(215, 90, 74, 0.30)",
            bottomColor: "rgba(215, 90, 74, 0.05)"
        });

        // Bearish lower (solid bg erase)
        const bearLower = chart.addSeries(AreaSeries, {
            ...sharedCloudOpts,
            topColor: bg,
            bottomColor: bg
        });

        // ── Indicator lines (rendered above the cloud) ────────────────────────

        // Tenkan (green) and Kijun (red) — these are the two key reference
        // levels traders watch most, so they get last-value labels on the
        // right price scale. Chikou stays unlabelled to keep the axis clean.
        const kijun = chart.addSeries(LineSeries, {
            color: "#ef4444", // red
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: true,
            crosshairMarkerVisible: false
        });

        const tenkan = chart.addSeries(LineSeries, {
            color: "#22c55e", // green
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: true,
            crosshairMarkerVisible: false
        });

        const chikou = chart.addSeries(LineSeries, {
            color: "#387ed1", // blue, dashed
            lineWidth: 1,
            lineStyle: LINE_DASHED,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false
        });

        // ── Candlestick series (topmost layer) ────────────────────────────────
        const candles = chart.addSeries(CandlestickSeries, {
            upColor: "#59a05c",
            downColor: "#d75a4a",
            borderUpColor: "#59a05c",
            borderDownColor: "#d75a4a",
            wickUpColor: "#59a05c",
            wickDownColor: "#d75a4a"
        });

        seriesRef.current = {
            candles,
            bullUpper,
            bullLower,
            bearUpper,
            bearLower,
            kijun,
            tenkan,
            chikou
        };

        // ── Theme sync: re-apply colours whenever data-theme attribute changes ──
        // The cloud "erase" series must exactly match the chart background, so any
        // theme toggle needs to push the new bg colour into both the layout and those series.
        function _applyTheme() {
            const newBg = cssVar("--bg", "#06091a");
            const newTxt = cssVar("--txt", "#dde3f0");
            const newGrid = cssVar("--border", "#1e2340");

            chart.applyOptions({
                layout: {
                    background: { color: newBg },
                    textColor: newTxt
                },
                grid: {
                    vertLines: { color: newGrid },
                    horzLines: { color: newGrid }
                },
                rightPriceScale: { borderColor: newGrid },
                timeScale: { borderColor: newGrid, rightOffset: 5 }
            });

            // Erase layers must be opaque in the exact bg colour
            bullLower.applyOptions({ topColor: newBg, bottomColor: newBg });
            bearLower.applyOptions({ topColor: newBg, bottomColor: newBg });
        }

        const mo = new MutationObserver(_applyTheme);
        mo.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["data-theme"]
        });

        // ── Auto-resize when container width changes ──────────────────────────
        const ro = new ResizeObserver(entries => {
            for (const entry of entries) {
                chart.applyOptions({ width: entry.contentRect.width });
            }
        });
        ro.observe(containerRef.current);

        return () => {
            ro.disconnect();
            mo.disconnect();
            chart.remove();
            chartRef.current = null;
            seriesRef.current = {};
        };
    }, []); // run once — series are updated by data effect below

    // ── Peek-subscribe: ensure this token gets live ticks while the chart is open ──
    // Background scanner and manual screener alerts are NOT in the watchlist,
    // so their tokens have no Kite ticker subscription and ticks[token] stays null.
    // We subscribe on first mount (and on token change) and clean up on unmount
    // so the live-tick update effect below can animate the current candle.
    useEffect(() => {
        if (!token) return;
        api.post('/instruments/peek-subscribe', { tokens: [token] }).catch(() => {});
        return () => {
            api.post('/instruments/peek-unsubscribe', { tokens: [token] }).catch(() => {});
        };
    }, [token]);

    // ── Fetch + populate data whenever token or interval changes ─────────────
    useEffect(() => {
        if (!token) return;

        // Wait until the chart has been created (runs after mount effect)
        if (!seriesRef.current.candles) return;

        // Clear stale data immediately so the old TF chart never lingers
        // while the new one is loading or if it fails
        _clearChart();

        let cancelled = false;
        setLoading(true);
        setError(null);

        const bars = TF_BARS[interval] ?? 200;

        api.get(`/ichimoku/${token}/chart`, {
            params: { interval, bars }
        })
            .then(r => {
                if (cancelled) return;
                _populateChart(r.data.data);
            })
            .catch(err => {
                if (!cancelled) {
                    setError(err.response?.data?.error || "Failed to load chart data");
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [token, interval]);

    // ── Clear all series so stale data is never shown on TF switch / error ──────
    function _clearChart() {
        const s = seriesRef.current;
        if (!s.candles) return;
        s.candles.setData([]);
        s.bullUpper.setData([]);
        s.bullLower.setData([]);
        s.bearUpper.setData([]);
        s.bearLower.setData([]);
        s.kijun.setData([]);
        s.tenkan.setData([]);
        s.chikou.setData([]);
        // Reset live candle tracker so stale ticks don't bleed into the new TF
        liveRef.current = null;
    }

    // ── Populate all series from API response data ────────────────────────────
    function _populateChart(data) {
        const s = seriesRef.current;
        if (!s.candles || !data?.length) return;

        // Pre-allocate arrays — separate per series
        const candleData = [];
        const bullUpperData = [];
        const bullLowerData = [];
        const bearUpperData = [];
        const bearLowerData = [];
        const kijunData = [];
        const tenkanData = [];
        const chikouData = [];

        for (const d of data) {
            const t = d.time; // Unix seconds from server

            // Candlestick — skip projection bars which have null OHLC
            if (d.open !== null && d.close !== null) {
                candleData.push({ time: t, open: d.open, high: d.high, low: d.low, close: d.close });
            }

            // Cloud — only when both Senkou spans are calculated (from bar ≥77 due to 52+26 offset)
            if (d.senkouA !== null && d.senkouB !== null) {
                const upper = Math.max(d.senkouA, d.senkouB);
                const lower = Math.min(d.senkouA, d.senkouB);
                const isBull = d.senkouA >= d.senkouB;

                if (isBull) {
                    bullUpperData.push({ time: t, value: upper });
                    bullLowerData.push({ time: t, value: lower });
                } else {
                    bearUpperData.push({ time: t, value: upper });
                    bearLowerData.push({ time: t, value: lower });
                }
            }

            // Indicator lines — skip nulls so lightweight-charts renders clean gaps
            if (d.kijun !== null) kijunData.push({ time: t, value: d.kijun });
            if (d.tenkan !== null) tenkanData.push({ time: t, value: d.tenkan });
            if (d.chikou !== null) chikouData.push({ time: t, value: d.chikou });
        }

        s.candles.setData(candleData);
        s.bullUpper.setData(bullUpperData);
        s.bullLower.setData(bullLowerData);
        s.bearUpper.setData(bearUpperData);
        s.bearLower.setData(bearLowerData);
        s.kijun.setData(kijunData);
        s.tenkan.setData(tenkanData);
        s.chikou.setData(chikouData);

        // Seed the live-candle tracker with the last real candle so tick updates
        // can call series.update() without re-fetching historical data.
        const lastCandle = candleData[candleData.length - 1];
        liveRef.current = lastCandle ? { ...lastCandle } : null;

        // Set the initial visible range.
        //
        // Default: fitContent() shows the entire dataset zoomed out (~200 bars).
        // When `defaultBars` is set (e.g. 50 for the scanner chart modal):
        //   1. Compute a barSpacing that makes exactly `defaultBars` fit in the
        //      visible area — this is a "sticky" setting that survives
        //      ResizeObserver-triggered layout passes (unlike setVisibleLogicalRange).
        //   2. scrollToRealTime() anchors the view at the latest bar.
        //
        // The user can still pan left to see older bars and scroll-wheel zoom
        // — only the INITIAL view is constrained.
        const totalBars = candleData.length;
        const ts = chartRef.current?.timeScale();
        if (!ts) return;

        if (defaultBars && totalBars > 0) {
            const apply = () => {
                // Container width minus right price-scale (~60px) — width available for bars.
                const containerW = containerRef.current?.clientWidth || 1000;
                const usableW    = Math.max(200, containerW - 70);
                // Pixels per bar to fit exactly `defaultBars` in the visible area.
                // Clamp to [4, 40] so tiny modals don't disappear bars and huge
                // screens don't blow them up.
                const spacing = Math.max(4, Math.min(40, Math.floor(usableW / defaultBars)));

                chartRef.current?.applyOptions({
                    timeScale: { barSpacing: spacing, rightOffset: 5 },
                });
                ts.scrollToRealTime();
            };
            // Defer to the next frame so setData layout has settled and the
            // container has its final width (modal slide-in animation).
            requestAnimationFrame(apply);
        } else {
            ts.fitContent();
        }
    }

    // ── Live tick updates ─────────────────────────────────────────────────────
    // On every price tick:
    //   • Same candle period  → update close / high / low in-place
    //   • New candle period   → open a fresh bar at the correct boundary time
    //
    // Slot detection uses tick.lastTradeTime — the timestamp of the actual trade
    // that triggered this tick — with the same formula the server's candleStore
    // uses:  floor(tradeMs / intervalMs) * intervalMs
    //
    // This is inherently market-hours-aware:
    //   • NSE/BSE (9:15–15:30 IST) and MCX (9:00–23:30 IST) both work because
    //     lastTradeTime is only sent during live market sessions.
    //   • Using Date.now() would produce phantom candles during closed hours
    //     (overnight, weekends) as wall-clock time advances without trades.
    //
    // 4h / day: null → always patch the last bar; non-uniform sessions and
    //   synthesised 4h candles make client-side slot math unreliable.
    useEffect(() => {
        const price = tick?.lastPrice;
        if (!price || !seriesRef.current.candles || !liveRef.current) return;

        const iSecs = TICK_INTERVAL_SECS[intervalRef.current];
        const live  = liveRef.current;
        let updated;

        if (iSecs !== null && tick.lastTradeTime) {
            // Convert lastTradeTime to ms regardless of whether it arrives as an
            // ISO string (Date serialised by JSON.stringify) or a raw Unix number.
            // Values < 2e10 are treated as Unix seconds (Kite sends seconds);
            // larger values or strings go through new Date() for ISO handling.
            const ltt      = tick.lastTradeTime;
            const tradeMs  = (typeof ltt === 'number' && ltt < 2e10)
                ? ltt * 1000
                : new Date(ltt).getTime();

            // Mirror candleStore._slotStart: floor to the nearest interval boundary
            const currentSlot = Math.floor(tradeMs / (iSecs * 1000)) * iSecs;

            if (currentSlot > live.time) {
                // New candle — open a fresh bar aligned to the trade-time boundary
                updated = {
                    time:  currentSlot,
                    open:  price,
                    high:  price,
                    low:   price,
                    close: price,
                };
            } else {
                // Same candle — update OHLC in-place
                updated = {
                    time:  live.time,
                    open:  live.open,
                    high:  Math.max(live.high, price),
                    low:   Math.min(live.low,  price),
                    close: price,
                };
            }
        } else {
            // 4h / day, or lastTradeTime unavailable → patch last bar only
            updated = {
                time:  live.time,
                open:  live.open,
                high:  Math.max(live.high, price),
                low:   Math.min(live.low,  price),
                close: price,
            };
        }

        // Persist so the next tick always has the latest OHLC to diff against
        liveRef.current = updated;
        seriesRef.current.candles.update(updated);
    }, [tick]);

    // ── Trade overlay lines: entry / SL / target for every OPEN trade on this token ─
    //
    // Draws horizontal price lines on the candle series so traders can see where
    // their entry, stop-loss and target sit on the chart.  Re-runs whenever:
    //   • token / interval change                    (clear stale lines)
    //   • paperTrades change                         (new trade opened or closed)
    //   • a trade's SL moves (TSL trail)             (update the SL line)
    //
    // Lines are removed and recreated on every render — lightweight-charts
    // doesn't expose a setPrice() so this is the simplest, leak-free pattern.
    const paperTrades = useAppStore((s) => s.paperTrades);
    const priceLineHandlesRef = useRef([]);

    useEffect(() => {
        const series = seriesRef.current.candles;
        if (!series) return;

        // 1. Remove any lines drawn on a previous render
        for (const handle of priceLineHandlesRef.current) {
            try { series.removePriceLine(handle); } catch { /* line already gone */ }
        }
        priceLineHandlesRef.current = [];

        if (!token) return;

        // 2. Find OPEN trades belonging to the displayed token
        const myTrades = paperTrades.filter(
            (t) =>
                t.status === 'OPEN' &&
                Number(t.token) === Number(token) &&
                (t.source === 'scan' || t.source === 'auto'),
        );
        if (myTrades.length === 0) return;

        // 3. Draw entry / SL / target for each trade
        const ENTRY_COLOR  = '#3b82f6'; // blue
        const SL_COLOR     = '#f87171'; // red
        const TARGET_COLOR = '#4ade80'; // green
        const TSL_COLOR    = '#a78bfa'; // purple — distinguishes trailed stop from initial

        for (const t of myTrades) {
            const prefix = t.source === 'auto' ? '🤖' : '✦';
            if (t.entryPrice != null) {
                const h = series.createPriceLine({
                    price:     t.entryPrice,
                    color:     ENTRY_COLOR,
                    lineWidth: 1,
                    lineStyle: 2, // dashed
                    axisLabelVisible: true,
                    title:     `${prefix} ${t.action} @ ${t.entryPrice}`,
                });
                priceLineHandlesRef.current.push(h);
            }
            if (t.sl != null) {
                const h = series.createPriceLine({
                    price:     t.sl,
                    color:     t.tslActivated ? TSL_COLOR : SL_COLOR,
                    lineWidth: 1,
                    lineStyle: 0, // solid
                    axisLabelVisible: true,
                    title:     t.tslActivated ? `🔒 TSL ${t.sl}` : `SL ${t.sl}`,
                });
                priceLineHandlesRef.current.push(h);
            }
            if (t.target != null) {
                const h = series.createPriceLine({
                    price:     t.target,
                    color:     TARGET_COLOR,
                    lineWidth: 1,
                    lineStyle: 0, // solid
                    axisLabelVisible: true,
                    title:     `🎯 ${t.target}`,
                });
                priceLineHandlesRef.current.push(h);
            }
        }

        // Cleanup on token/interval change — fires before next effect run
        return () => {
            for (const handle of priceLineHandlesRef.current) {
                try { series.removePriceLine(handle); } catch { /* ignore */ }
            }
            priceLineHandlesRef.current = [];
        };
    }, [token, interval, paperTrades]);

    // ── Imperative zoom API ─────────────────────────────────────────────────
    // Exposed via forwardRef so parents (e.g. ScanChartModal) can wire zoom
    // buttons without re-implementing barSpacing math.
    useImperativeHandle(forwardedRef, () => ({
        /** Zoom to show approximately the last `nBars` candles. */
        zoomToBars: (nBars) => {
            const chart = chartRef.current;
            if (!chart) return;
            const ts = chart.timeScale();
            const containerW = containerRef.current?.clientWidth || 1000;
            const usableW    = Math.max(200, containerW - 70);
            const spacing    = Math.max(4, Math.min(40, Math.floor(usableW / nBars)));
            chart.applyOptions({ timeScale: { barSpacing: spacing, rightOffset: 5 } });
            ts.scrollToRealTime();
        },
        /** Fit the entire dataset into view. */
        fitAll: () => {
            chartRef.current?.timeScale().fitContent();
        },
    }), []);

    // ── Render ────────────────────────────────────────────────────────────────
    const ltp    = tick?.lastPrice ?? null;
    const change = tick?.change    ?? null;
    const chgPos = change > 0;
    const chgNeg = change < 0;

    return (
        <div className="ichi-chart-wrap">
            {/* Header: instrument name + live price on the same row */}
            <div className="ichi-chart-header">
                {label
                  ? <span className="ichi-chart-title">{label}</span>
                  : <span className="ichi-chart-title">Chart</span>
                }
                {ltp != null && (
                    <span className="ichi-chart-ltp">
                        ₹{Number(ltp).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        {change != null && (
                            <span className={`ichi-chart-chg ${chgPos ? 'ichi-chart-chg--up' : chgNeg ? 'ichi-chart-chg--down' : ''}`}>
                                {chgPos ? '+' : ''}{Number(change).toFixed(2)}%
                            </span>
                        )}
                    </span>
                )}
            </div>

            {/* Chart canvas */}
            <div className="ichi-chart" ref={containerRef} />

            {/* Overlay states */}
            {loading && (
                <div className="ichi-chart-overlay">
                    <span className="ichi-chart-overlay-spinner" />
                    Loading…
                </div>
            )}
            {!loading && error && <div className="ichi-chart-overlay ichi-chart-overlay--err">{error}</div>}
        </div>
    );
}

// forwardRef wrapper so consumers can call zoomToBars / fitAll imperatively
const IchimokuChart = forwardRef(IchimokuChartImpl);
export default IchimokuChart;
