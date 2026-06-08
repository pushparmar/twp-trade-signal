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

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react"; // useState kept for loading/error
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
    minute: 60,
    "5minute": 5 * 60,
    "15minute": 15 * 60,
    "30minute": 30 * 60,
    "60minute": 60 * 60,
    "4h": null,
    day: null
};

// Dashed line style constant (lightweight-charts LineStyle.Dashed = 2)
const LINE_DASHED = 2;

// ── FVG / Order Block detection (pure, no React deps) ────────────────────────

/**
 * Detect Fair Value Gaps from OHLCV candle array.
 * Bullish FVG:  candle[i-2].high < candle[i].low   (price jumped up, left a gap below)
 * Bearish FVG:  candle[i-2].low  > candle[i].high  (price jumped down, left a gap above)
 * Returns the last `maxCount` gaps so the chart stays uncluttered.
 */
function _detectFVG(candles, maxCount = 5) {
    const gaps = [];
    for (let i = 2; i < candles.length; i++) {
        const c0 = candles[i - 2];
        const c2 = candles[i];
        if (c0.high < c2.low) {
            // Bullish gap — unfilled upward inefficiency
            gaps.push({ signal: 'bullish', top: c2.low, bottom: c0.high });
        } else if (c0.low > c2.high) {
            // Bearish gap — unfilled downward inefficiency
            gaps.push({ signal: 'bearish', top: c0.low, bottom: c2.high });
        }
    }
    return gaps.slice(-maxCount);
}

/**
 * Detect Order Blocks from OHLCV candle array.
 * Bullish OB:  last bearish candle before `minImpulse` consecutive bullish candles
 * Bearish OB:  last bullish candle before `minImpulse` consecutive bearish candles
 * Returns the last `maxCount` blocks — most recent are most relevant.
 */
function _detectOrderBlocks(candles, maxCount = 3, minImpulse = 2) {
    const blocks = [];
    for (let i = 1; i < candles.length - minImpulse; i++) {
        const c = candles[i];
        const isBear = c.close < c.open;
        const isBull = c.close > c.open;

        if (isBear) {
            // Check for bullish impulse after this bearish candle
            let bullCount = 0;
            for (let j = i + 1; j <= i + minImpulse && j < candles.length; j++) {
                if (candles[j].close > candles[j].open) bullCount++;
            }
            if (bullCount >= minImpulse) {
                blocks.push({ signal: 'bullish', high: c.high, low: c.low });
            }
        } else if (isBull) {
            // Check for bearish impulse after this bullish candle
            let bearCount = 0;
            for (let j = i + 1; j <= i + minImpulse && j < candles.length; j++) {
                if (candles[j].close < candles[j].open) bearCount++;
            }
            if (bearCount >= minImpulse) {
                blocks.push({ signal: 'bearish', high: c.high, low: c.low });
            }
        }
    }
    return blocks.slice(-maxCount);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Read a CSS variable from :root, with a fallback for when theme hasn't loaded */
function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

// ── IchimokuChart ─────────────────────────────────────────────────────────────

function IchimokuChartImpl({ token, interval = "15minute", defaultBars = 50, label = null }, forwardedRef) {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    // Multi-timeframe RSI snapshot — fetched once per token open, cache-first on server
    const [multiRsi, setMultiRsi] = useState(null);
    // TimeFM forecast overlay — sourced from global store so forecasts survive
    // modal close/reopen and instrument switching within the same session.
    const setForecastInStore = useAppStore(s => s.setForecast);
    const clearForecastInStore = useAppStore(s => s.clearForecast);
    const forecastMap = useAppStore(s => s.forecastMap);
    const forecast = token ? forecastMap[`${token}:${interval}`] ?? null : null;

    const [forecastLoad, setForecastLoad] = useState(false);
    const [forecastHorizon, setForecastHorizon] = useState(10); // 1–32 bars
    // Set to false when the service returns 503 so the button stays hidden
    const [timefmAvail, setTimefmAvail] = useState(true);
    // Toggle Ichimoku indicator visibility (cloud + lines) without removing series
    const [showIchimoku, setShowIchimoku] = useState(true);
    // Toggle Fair Value Gap and Order Block overlays
    const [showFVG, setShowFVG] = useState(false);
    const [showOB,  setShowOB]  = useState(false);

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

    // Raw OHLCV candles from the last successful data load — used for FVG/OB detection
    const rawCandlesRef = useRef([]);
    // Price-line handles for FVG and OB overlays — kept for cleanup on redraw/unmount
    const fvgLinesRef = useRef([]);
    const obLinesRef  = useRef([]);

    // Subscribe to live tick for this token from the global store
    const tick = useAppStore(s => (token ? s.ticks[token] : null));

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
        const _toIST = unixSec => new Date(unixSec * 1000 + IST_OFFSET_MS);
        const _pad = n => String(n).padStart(2, "0");

        const tickMarkFormatter = (time, tickMarkType /* , locale */) => {
            const d = _toIST(time);
            // tickMarkType: 0=Year, 1=Month, 2=DayOfMonth, 3=Time, 4=TimeWithSeconds
            if (tickMarkType === 0) return String(d.getUTCFullYear());
            if (tickMarkType === 1) return d.toLocaleString("en-IN", { month: "short", timeZone: "UTC" });
            if (tickMarkType === 2)
                return `${_pad(d.getUTCDate())} ${d.toLocaleString("en-IN", { month: "short", timeZone: "UTC" })}`;
            return `${_pad(d.getUTCHours())}:${_pad(d.getUTCMinutes())}`;
        };

        // Crosshair tooltip / status line time format (full IST timestamp)
        const timeFormatter = time => {
            const d = _toIST(time);
            return `${_pad(d.getUTCDate())} ${d.toLocaleString("en-IN", { month: "short", timeZone: "UTC" })} ${_pad(
                d.getUTCHours()
            )}:${_pad(d.getUTCMinutes())} IST`;
        };

        const chart = createChart(containerRef.current, {
            layout: {
                background: { color: bg },
                textColor: txt,
                fontSize: 11,
                attributionLogo: false // hide TradingView branding
            },
            grid: {
                vertLines: { color: grid },
                horzLines: { color: grid }
            },
            crosshair: { mode: 1 },
            rightPriceScale: { borderColor: grid },
            leftPriceScale: { visible: false },
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
                barSpacing: 6
            },
            localization: {
                timeFormatter
            },
            width: containerRef.current.clientWidth,
            height: 540
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

        // Erase layers must not participate in auto-scale — their values
        // extend down to zero and would stretch the Y-axis far below price.
        const eraseOpts = {
            ...sharedCloudOpts,
            autoscaleInfoProvider: () => null,
        };

        // Bullish upper (green gradient fill — drawn first, below)
        const bullUpper = chart.addSeries(AreaSeries, {
            ...sharedCloudOpts,
            topColor: "rgba(89, 160, 92, 0.30)",
            bottomColor: "rgba(89, 160, 92, 0.05)"
        });

        // Bullish lower (solid bg erase — drawn second, covers area below cloud)
        const bullLower = chart.addSeries(AreaSeries, {
            ...eraseOpts,
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
            ...eraseOpts,
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
            crosshairMarkerVisible: false,
            // Chikou is plotted 26 bars behind — its value can be far from
            // current price and stretch the Y-axis. Exclude from auto-scale.
            autoscaleInfoProvider: () => null,
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
        api.post("/instruments/peek-subscribe", { tokens: [token] }).catch(() => {});
        return () => {
            api.post("/instruments/peek-unsubscribe", { tokens: [token] }).catch(() => {});
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
        // Clear FVG/OB overlays and raw candle store
        _clearFVGLines();
        _clearOBLines();
        rawCandlesRef.current = [];
    }

    /** Remove all existing FVG price lines from the candle series */
    function _clearFVGLines() {
        const cs = seriesRef.current.candles;
        for (const line of fvgLinesRef.current) {
            try { cs?.removePriceLine(line); } catch { /* already removed */ }
        }
        fvgLinesRef.current = [];
    }

    /** Remove all existing OB price lines from the candle series */
    function _clearOBLines() {
        const cs = seriesRef.current.candles;
        for (const line of obLinesRef.current) {
            try { cs?.removePriceLine(line); } catch { /* already removed */ }
        }
        obLinesRef.current = [];
    }

    /** Redraw FVG zones from rawCandlesRef (respects current showFVG state) */
    function _redrawFVG(visible) {
        _clearFVGLines();
        const cs = seriesRef.current.candles;
        if (!visible || !cs || rawCandlesRef.current.length < 3) return;
        const gaps = _detectFVG(rawCandlesRef.current, 5);
        for (const gap of gaps) {
            const isBull = gap.signal === 'bullish';
            const color  = isBull ? 'rgba(89, 200, 92, 0.80)' : 'rgba(215, 90, 74, 0.80)';
            const title  = isBull ? 'FVG↑' : 'FVG↓';
            fvgLinesRef.current.push(
                cs.createPriceLine({ price: gap.top,    color, lineWidth: 1, lineStyle: LINE_DASHED, axisLabelVisible: false, title }),
                cs.createPriceLine({ price: gap.bottom, color, lineWidth: 1, lineStyle: LINE_DASHED, axisLabelVisible: false, title: '' }),
            );
        }
    }

    /** Redraw OB zones from rawCandlesRef (respects current showOB state) */
    function _redrawOB(visible) {
        _clearOBLines();
        const cs = seriesRef.current.candles;
        if (!visible || !cs || rawCandlesRef.current.length < 3) return;
        const blocks = _detectOrderBlocks(rawCandlesRef.current, 3);
        for (const ob of blocks) {
            const isBull = ob.signal === 'bullish';
            const color  = isBull ? 'rgba(120, 220, 120, 0.90)' : 'rgba(240, 130, 80, 0.90)';
            const title  = isBull ? 'OB↑' : 'OB↓';
            obLinesRef.current.push(
                cs.createPriceLine({ price: ob.high, color, lineWidth: 1, lineStyle: 0, axisLabelVisible: false, title }),
                cs.createPriceLine({ price: ob.low,  color, lineWidth: 1, lineStyle: 0, axisLabelVisible: false, title: '' }),
            );
        }
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

        // Store raw OHLCV for FVG / OB detection and draw overlays immediately.
        // We pass the current React state values explicitly so the draw functions
        // use the right visibility flags even when called inside an async .then().
        rawCandlesRef.current = candleData;
        _redrawFVG(showFVG);
        _redrawOB(showOB);

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
                const usableW = Math.max(200, containerW - 70);
                // Pixels per bar to fit exactly `defaultBars` in the visible area.
                // Clamp to [4, 40] so tiny modals don't disappear bars and huge
                // screens don't blow them up.
                const spacing = Math.max(4, Math.min(40, Math.floor(usableW / defaultBars)));

                chartRef.current?.applyOptions({
                    timeScale: { barSpacing: spacing, rightOffset: 5 }
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
        // Reject stale ref with null OHLC (e.g. from projection bar) — seed fresh
        if (liveRef.current.open == null || liveRef.current.close == null) {
            liveRef.current = { time: liveRef.current.time, open: price, high: price, low: price, close: price };
        }

        const iSecs = TICK_INTERVAL_SECS[intervalRef.current];
        const live = liveRef.current;
        let updated;

        if (iSecs !== null && tick.lastTradeTime) {
            // Convert lastTradeTime to ms regardless of whether it arrives as an
            // ISO string (Date serialised by JSON.stringify) or a raw Unix number.
            // Values < 2e10 are treated as Unix seconds (Kite sends seconds);
            // larger values or strings go through new Date() for ISO handling.
            const ltt = tick.lastTradeTime;
            const tradeMs = typeof ltt === "number" && ltt < 2e10 ? ltt * 1000 : new Date(ltt).getTime();

            // Mirror candleStore._slotStart: floor to the nearest interval boundary
            const currentSlot = Math.floor(tradeMs / (iSecs * 1000)) * iSecs;

            if (currentSlot > live.time) {
                // New candle — open a fresh bar aligned to the trade-time boundary
                updated = {
                    time: currentSlot,
                    open: price,
                    high: price,
                    low: price,
                    close: price
                };
            } else {
                // Same candle — update OHLC in-place
                // Guard against null OHLC (stale ref from projection bar or empty data)
                updated = {
                    time: live.time,
                    open: live.open ?? price,
                    high: live.high != null ? Math.max(live.high, price) : price,
                    low:  live.low  != null ? Math.min(live.low, price)  : price,
                    close: price
                };
            }
        } else {
            // 4h / day, or lastTradeTime unavailable → patch last bar only
            updated = {
                time: live.time,
                open: live.open ?? price,
                high: live.high != null ? Math.max(live.high, price) : price,
                low:  live.low  != null ? Math.min(live.low, price)  : price,
                close: price
            };
        }

        // Persist so the next tick always has the latest OHLC to diff against
        liveRef.current = updated;
        seriesRef.current.candles.update(updated);
    }, [tick]);

    // Trade overlay lines removed — entry / SL / target price lines are no
    // longer drawn on the chart.  paperTrades is still subscribed downstream
    // if needed for other purposes; the ref and effect have been removed.

    // ── Multi-TF RSI snapshot ───────────────────────────────────────────────
    // Fetches RSI(14) for all four standard timeframes in one server call.
    // The server reads from the candleStore cache first — zero Kite API calls
    // when the instrument has been subscribed or recently scanned.
    useEffect(() => {
        if (!token) return;
        setMultiRsi(null); // clear stale values when token changes
        api.get(`/ichimoku/${token}/multi-rsi`)
            .then(r => setMultiRsi(r.data))
            .catch(() => {}); // non-critical — RSI strip simply stays hidden
    }, [token]);

    // ── Ichimoku visibility toggle ──────────────────────────────────────────
    // Hides/shows all cloud + indicator line series without destroying data.
    // The candlestick series is always kept visible.
    useEffect(() => {
        const s = seriesRef.current;
        const v = { visible: showIchimoku };
        s.bullUpper?.applyOptions(v);
        s.bullLower?.applyOptions(v);
        s.bearUpper?.applyOptions(v);
        s.bearLower?.applyOptions(v);
        s.kijun?.applyOptions(v);
        s.tenkan?.applyOptions(v);
        s.chikou?.applyOptions(v);
    }, [showIchimoku]);

    // ── FVG / OB overlay toggle ─────────────────────────────────────────────
    // Re-draw (or clear) price lines whenever the user toggles the overlay.
    // _redrawFVG/_redrawOB clear existing lines first, so toggling off removes them.
    useEffect(() => { _redrawFVG(showFVG); }, [showFVG]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { _redrawOB(showOB);   }, [showOB]);  // eslint-disable-line react-hooks/exhaustive-deps

    // ── TimeFM forecast overlay ─────────────────────────────────────────────
    // Forecasts persist per instrument — switching token does NOT clear them.
    // The user dismisses explicitly via the ✕ button.
    /** Fetch a TimeFM directional forecast from the Node proxy. */
    async function handleForecast() {
        if (!token) return;
        setForecastLoad(true);
        try {
            const r = await api.get(`/ichimoku/${token}/forecast`, {
                params: { interval, horizon: forecastHorizon }
            });
            // Keyed by token:interval — persists across instrument AND timeframe switches
            setForecastInStore(`${token}:${interval}`, r.data);
        } catch (err) {
            // 503 means the Python service is not running — hide the button
            // permanently for this session so the user isn't confused by retries.
            if (err.response?.status === 503) setTimefmAvail(false);
        } finally {
            setForecastLoad(false);
        }
    }

    /** Dismiss the forecast for the current instrument + timeframe only. */
    function dismissForecast() {
        if (!token) return;
        clearForecastInStore(`${token}:${interval}`);
    }

    // Draw the forecast series whenever forecast state changes.
    // Rendered as semi-transparent candlesticks so the shape and direction read
    // instantly — open/close come from consecutive point forecasts, high/low from
    // the q90/q10 confidence bounds (the "wicks" represent uncertainty width).
    useEffect(() => {
        const chart = chartRef.current;
        if (!chart || !forecast) return;

        // Seconds per bar for each supported interval — used to project future
        // timestamps. Day bars use 6.5 h (NSE session length) as a rough proxy
        // since we only need approximate x-axis positions for the candles.
        const INTERVAL_SECS = {
            "15minute": 15 * 60,
            "60minute": 60 * 60,
            "4h": 4 * 60 * 60,
            day: 6.5 * 60 * 60
        };
        const iSecs = INTERVAL_SECS[interval] ?? 900;

        // Build OHLC — body only, no wicks (high = max(open,close), low = min(open,close))
        const candleData = forecast.point.map((close, i) => {
            const open = i === 0 ? forecast.lastClose : forecast.point[i - 1];
            return {
                time:  forecast.lastTime + (i + 1) * iSecs,
                open,
                high:  Math.max(open, close),
                low:   Math.min(open, close),
                close,
            };
        });

        const fcSeries = chart.addSeries(CandlestickSeries, {
            upColor:         "rgba(34, 211, 238, 0.30)",
            downColor:       "rgba(251, 113, 133, 0.30)",
            borderUpColor:   "rgba(34, 211, 238, 0.30)",
            borderDownColor: "rgba(251, 113, 133, 0.30)",
            wickUpColor:     "rgba(34, 211, 238, 0.30)",
            wickDownColor:   "rgba(251, 113, 133, 0.30)",
            priceLineVisible:   false,
            lastValueVisible:   false,
            // Exclude forecast bars from auto-scale so the y-axis stays anchored
            // to historical candles — forecast candles never push the price scale out.
            autoscaleInfoProvider: () => null,
        });
        fcSeries.setData(candleData);

        // Store on seriesRef for cleanup tracking
        seriesRef.current.forecast = fcSeries;

        // Dashed target line — highest point for bullish, lowest for bearish
        const isBull     = forecast.direction === 'bullish';
        const targetPrice = isBull
            ? Math.max(...forecast.point)
            : Math.min(...forecast.point);
        const lineColor  = isBull ? 'rgba(34, 211, 238, 0.85)' : 'rgba(251, 113, 133, 0.85)';

        const targetLine = seriesRef.current.candles?.createPriceLine({
            price:            targetPrice,
            color:            lineColor,
            lineWidth:        1,
            lineStyle:        2,  // dashed
            axisLabelVisible: true,
            title:            isBull
                ? `🔮 ▲ ${targetPrice.toFixed(2)}`
                : `🔮 ▼ ${targetPrice.toFixed(2)}`,
        });

        return () => {
            try { chart.removeSeries(fcSeries); } catch { /* series already removed */ }
            try { seriesRef.current.candles?.removePriceLine(targetLine); } catch { /* line already removed */ }
            seriesRef.current.forecast = null;
        };
    }, [forecast, interval]);

    // ── Imperative zoom API ─────────────────────────────────────────────────
    // Exposed via forwardRef so parents (e.g. ScanChartModal) can wire zoom
    // buttons without re-implementing barSpacing math.

    /** Reset to the default bar count (defaultBars) anchored at real-time.
     *  Used by the internal "Auto" button and exposed via forwardRef. */
    const resetView = useCallback(() => {
        const chart = chartRef.current;
        if (!chart) return;
        const ts = chart.timeScale();
        const containerW = containerRef.current?.clientWidth || 1000;
        const usableW = Math.max(200, containerW - 70);
        const spacing = Math.max(4, Math.min(40, Math.floor(usableW / defaultBars)));
        chart.applyOptions({ timeScale: { barSpacing: spacing, rightOffset: 5 } });
        ts.scrollToRealTime();
    }, [defaultBars]);

    useImperativeHandle(
        forwardedRef,
        () => ({
            /** Zoom to show approximately the last `nBars` candles. */
            zoomToBars: nBars => {
                const chart = chartRef.current;
                if (!chart) return;
                const ts = chart.timeScale();
                const containerW = containerRef.current?.clientWidth || 1000;
                const usableW = Math.max(200, containerW - 70);
                const spacing = Math.max(4, Math.min(40, Math.floor(usableW / nBars)));
                chart.applyOptions({ timeScale: { barSpacing: spacing, rightOffset: 5 } });
                ts.scrollToRealTime();
            },
            /** Fit the entire dataset into view. */
            fitAll: () => {
                chartRef.current?.timeScale().fitContent();
            },
            /** Reset back to the default view (defaultBars, scrolled to latest). */
            resetView
        }),
        [resetView]
    );

    // ── Render ────────────────────────────────────────────────────────────────
    const ltp = tick?.lastPrice ?? null;
    const change = tick?.change ?? null;
    const chgPos = change > 0;
    const chgNeg = change < 0;

    return (
        <div className="ichi-chart-wrap">
            {/* Header: instrument name | auto-reset button + live price */}
            <div className="ichi-chart-header">
                {label ? (
                    <span className="ichi-chart-title">{label}</span>
                ) : (
                    <span className="ichi-chart-title">Chart</span>
                )}

                {/* Multi-TF RSI strip — shown once server returns values */}
                {multiRsi && (
                    <div className="ichi-rsi-strip">
                        {["15m", "1h", "4h", "1d"].map(tf => {
                            const val = multiRsi[tf];
                            const cls = val == null ? "rsi-na" : val >= 70 ? "rsi-ob" : val <= 30 ? "rsi-os" : "";
                            return (
                                <span
                                    key={tf}
                                    className={`ichi-rsi-cell ${cls}`}
                                    title={`RSI(14) on ${tf}: ${val != null ? val.toFixed(2) : "N/A"}`}
                                >
                                    <span className="ichi-rsi-tf">{tf}</span>
                                    <span className="ichi-rsi-val">{val != null ? val.toFixed(1) : "—"}</span>
                                </span>
                            );
                        })}
                    </div>
                )}

                <div className="ichi-chart-header-right">
                    {/* TimeFM AI forecast toggle — hidden when service is unavailable */}
                    {timefmAvail && (
                        <>
                            <input
                                type="number"
                                className="ichi-forecast-horizon"
                                value={forecastHorizon}
                                min={1}
                                max={32}
                                disabled={forecastLoad}
                                title="Forecast horizon: number of future bars (1–32)"
                                onChange={e => {
                                    const v = Math.max(1, Math.min(32, Number(e.target.value) || 10));
                                    setForecastHorizon(v);
                                }}
                            />
                            <button
                                className={`ichi-chart-forecast-btn${forecast ? " ichi-chart-forecast-btn--active" : ""}`}
                                onClick={forecast ? dismissForecast : handleForecast}
                                disabled={forecastLoad}
                                title={`Toggle TimeFM AI forecast (${forecastHorizon} bars)`}
                            >
                                {forecastLoad ? "…" : forecast ? "✕ Forecast" : "🔮 Forecast"}
                            </button>
                        </>
                    )}
                    {/* Directional bias badge — shown while forecast is active */}
                    {forecast && (
                        <span className={`ichi-forecast-badge ichi-forecast-badge--${forecast.direction}`}>
                            {forecast.direction === "bullish" ? "▲" : "▼"} {Math.abs(forecast.pctMove)}%
                        </span>
                    )}
                    {/* Ichimoku show/hide toggle */}
                    <button
                        className={`ichi-chart-auto-btn${showIchimoku ? '' : ' ichi-chart-auto-btn--off'}`}
                        onClick={() => setShowIchimoku(v => !v)}
                        title={showIchimoku ? 'Hide Ichimoku cloud & lines' : 'Show Ichimoku cloud & lines'}
                    >
                        {showIchimoku ? 'Ichi ✓' : 'Ichi ✗'}
                    </button>
                    {/* FVG overlay toggle */}
                    <button
                        className={`ichi-chart-auto-btn${showFVG ? '' : ' ichi-chart-auto-btn--off'}`}
                        onClick={() => setShowFVG(v => !v)}
                        title={showFVG ? 'Hide Fair Value Gaps' : 'Show Fair Value Gaps'}
                    >
                        {showFVG ? 'FVG ✓' : 'FVG ✗'}
                    </button>
                    {/* OB overlay toggle */}
                    <button
                        className={`ichi-chart-auto-btn${showOB ? '' : ' ichi-chart-auto-btn--off'}`}
                        onClick={() => setShowOB(v => !v)}
                        title={showOB ? 'Hide Order Blocks' : 'Show Order Blocks'}
                    >
                        {showOB ? 'OB ✓' : 'OB ✗'}
                    </button>
                    {/* Auto button — resets pan/zoom back to the default view */}
                    <button
                        className="ichi-chart-auto-btn"
                        onClick={resetView}
                        title={`Reset to default view (${defaultBars} bars)`}
                    >
                        Auto
                    </button>
                    {ltp != null && (
                        <span className="ichi-chart-ltp">
                            ₹
                            {Number(ltp).toLocaleString("en-IN", {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2
                            })}
                            {change != null && (
                                <span
                                    className={`ichi-chart-chg ${
                                        chgPos ? "ichi-chart-chg--up" : chgNeg ? "ichi-chart-chg--down" : ""
                                    }`}
                                >
                                    {chgPos ? "+" : ""}
                                    {Number(change).toFixed(2)}%
                                </span>
                            )}
                        </span>
                    )}
                </div>
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
