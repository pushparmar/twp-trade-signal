function statusClass(status) {
  if (!status) return 'badge-gray';
  const s = status.toUpperCase();
  if (s === 'COMPLETE') return 'badge-green';
  if (s === 'REJECTED' || s === 'FAILED' || s === 'CANCELLED') return 'badge-red';
  if (s === 'OPEN' || s === 'TRIGGER PENDING') return 'badge-yellow';
  return 'badge-gray';
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString();
}

export default function OrderTable({ orders }) {
  if (orders.length === 0) {
    return <p className="empty-state">No orders placed yet.</p>;
  }

  return (
    <table className="order-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Symbol</th>
          <th>Action</th>
          <th>Price</th>
          <th>Order ID</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((order) => (
          <tr key={order.id}>
            <td>{formatTime(order.ts)}</td>
            <td><strong>{order.symbol}</strong></td>
            <td>
              <span className={`badge ${order.action === 'BUY' ? 'badge-green' : 'badge-red'}`}>
                {order.action}
              </span>
            </td>
            <td>{order.price ?? '—'}</td>
            <td className="muted">{order.orderId || '—'}</td>
            <td>
              <span className={`badge ${statusClass(order.status)}`}>{order.status || 'UNKNOWN'}</span>
              {order.error && <span className="error-text" title={order.error}> ⚠</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
