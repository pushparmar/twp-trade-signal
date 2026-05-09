import api from '../../api';
import useAppStore from '../../store/appStore';
import PaperTradingPanel from './PaperTradingPanel';

function fmt(ts) {
  return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function StatusPill({ status }) {
  const map = {
    OPEN: 'pill-blue',
    COMPLETE: 'pill-green',
    REJECTED: 'pill-red',
    FAILED: 'pill-red',
    CANCELLED: 'pill-gray',
    active: 'pill-green',
  };
  return <span className={`pill ${map[status] || 'pill-gray'}`}>{status}</span>;
}

function KiteBanner({ connected, onConnect }) {
  if (connected === null) return null;
  if (connected) {
    return (
      <div className="kite-banner kite-banner--connected">
        <span className="kite-banner-dot" />
        <span>Kite connected</span>
      </div>
    );
  }
  return (
    <div className="kite-banner kite-banner--disconnected">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span>Kite not connected — orders won't be placed</span>
      <button className="btn btn-kite-connect" onClick={onConnect}>Connect Kite →</button>
    </div>
  );
}

function SummaryCards({ signals, orders }) {
  const completedOrders = orders.filter((o) => o.status === 'COMPLETE').length;
  const failedOrders = orders.filter((o) => o.status === 'REJECTED' || o.status === 'FAILED').length;
  return (
    <div className="summary-row">
      <div className="summary-card">
        <div className="summary-icon summary-icon--blue">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
        </div>
        <div className="summary-info">
          <span className="summary-value">{signals.length}</span>
          <span className="summary-label">Signals</span>
        </div>
      </div>
      <div className="summary-card">
        <div className="summary-icon summary-icon--green">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
        </div>
        <div className="summary-info">
          <span className="summary-value">{completedOrders}</span>
          <span className="summary-label">Filled</span>
        </div>
      </div>
      <div className="summary-card">
        <div className="summary-icon summary-icon--red">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
        </div>
        <div className="summary-info">
          <span className="summary-value">{failedOrders}</span>
          <span className="summary-label">Rejected</span>
        </div>
      </div>
    </div>
  );
}

function multiVal(arr) {
  if (!arr || arr.length === 0) return '—';
  return arr.join(' / ');
}

export default function Dashboard() {
  const signals = useAppStore((s) => s.signals);
  const orders = useAppStore((s) => s.orders);
  const kiteConnected = useAppStore((s) => s.kiteConnected);
  const testMode = useAppStore((s) => s.testMode);

  async function handleKiteConnect() {
    try {
      const r = await api.get('/kite/auth/login-url');
      window.location.href = r.data.loginUrl;
    } catch (err) {
      console.error('Kite login error:', err.message);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Dashboard</h2>
          <p className="page-sub">Real-time signals and order tracking</p>
        </div>
      </div>

      {testMode ? (
        <div className="test-mode-banner">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <line x1="9" y1="15" x2="15" y2="15" />
          </svg>
          <span><strong>Test Mode</strong> — orders are simulated, nothing is sent to Kite</span>
        </div>
      ) : (
        <KiteBanner connected={kiteConnected} onConnect={handleKiteConnect} />
      )}

      {testMode ? (
        <PaperTradingPanel />
      ) : (
        <SummaryCards signals={signals} orders={orders} />
      )}

      {/* Signals */}
      <section className="dash-section">
        <h3 className="section-title">Signals <span className="count-badge">{signals.length}</span></h3>
        {signals.length === 0 ? (
          <div className="empty-card"><p>Waiting for Telegram signals…</p></div>
        ) : (
          <div className="kite-table-wrap">
            <table className="kite-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Symbol</th>
                  <th>Entries</th>
                  <th>SL</th>
                  <th>Targets</th>
                  <th>Raw</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((sig) => (
                  <tr key={sig.id}>
                    <td className="td-mono">{fmt(sig.ts)}</td>
                    <td className="td-symbol">{sig.parsed?.symbol || '—'}</td>
                    <td className="td-num">{multiVal(sig.parsed?.entries)}</td>
                    <td className="td-num td-sl">{sig.parsed?.sl ?? '—'}</td>
                    <td className="td-num td-tgt">{multiVal(sig.parsed?.targets)}</td>
                    <td className="td-raw">{sig.raw}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Orders */}
      <section className="dash-section">
        <h3 className="section-title">Orders <span className="count-badge">{orders.length}</span></h3>
        {orders.length === 0 ? (
          <div className="empty-card"><p>No orders placed yet.</p></div>
        ) : (
          <div className="kite-table-wrap">
            <table className="kite-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Symbol</th>
                  <th>Action</th>
                  <th>Price</th>
                  <th>SL</th>
                  <th>Target</th>
                  <th>Order ID</th>
                  <th>Status</th>
                  <th>GTT</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td className="td-mono">{fmt(o.ts)}</td>
                    <td className="td-symbol">{o.symbol || '—'}</td>
                    <td>
                      <span className={`pill ${o.action === 'BUY' ? 'pill-green' : 'pill-red'}`}>
                        {o.action || '—'}
                      </span>
                    </td>
                    <td className="td-num">{o.price ?? '—'}</td>
                    <td className="td-num td-sl">{o.sl ?? '—'}</td>
                    <td className="td-num td-tgt">{o.target ?? '—'}</td>
                    <td className="td-mono td-muted">{o.orderId || '—'}</td>
                    <td><StatusPill status={o.status} /></td>
                    <td>
                      {o.gttStatus
                        ? <StatusPill status={o.gttStatus} />
                        : <span className="td-muted">—</span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
