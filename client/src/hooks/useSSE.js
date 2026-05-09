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

  useEffect(() => {
    const es = new EventSource('/api/stream');

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

    return () => es.close();
  }, [addSignal, addOrder, updateOrder, attachGTT, setPollingStatus, addPaperTrade, updatePaperTrade, clearPaperTrades, setTestMode, setPaperBalance, addToast]);
}
