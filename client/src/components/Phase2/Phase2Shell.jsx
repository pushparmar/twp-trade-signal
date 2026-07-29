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

import { useState } from 'react';
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

  // Keep the SSE pipeline alive — the screener relies on scan alert events
  useSSE();

  return (
    <div className="p2-shell">
      <header className="p2-header">
        <div className="p2-brand">
          <span className="p2-logo">⚡</span>
          <span className="p2-title">Trade Scanner</span>
          <span className="p2-badge">Phase 2</span>
        </div>
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
