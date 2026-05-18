import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const MAX_ITEMS = 100;

const useAppStore = create(
  persist(
    (set) => ({
  signals: [],
  orders: [],
  pollingStatus: 'stopped',
  kiteConnected: null,
  testMode: false,
  paperTrades: [],
  paperBalance: { initial: 100000, available: 100000, invested: 0, realizedPnl: 0 },
  tradingDefaults: { quantity: 1, exchange: 'NFO', product: 'MIS' },
  toasts: [],

  // Market watch
  watchlist: [],       // [{ instrumentToken, tradingsymbol, exchange, name, lotSize, expiry }]
  ticks: {},           // { [instrumentToken]: { lastPrice, ohlc, volume, change, prevPrice } }
  tradeTicks: {},      // { [tradeId]: { ltp, unrealizedPnl } } — per-trade live feed from tradeWatcher
  tickerConnected: false,
  ichiSignals: {},  // { [`${token}:${interval}`]: ichimokuSignals } — pushed by server on candle close
  macroData: null,         // { vix, crude, gold, silver, usdinr } — pushed by server on every macro candle close
  macroPrices: null,       // { vix, crude, gold, silver, usdinr } — live price pushed on every tick
  selectedInstrument: null, // { type, key?, token, label, sublabel? } — instrument selected in sidebar

  setPollingStatus: (pollingStatus) => set({ pollingStatus }),
  setKiteConnected: (kiteConnected) => set({ kiteConnected }),
  setTestMode: (testMode) => set({ testMode }),
  setPaperTrades: (paperTrades) => set({ paperTrades }),
  setPaperBalance: (paperBalance) => set({ paperBalance }),
  setTradingDefaults: (tradingDefaults) => set({ tradingDefaults }),

  addSignal: (signal) =>
    set((state) => ({ signals: [signal, ...state.signals].slice(0, MAX_ITEMS) })),

  addOrder: (order) =>
    set((state) => ({ orders: [order, ...state.orders].slice(0, MAX_ITEMS) })),

  updateOrder: (update) =>
    set((state) => ({
      orders: state.orders.map((o) =>
        o.orderId && o.orderId === update.orderId ? { ...o, ...update } : o,
      ),
    })),

  attachGTT: (gtt) =>
    set((state) => ({
      orders: state.orders.map((o) =>
        o.orderId === gtt.orderId || o.signalId === gtt.signalId
          ? { ...o, gttId: gtt.gttId, gttStatus: gtt.status, gttError: gtt.error }
          : o,
      ),
    })),

  addPaperTrade: (trade) =>
    set((state) => {
      // Deduct cost from available balance when opening a scan-sourced paper trade
      const cost = (trade.entryPrice ?? 0) * (trade.quantity ?? 1);
      const newBalance = {
        ...state.paperBalance,
        available: state.paperBalance.available - cost,
        invested:  state.paperBalance.invested  + cost,
      };
      return {
        paperTrades: [trade, ...state.paperTrades].slice(0, MAX_ITEMS),
        paperBalance: newBalance,
      };
    }),

  updatePaperTrade: (updated) =>
    set((state) => {
      // When a trade closes, remove its live-tick entry so the row stops updating.
      const tradeTicks = updated.status === 'CLOSED'
        ? Object.fromEntries(Object.entries(state.tradeTicks).filter(([k]) => k !== updated.id))
        : state.tradeTicks;
      return {
        paperTrades: state.paperTrades.map((t) => t.id === updated.id ? updated : t),
        tradeTicks,
      };
    }),

  // Per-trade live tick from tradeWatcher (paper_trade_tick SSE event).
  // Keyed by trade ID so two open trades on the same token stay independent.
  updateTradeTick: ({ id, ltp, unrealizedPnl }) =>
    set((state) => ({
      tradeTicks: { ...state.tradeTicks, [id]: { ltp, unrealizedPnl } },
    })),

  clearPaperTrades: () => set({ paperTrades: [] }),

  // Close a paper trade opened from the scan alerts table.
  // Calculates PnL, returns invested capital + pnl to available balance.
  closeScanPaperTrade: (id, exitPrice) =>
    set((state) => {
      let investedReturn = 0;
      let tradePnl       = 0;

      const paperTrades = state.paperTrades.map((t) => {
        if (t.id !== id) return t;
        const pnl = t.action === 'BUY'
          ? (exitPrice - t.entryPrice) * t.quantity
          : (t.entryPrice - exitPrice) * t.quantity;
        investedReturn = (t.entryPrice ?? 0) * (t.quantity ?? 1);
        tradePnl = pnl;
        return { ...t, status: 'CLOSED', exitPrice, closedTs: Date.now(), pnl };
      });

      // Return invested capital + realised profit/loss back to available balance
      const newBalance = {
        ...state.paperBalance,
        available:   state.paperBalance.available + investedReturn + tradePnl,
        invested:    Math.max(0, state.paperBalance.invested - investedReturn),
        realizedPnl: state.paperBalance.realizedPnl + tradePnl,
      };

      return { paperTrades, paperBalance: newBalance };
    }),

  addToast: (toast) =>
    set((state) => ({ toasts: [...state.toasts, { id: Date.now() + Math.random(), ...toast }] })),
  removeToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  // Market watch actions
  setWatchlist: (watchlist) => set({ watchlist }),
  addToWatchlist: (item) =>
    set((state) => {
      if (state.watchlist.find((i) => i.instrumentToken === item.instrumentToken)) return state;
      return { watchlist: [...state.watchlist, item] };
    }),
  removeFromWatchlist: (instrumentToken) =>
    set((state) => ({
      watchlist: state.watchlist.filter((i) => i.instrumentToken !== instrumentToken),
    })),
  updateTick: (tick) =>
    set((state) => {
      const prev = state.ticks[tick.instrumentToken];
      return {
        ticks: {
          ...state.ticks,
          [tick.instrumentToken]: {
            ...tick,
            prevPrice: prev?.lastPrice ?? tick.lastPrice,
          },
        },
      };
    }),
  setTickerConnected: (tickerConnected) => set({ tickerConnected }),
  setIchiSignal: ({ token, interval, ...signals }) =>
    set((state) => ({
      ichiSignals: { ...state.ichiSignals, [`${token}:${interval}`]: signals },
    })),
  setMacroData:          (macroData)          => set({ macroData }),
  setMacroPrices:        (macroPrices)        => set({ macroPrices }),
  setSelectedInstrument: (selectedInstrument) => set({ selectedInstrument }),

  // ── Scanner tab — accumulated pattern alert events ──────────────────────────
  // Each entry: { token, label, interval, tfLabel, patternId, patternLabel,
  //               signal, score, close, ts }
  // Keyed by "token:interval:patternId" so each combo shows only the latest firing.
  // Stored as array sorted newest-first; capped at 500 entries.
  scanAlerts: [],
  addScanAlert: (alert) =>
    set((s) => ({
      scanAlerts: [
        alert,
        ...s.scanAlerts.filter(
          (a) =>
            !(
              a.token     === alert.token     &&
              a.interval  === alert.interval  &&
              a.patternId === alert.patternId
            )
        ),
      ].slice(0, 500),
    })),

  // Wipe the entire scan table so a new manual scan starts with a clean slate.
  // Live SSE alerts (background scanner) that arrive DURING or AFTER the new run
  // will be added normally — nothing is permanently lost.
  clearScreenerAlerts: () => set({ scanAlerts: [] }),

  // Timestamp (ms) of the last successful screener auto-run. Used by the
  // Scanner tab to decide whether to auto-rerun on mount or reuse the
  // results that are already in scanAlerts. Persisting this in the store
  // (instead of a component ref) means tab-switching does NOT trigger a
  // fresh scan — the previous results stay visible.
  screenerLastRunAt: 0,
  setScreenerLastRunAt: (ts) => set({ screenerLastRunAt: ts }),

  // Per-TF status pills from the most recent screener run, persisted so they
  // survive a tab switch without flashing back to "queued".
  screenerTfState: {},
  setScreenerTfState: (updater) => set((s) => ({
    screenerTfState: typeof updater === 'function' ? updater(s.screenerTfState) : updater,
  })),

  // Status line text + kind, also persisted for cross-tab continuity.
  // Two separate setters so callers can update each field independently
  // without closure pitfalls when both are written in quick succession.
  screenerStatus:     '',
  screenerStatusKind: '',
  setScreenerStatus:     (status) => set({ screenerStatus: status }),
  setScreenerStatusKind: (kind)   => set({ screenerStatusKind: kind }),
    }),
    {
      name: 'tdk-store',
      // Only persist scanner / paper-trade fields that survive a hard refresh.
      // Session-only fields (ticks, watchlist, orders, signals, toasts) are
      // intentionally excluded — they are re-hydrated from the server / socket.
      partialize: (state) => ({
        scanAlerts:         state.scanAlerts,
        screenerLastRunAt:  state.screenerLastRunAt,
        screenerTfState:    state.screenerTfState,
        screenerStatus:     state.screenerStatus,
        screenerStatusKind: state.screenerStatusKind,
        paperTrades:        state.paperTrades,
        paperBalance:       state.paperBalance,
      }),
      // On rehydration from localStorage, drop scan alerts from previous IST
      // trading days. Futures contracts roll over daily, so yesterday's tokens
      // are stale and their charts will return "0 candles" from Kite.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
        const todayIST = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
        state.scanAlerts = (state.scanAlerts || []).filter((a) => {
          if (!a.ts) return false;
          const alertDay = new Date(a.ts + IST_OFFSET_MS).toISOString().slice(0, 10);
          return alertDay === todayIST;
        });
        // Also reset screener state if the last run was from a previous day
        if (state.screenerLastRunAt) {
          const lastRunDay = new Date(state.screenerLastRunAt + IST_OFFSET_MS).toISOString().slice(0, 10);
          if (lastRunDay !== todayIST) {
            state.screenerLastRunAt  = 0;
            state.screenerTfState   = {};
            state.screenerStatus    = '';
            state.screenerStatusKind = '';
          }
        }
      },
    },
  ),
);

export default useAppStore;
