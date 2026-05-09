import { useState } from 'react';
import SignalFeed from './SignalFeed';
import OrderTable from './OrderTable';

export default function SystemCard({ system, signals, orders }) {
  const [tab, setTab] = useState('signals');

  return (
    <div className="system-card">
      <div className="card-header">
        <span className="card-title">{system.name}</span>
        <span className="card-meta">
          {system.orderConfig?.exchange} · {system.orderConfig?.orderType}
        </span>
        <span className={`badge ${system.orderConfig?.autoPlace ? 'badge-green' : 'badge-gray'}`}>
          {system.orderConfig?.autoPlace ? 'Auto' : 'Manual'}
        </span>
      </div>

      <div className="card-tabs">
        <button
          className={`tab-btn ${tab === 'signals' ? 'tab-active' : ''}`}
          onClick={() => setTab('signals')}
        >
          Signals ({signals.length})
        </button>
        <button
          className={`tab-btn ${tab === 'orders' ? 'tab-active' : ''}`}
          onClick={() => setTab('orders')}
        >
          Orders ({orders.length})
        </button>
      </div>

      <div className="card-body">
        {tab === 'signals' ? (
          <SignalFeed signals={signals} />
        ) : (
          <OrderTable orders={orders} />
        )}
      </div>
    </div>
  );
}
