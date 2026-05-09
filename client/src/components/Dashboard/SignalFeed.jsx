function formatTime(ts) {
  return new Date(ts).toLocaleTimeString();
}

export default function SignalFeed({ signals }) {
  if (signals.length === 0) {
    return <p className="empty-state">No signals received yet.</p>;
  }

  return (
    <ul className="signal-feed">
      {signals.map((sig) => (
        <li key={sig.id} className="signal-item">
          <span className="signal-time">{formatTime(sig.ts)}</span>
          <span className="signal-raw">{sig.raw}</span>
          {sig.parsed && (
            <span className="signal-parsed">
              {sig.parsed.action && (
                <span className={`badge ${sig.parsed.action === 'BUY' ? 'badge-green' : 'badge-red'}`}>
                  {sig.parsed.action}
                </span>
              )}
              {sig.parsed.symbol && <span className="signal-symbol">{sig.parsed.symbol}</span>}
              {sig.parsed.price != null && <span>@ {sig.parsed.price}</span>}
              {sig.parsed.sl != null && <span className="muted">SL: {sig.parsed.sl}</span>}
              {sig.parsed.trail != null && <span className="muted">Trail: {sig.parsed.trail}</span>}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
