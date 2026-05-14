import { useState, useEffect } from 'react';
import IchimokuChart from '../Market/IchimokuChart';

/**
 * ScanChartModal — opens an Ichimoku chart in a centred modal for a single
 * alert row from the screener table.
 *
 * Pre-selects the alert's timeframe but allows the user to switch TF via
 * the chip row at the top. ESC and outside-click both close the modal.
 *
 * Props:
 *   alert    { token, label, interval, tfLabel, patternLabel, signal,
 *              score, close, strength, ... } — the row that was clicked
 *   onClose  () => void
 */

const TF_OPTIONS = [
  { id: '15minute', label: '15m' },
  { id: '60minute', label: '1h'  },
  { id: '4h',       label: '4h'  },
  { id: 'day',      label: '1d'  },
];

const STRENGTH_EMOJI = { strong: '💪', neutral: '➡️', weak: '⚠️' };

export default function ScanChartModal({ alert, onClose }) {
  // Start at the alert's TF — user can switch to compare other timeframes
  const [interval, setInterval] = useState(alert?.interval || '15minute');

  // Close on ESC
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!alert) return null;

  const signalClass = alert.signal === 'bullish' ? 'scan-modal-signal--bullish' : 'scan-modal-signal--bearish';
  const signalEmoji = alert.signal === 'bullish' ? '🟢' : '🔴';
  const signalText  = alert.signal === 'bullish' ? 'BULLISH' : 'BEARISH';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card scan-modal-card" onClick={(e) => e.stopPropagation()}>
        {/* ── Header ─────────────────────────────────────────────────── */}
        <div className="modal-header scan-modal-header">
          <div className="scan-modal-title">
            <div className="scan-modal-symbol">{alert.label}</div>
            <div className="scan-modal-meta">
              <span className={`scan-modal-signal ${signalClass}`}>
                {signalEmoji} {signalText}
              </span>
              <span className="scan-modal-pattern">{alert.patternLabel || '—'}</span>
              {alert.strength && (
                <span className="scan-modal-strength">
                  {STRENGTH_EMOJI[alert.strength] || ''} {alert.strength}
                </span>
              )}
              {alert.score != null && (
                <span className="scan-modal-score">Score {alert.score}/5</span>
              )}
              {alert.close != null && (
                <span className="scan-modal-price">@ {alert.close}</span>
              )}
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {/* ── Timeframe chips ────────────────────────────────────────── */}
        <div className="scan-modal-tfs">
          <span className="scan-modal-tf-label">Timeframe:</span>
          {TF_OPTIONS.map((tf) => (
            <button
              key={tf.id}
              className={`scan-modal-tf-btn ${interval === tf.id ? 'scan-modal-tf-btn--active' : ''} ${tf.id === alert.interval ? 'scan-modal-tf-btn--alert' : ''}`}
              onClick={() => setInterval(tf.id)}
              title={tf.id === alert.interval ? 'Timeframe where the alert fired' : ''}
            >
              {tf.label}
              {tf.id === alert.interval && <span className="scan-modal-tf-dot" />}
            </button>
          ))}
        </div>

        {/* ── Chart ──────────────────────────────────────────────────── */}
        <div className="scan-modal-chart">
          <IchimokuChart token={alert.token} interval={interval} />
        </div>
      </div>
    </div>
  );
}
