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

import { useEffect, useRef, useState } from "react"; // useState kept for loading/error
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

export default function IchimokuChart({ token, interval = "15minute" }) {
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

        const kijun = chart.addSeries(LineSeries, {
            color: "#f97316", // orange
            lineWidth: 2,
            // Show current value label on price axis + dotted reference line
            // so the user can instantly read the exact Kijun level.
            priceLineVisible: true,
            priceLineStyle: LINE_DASHED,
            lastValueVisible: true,
            crosshairMarkerVisible: false
        });

        const tenkan = chart.addSeries(LineSeries, {
            color: "#84cc16", // lime
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false
        });

        const chikou = chart.addSeries(LineSeries, {
            color: "#387ed1", // blue, dashed
            lineWidth: 1,
            lineStyle: LINE_DASHED,
            // Show current value label + dotted reference line for Chikou too.
            priceLineVisible: true,
            priceLineStyle: LINE_DASHED,
            lastValueVisible: true,
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

        // Scroll to show the last N candles with some right padding
        chartRef.current?.timeScale().fitContent();
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

    // ── Render ────────────────────────────────────────────────────────────────
    return (
        <div className="ichi-chart-wrap">
            {/* Header: title + legend in one compact row */}
            <div className="ichi-chart-header">
                <span className="ichi-chart-title">TWP chart</span>
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
