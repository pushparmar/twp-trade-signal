import { useEffect, useRef, useState } from 'react';
import api from './api';
import useAppStore from './store/appStore';
import useSSE from './hooks/useSSE';
import Sidebar from './components/Layout/Sidebar';
import Dashboard from './components/Dashboard/Dashboard';
import SettingsPanel from './components/Settings/SettingsPanel';
import MarketWatch from './components/Market/MarketWatch';
import ScanAlertsPage from './components/Scanner/ScanAlertsPage';
import AnalyticsPage from './components/Analytics/AnalyticsPage';
import ToastContainer from './components/Toast/Toast';
import LoginPage from './components/Auth/LoginPage';
import './App.css';

// ── Global paper-trade auto-close watcher ─────────────────────────────────────
// Watches live ticks for every open scan-sourced paper trade and auto-closes
// when SL or target is hit. Runs at the App level so it stays active regardless
// of which tab (Dashboard / Scanner / Market) the user is on.
function usePaperAutoClose() {
  const paperTrades         = useAppStore((s) => s.paperTrades);
  const ticks               = useAppStore((s) => s.ticks);
  const closeScanPaperTrade = useAppStore((s) => s.closeScanPaperTrade);
  const addToast            = useAppStore((s) => s.addToast);
  // Ref prevents double-closing the same trade in React strict-mode double-effects
  const closedIds = useRef(new Set());

  useEffect(() => {
    // Monitor all scan-originated and auto-placed trades for SL / target hits
    const openTrades = paperTrades.filter(
      (t) => t.status === 'OPEN' && (t.source === 'scan' || t.source === 'auto'),
    );
    if (openTrades.length === 0) return;

    for (const trade of openTrades) {
      if (closedIds.current.has(trade.id)) continue;
      const ltp = ticks[trade.token]?.lastPrice;
      if (ltp == null) continue;

      let closeAt  = null;
      let msg      = '';

      if (trade.action === 'BUY') {
        if (trade.sl != null && ltp <= trade.sl) {
          closeAt = trade.sl;
          msg = `🛑 SL hit — ${trade.symbol} closed @ ₹${ltp.toFixed(2)}`;
        } else if (trade.target != null && ltp >= trade.target) {
          closeAt = trade.target;
          msg = `🎯 Target hit — ${trade.symbol} closed @ ₹${ltp.toFixed(2)}`;
        }
      } else if (trade.action === 'SELL') {
        if (trade.sl != null && ltp >= trade.sl) {
          closeAt = trade.sl;
          msg = `🛑 SL hit — ${trade.symbol} closed @ ₹${ltp.toFixed(2)}`;
        } else if (trade.target != null && ltp <= trade.target) {
          closeAt = trade.target;
          msg = `🎯 Target hit — ${trade.symbol} closed @ ₹${ltp.toFixed(2)}`;
        }
      }

      if (closeAt != null) {
        closedIds.current.add(trade.id);
        closeScanPaperTrade(trade.id, closeAt);
        addToast({ type: 'info', message: msg });
        // Sync the auto-close to the server so trades-current.json reflects
        // the closed status and the 6 AM archive captures correct P&L.
        api.post(`/paper/${trade.id}/close`, { exitPrice: closeAt }).catch(() => {});
      }
    }
  }, [ticks, paperTrades, closeScanPaperTrade, addToast]);
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
