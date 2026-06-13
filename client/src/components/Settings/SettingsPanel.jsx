import { useState, useCallback, useEffect } from "react";
import api from "../../api";
import useAppStore from "../../store/appStore";

// ── helpers ───────────────────────────────────────────────────────────────────
function fmtAgo(ms) {
    if (!ms) return '—';
    const diffSec = Math.round((Date.now() - ms) / 1000);
    if (diffSec < 60)  return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
    return `${Math.round(diffSec / 3600)}h ago`;
}
function fmtIn(ms) {
    if (!ms) return '—';
    const diffSec = Math.round((ms - Date.now()) / 1000);
    if (diffSec <= 0) return 'now';
    if (diffSec < 60)  return `${diffSec}s`;
    if (diffSec < 3600) return `${Math.round(diffSec / 60)}m`;
    return `${Math.round(diffSec / 3600)}h`;
}

export default function SettingsPanel() {
    const pollingStatus = useAppStore(s => s.pollingStatus);
    const setPollingStatus = useAppStore(s => s.setPollingStatus);
    const kiteConnected = useAppStore(s => s.kiteConnected);
    const tradingDefaults = useAppStore(s => s.tradingDefaults);
    const setTradingDefaults = useAppStore(s => s.setTradingDefaults);

    const [pollError, setPollError] = useState("");
    const [savingDefaults, setSavingDefaults] = useState(false);
    const [defaultsForm, setDefaultsForm] = useState(null);
    const [debugMsgs, setDebugMsgs] = useState(null);   // null = not yet loaded
    const [debugLoading, setDebugLoading] = useState(false);

    // Scanner diagnostics
    const [scanStatus, setScanStatus] = useState(null);
    const [scanLoading, setScanLoading] = useState(false);
    const [tgTestResult, setTgTestResult] = useState(null); // null | 'ok' | 'error'
    const [tgTestMsg, setTgTestMsg] = useState('');
    const [tgTesting, setTgTesting] = useState(false);
    const [clearingDedup, setClearingDedup] = useState(false);
    const [clearingEquityCache, setClearingEquityCache] = useState(false);
    const [equityCacheMsg, setEquityCacheMsg] = useState('');

    const isRunning = pollingStatus === "running";
    const form = defaultsForm ?? tradingDefaults;

    function editDefaults(field, value) {
        setDefaultsForm(prev => ({ ...(prev ?? tradingDefaults), [field]: value }));
    }

    async function saveDefaults() {
        setSavingDefaults(true);
        try {
            const r = await api.post("/settings/trading", {
                quantity: parseInt(form.quantity, 10) || 1,
                exchange: form.exchange,
                product: form.product
            });
            setTradingDefaults(r.data);
            setDefaultsForm(null);
        } catch (err) {
            console.error("Failed to save trading defaults:", err.message);
        } finally {
            setSavingDefaults(false);
        }
    }

    async function openKiteLogin() {
        try {
            const r = await api.get("/kite/auth/login-url");
            window.location.href = r.data.loginUrl;
        } catch (err) {
            console.error("Kite login error:", err.message);
        }
    }

    const loadDebug = useCallback(async () => {
        setDebugLoading(true);
        try {
            const r = await api.get("/telegram/debug");
            setDebugMsgs(r.data.lastMessages || []);
        } catch {
            setDebugMsgs([]);
        } finally {
            setDebugLoading(false);
        }
    }, []);

    const loadScanStatus = useCallback(async () => {
        setScanLoading(true);
        try {
            const r = await api.get('/scan/bg-status');
            setScanStatus(r.data);
        } catch {
            setScanStatus(null);
        } finally {
            setScanLoading(false);
        }
    }, []);

    async function testTelegram() {
        setTgTesting(true);
        setTgTestResult(null);
        setTgTestMsg('');
        try {
            await api.post('/scan/test-telegram');
            setTgTestResult('ok');
            setTgTestMsg('✅ Test message sent! Check your Telegram.');
        } catch (err) {
            setTgTestResult('error');
            setTgTestMsg(err.response?.data?.error || err.message);
        } finally {
            setTgTesting(false);
        }
    }

    async function clearDedup() {
        setClearingDedup(true);
        try {
            await api.post('/scan/clear-dedup');
            // Reload status after clearing
            await loadScanStatus();
        } catch { /* ignore */ } finally {
            setClearingDedup(false);
        }
    }

    async function clearEquityCache() {
        if (!window.confirm('Clear equity scan results? Patterns will be recalculated on next scan.')) {
            return;
        }
        setClearingEquityCache(true);
        setEquityCacheMsg('');
        try {
            const r = await api.post('/equity-scan/clear-scan-results');
            setEquityCacheMsg(`✅ Cleared ${r.data.deleted} scan results`);
        } catch (err) {
            setEquityCacheMsg(`❌ ${err.response?.data?.error || err.message}`);
        } finally {
            setClearingEquityCache(false);
        }
    }

    async function togglePolling() {
        setPollError("");
        const action = isRunning ? "stop" : "start";
        try {
            const r = await api.post(`/telegram/${action}`);
            setPollingStatus(r.data.status);
        } catch (err) {
            setPollError(err.response?.data?.error || err.message);
        }
    }

    return (
        <div className="page">
            <div className="page-header">
                <div>
                    <h2 className="page-title">Settings</h2>
                    <p className="page-sub">Connections and trading configuration</p>
                </div>
            </div>

            <div className="settings-panel">
                {/* Kite */}
                <div className="settings-group">
                    <h3>Kite</h3>
                    <div className="connection-row">
                        <div
                            className={`conn-status-btn ${
                                kiteConnected ? "conn-status-btn--green" : "conn-status-btn--red"
                            }`}
                        >
                            <span className="conn-dot" />
                            <span>{kiteConnected ? "Connected" : "Not connected"}</span>
                        </div>
                        <button className="btn btn-primary btn-sm" onClick={openKiteLogin}>
                            {kiteConnected ? "Re-auth Kite →" : "Login to Kite →"}
                        </button>
                    </div>
                    <p className="poll-hint" style={{ marginTop: "10px" }}>
                        {kiteConnected
                            ? "Token expires daily at midnight IST — click Re-auth Kite each morning to refresh."
                            : "Login opens Kite in this tab. After authorizing, you'll be redirected back automatically."}
                    </p>
                </div>

                {/* Telegram */}
                <div className="settings-group">
                    <h3>Telegram Bot</h3>
                    <div className="connection-row">
                        <div
                            className={`conn-status-btn ${
                                isRunning ? "conn-status-btn--green" : "conn-status-btn--red"
                            }`}
                        >
                            <span className="conn-dot" />
                            <span>{isRunning ? "Polling active" : "Stopped"}</span>
                        </div>
                        <button
                            className={`btn btn-sm ${isRunning ? "btn-danger" : "btn-success"}`}
                            onClick={togglePolling}
                        >
                            {isRunning ? "Stop" : "Start"}
                        </button>
                    </div>
                    {pollError && <p className="poll-error">{pollError}</p>}

                    {/* Expected signal format hint */}
                    <div className="tg-format-hint">
                        <p className="tg-format-label">Expected message format (4 lines):</p>
                        <pre className="tg-format-pre">{`NIFTY24550CE\n216\n200\n289`}</pre>
                        <p className="tg-format-label" style={{ marginTop: 6 }}>
                            Line 1: symbol &nbsp;·&nbsp; Line 2: entry price(s) &nbsp;·&nbsp;
                            Line 3: stop-loss &nbsp;·&nbsp; Line 4: target(s) (optional)
                        </p>
                    </div>

                    {/* Debug: recent messages */}
                    <div className="tg-debug">
                        <div className="tg-debug-header">
                            <span className="tg-debug-title">Recent messages</span>
                            <button
                                className="btn btn-sm btn-secondary"
                                onClick={loadDebug}
                                disabled={debugLoading}
                            >
                                {debugLoading ? "Loading…" : "Refresh"}
                            </button>
                        </div>

                        {debugMsgs === null && (
                            <p className="tg-debug-empty">Click Refresh to inspect received messages.</p>
                        )}
                        {debugMsgs !== null && debugMsgs.length === 0 && (
                            <p className="tg-debug-empty">No messages received yet.</p>
                        )}
                        {debugMsgs !== null && debugMsgs.length > 0 && (
                            <div className="tg-debug-list">
                                {debugMsgs.map((m, i) => (
                                    <div key={i} className={`tg-debug-row tg-debug-row--${m.status === "MATCHED" ? "ok" : "err"}`}>
                                        <span className={`tg-debug-badge tg-debug-badge--${m.status === "MATCHED" ? "ok" : "err"}`}>
                                            {m.status === "MATCHED" ? "✓ matched" : "✗ no match"}
                                        </span>
                                        <span className="tg-debug-ts">{new Date(m.ts).toLocaleTimeString()}</span>
                                        <pre className="tg-debug-text">{m.text}</pre>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* Scanner Diagnostics */}
                <div className="settings-group">
                    <h3>Scanner Diagnostics</h3>

                    {/* Test outgoing Telegram */}
                    <div className="diag-row">
                        <span className="diag-label">Outgoing alerts</span>
                        <button
                            className="btn btn-sm btn-secondary"
                            onClick={testTelegram}
                            disabled={tgTesting}
                        >
                            {tgTesting ? 'Sending…' : 'Send test message'}
                        </button>
                    </div>
                    {tgTestMsg && (
                        <p className={`diag-result ${tgTestResult === 'ok' ? 'diag-result--ok' : 'diag-result--err'}`}>
                            {tgTestMsg}
                        </p>
                    )}

                    {/* Clear dedup */}
                    <div className="diag-row" style={{ marginTop: 10 }}>
                        <span className="diag-label">Dedup map</span>
                        <button
                            className="btn btn-sm btn-secondary"
                            onClick={clearDedup}
                            disabled={clearingDedup}
                            title="Clear daily dedup so all patterns can re-fire on the next scan"
                        >
                            {clearingDedup ? 'Clearing…' : 'Clear & refresh'}
                        </button>
                    </div>
                    {scanStatus && (
                        <p className="diag-hint">
                            {scanStatus.dedupSize} dedup entries · scanner {scanStatus.running ? '🟢 running' : '🔴 stopped'}
                        </p>
                    )}

                    {/* Clear equity candle cache */}
                    <div className="diag-row" style={{ marginTop: 10 }}>
                        <span className="diag-label">Equity scan results</span>
                        <button
                            className="btn btn-sm btn-secondary"
                            onClick={clearEquityCache}
                            disabled={clearingEquityCache}
                            title="Clear stored scan results. Next scan will recalculate all patterns from cached candles."
                        >
                            {clearingEquityCache ? 'Clearing…' : 'Clear & rescan'}
                        </button>
                    </div>
                    {equityCacheMsg && (
                        <p className={`diag-result ${equityCacheMsg.startsWith('✅') ? 'diag-result--ok' : 'diag-result--err'}`}>
                            {equityCacheMsg}
                        </p>
                    )}

                    {/* Background scanner next-run table */}
                    <div className="diag-row" style={{ marginTop: 10 }}>
                        <span className="diag-label">Next scan times</span>
                        <button
                            className="btn btn-sm btn-secondary"
                            onClick={loadScanStatus}
                            disabled={scanLoading}
                        >
                            {scanLoading ? 'Loading…' : 'Refresh'}
                        </button>
                    </div>
                    {scanStatus?.schedule && (
                        <table className="diag-table">
                            <thead>
                                <tr><th>TF</th><th>Last run</th><th>Next in</th></tr>
                            </thead>
                            <tbody>
                                {Object.entries(scanStatus.schedule).map(([iv, s]) => (
                                    <tr key={iv}>
                                        <td>{iv === '15minute' ? '15m' : iv === '60minute' ? '1h' : iv === '4h' ? '4h' : '1d'}</td>
                                        <td>{fmtAgo(scanStatus.lastRunAt?.[iv])}</td>
                                        <td>{fmtIn(s.fireAt)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                    {!scanStatus && !scanLoading && (
                        <p className="diag-hint">Click Refresh to check scanner health.</p>
                    )}
                </div>

                {/* Module Config */}
                <ModuleConfigPanel />

                {/* Index Trade Settings */}
                <IndexTradeSettingsPanel />

                {/* Quality Score Config */}
                <QualityScoreConfigPanel />

                {/* Pattern Config */}
                <PatternConfigPanel />
            </div>
        </div>
    );
}

// ── Index Trade Settings Panel ───────────────────────────────────────────────
// Moved from IndexTradePage - contains Trading Window, Pattern Trade, LP Scalper, RSI Filter settings

function IndexTradeSettingsPanel() {
    const [config, setConfig] = useState(null);
    const [loading, setLoading] = useState(true);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        api.get('/index-trade/config')
            .then(r => setConfig(r.data))
            .catch(() => {})
            .finally(() => setLoading(false));
    }, []);

    async function updateConfig(updates) {
        try {
            const r = await api.post('/index-trade/config', updates);
            setConfig(r.data);
        } catch (err) {
            console.error('Failed to update index trade config:', err.message);
        }
    }

    if (loading) return <div className="settings-group"><p>Loading index trade settings...</p></div>;
    if (!config) return null;

    return (
        <div className="settings-group" style={{ marginTop: 20 }}>
            <div
                onClick={() => setOpen(!open)}
                style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    cursor: 'pointer', marginBottom: open ? 12 : 0,
                }}
            >
                <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                    📊 Index Trade Settings
                    <span style={{
                        fontSize: 10, padding: '2px 6px', borderRadius: 4,
                        background: config.enabled ? '#51cf6622' : '#ff6b6b22',
                        color: config.enabled ? '#51cf66' : '#ff6b6b',
                    }}>
                        {config.enabled ? 'SCANNER ON' : 'SCANNER OFF'}
                    </span>
                </h3>
                <span style={{ fontSize: 12, color: '#868e96' }}>{open ? '▼' : '▶'}</span>
            </div>

            {open && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {/* Time Filter */}
                    <TimeFilterConfig config={config} onUpdate={updateConfig} />

                    {/* Pattern Trade Settings */}
                    <PatternTradeConfig config={config} onUpdate={updateConfig} />

                    {/* Low Premium Scalper */}
                    <LowPremiumConfig config={config} onUpdate={updateConfig} />

                    {/* RSI Filter */}
                    <RsiFilterConfig config={config} onUpdate={updateConfig} />
                </div>
            )}
        </div>
    );
}

// ── Time Filter Config ────────────────────────────────────────────────────────

function TimeFilterConfig({ config, onUpdate }) {
    if (!config) return null;

    const startTime = config.tradeStartHHMM ?? '09:20';
    const endTime   = config.tradeEndHHMM   ?? '15:15';
    const eodTime   = config.eodCloseHHMM   ?? '15:25';

    function handleChange(key, val) {
        if (/^\d{2}:\d{2}$/.test(val)) onUpdate({ [key]: val });
    }

    return (
        <div style={{ padding: '12px', background: 'var(--bg-secondary)', borderRadius: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                ⏰ Trading Time Window
                <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#51cf6622', color: '#51cf66' }}>
                    {startTime} – {endTime} IST
                </span>
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
                No new entries outside this window. All trades force-closed at EOD time.
            </p>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 }}>
                    <span style={{ color: 'var(--text-muted)' }}>No entry before</span>
                    <input type="time" className="screener-input" value={startTime}
                        onChange={e => handleChange('tradeStartHHMM', e.target.value)}
                        style={{ width: 100, fontSize: 12 }} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 }}>
                    <span style={{ color: 'var(--text-muted)' }}>No entry after</span>
                    <input type="time" className="screener-input" value={endTime}
                        onChange={e => handleChange('tradeEndHHMM', e.target.value)}
                        style={{ width: 100, fontSize: 12 }} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 }}>
                    <span style={{ color: 'var(--text-muted)' }}>EOD close</span>
                    <input type="time" className="screener-input" value={eodTime}
                        onChange={e => handleChange('eodCloseHHMM', e.target.value)}
                        style={{ width: 100, fontSize: 12 }} />
                </label>
            </div>
        </div>
    );
}

// ── Pattern Trade Config ────────────────────────────────────────────────────

function PatternTradeConfig({ config, onUpdate }) {
    if (!config) return null;

    const c = {
        maxPatternTrades: config.maxPatternTrades ?? 2,
        niftyLots:        config.niftyLots        ?? 3,
        sensexLots:       config.sensexLots       ?? 5,
        bankniftyLots:    config.bankniftyLots    ?? 3,
        tslEnabled:       config.tslEnabled       ?? true,
        tslTriggerPct:    config.tslTriggerPct    ?? 80,
        tslTrailPct:      config.tslTrailPct      ?? 70,
    };

    function handleNum(key, raw) {
        const val = parseInt(raw, 10);
        if (!isNaN(val) && val >= 0) onUpdate({ [key]: val });
    }

    return (
        <div style={{ padding: '12px', background: 'var(--bg-secondary)', borderRadius: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                📈 Pattern Trade Settings
                <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 8 }}>
                    max {c.maxPatternTrades} · NIFTY ×{c.niftyLots} · SENSEX ×{c.sensexLots}
                </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 12 }}>
                <SettingsField label="Max Trades" value={c.maxPatternTrades} onChange={v => handleNum('maxPatternTrades', v)} />
                <SettingsField label="NIFTY Lots" value={c.niftyLots} onChange={v => handleNum('niftyLots', v)} />
                <SettingsField label="SENSEX Lots" value={c.sensexLots} onChange={v => handleNum('sensexLots', v)} />
                <SettingsField label="BANKNIFTY Lots" value={c.bankniftyLots} onChange={v => handleNum('bankniftyLots', v)} />
            </div>
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
                <label style={{ fontSize: 12 }}>
                    <input type="checkbox" checked={c.tslEnabled}
                        onChange={() => onUpdate({ tslEnabled: !c.tslEnabled })} style={{ marginRight: 6 }} />
                    Enable TSL
                </label>
                {c.tslEnabled && (
                    <>
                        <SettingsField label="Trigger %" value={c.tslTriggerPct} onChange={v => handleNum('tslTriggerPct', v)} width={70} />
                        <SettingsField label="Trail %" value={c.tslTrailPct} onChange={v => handleNum('tslTrailPct', v)} width={70} />
                    </>
                )}
            </div>
        </div>
    );
}

// ── Low Premium Scalper Config ──────────────────────────────────────────────

function LowPremiumConfig({ config, onUpdate }) {
    if (!config) return null;

    const lp = {
        lowPremiumEnabled: config.lowPremiumEnabled ?? false,
        lpEntryMin:        config.lpEntryMin        ?? 5,
        lpEntryMax:        config.lpEntryMax        ?? 10,
        lpTarget:          config.lpTarget          ?? 15,
        lpTslTrigger:      config.lpTslTrigger      ?? 12,
        lpTslInitialSl:    config.lpTslInitialSl    ?? 8,
        lpTslTrailPct:     config.lpTslTrailPct     ?? 0.70,
        lpAvgDownPct:      config.lpAvgDownPct      ?? 0.60,
        lpAvgDownSlPct:    config.lpAvgDownSlPct    ?? 0.50,
        lpMaxPositions:    config.lpMaxPositions    ?? 4,
    };

    function handleField(key, raw) {
        const val = key === 'lowPremiumEnabled' ? raw : parseFloat(raw);
        if (key !== 'lowPremiumEnabled' && isNaN(val)) return;
        onUpdate({ [key]: val });
    }

    return (
        <div style={{ padding: '12px', background: 'var(--bg-secondary)', borderRadius: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                💰 Low Premium Scalper
                <span style={{
                    fontSize: 10, padding: '2px 6px', borderRadius: 4,
                    background: lp.lowPremiumEnabled ? '#51cf6622' : '#ff6b6b22',
                    color: lp.lowPremiumEnabled ? '#51cf66' : '#ff6b6b',
                }}>
                    {lp.lowPremiumEnabled ? 'ON' : 'OFF'}
                </span>
            </div>
            <label style={{ fontSize: 12, marginBottom: 12, display: 'block' }}>
                <input type="checkbox" checked={lp.lowPremiumEnabled}
                    onChange={e => handleField('lowPremiumEnabled', e.target.checked)} style={{ marginRight: 6 }} />
                Enable LP Scalper
            </label>
            {lp.lowPremiumEnabled && (
                <>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Entry Settings</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: 8, marginBottom: 12 }}>
                        <SettingsField label="Min ₹" value={lp.lpEntryMin} onChange={v => handleField('lpEntryMin', v)} />
                        <SettingsField label="Max ₹" value={lp.lpEntryMax} onChange={v => handleField('lpEntryMax', v)} />
                        <SettingsField label="Target ₹" value={lp.lpTarget} onChange={v => handleField('lpTarget', v)} />
                        <SettingsField label="Max Pos" value={lp.lpMaxPositions} onChange={v => handleField('lpMaxPositions', v)} />
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Avg-Down & TSL</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: 8 }}>
                        <SettingsField label="Drop %" value={lp.lpAvgDownPct} step="0.05" onChange={v => handleField('lpAvgDownPct', v)} />
                        <SettingsField label="SL Factor" value={lp.lpAvgDownSlPct} step="0.05" onChange={v => handleField('lpAvgDownSlPct', v)} />
                        <SettingsField label="TSL Trig ₹" value={lp.lpTslTrigger} onChange={v => handleField('lpTslTrigger', v)} />
                        <SettingsField label="TSL Init ₹" value={lp.lpTslInitialSl} onChange={v => handleField('lpTslInitialSl', v)} />
                        <SettingsField label="Trail %" value={lp.lpTslTrailPct} step="0.05" onChange={v => handleField('lpTslTrailPct', v)} />
                    </div>
                </>
            )}
        </div>
    );
}

// ── RSI Filter Config ────────────────────────────────────────────────────────

function RsiFilterConfig({ config, onUpdate }) {
    if (!config) return null;

    const c = {
        rsiFilterEnabled: config.rsiFilterEnabled ?? false,
        rsiFilterScan:    config.rsiFilterScan    ?? true,
        rsiFilterOrder:   config.rsiFilterOrder   ?? true,
        rsiBullishMin:    config.rsiBullishMin    ?? 50,
        rsiBullishMax:    config.rsiBullishMax    ?? 65,
        rsiBearishMin:    config.rsiBearishMin    ?? 35,
        rsiBearishMax:    config.rsiBearishMax    ?? 50,
    };

    function handleToggle(key) { onUpdate({ [key]: !c[key] }); }
    function handleNum(key, raw) {
        const val = parseFloat(raw);
        if (!isNaN(val)) onUpdate({ [key]: val });
    }

    return (
        <div style={{ padding: '12px', background: 'var(--bg-secondary)', borderRadius: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                📊 RSI Filter
                <span style={{
                    fontSize: 10, padding: '2px 6px', borderRadius: 4,
                    background: c.rsiFilterEnabled ? '#51cf6622' : '#ff6b6b22',
                    color: c.rsiFilterEnabled ? '#51cf66' : '#ff6b6b',
                }}>
                    {c.rsiFilterEnabled ? 'ON' : 'OFF'}
                </span>
            </div>
            <label style={{ fontSize: 12, marginBottom: 8, display: 'block' }}>
                <input type="checkbox" checked={c.rsiFilterEnabled}
                    onChange={() => handleToggle('rsiFilterEnabled')} style={{ marginRight: 6 }} />
                Enable RSI Filter
            </label>
            {c.rsiFilterEnabled && (
                <>
                    <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: 12 }}>
                        <label>
                            <input type="checkbox" checked={c.rsiFilterScan} onChange={() => handleToggle('rsiFilterScan')} /> Scan Gate
                        </label>
                        <label>
                            <input type="checkbox" checked={c.rsiFilterOrder} onChange={() => handleToggle('rsiFilterOrder')} /> Order Gate
                        </label>
                    </div>
                    <div style={{ display: 'flex', gap: 16, fontSize: 11 }}>
                        <span>Long:
                            <input type="number" value={c.rsiBullishMin} onChange={e => handleNum('rsiBullishMin', e.target.value)}
                                style={{ width: 40, marginLeft: 4, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', padding: '2px 4px' }} />
                            –<input type="number" value={c.rsiBullishMax} onChange={e => handleNum('rsiBullishMax', e.target.value)}
                                style={{ width: 40, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', padding: '2px 4px' }} />
                        </span>
                        <span>Short:
                            <input type="number" value={c.rsiBearishMin} onChange={e => handleNum('rsiBearishMin', e.target.value)}
                                style={{ width: 40, marginLeft: 4, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', padding: '2px 4px' }} />
                            –<input type="number" value={c.rsiBearishMax} onChange={e => handleNum('rsiBearishMax', e.target.value)}
                                style={{ width: 40, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', padding: '2px 4px' }} />
                        </span>
                    </div>
                </>
            )}
        </div>
    );
}

// ── Settings Field Helper ────────────────────────────────────────────────────

function SettingsField({ label, value, onChange, step = '1', width = 80 }) {
    return (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11 }}>
            <span style={{ color: 'var(--text-muted)' }}>{label}</span>
            <input type="number" value={value} step={step} min="0"
                onChange={e => onChange(e.target.value)}
                style={{
                    width, padding: '4px 6px', borderRadius: 4,
                    border: '1px solid var(--border)', background: 'var(--bg-primary)',
                    color: 'var(--text-primary)', fontSize: 12,
                }} />
        </label>
    );
}

// ── Module Config Panel ──────────────────────────────────────────────────────
// Controls which server-side services run and which UI pages are visible.

function ModuleConfigPanel() {
    const [modules, setModules] = useState({});
    const [draft, setDraft] = useState({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saveMsg, setSaveMsg] = useState('');
    const [open, setOpen] = useState(true);

    useEffect(() => {
        api.get('/settings/modules')
            .then(r => {
                console.log('[ModuleConfig] Loaded:', r.data);
                setModules(r.data);
                setDraft(r.data);
            })
            .catch((err) => {
                console.error('[ModuleConfig] Load failed:', err);
            })
            .finally(() => setLoading(false));
    }, []);

    const hasChanges = JSON.stringify(
        Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, v.enabled]))
    ) !== JSON.stringify(
        Object.fromEntries(Object.entries(modules).map(([k, v]) => [k, v.enabled]))
    );

    function toggle(moduleId) {
        setDraft(prev => ({
            ...prev,
            [moduleId]: { ...prev[moduleId], enabled: !prev[moduleId].enabled }
        }));
        setSaveMsg('');
    }

    async function save() {
        setSaving(true);
        setSaveMsg('');
        try {
            // Only send enabled state changes
            const updates = {};
            for (const [moduleId, val] of Object.entries(draft)) {
                if (val.enabled !== modules[moduleId]?.enabled) {
                    updates[moduleId] = { enabled: val.enabled };
                }
            }
            const r = await api.post('/settings/modules', updates);
            setModules(r.data);
            setDraft(r.data);
            setSaveMsg('✅ Saved — some changes may require page refresh');
            setTimeout(() => setSaveMsg(''), 5000);
        } catch (err) {
            setSaveMsg('❌ Save failed: ' + (err.response?.data?.error || err.message));
        } finally {
            setSaving(false);
        }
    }

    function reset() {
        setDraft(modules);
        setSaveMsg('');
    }

    if (loading) return <div className="settings-group"><p>Loading modules...</p></div>;

    // Group modules by category
    const serverModules = Object.entries(draft).filter(([_, m]) => m.category === 'server');
    const uiModules = Object.entries(draft).filter(([_, m]) => m.category === 'ui');

    const enabledCount = Object.values(draft).filter(m => m.enabled).length;
    const totalCount = Object.keys(draft).length;

    // Debug: show if no modules loaded
    if (totalCount === 0) {
        return (
            <div className="settings-group" style={{ marginTop: 20 }}>
                <h3>⚙️ Module Configuration</h3>
                <p style={{ color: '#ff6b6b' }}>No modules loaded. Check browser console for errors.</p>
            </div>
        );
    }

    return (
        <div className="settings-group" style={{ marginTop: 20 }}>
            <div
                onClick={() => setOpen(!open)}
                style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    cursor: 'pointer', marginBottom: open ? 12 : 0,
                }}
            >
                <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                    ⚙️ Module Configuration
                    <span style={{
                        fontSize: 11, padding: '2px 8px', borderRadius: 10,
                        background: '#228be6', color: '#fff',
                    }}>{enabledCount}/{totalCount} enabled</span>
                </h3>
                <span style={{ fontSize: 12, color: '#868e96' }}>{open ? '▼' : '▶'}</span>
            </div>

            {open && (
                <>
                    <p className="diag-hint" style={{ marginBottom: 12 }}>
                        Toggle which features run on the server and which tabs appear in the UI.
                        {hasChanges && <span style={{ color: '#ffd43b', marginLeft: 8 }}>● Unsaved changes</span>}
                    </p>

                    {/* Server-side modules */}
                    <div style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#868e96', marginBottom: 8 }}>
                            🖥️ Server-side Services
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
                            {serverModules.map(([moduleId, mod]) => {
                                const changed = mod.enabled !== modules[moduleId]?.enabled;
                                return (
                                    <div
                                        key={moduleId}
                                        onClick={() => toggle(moduleId)}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: 10,
                                            padding: '8px 12px', borderRadius: 6,
                                            background: mod.enabled ? 'rgba(81, 207, 102, 0.1)' : 'var(--bg-secondary)',
                                            border: `1px solid ${mod.enabled ? '#51cf66' : 'var(--border)'}`,
                                            cursor: 'pointer',
                                            outline: changed ? '2px solid #ffd43b' : 'none',
                                            outlineOffset: 1,
                                        }}
                                    >
                                        <span style={{
                                            width: 20, height: 20, borderRadius: 4,
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            background: mod.enabled ? '#51cf66' : 'var(--border)',
                                            color: mod.enabled ? '#fff' : 'var(--text-muted)',
                                            fontSize: 12, fontWeight: 600,
                                        }}>
                                            {mod.enabled ? '✓' : '×'}
                                        </span>
                                        <div style={{ flex: 1 }}>
                                            <div style={{ fontSize: 13, fontWeight: 500 }}>{mod.label}</div>
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{mod.description}</div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* UI modules */}
                    <div style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#868e96', marginBottom: 8 }}>
                            📱 UI Pages / Tabs
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
                            {uiModules.map(([moduleId, mod]) => {
                                const changed = mod.enabled !== modules[moduleId]?.enabled;
                                return (
                                    <div
                                        key={moduleId}
                                        onClick={() => toggle(moduleId)}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: 10,
                                            padding: '8px 12px', borderRadius: 6,
                                            background: mod.enabled ? 'rgba(77, 171, 247, 0.1)' : 'var(--bg-secondary)',
                                            border: `1px solid ${mod.enabled ? '#4dabf7' : 'var(--border)'}`,
                                            cursor: 'pointer',
                                            outline: changed ? '2px solid #ffd43b' : 'none',
                                            outlineOffset: 1,
                                        }}
                                    >
                                        <span style={{
                                            width: 20, height: 20, borderRadius: 4,
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            background: mod.enabled ? '#4dabf7' : 'var(--border)',
                                            color: mod.enabled ? '#fff' : 'var(--text-muted)',
                                            fontSize: 12, fontWeight: 600,
                                        }}>
                                            {mod.enabled ? '✓' : '×'}
                                        </span>
                                        <div>
                                            <div style={{ fontSize: 13, fontWeight: 500 }}>{mod.label}</div>
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{mod.description}</div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Save / Reset buttons */}
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <button
                            className="btn btn-primary btn-sm"
                            onClick={save}
                            disabled={!hasChanges || saving}
                        >
                            {saving ? 'Saving…' : 'Save'}
                        </button>
                        <button
                            className="btn btn-secondary btn-sm"
                            onClick={reset}
                            disabled={!hasChanges || saving}
                        >
                            Reset
                        </button>
                        {saveMsg && (
                            <span style={{ fontSize: 12, color: saveMsg.startsWith('✅') ? '#51cf66' : '#ff6b6b' }}>
                                {saveMsg}
                            </span>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

// ── Quality Score Config Panel ───────────────────────────────────────────────

const SCORE_FACTORS = [
  { label: 'Price vs Cloud',    max: '+2', desc: 'Price above (bull) or below (bear) cloud' },
  { label: 'Cloud Expanding',   max: '+2', desc: 'Cloud width growing >5% vs 5 bars ago' },
  { label: 'Chikou Free Space', max: '+2', desc: 'No obstruction at chikou plot point' },
  { label: 'HTF Aligned',       max: '+2', desc: 'Cloud position on higher timeframe agrees' },
  { label: 'Kijun Angle',       max: '+1', desc: 'Kijun slope >0.1% in signal direction' },
  { label: 'RSI Ideal Zone',    max: '+1', desc: 'RSI within configured bull/bear range' },
  { label: 'Volume',            max: '+1', desc: 'Volume ratio ≥ 1.2× average' },
];

function QualityScoreConfigPanel() {
  const [cfg, setCfg]       = useState(null);
  const [draft, setDraft]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [open, setOpen]     = useState(false);

  useEffect(() => {
    api.get('/settings/quality-score')
      .then(r => { setCfg(r.data); setDraft(r.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const hasChanges = JSON.stringify(draft) !== JSON.stringify(cfg);

  async function save() {
    setSaving(true);
    try {
      const r = await api.post('/settings/quality-score', draft);
      setCfg(r.data);
      setDraft(r.data);
    } catch (err) {
      console.error('Failed to save quality score config:', err.message);
    } finally {
      setSaving(false);
    }
  }

  function reset() { setDraft(cfg); }

  function update(field, value) {
    setDraft(prev => ({ ...prev, [field]: value }));
  }

  if (loading || !draft) return null;

  const badgeColor = draft.enabled ? '#51cf66' : '#868e96';
  const badgeLabel = draft.enabled ? 'ON' : 'OFF';

  return (
    <div style={{ marginTop: 20, border: '1px solid #343a40', borderRadius: 8, overflow: 'hidden' }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', cursor: 'pointer', background: '#25262b',
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 14 }}>
          🏅 Quality Score Filter
          <span style={{
            marginLeft: 8, fontSize: 11, padding: '2px 8px', borderRadius: 10,
            background: badgeColor, color: '#fff',
          }}>{badgeLabel}</span>
        </span>
        <span style={{ fontSize: 12, color: '#868e96' }}>{open ? '▼' : '▶'}</span>
      </div>

      {open && (
        <div style={{ padding: '12px 14px', background: '#1a1b1e' }}>
          {/* Master toggle */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={draft.enabled} onChange={e => update('enabled', e.target.checked)} />
            <span style={{ fontSize: 13 }}>Enable Quality Score Filter</span>
          </label>

          {/* Gate toggles */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
            {[
              { key: 'scanGateEnabled',  label: '📡 Scan Gate' },
              { key: 'alertGateEnabled', label: '📱 Alert Gate' },
              { key: 'orderGateEnabled', label: '📦 Order Gate' },
            ].map(({ key, label }) => (
              <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                <input type="checkbox" checked={draft[key]} onChange={e => update(key, e.target.checked)} />
                {label}
              </label>
            ))}
          </div>

          {/* Numeric fields */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 12 }}>
              Min Score (skip below):
              <input
                type="number" min={0} max={10} step={1}
                value={draft.minQualityScore}
                onChange={e => update('minQualityScore', parseInt(e.target.value, 10) || 0)}
                style={{ width: 50, marginLeft: 6, background: '#2c2e33', border: '1px solid #495057', borderRadius: 4, color: '#fff', padding: '2px 6px' }}
              />
            </label>
            <label style={{ fontSize: 12 }}>
              A-Setup threshold:
              <input
                type="number" min={0} max={10} step={1}
                value={draft.aSetupMinScore}
                onChange={e => update('aSetupMinScore', parseInt(e.target.value, 10) || 0)}
                style={{ width: 50, marginLeft: 6, background: '#2c2e33', border: '1px solid #495057', borderRadius: 4, color: '#fff', padding: '2px 6px' }}
              />
            </label>
          </div>

          {/* RSI ranges */}
          <div style={{ fontSize: 12, marginBottom: 12 }}>
            <span style={{ color: '#868e96' }}>RSI Ideal Zones:</span>
            <div style={{ display: 'flex', gap: 12, marginTop: 4, flexWrap: 'wrap' }}>
              <span>Bull: {' '}
                <input type="number" value={draft.rsiBullishMin} onChange={e => update('rsiBullishMin', +e.target.value)}
                  style={{ width: 40, background: '#2c2e33', border: '1px solid #495057', borderRadius: 4, color: '#fff', padding: '2px 4px' }}
                />–<input type="number" value={draft.rsiBullishMax} onChange={e => update('rsiBullishMax', +e.target.value)}
                  style={{ width: 40, background: '#2c2e33', border: '1px solid #495057', borderRadius: 4, color: '#fff', padding: '2px 4px' }}
                />
              </span>
              <span>Bear: {' '}
                <input type="number" value={draft.rsiBearishMin} onChange={e => update('rsiBearishMin', +e.target.value)}
                  style={{ width: 40, background: '#2c2e33', border: '1px solid #495057', borderRadius: 4, color: '#fff', padding: '2px 4px' }}
                />–<input type="number" value={draft.rsiBearishMax} onChange={e => update('rsiBearishMax', +e.target.value)}
                  style={{ width: 40, background: '#2c2e33', border: '1px solid #495057', borderRadius: 4, color: '#fff', padding: '2px 4px' }}
                />
              </span>
            </div>
          </div>

          {/* Scoring reference */}
          <details style={{ fontSize: 11, color: '#868e96', marginBottom: 12 }}>
            <summary style={{ cursor: 'pointer' }}>Scoring Reference (7 factors, max 10)</summary>
            <table style={{ width: '100%', marginTop: 6, borderCollapse: 'collapse' }}>
              <tbody>
                {SCORE_FACTORS.map(f => (
                  <tr key={f.label} style={{ borderBottom: '1px solid #2c2e33' }}>
                    <td style={{ padding: '3px 6px', color: '#dee2e6' }}>{f.label}</td>
                    <td style={{ padding: '3px 6px', color: '#51cf66', textAlign: 'center' }}>{f.max}</td>
                    <td style={{ padding: '3px 6px' }}>{f.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>

          {/* Save / Reset */}
          {hasChanges && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={save} disabled={saving}
                style={{ padding: '4px 14px', borderRadius: 4, border: 'none', background: '#228be6', color: '#fff', cursor: 'pointer', fontSize: 12 }}>
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button onClick={reset}
                style={{ padding: '4px 14px', borderRadius: 4, border: '1px solid #495057', background: 'transparent', color: '#ced4da', cursor: 'pointer', fontSize: 12 }}>
                Reset
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── TF label map ────────────────────────────────────────────────────────────
const TF_SHORT = { '15minute': '15m', '60minute': '1h', '4h': '4h', 'day': '1d' };
const CHANNELS = ['scan', 'alert', 'order'];
const CH_LABELS = { scan: 'Scan', alert: 'Telegram', order: 'Order' };
const CH_COLORS = { scan: '#4dabf7', alert: '#51cf66', order: '#ffd43b' };

function PatternConfigPanel() {
    const [patterns,  setPatterns]  = useState([]);
    const [intervals, setIntervals] = useState([]);
    const [savedConfig, setSavedConfig] = useState({});   // last-saved server state
    const [draft,     setDraft]     = useState({});        // local edits (unsaved)
    const [loading,   setLoading]   = useState(true);
    const [saving,    setSaving]    = useState(false);
    const [saveMsg,   setSaveMsg]   = useState('');

    useEffect(() => {
        api.get('/settings/pattern-config')
            .then(r => {
                setPatterns(r.data.patterns || []);
                setIntervals(r.data.intervals || []);
                const serverConfig = r.data.config || {};
                setSavedConfig(serverConfig);
                setDraft(serverConfig);
            })
            .catch(() => {})
            .finally(() => setLoading(false));
    }, []);

    // Check if draft has unsaved changes compared to savedConfig
    const hasChanges = JSON.stringify(draft) !== JSON.stringify(savedConfig);

    function isEnabled(patternId, interval, channel) {
        const key = `${patternId}:${interval}`;
        const entry = draft[key];
        if (!entry) return true;
        return entry[channel] !== false;
    }

    // Check if a cell was changed from the saved state
    function isChanged(patternId, interval, channel) {
        const key = `${patternId}:${interval}`;
        const savedEntry = savedConfig[key];
        const draftEntry = draft[key];
        const savedVal = savedEntry ? savedEntry[channel] !== false : true;
        const draftVal = draftEntry ? draftEntry[channel] !== false : true;
        return savedVal !== draftVal;
    }

    function toggle(patternId, interval, channel) {
        const key = `${patternId}:${interval}`;
        const current = isEnabled(patternId, interval, channel);
        const existing = draft[key] || { scan: true, alert: true, order: true };
        const updated  = { ...existing, [channel]: !current };
        setDraft(prev => ({ ...prev, [key]: updated }));
        setSaveMsg('');
    }

    function toggleFullRow(patternId) {
        // Check if ALL cells across ALL intervals are ON
        const allOn = intervals.every(iv =>
            CHANNELS.every(ch => isEnabled(patternId, iv, ch))
        );
        const newVal = !allOn;
        const updates = {};
        for (const iv of intervals) {
            updates[`${patternId}:${iv}`] = { scan: newVal, alert: newVal, order: newVal };
        }
        setDraft(prev => ({ ...prev, ...updates }));
        setSaveMsg('');
    }

    function resetDraft() {
        setDraft(savedConfig);
        setSaveMsg('');
    }

    async function saveDraft() {
        // Only send the keys that actually changed
        const changedEntries = {};
        for (const key of Object.keys(draft)) {
            if (JSON.stringify(draft[key]) !== JSON.stringify(savedConfig[key])) {
                changedEntries[key] = draft[key];
            }
        }
        if (Object.keys(changedEntries).length === 0) return;

        setSaving(true);
        setSaveMsg('');
        try {
            const r = await api.post('/settings/pattern-config', changedEntries);
            const newSaved = r.data.config || { ...savedConfig, ...changedEntries };
            setSavedConfig(newSaved);
            setDraft(newSaved);
            setSaveMsg('✅ Saved');
            setTimeout(() => setSaveMsg(''), 3000);
        } catch (err) {
            setSaveMsg('❌ Save failed: ' + (err.response?.data?.error || err.message));
        } finally {
            setSaving(false);
        }
    }

    if (loading) return <div className="settings-group"><h3>Pattern Config</h3><p className="diag-hint">Loading…</p></div>;

    return (
        <div className="settings-group">
            <h3>Pattern Config</h3>
            <p className="diag-hint" style={{ marginBottom: 10 }}>
                Toggle which patterns run on each timeframe for scanning, Telegram alerts, and auto orders.
                {hasChanges && <span style={{ color: '#ffd43b', marginLeft: 8 }}>● Unsaved changes</span>}
            </p>

            <div style={{ overflowX: 'auto' }}>
                <table className="diag-table" style={{ fontSize: 12, width: '100%' }}>
                    <thead>
                        <tr>
                            <th style={{ textAlign: 'left', minWidth: 120 }}>Pattern</th>
                            {intervals.map(iv => (
                                <th key={iv} colSpan={3} style={{ textAlign: 'center', borderLeft: '1px solid var(--border)' }}>
                                    {TF_SHORT[iv] || iv}
                                </th>
                            ))}
                        </tr>
                        <tr>
                            <th />
                            {intervals.map(iv =>
                                CHANNELS.map(ch => (
                                    <th key={`${iv}-${ch}`}
                                        style={{
                                            textAlign: 'center',
                                            fontSize: 10,
                                            color: CH_COLORS[ch],
                                            fontWeight: 500,
                                            borderLeft: ch === 'scan' ? '1px solid var(--border)' : 'none',
                                        }}>
                                        {CH_LABELS[ch]}
                                    </th>
                                ))
                            )}
                        </tr>
                    </thead>
                    <tbody>
                        {patterns.map(p => (
                            <tr key={p.id}>
                                <td
                                    style={{ fontWeight: 500, whiteSpace: 'nowrap', cursor: 'pointer' }}
                                    title="Click to toggle all timeframes & channels for this pattern"
                                    onClick={() => toggleFullRow(p.id)}
                                >
                                    {p.label}
                                </td>
                                {intervals.map(iv =>
                                    CHANNELS.map(ch => {
                                        const on = isEnabled(p.id, iv, ch);
                                        const changed = isChanged(p.id, iv, ch);
                                        return (
                                            <td key={`${p.id}-${iv}-${ch}`}
                                                style={{
                                                    textAlign: 'center',
                                                    cursor: 'pointer',
                                                    borderLeft: ch === 'scan' ? '1px solid var(--border)' : 'none',
                                                }}
                                                onClick={() => toggle(p.id, iv, ch)}
                                                title={`${p.label} · ${TF_SHORT[iv]} · ${CH_LABELS[ch]}: ${on ? 'ON' : 'OFF'}${changed ? ' (changed)' : ''}`}
                                            >
                                                <span style={{
                                                    display: 'inline-block',
                                                    width: 18,
                                                    height: 18,
                                                    lineHeight: '18px',
                                                    borderRadius: 4,
                                                    fontSize: 11,
                                                    background: on ? CH_COLORS[ch] + '22' : 'var(--bg-secondary)',
                                                    color: on ? CH_COLORS[ch] : 'var(--text-muted)',
                                                    border: `1px solid ${on ? CH_COLORS[ch] : 'var(--border)'}`,
                                                    outline: changed ? `2px solid ${CH_COLORS[ch]}` : 'none',
                                                    outlineOffset: 1,
                                                }}>
                                                    {on ? '✓' : '×'}
                                                </span>
                                            </td>
                                        );
                                    })
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Legend */}
            <div style={{ marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {CHANNELS.map(ch => (
                    <span key={ch} style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        <span style={{ color: CH_COLORS[ch], fontWeight: 600 }}>■</span> {CH_LABELS[ch]}
                    </span>
                ))}
            </div>

            {/* Save / Reset buttons */}
            <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
                <button
                    className="btn btn-primary btn-sm"
                    onClick={saveDraft}
                    disabled={!hasChanges || saving}
                >
                    {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                    className="btn btn-secondary btn-sm"
                    onClick={resetDraft}
                    disabled={!hasChanges || saving}
                >
                    Reset
                </button>
                {saveMsg && (
                    <span style={{ fontSize: 12, color: saveMsg.startsWith('✅') ? '#51cf66' : '#ff6b6b' }}>
                        {saveMsg}
                    </span>
                )}
            </div>
        </div>
    );
}
