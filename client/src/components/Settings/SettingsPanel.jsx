import { useState, useCallback } from "react";
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
            </div>
        </div>
    );
}
