import { useState, useEffect, useCallback } from 'react';
import api from '../../api';

const ZONE_COLOR = {
  complacency: '#f59e0b',
  calm:        '#22c55e',
  normal:      '#3b82f6',
  elevated:    '#f97316',
  fear:        '#ef4444',
  extreme:     '#7c3aed',
};

const ZONE_LABEL = {
  complacency: 'Complacency',
  calm:        'Calm',
  normal:      'Normal',
  elevated:    'Elevated',
  fear:        'Fear',
  extreme:     'Extreme Fear',
};

const TREND_ICON = { rising: '↑', falling: '↓', flat: '→' };

const SIGNAL_COLOR = { bullish: '#22c55e', bearish: '#ef4444', neutral: '#94a3b8' };

function DirectionBadge({ direction, confidence, currentVix }) {
  const color = SIGNAL_COLOR[direction] || '#94a3b8';
  const label = direction === 'bullish' ? 'BULLISH'
    : direction === 'bearish' ? 'BEARISH'
    : 'NEUTRAL';

  return (
    <div style={{ textAlign: 'center', padding: '20px 0 16px' }}>
      <div style={{ fontSize: 11, color: '#94a3b8', letterSpacing: 1, marginBottom: 6 }}>
        INDIA VIX  {currentVix != null && <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{currentVix}</span>}
      </div>
      <div style={{
        display: 'inline-block',
        padding: '6px 24px',
        borderRadius: 99,
        background: color + '22',
        border: `1.5px solid ${color}`,
        color,
        fontWeight: 700,
        fontSize: 18,
        letterSpacing: 2,
      }}>
        {label}
      </div>
      <div style={{ fontSize: 12, color: '#64748b', marginTop: 8 }}>
        {confidence}% timeframes agree
      </div>
    </div>
  );
}

function TfRow({ tf }) {
  const zoneColor = ZONE_COLOR[tf.zone] || '#94a3b8';
  const sigColor  = SIGNAL_COLOR[tf.signal] || '#94a3b8';

  return (
    <tr>
      <td style={{ fontWeight: 600, color: '#e2e8f0', paddingLeft: 12 }}>{tf.label}</td>
      <td style={{ fontFamily: 'monospace', color: '#e2e8f0' }}>{tf.current}</td>
      <td style={{
        fontFamily: 'monospace',
        color: tf.change > 0 ? '#ef4444' : tf.change < 0 ? '#22c55e' : '#94a3b8',
      }}>
        {tf.change > 0 ? '+' : ''}{tf.change}
      </td>
      <td style={{ color: tf.change > 0 ? '#ef4444' : tf.change < 0 ? '#22c55e' : '#94a3b8' }}>
        {TREND_ICON[tf.trend]} {tf.trend}
      </td>
      <td>
        <span style={{
          fontSize: 11,
          padding: '2px 8px',
          borderRadius: 99,
          background: zoneColor + '22',
          color: zoneColor,
          fontWeight: 600,
        }}>
          {ZONE_LABEL[tf.zone]}
        </span>
      </td>
      <td>
        <span style={{ fontWeight: 700, color: sigColor }}>
          {tf.signal.toUpperCase()}
        </span>
      </td>
    </tr>
  );
}

export default function VixPanel() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const fetch = useCallback(async () => {
    try {
      const r = await api.get('/vix/analysis');
      setData(r.data);
      setError('');
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
    const t = setInterval(fetch, 60_000);
    return () => clearInterval(t);
  }, [fetch]);

  if (loading) return <div style={{ padding: 32, color: '#64748b', textAlign: 'center' }}>Loading VIX…</div>;
  if (error)   return <div style={{ padding: 32, color: '#ef4444', textAlign: 'center' }}>{error}</div>;
  if (!data)   return null;

  return (
    <div style={{ padding: '0 4px' }}>
      <DirectionBadge
        direction={data.direction}
        confidence={data.confidence}
        currentVix={data.currentVix}
      />

      <div className="kite-table-wrap">
        <table className="kite-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ paddingLeft: 12 }}>TF</th>
              <th>VIX</th>
              <th>Change</th>
              <th>Trend</th>
              <th>Zone</th>
              <th>Signal</th>
            </tr>
          </thead>
          <tbody>
            {data.timeframes.map((tf) => <TfRow key={tf.key} tf={tf} />)}
          </tbody>
        </table>
      </div>

      <div style={{ padding: '12px 4px 0', fontSize: 11, color: '#475569', lineHeight: 1.7 }}>
        <strong style={{ color: '#64748b' }}>VIX Zones</strong><br />
        <span style={{ color: ZONE_COLOR.calm }}>■</span> Calm (&lt;16) — low fear, bullish bias &nbsp;
        <span style={{ color: ZONE_COLOR.normal }}>■</span> Normal (16–20) &nbsp;
        <span style={{ color: ZONE_COLOR.elevated }}>■</span> Elevated (20–25) — caution &nbsp;
        <span style={{ color: ZONE_COLOR.fear }}>■</span> Fear (&gt;25) — bearish, watch for reversal
      </div>
    </div>
  );
}
