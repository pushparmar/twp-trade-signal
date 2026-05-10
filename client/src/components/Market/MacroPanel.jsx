import { useState, useEffect, useCallback } from 'react';
import api from '../../api';

const SIGNAL_COLOR = { bullish: '#22c55e', bearish: '#ef4444', neutral: '#94a3b8' };
const SIGNAL_ICON  = { bullish: '↑', bearish: '↓', neutral: '→' };

const VIX_ZONE_COLOR = {
  complacency: '#f59e0b', calm: '#22c55e', normal: '#3b82f6',
  elevated: '#f97316', fear: '#ef4444', extreme: '#7c3aed',
};
const VIX_ZONE_LABEL = {
  complacency: 'Complacency', calm: 'Calm', normal: 'Normal',
  elevated: 'Elevated', fear: 'Fear', extreme: 'Extreme',
};

const TF_KEYS   = ['15m', '1h', '4h', '1d'];
const TF_LABELS = { '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' };

const ICHI_LABELS = { cloud: '☁', kijun: 'K', chikou: 'C', tenkan: 'T' };

function IchiDots({ ichi }) {
  if (!ichi) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'center', gap: 4, marginTop: 3 }}>
      {Object.entries(ICHI_LABELS).map(([key, label]) => {
        const sig = ichi[key];
        const color = SIGNAL_COLOR[sig] || '#334155';
        return (
          <span key={key} title={`${key}: ${sig}`} style={{ fontSize: 10, color, fontWeight: 600 }}>
            {label}
          </span>
        );
      })}
    </div>
  );
}

function TfCell({ tf, showZone }) {
  if (!tf) return <td style={{ color: '#334155', textAlign: 'center' }}>—</td>;
  const sigColor = SIGNAL_COLOR[tf.signal] || '#94a3b8';
  const chgColor = SIGNAL_COLOR[tf.signal] || '#94a3b8';
  return (
    <td style={{ textAlign: 'center', padding: '6px 4px' }}>
      <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#cbd5e1', marginBottom: 2 }}>
        <span style={{ color: chgColor }}>{SIGNAL_ICON[tf.signal]}</span> {tf.current}
      </div>
      {showZone && tf.zone && (
        <div style={{ fontSize: 10, color: VIX_ZONE_COLOR[tf.zone] || '#94a3b8', marginBottom: 2 }}>
          {VIX_ZONE_LABEL[tf.zone]}
        </div>
      )}
      <div style={{ fontWeight: 700, fontSize: 11, color: sigColor, letterSpacing: 0.5 }}>
        {tf.signal?.toUpperCase()}
      </div>
      <IchiDots ichi={tf.ichi} />
    </td>
  );
}

function BiasCell({ direction, confidence }) {
  const color = SIGNAL_COLOR[direction] || '#94a3b8';
  return (
    <td style={{ textAlign: 'center', padding: '6px 8px' }}>
      <div style={{
        display: 'inline-block', padding: '3px 10px', borderRadius: 99,
        background: color + '22', border: `1px solid ${color}`,
        color, fontWeight: 700, fontSize: 11, letterSpacing: 0.5,
        whiteSpace: 'nowrap',
      }}>
        {direction?.toUpperCase() ?? '—'}
      </div>
      <div style={{ fontSize: 10, color: '#475569', marginTop: 3 }}>{confidence}%</div>
    </td>
  );
}

function InstrumentRow({ label, sublabel, current, direction, confidence, timeframes, showZone }) {
  const byKey = (key) => timeframes?.find((t) => t.key === key);
  return (
    <tr>
      <td style={{ padding: '8px 4px 8px 12px', whiteSpace: 'nowrap' }}>
        <div style={{ fontWeight: 700, color: '#e2e8f0', fontSize: 13 }}>{label}</div>
        {sublabel && <div style={{ fontSize: 10, color: '#475569', marginTop: 1 }}>{sublabel}</div>}
        {current != null && (
          <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{current}</div>
        )}
      </td>
      {TF_KEYS.map((key) => (
        <TfCell key={key} tf={byKey(key)} showZone={showZone} />
      ))}
      <BiasCell direction={direction} confidence={confidence} />
    </tr>
  );
}

export default function MacroPanel() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.get('/macro/analysis');
      setData(r.data);
      setError('');
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (loading) return <div style={{ padding: 32, color: '#64748b', textAlign: 'center' }}>Loading…</div>;
  if (error)   return <div style={{ padding: 32, color: '#ef4444', textAlign: 'center' }}>{error}</div>;
  if (!data)   return null;

  const { vix, crude, usdinr } = data;

  return (
    <div style={{ padding: '0 4px' }}>
      <div className="idx-table-wrap">
        <table className="idx-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th className="idx-th-name" style={{ paddingLeft: 12 }}>Instrument</th>
              {TF_KEYS.map((k) => (
                <th key={k} className="idx-th-tf" style={{ textAlign: 'center' }}>{TF_LABELS[k]}</th>
              ))}
              <th className="idx-th-tf" style={{ textAlign: 'center' }}>Bias</th>
            </tr>
          </thead>
          <tbody>
            <InstrumentRow
              label="India VIX"
              current={vix?.currentVix}
              direction={vix?.direction}
              confidence={vix?.confidence ?? 0}
              timeframes={vix?.timeframes}
              showZone
            />
            <InstrumentRow
              label="Crude Oil"
              sublabel={crude?.tradingsymbol ?? ''}
              current={crude?.currentPrice}
              direction={crude?.direction}
              confidence={crude?.confidence ?? 0}
              timeframes={crude?.timeframes}
              showZone={false}
            />
            <InstrumentRow
              label="USD / INR"
              sublabel={usdinr?.tradingsymbol ?? ''}
              current={usdinr?.currentPrice}
              direction={usdinr?.direction}
              confidence={usdinr?.confidence ?? 0}
              timeframes={usdinr?.timeframes}
              showZone={false}
            />
          </tbody>
        </table>
      </div>

      <div style={{ padding: '10px 4px 0', fontSize: 11, color: '#475569', lineHeight: 1.8 }}>
        <span style={{ color: '#94a3b8' }}>Signals show instrument own direction. &nbsp;</span>
        VIX bullish = fear rising → equity risk &nbsp;·&nbsp;
        Crude bullish = oil rising → margin pressure &nbsp;·&nbsp;
        USDINR bullish = rupee weakening<br />
        <span style={{ color: VIX_ZONE_COLOR.calm }}>■</span> VIX &lt;16 Calm &nbsp;
        <span style={{ color: VIX_ZONE_COLOR.normal }}>■</span> 16–20 Normal &nbsp;
        <span style={{ color: VIX_ZONE_COLOR.elevated }}>■</span> 20–25 Elevated &nbsp;
        <span style={{ color: VIX_ZONE_COLOR.fear }}>■</span> &gt;25 Fear &nbsp;·&nbsp;
        ☁ K C T = Cloud Kijun Chikou Tenkan
      </div>
    </div>
  );
}
