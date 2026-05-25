/**
 * useIndexTrade — Data hook for the Index Trade tab.
 *
 * Creates its own EventSource to /api/stream and listens for idx_* events.
 * Provides API helpers for fetching trades, config, and status.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../api';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export default function useIndexTrade() {
  const [trades, setTrades]       = useState([]);
  const [tradeTicks, setTradeTicks] = useState({}); // { tradeId: { ltp, unrealizedPnl, sl, tslActivated } }
  const [status, setStatus]       = useState(null);
  const [config, setConfig]       = useState(null);
  const [pnl, setPnl]             = useState(null);
  const [alerts, setAlerts]       = useState([]);   // recent scan alerts
  const [optionChain, setOptionChain] = useState(null);
  const esRef = useRef(null);

  // ── Fetch functions ─────────────────────────────────────────────────────

  const fetchTrades = useCallback(async () => {
    try {
      const r = await api.get('/index-trade/trades');
      setTrades(r.data || []);
    } catch { /* ignore */ }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await api.get('/index-trade/status');
      setStatus(r.data);
    } catch { /* ignore */ }
  }, []);

  const fetchConfig = useCallback(async () => {
    try {
      const r = await api.get('/index-trade/config');
      setConfig(r.data);
    } catch { /* ignore */ }
  }, []);

  const fetchPnl = useCallback(async () => {
    try {
      const r = await api.get('/index-trade/pnl');
      setPnl(r.data);
    } catch { /* ignore */ }
  }, []);

  const fetchOptionChain = useCallback(async () => {
    try {
      const r = await api.get('/index-trade/option-chain');
      setOptionChain(r.data);
    } catch { /* ignore */ }
  }, []);

  const updateConfig = useCallback(async (updates) => {
    try {
      const r = await api.post('/index-trade/config', updates);
      setConfig(r.data);
    } catch { /* ignore */ }
  }, []);

  const manualClose = useCallback(async (id, exitPrice) => {
    try {
      await api.post(`/index-trade/trades/${id}/close`, { exitPrice });
      fetchTrades();
      fetchPnl();
    } catch { /* ignore */ }
  }, [fetchTrades, fetchPnl]);

  const clearTrades = useCallback(async () => {
    try {
      await api.delete('/index-trade/trades');
      setTrades([]);
      fetchPnl();
    } catch { /* ignore */ }
  }, [fetchPnl]);

  // ── SSE subscription ───────────────────────────────────────────────────

  useEffect(() => {
    // Initial data load
    fetchTrades();
    fetchStatus();
    fetchConfig();
    fetchPnl();
    fetchOptionChain();

    // Create SSE connection
    const baseUrl = api.defaults.baseURL || '';
    const streamUrl = baseUrl.replace(/\/api$/, '') + '/api/stream';
    const es = new EventSource(streamUrl);
    esRef.current = es;

    es.addEventListener('idx_trade', (e) => {
      try {
        const trade = JSON.parse(e.data);
        setTrades(prev => [trade, ...prev.filter(t => t.id !== trade.id)]);
        fetchPnl();
      } catch { /* ignore */ }
    });

    es.addEventListener('idx_trade_update', (e) => {
      try {
        const updated = JSON.parse(e.data);
        setTrades(prev => prev.map(t => t.id === updated.id ? updated : t));
        fetchPnl();
      } catch { /* ignore */ }
    });

    es.addEventListener('idx_trade_tick', (e) => {
      try {
        const tick = JSON.parse(e.data);
        setTradeTicks(prev => ({ ...prev, [tick.id]: tick }));
      } catch { /* ignore */ }
    });

    es.addEventListener('idx_scan_alert', (e) => {
      try {
        const alert = JSON.parse(e.data);
        setAlerts(prev => [alert, ...prev].slice(0, 50)); // keep last 50
      } catch { /* ignore */ }
    });

    // Refresh status every 30s
    const statusTimer = setInterval(fetchStatus, 30_000);

    return () => {
      es.close();
      clearInterval(statusTimer);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived state ─────────────────────────────────────────────────────

  const openTrades  = trades.filter(t => t.status === 'OPEN');
  const closedTrades = trades.filter(t => t.status === 'CLOSED');

  // Today's closed trades (IST)
  const todayIST = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
  const todayClosed = closedTrades.filter(t => {
    if (!t.closedTs) return false;
    return new Date(t.closedTs + IST_OFFSET_MS).toISOString().slice(0, 10) === todayIST;
  });

  return {
    trades, openTrades, closedTrades, todayClosed,
    tradeTicks, optionChain,
    status, config, pnl, alerts,
    fetchTrades, fetchStatus, fetchConfig, fetchPnl, fetchOptionChain,
    updateConfig, manualClose, clearTrades,
  };
}
