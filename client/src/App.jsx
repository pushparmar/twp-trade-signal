import { useEffect, useRef, useState } from 'react';
import api from './api';
import useAppStore from './store/appStore';
import useSSE from './hooks/useSSE';
import Sidebar from './components/Layout/Sidebar';
import Dashboard from './components/Dashboard/Dashboard';
import SettingsPanel from './components/Settings/SettingsPanel';
import MarketWatch from './components/Market/MarketWatch';
import ScanAlertsPage from './components/Scanner/ScanAlertsPage';
import ToastContainer from './components/Toast/Toast';
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
    const openTrades = paperTrades.filter((t) => t.status === 'OPEN' && t.source === 'scan');
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
  settings:  SettingsPanel,
};

export default function App() {
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

    api.get('/paper')
      .then((r) => setPaperTrades(r.data))
      .catch(() => {});

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
