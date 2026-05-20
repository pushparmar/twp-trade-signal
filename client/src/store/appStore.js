import { create } from 'zustand';

const MAX_ITEMS = 100;

const useAppStore = create(
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
  macroData: null,         // { vix, crude, gold, silver, usdinr, naturalgas } — pushed by server on every macro candle close
  macroPrices: null,       // { vix, crude, gold, silver, usdinr, naturalgas } — live price pushed on every tick
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
      // PENDING orders are not yet filled — don't deduct balance until activation
      const cost = trade.status === 'PENDING' ? 0 : (trade.entryPrice ?? 0) * (trade.quantity ?? 1);
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
      const old = state.paperTrades.find((t) => t.id === updated.id);
      let paperBalance = state.paperBalance;

      // PENDING → OPEN: deduct cost now that the order is filled
      if (old?.status === 'PENDING' && updated.status === 'OPEN') {
        const cost = (updated.entryPrice ?? 0) * (updated.quantity ?? 1);
        paperBalance = {
          ...state.paperBalance,
          available: state.paperBalance.available - cost,
          invested:  state.paperBalance.invested  + cost,
        };
      }

      const tradeTicks = updated.status === 'CLOSED'
        ? Object.fromEntries(Object.entries(state.tradeTicks).filter(([k]) => k !== updated.id))
        : state.tradeTicks;
      return {
        paperTrades: state.paperTrades.map((t) => t.id === updated.id ? updated : t),
        tradeTicks,
        paperBalance,
      };
    }),

  // Remove a single trade by id (used for cancelled pending orders)
  removePaperTrade: (id) =>
    set((state) => ({
      paperTrades: state.paperTrades.filter((t) => t.id !== id),
    })),

  updateTradeTick: (data) =>
    set((state) => ({
      tradeTicks: { ...state.tradeTicks, [data.id]: data },
    })),

  clearPaperTrades: () => set({ paperTrades: [] }),

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

  clearScreenerAlerts: () => set({ scanAlerts: [] }),

  screenerLastRunAt: 0,
  setScreenerLastRunAt: (ts) => set({ screenerLastRunAt: ts }),

  screenerTfState: {},
  setScreenerTfState: (updater) => set((s) => ({
    screenerTfState: typeof updater === 'function' ? updater(s.screenerTfState) : updater,
  })),

  screenerStatus:     '',
  screenerStatusKind: '',
  setScreenerStatus:     (status) => set({ screenerStatus: status }),
  setScreenerStatusKind: (kind)   => set({ screenerStatusKind: kind }),
  }),
);

export default useAppStore;
