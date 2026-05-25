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
                        {!kiteConnected && (
                            <button className="btn btn-primary btn-sm" onClick={openKiteLogin}>
                                Login to Kite →
                            </button>
                        )}
                    </div>
                    <p className="poll-hint" style={{ marginTop: "10px" }}>
                        {kiteConnected
                            ? "Access token expires daily at midnight IST — re-login each morning."
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

                {/* Pattern Config */}
                <PatternConfigPanel />
            </div>
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
