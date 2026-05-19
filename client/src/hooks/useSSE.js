import { useEffect } from 'react';
import useAppStore from '../store/appStore';

export default function useSSE() {
  const addSignal = useAppStore((s) => s.addSignal);
  const addOrder = useAppStore((s) => s.addOrder);
  const updateOrder = useAppStore((s) => s.updateOrder);
  const attachGTT = useAppStore((s) => s.attachGTT);
  const setPollingStatus = useAppStore((s) => s.setPollingStatus);
  const addPaperTrade = useAppStore((s) => s.addPaperTrade);
  const updatePaperTrade = useAppStore((s) => s.updatePaperTrade);
  const clearPaperTrades = useAppStore((s) => s.clearPaperTrades);
  const setTestMode = useAppStore((s) => s.setTestMode);
  const setPaperBalance = useAppStore((s) => s.setPaperBalance);
  const addToast = useAppStore((s) => s.addToast);
  const updateTick = useAppStore((s) => s.updateTick);
  const setTickerConnected = useAppStore((s) => s.setTickerConnected);
  const setIchiSignal = useAppStore((s) => s.setIchiSignal);
  const setMacroData = useAppStore((s) => s.setMacroData);
  const addScanAlert    = useAppStore((s) => s.addScanAlert);
  const updateTradeTick = useAppStore((s) => s.updateTradeTick);

  useEffect(() => {
    // In production VITE_API_URL points to Railway — SSE cannot go through Vercel rewrites.
    const streamUrl = import.meta.env.VITE_API_URL
      ? `${import.meta.env.VITE_API_URL}/api/stream`
      : '/api/stream';
    const es = new EventSource(streamUrl);

    es.addEventListener('signal', (e) => addSignal(JSON.parse(e.data)));
    es.addEventListener('order_placed', (e) => addOrder(JSON.parse(e.data)));
    es.addEventListener('order_update', (e) => updateOrder(JSON.parse(e.data)));
    es.addEventListener('gtt_placed', (e) => attachGTT(JSON.parse(e.data)));
    es.addEventListener('status', (e) => {
      const data = JSON.parse(e.data);
      if (data.pollingStatus) setPollingStatus(data.pollingStatus);
    });
    es.addEventListener('paper_trade', (e) => {
      const trade = JSON.parse(e.data);
      addPaperTrade(trade);
      if (trade.source !== 'auto') {
        addToast({
          type: trade.action === 'BUY' ? 'buy' : 'sell',
          message: `${trade.action} matched — ${trade.symbol} [${trade.tfLabel ?? trade.interval ?? ''}] @ ₹${trade.entryPrice}`,
        });
      }
    });
    es.addEventListener('paper_trade_update', (e) => updatePaperTrade(JSON.parse(e.data)));
    es.addEventListener('paper_trades_cleared', () => clearPaperTrades());
    es.addEventListener('test_mode', (e) => setTestMode(JSON.parse(e.data).testMode));
    es.addEventListener('paper_balance', (e) => setPaperBalance(JSON.parse(e.data)));
    // paper_trade_pending is informational — no state needed, toast handled on paper_trade fill

    es.addEventListener('tick', (e) => updateTick(JSON.parse(e.data)));
    es.addEventListener('ticker_status', (e) => setTickerConnected(JSON.parse(e.data).connected));
    es.addEventListener('ichimoku_update', (e) => setIchiSignal(JSON.parse(e.data)));
    es.addEventListener('macro_update', (e) => setMacroData(JSON.parse(e.data)));
    es.addEventListener('scan_alert', (e) => addScanAlert(JSON.parse(e.data)));

    // Per-trade live tick — ltp + server-calculated unrealised P&L, throttled
    // to 500 ms per trade by tradeWatcher.js. Only fires for OPEN trades whose
    // token is subscribed to the Kite WebSocket.
    es.addEventListener('paper_trade_tick', (e) => updateTradeTick(JSON.parse(e.data)));

    return () => es.close();
  }, [addSignal, addOrder, updateOrder, attachGTT, setPollingStatus, addPaperTrade, updatePaperTrade, clearPaperTrades, setTestMode, setPaperBalance, addToast, updateTick, setTickerConnected, setIchiSignal, setMacroData, addScanAlert, updateTradeTick]);
}
