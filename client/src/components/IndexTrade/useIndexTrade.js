/**
 * useIndexTrade — Data hook for the Index Trade tab.
 *
 * All live data flows via SSE — no client-side polling.
 *
 *  idx_option_chain  → live strike prices (pushed every 3s by server)
 *  idx_trade         → new paper trade opened
 *  idx_trade_update  → trade closed / updated
 *  idx_trade_tick    → per-tick unrealized PnL on open trades
 *  idx_scan_alert    → pattern match signal
 *
 * On mount: fetches initial snapshot of all data + alert history so
 * signals are visible after a page refresh.
 *
 * SSE auto-reconnects on drop (network blip / server restart).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../api';

const IST_OFFSET_MS    = 5.5 * 60 * 60 * 1000;
const SSE_RECONNECT_MS = 3_000;

export default function useIndexTrade() {
  const [trades, setTrades]             = useState([]);
  const [tradeTicks, setTradeTicks]     = useState({});
  const [status, setStatus]             = useState(null);
  const [config, setConfig]             = useState(null);
  const [pnl, setPnl]                   = useState(null);
  const [alerts, setAlerts]             = useState([]);
  const [optionChain, setOptionChain]   = useState(null);
  const [sseConnected, setSseConnected] = useState(false);

  const esRef          = useRef(null);
  const reconnectTimer = useRef(null);
  const destroyedRef   = useRef(false);

  // ── Fetch helpers (initial load only) ─────────────────────────────────

  const fetchTrades = useCallback(async () => {
    try { const r = await api.get('/index-trade/trades');      setTrades(r.data || []); }      catch { /* ignore */ }
  }, []);

  const fetchStatus = useCallback(async () => {
    try { const r = await api.get('/index-trade/status');      setStatus(r.data); }            catch { /* ignore */ }
  }, []);

  const fetchConfig = useCallback(async () => {
    try { const r = await api.get('/index-trade/config');      setConfig(r.data); }            catch { /* ignore */ }
  }, []);

  const fetchPnl = useCallback(async () => {
    try { const r = await api.get('/index-trade/pnl');         setPnl(r.data); }               catch { /* ignore */ }
  }, []);

  const fetchOptionChain = useCallback(async () => {
    try { const r = await api.get('/index-trade/option-chain'); setOptionChain(r.data); }      catch { /* ignore */ }
  }, []);

  const fetchAlerts = useCallback(async () => {
    try { const r = await api.get('/index-trade/alerts');      setAlerts(r.data || []); }      catch { /* ignore */ }
  }, []);

  // ── Mutation helpers ───────────────────────────────────────────────────

  const updateConfig = useCallback(async (updates) => {
    try { const r = await api.post('/index-trade/config', updates); setConfig(r.data); } catch { /* ignore */ }
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

  const refreshStrikes = useCallback(async () => {
    try {
      await api.post('/index-trade/refresh-strikes');
      fetchStatus();
      fetchOptionChain(); // immediate snapshot after strike reset
    } catch { /* ignore */ }
  }, [fetchStatus, fetchOptionChain]);

  // ── SSE connection with auto-reconnect ────────────────────────────────

  const connectSSE = useCallback(() => {
    if (destroyedRef.current) return;
    if (esRef.current) { esRef.current.close(); esRef.current = null; }

    const baseUrl   = api.defaults.baseURL || '';
    const streamUrl = baseUrl.replace(/\/api$/, '') + '/api/stream';
    const es        = new EventSource(streamUrl);
    esRef.current   = es;

    // Connection confirmed
    es.addEventListener('status', () => setSseConnected(true));

    // Live option chain prices — pushed by server every 3s
    es.addEventListener('idx_option_chain', (e) => {
      try { setOptionChain(JSON.parse(e.data)); } catch { /* ignore */ }
    });

    // New paper trade opened by scanner
    es.addEventListener('idx_trade', (e) => {
      try {
        const trade = JSON.parse(e.data);
        setTrades(prev => [trade, ...prev.filter(t => t.id !== trade.id)]);
        fetchPnl();
      } catch { /* ignore */ }
    });

    // Trade closed / SL / target hit
    es.addEventListener('idx_trade_update', (e) => {
      try {
        const updated = JSON.parse(e.data);
        setTrades(prev => prev.map(t => t.id === updated.id ? updated : t));
        fetchPnl();
      } catch { /* ignore */ }
    });

    // Per-tick unrealized PnL on open trades
    es.addEventListener('idx_trade_tick', (e) => {
      try {
        const tick = JSON.parse(e.data);
        setTradeTicks(prev => ({ ...prev, [tick.id]: tick }));
      } catch { /* ignore */ }
    });

    // Pattern match signal from scanner
    es.addEventListener('idx_scan_alert', (e) => {
      try {
        const alert = JSON.parse(e.data);
        setAlerts(prev => [alert, ...prev].slice(0, 100));
      } catch { /* ignore */ }
    });

    // Auto-reconnect on error / unexpected close
    es.onerror = () => {
      setSseConnected(false);
      es.close();
      esRef.current = null;
      if (!destroyedRef.current) {
        reconnectTimer.current = setTimeout(connectSSE, SSE_RECONNECT_MS);
      }
    };
  }, [fetchPnl]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mount / unmount ────────────────────────────────────────────────────

  useEffect(() => {
    destroyedRef.current = false;

    // Fetch initial snapshot of everything on page load
    fetchTrades();
    fetchStatus();
    fetchConfig();
    fetchPnl();
    fetchOptionChain();   // immediate snapshot before SSE kicks in
    fetchAlerts();        // restore past signals from server history

    // Open SSE — all subsequent updates arrive as events
    connectSSE();

    // Refresh status every 30s (lightweight)
    const statusTimer = setInterval(fetchStatus, 30_000);

    return () => {
      destroyedRef.current = true;
      if (esRef.current)          { esRef.current.close(); esRef.current = null; }
      if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); }
      clearInterval(statusTimer);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived state ──────────────────────────────────────────────────────

  const openTrades   = trades.filter(t => t.status === 'OPEN');
  const closedTrades = trades.filter(t => t.status === 'CLOSED');

  const todayIST    = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
  const todayClosed = closedTrades.filter(t => {
    if (!t.closedTs) return false;
    return new Date(t.closedTs + IST_OFFSET_MS).toISOString().slice(0, 10) === todayIST;
  });

  return {
    trades, openTrades, closedTrades, todayClosed,
    tradeTicks, optionChain, sseConnected,
    status, config, pnl, alerts,
    fetchTrades, fetchStatus, fetchConfig, fetchPnl, fetchOptionChain,
    updateConfig, manualClose, clearTrades, refreshStrikes,
  };
}
