/**
 * Phase2Shell — the minimal two-tab Phase-2 app.
 *
 *   Tab 1: Screener       — the existing F&O screener (ScanAlertsPage)
 *   Tab 2: Index Strikes  — auto-scanned index option strikes (new)
 *
 * Standalone shell: no sidebar, no HeaderStrip, none of the classic pages.
 * The "Classic App" button flips localStorage app mode and reloads into
 * the full previous application.
 */

import { useState, useEffect } from 'react';
import api from '../../api';
import useSSE from '../../hooks/useSSE';
import ScanAlertsPage from '../Scanner/ScanAlertsPage';
import Phase2StrikesPage from './Phase2StrikesPage';
import './Phase2.css';

const TABS = [
  { id: 'screener', label: 'Screener' },
  { id: 'strikes', label: 'Index Strikes' },
];

export default function Phase2Shell({ onSwitchApp }) {
  const [tab, setTab] = useState('screener');
  const [health, setHealth] = useState(null);

  // Keep the SSE pipeline alive — the screener relies on scan alert events
  useSSE();

  // Kite connection health — poll every 20s
  useEffect(() => {
    const load = () => api.get('/phase2/health').then(r => setHealth(r.data)).catch(() => setHealth(null));
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, []);

  const kiteOk = health?.kiteAuthenticated;
  const tickerOk = health?.tickerConnected;

  return (
    <div className="p2-shell">
      <header className="p2-header">
        <div className="p2-brand">
          <span className="p2-logo">⚡</span>
          <span className="p2-title">Trade Scanner</span>
          <span className="p2-badge">Phase 2</span>
        </div>
        {health !== null && (
          <div className="p2-health" title={`Kite API: ${kiteOk ? 'authenticated' : 'NOT authenticated'} · Live ticker: ${tickerOk ? 'connected' : 'disconnected'} · Market: ${health.marketOpen ? 'open' : 'closed'}`}>
            <span className={`p2-health-dot ${kiteOk ? 'p2-health-dot--ok' : 'p2-health-dot--bad'}`} />
            <span className="p2-health-label">Kite {kiteOk ? 'Connected' : 'Disconnected'}</span>
            <span className={`p2-health-dot ${tickerOk ? 'p2-health-dot--ok' : 'p2-health-dot--bad'}`} />
            <span className="p2-health-label">Ticker</span>
            {!health.marketOpen && <span className="p2-health-market">Market Closed</span>}
          </div>
        )}
        <nav className="p2-tabs">
          {TABS.map(t => (
            <button
              key={t.id}
              className={`p2-tab ${tab === t.id ? 'p2-tab--active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <button className="p2-switch-btn" onClick={onSwitchApp} title="Switch to the full classic app">
          ↩ Classic App
        </button>
      </header>

      <main className="p2-main">
        {tab === 'screener' ? <ScanAlertsPage /> : <Phase2StrikesPage />}
      </main>
    </div>
  );
}
