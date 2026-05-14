import { create } from 'zustand';

const MAX_ITEMS = 100;

const useAppStore = create((set) => ({
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
    set((state) => ({ paperTrades: [trade, ...state.paperTrades].slice(0, MAX_ITEMS) })),

  updatePaperTrade: (updated) =>
    set((state) => ({
      paperTrades: state.paperTrades.map((t) => t.id === updated.id ? updated : t),
    })),

  clearPaperTrades: () => set({ paperTrades: [] }),

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

  // Scanner tab — accumulated pattern alert events
  // Each entry: { token, label, interval, tfLabel, patternId, patternLabel,
  //               signal, score, close, ts }
  // Keyed by "token:interval:patternId" so each combo shows only the latest firing.
  // Stored as array sorted newest-first; capped at 200 entries.
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

  // Wipe only the screener-sourced alerts. Live SSE alerts (source !== 'screener')
  // are preserved so a new screener run doesn't erase the day's live signals.
  clearScreenerAlerts: () =>
    set((s) => ({
      scanAlerts: s.scanAlerts.filter((a) => a.source !== 'screener'),
    })),
}));

export default useAppStore;
