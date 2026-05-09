import { useEffect, useState } from 'react';
import api from './api';
import useAppStore from './store/appStore';
import useSSE from './hooks/useSSE';
import Sidebar from './components/Layout/Sidebar';
import Dashboard from './components/Dashboard/Dashboard';
import SettingsPanel from './components/Settings/SettingsPanel';
import MarketWatch from './components/Market/MarketWatch';
import ToastContainer from './components/Toast/Toast';
import './App.css';

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
  market: MarketWatch,
  settings: SettingsPanel,
};

export default function App() {
  const [activePage, setActivePage] = useState('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
