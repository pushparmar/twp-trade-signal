import { useState } from "react";
import api from "../../api";
import useAppStore from "../../store/appStore";

export default function SettingsPanel() {
    const pollingStatus = useAppStore(s => s.pollingStatus);
    const setPollingStatus = useAppStore(s => s.setPollingStatus);
    const kiteConnected = useAppStore(s => s.kiteConnected);
    const tradingDefaults = useAppStore(s => s.tradingDefaults);
    const setTradingDefaults = useAppStore(s => s.setTradingDefaults);

    const [pollError, setPollError] = useState("");
    const [savingDefaults, setSavingDefaults] = useState(false);
    const [defaultsForm, setDefaultsForm] = useState(null);

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
                </div>
            </div>
        </div>
    );
}
