import { useEffect, useRef, useState } from 'react';
import api from './api';
import useAppStore from './store/appStore';
import useSSE from './hooks/useSSE';
import Sidebar from './components/Layout/Sidebar';
import HeaderStrip from './components/Layout/HeaderStrip';
import Dashboard from './components/Dashboard/Dashboard';
import SettingsPanel from './components/Settings/SettingsPanel';
import MarketWatch from './components/Market/MarketWatch';
import ScanAlertsPage from './components/Scanner/ScanAlertsPage';
import AnalyticsPage from './components/Analytics/AnalyticsPage';
import BacktestPage from './components/Backtest/BacktestPage';
import ToastContainer from './components/Toast/Toast';
import LoginPage from './components/Auth/LoginPage';
import './App.css';

// ── Client-side fallback for SL / Target / TSL ────────────────────────────────
// The server-side tradeWatcher.js is the authoritative path — it runs on raw
// ticks, has access to ohlc.high/low (catches gap-throughs), persists every
// state change, and broadcasts paper_trade_update SSE so all clients sync.
//
// This client hook now exists ONLY as a fallback for when SSE drops or the
// server-side watcher is unavailable (e.g. older deployment).  It uses the
// same logic but PATCH /trail and POST /close calls become no-ops when the
// server has already processed the close (server returns 404, we ignore).
function usePaperAutoClose() {
  const paperTrades         = useAppStore((s) => s.paperTrades);
  const ticks               = useAppStore((s) => s.ticks);
  const closeScanPaperTrade = useAppStore((s) => s.closeScanPaperTrade);
  const updatePaperTrade    = useAppStore((s) => s.updatePaperTrade);
  const addToast            = useAppStore((s) => s.addToast);
  // Ref prevents double-closing the same trade in React strict-mode double-effects
  const closedIds  = useRef(new Set());
  // Cache TSL settings — refetched lazily, no need for SSE
  const tslSettings = useRef(null);

  // Lazy-load TSL settings on first use
  useEffect(() => {
    api.get('/auto-trader/settings')
      .then((r) => { tslSettings.current = r.data; })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const openTrades = paperTrades.filter(
      (t) => t.status === 'OPEN' && (t.source === 'scan' || t.source === 'auto'),
    );
    if (openTrades.length === 0) return;

    const tslCfg = tslSettings.current;
    const tslEnabled   = !!tslCfg?.tslEnabled;
    const tslTriggerR  = tslCfg?.tslTriggerR  ?? 1.0;
    const tslDistanceR = tslCfg?.tslDistanceR ?? 0.5;

    for (const trade of openTrades) {
      if (closedIds.current.has(trade.id)) continue;
      const ltp = ticks[trade.token]?.lastPrice;
      if (ltp == null) continue;

      // ── 1. TRAILING STOP LOSS ─────────────────────────────────────────────
      // Only run TSL when enabled, an initialSl is present (set at trade open),
      // and we have a clean BUY/SELL direction.
      const initialSl  = trade.initialSl ?? trade.sl;
      const riskPerUnit = Math.abs(trade.entryPrice - initialSl);
      if (tslEnabled && riskPerUnit > 0.01 && (trade.action === 'BUY' || trade.action === 'SELL')) {
        // Profit in price-units (per share) so far
        const profit = trade.action === 'BUY'
          ? ltp - trade.entryPrice
          : trade.entryPrice - ltp;

        if (profit >= tslTriggerR * riskPerUnit) {
          // Track the favourable extreme
          const prevPeak = trade.peakPrice ?? trade.entryPrice;
          const newPeak  = trade.action === 'BUY' ? Math.max(prevPeak, ltp) : Math.min(prevPeak, ltp);

          // New SL = trail tslDistanceR × risk behind the peak
          const trailGap = tslDistanceR * riskPerUnit;
          const candidateSl = trade.action === 'BUY' ? newPeak - trailGap : newPeak + trailGap;

          // SL may only move favourably (never widen) — and must clear break-even
          const shouldMove = trade.action === 'BUY'
            ? candidateSl > (trade.sl ?? -Infinity)
            : candidateSl < (trade.sl ?? Infinity);

          if (shouldMove) {
            const newSl = Math.round(candidateSl * 100) / 100;
            // Update local state immediately for snappy UI
            updatePaperTrade({ ...trade, sl: newSl, peakPrice: newPeak, tslActivated: true });
            // Persist server-side (mirrored to MongoDB inside the route)
            api.patch(`/paper/${trade.id}/trail`, {
              sl: newSl, peakPrice: newPeak, tslActivated: true,
            }).catch(() => {});
            // First-time activation toast
            if (!trade.tslActivated) {
              addToast({ type: 'info', message: `🔒 TSL armed — ${trade.symbol} SL → ₹${newSl.toFixed(2)}` });
            }
            // Continue to SL/target check below using the new SL via local ref
            trade.sl = newSl;
          }
        }
      }

      // ── 2. SL / TARGET HIT CHECK ──────────────────────────────────────────
      let closeAt = null;
      let msg     = '';

      if (trade.action === 'BUY') {
        if (trade.sl != null && ltp <= trade.sl) {
          closeAt = trade.sl;
          msg = `${trade.tslActivated ? '🔒' : '🛑'} ${trade.tslActivated ? 'TSL' : 'SL'} hit — ${trade.symbol} @ ₹${ltp.toFixed(2)}`;
        } else if (trade.target != null && ltp >= trade.target) {
          closeAt = trade.target;
          msg = `🎯 Target hit — ${trade.symbol} @ ₹${ltp.toFixed(2)}`;
        }
      } else if (trade.action === 'SELL') {
        if (trade.sl != null && ltp >= trade.sl) {
          closeAt = trade.sl;
          msg = `${trade.tslActivated ? '🔒' : '🛑'} ${trade.tslActivated ? 'TSL' : 'SL'} hit — ${trade.symbol} @ ₹${ltp.toFixed(2)}`;
        } else if (trade.target != null && ltp <= trade.target) {
          closeAt = trade.target;
          msg = `🎯 Target hit — ${trade.symbol} @ ₹${ltp.toFixed(2)}`;
        }
      }

      if (closeAt != null) {
        closedIds.current.add(trade.id);
        closeScanPaperTrade(trade.id, closeAt);
        addToast({ type: 'info', message: msg });
        api.post(`/paper/${trade.id}/close`, { exitPrice: closeAt }).catch(() => {});
      }
    }
  }, [ticks, paperTrades, closeScanPaperTrade, updatePaperTrade, addToast]);
}

function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggle = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  return { theme, toggle };
}

const PAGES = {
  dashboard: Dashboard,
  market:    MarketWatch,
  scanner:   ScanAlertsPage,
  analytics: AnalyticsPage,
  backtest:  BacktestPage,
  settings:  SettingsPanel,
};

// ── Authenticated shell ────────────────────────────────────────────────────────
// Extracted into its own component so all hooks are called unconditionally,
// regardless of whether the user is logged in (satisfies React rules of hooks).
function AppShell() {
  const [activePage, setActivePage] = useState('market');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Settings tab visible only when ?setting=1 is in the URL
  const showSettings = new URLSearchParams(window.location.search).get('setting') === '1';
  const setKiteConnected = useAppStore((s) => s.setKiteConnected);
  const setPollingStatus = useAppStore((s) => s.setPollingStatus);
  const setTestMode = useAppStore((s) => s.setTestMode);
  const setPaperTrades = useAppStore((s) => s.setPaperTrades);
  const setPaperBalance = useAppStore((s) => s.setPaperBalance);
  const setTradingDefaults = useAppStore((s) => s.setTradingDefaults);
  const testMode = useAppStore((s) => s.testMode);
  const pollingStatus = useAppStore((s) => s.pollingStatus);
  const signals = useAppStore((s) => s.signals);
  const orders = useAppStore((s) => s.orders);
  const tickerConnected = useAppStore((s) => s.tickerConnected);
  const { theme, toggle: toggleTheme } = useTheme();

  useSSE();
  usePaperAutoClose();

  useEffect(() => {
    api.get('/kite/auth/status')
      .then((r) => setKiteConnected(r.data.authenticated))
      .catch(() => setKiteConnected(false));

    api.get('/telegram/status')
      .then((r) => setPollingStatus(r.data.isPolling ? 'running' : 'stopped'))
      .catch(() => {});

    api.get('/paper/mode')
      .then((r) => setTestMode(r.data.testMode))
      .catch(() => {});

    // Primary load: in-memory server store (fast, always works)
    api.get('/paper')
      .then((r) => setPaperTrades(r.data))
      .catch(() => {})
      .finally(() => {
        // Secondary sync: pull OPEN trades directly from MongoDB.
        // Merges in any trades the client is missing (e.g. after localStorage
        // was cleared or logging in from a new device).  No-op when MongoDB
        // is not configured (server returns []).
        api.get('/paper/open-from-db').then((r) => {
          if (!r.data?.length) return;
          // Merge MongoDB open trades into current state.
          // useAppStore.getState() lets us read current trades without a hook.
          const current = useAppStore.getState().paperTrades || [];
          const existingIds = new Set(current.map((t) => t.id));
          const missing = r.data.filter((t) => !existingIds.has(t.id));
          if (missing.length) {
            setPaperTrades([...missing, ...current]);
          }
        }).catch(() => {});
      });

    api.get('/paper/balance')
      .then((r) => setPaperBalance(r.data))
      .catch(() => {});

    api.get('/settings/trading')
      .then((r) => setTradingDefaults(r.data))
      .catch(() => {});

    const params = new URLSearchParams(window.location.search);
    if (params.get('kite') === 'connected') {
      setKiteConnected(true);
      window.history.replaceState({}, '', '/');
    }
  }, [setKiteConnected, setPollingStatus, setTestMode, setPaperTrades, setPaperBalance, setTradingDefaults]);

  const ActiveComponent = PAGES[activePage];

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar
        activePage={activePage}
        onNavigate={setActivePage}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        theme={theme}
        onToggleTheme={toggleTheme}
        pollingStatus={pollingStatus}
        signalCount={signals.length}
        orderCount={orders.length}
        tickerConnected={tickerConnected}
        testMode={testMode}
        showSettings={showSettings}
        onToggleTestMode={() => {
          const next = !testMode;
          setTestMode(next);
          api.post('/paper/mode', { enabled: next }).catch(() => {});
        }}
      />
      <div className="main-area">
        <HeaderStrip />
        <ActiveComponent />
      </div>
      <ToastContainer />
    </div>
  );
}

// ── Root — auth gate ───────────────────────────────────────────────────────────
// Renders either the login screen or the full app shell based on the stored flag.
export default function App() {
  // A simple localStorage flag keeps the session alive across refreshes.
  // LoginPage sets twp_auth='1' on success; clearing it here forces a re-login.
  const [loggedIn, setLoggedIn] = useState(() => localStorage.getItem('twp_auth') === '1');

  if (!loggedIn) {
    return <LoginPage onLogin={() => setLoggedIn(true)} />;
  }

  return <AppShell />;
}
