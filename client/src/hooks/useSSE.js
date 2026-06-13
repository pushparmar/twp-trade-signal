import { useEffect, useRef } from 'react';
import useAppStore from '../store/appStore';

export default function useSSE() {
  // Store all handlers in refs to avoid SSE reconnection on every state change
  const handlersRef = useRef({});

  // Update refs whenever handlers change
  handlersRef.current = {
    addSignal: useAppStore.getState().addSignal,
    addOrder: useAppStore.getState().addOrder,
    updateOrder: useAppStore.getState().updateOrder,
    attachGTT: useAppStore.getState().attachGTT,
    setPollingStatus: useAppStore.getState().setPollingStatus,
    addPaperTrade: useAppStore.getState().addPaperTrade,
    updatePaperTrade: useAppStore.getState().updatePaperTrade,
    removePaperTrade: useAppStore.getState().removePaperTrade,
    clearPaperTrades: useAppStore.getState().clearPaperTrades,
    setTestMode: useAppStore.getState().setTestMode,
    setPaperBalance: useAppStore.getState().setPaperBalance,
    updateTick: useAppStore.getState().updateTick,
    setTickerConnected: useAppStore.getState().setTickerConnected,
    setIchiSignal: useAppStore.getState().setIchiSignal,
    setMacroData: useAppStore.getState().setMacroData,
    addScanAlert: useAppStore.getState().addScanAlert,
    updateTradeTick: useAppStore.getState().updateTradeTick,
    addEquityScanBatch: useAppStore.getState().addEquityScanBatch,
    setEquityScanProgress: useAppStore.getState().setEquityScanProgress,
    setEquityScanComplete: useAppStore.getState().setEquityScanComplete,
    setModuleConfig: useAppStore.getState().setModuleConfig,
  };

  useEffect(() => {
    // In production VITE_API_URL points to Railway — SSE cannot go through Vercel rewrites.
    const streamUrl = import.meta.env.VITE_API_URL
      ? `${import.meta.env.VITE_API_URL}/api/stream`
      : '/api/stream';
    const es = new EventSource(streamUrl);

    // Use handlers from ref so SSE doesn't reconnect when store actions change
    const h = handlersRef.current;

    es.addEventListener('signal', (e) => h.addSignal(JSON.parse(e.data)));
    es.addEventListener('order_placed', (e) => h.addOrder(JSON.parse(e.data)));
    es.addEventListener('order_update', (e) => h.updateOrder(JSON.parse(e.data)));
    es.addEventListener('gtt_placed', (e) => h.attachGTT(JSON.parse(e.data)));
    es.addEventListener('status', (e) => {
      const data = JSON.parse(e.data);
      if (data.pollingStatus) h.setPollingStatus(data.pollingStatus);
    });
    es.addEventListener('paper_trade', (e) => {
      const trade = JSON.parse(e.data);
      h.addPaperTrade(trade);
    });
    es.addEventListener('paper_trade_update', (e) => {
      const updated = JSON.parse(e.data);
      h.updatePaperTrade(updated);
    });
    es.addEventListener('paper_trade_cancelled', (e) => h.removePaperTrade(JSON.parse(e.data).id));
    es.addEventListener('paper_trades_cleared', () => h.clearPaperTrades());
    es.addEventListener('test_mode', (e) => h.setTestMode(JSON.parse(e.data).testMode));
    es.addEventListener('paper_balance', (e) => h.setPaperBalance(JSON.parse(e.data)));

    es.addEventListener('tick', (e) => h.updateTick(JSON.parse(e.data)));
    es.addEventListener('ticker_status', (e) => h.setTickerConnected(JSON.parse(e.data).connected));
    es.addEventListener('ichimoku_update', (e) => h.setIchiSignal(JSON.parse(e.data)));
    es.addEventListener('macro_update', (e) => h.setMacroData(JSON.parse(e.data)));
    es.addEventListener('scan_alert', (e) => h.addScanAlert(JSON.parse(e.data)));

    // Per-trade live tick — ltp + server-calculated unrealised P&L, throttled
    // to 500 ms per trade by tradeWatcher.js. Only fires for OPEN trades whose
    // token is subscribed to the Kite WebSocket.
    es.addEventListener('paper_trade_tick', (e) => h.updateTradeTick(JSON.parse(e.data)));

    // Equity scan progressive results — streamed in batches of 50
    es.addEventListener('equity_scan_batch', (e) => h.addEquityScanBatch(JSON.parse(e.data)));
    es.addEventListener('equity_scan_progress', (e) => h.setEquityScanProgress(JSON.parse(e.data)));
    es.addEventListener('equity_scan_complete', (e) => h.setEquityScanComplete(JSON.parse(e.data)));

    // Module config updates — broadcast when settings change
    es.addEventListener('module_config', (e) => h.setModuleConfig(JSON.parse(e.data)));

    return () => es.close();
  }, []); // Empty dependency array - SSE connection stays stable
}
