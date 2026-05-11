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
      addToast({
        type: trade.action === 'BUY' ? 'buy' : 'sell',
        message: `${trade.action} matched — ${trade.symbol} @ ₹${trade.entryPrice}`,
      });
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

    return () => es.close();
  }, [addSignal, addOrder, updateOrder, attachGTT, setPollingStatus, addPaperTrade, updatePaperTrade, clearPaperTrades, setTestMode, setPaperBalance, addToast, updateTick, setTickerConnected, setIchiSignal, setMacroData]);
}
