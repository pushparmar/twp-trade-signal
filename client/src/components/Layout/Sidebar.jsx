import useAppStore from "../../store/appStore";

// ── Constants mirrored from MarketWatch (kept in sync) ────────────────────────
const TAB_INDEX = {
    NIFTY: { match: "NIFTY 50", label: "Nifty 50" },
    BANKNIFTY: { match: "NIFTY BANK", label: "Bank Nifty" },
    SENSEX: { match: "SENSEX", label: "Sensex" }
};
const INDEX_NAMES = new Set(["NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY", "BANKEX"]);
const INDEX_SYMBOLS = new Set(["NIFTY 50", "NIFTY BANK", "SENSEX"]);
const MACRO_KEYS = [
    { key: "vix", label: "India VIX" },
    { key: "crude", label: "Crude Oil" },
    { key: "gold", label: "Gold" },
    { key: "silver", label: "Silver" },
    { key: "naturalgas", label: "Natural Gas" },
    { key: "usdinr", label: "USD / INR" }
];

function fmt(n) {
    if (n == null || isNaN(n)) return "—";
    return Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Single instrument item in the sidebar ────────────────────────────────────
function InstItem({ token, label, sublabel, active, onClick }) {
    const tick = useAppStore(s => (token ? s.ticks[token] : null));
    const ltp = tick?.lastPrice ?? null;
    const change = tick?.change ?? null;
    const chgCls = change > 0 ? "mw-up" : change < 0 ? "mw-down" : "";

    return (
        <div className={`sidebar-inst-item ${active ? "sidebar-inst-item--active" : ""}`} onClick={onClick}>
            <div className="sidebar-inst-name">{label}</div>
            {sublabel && <div className="sidebar-inst-sub">{sublabel}</div>}
            <div className="sidebar-inst-price">
                <span className="sidebar-inst-ltp">{ltp != null ? fmt(ltp) : "—"}</span>
                {change != null && (
                    <span className={`sidebar-inst-chg ${chgCls}`}>
                        {change > 0 ? "+" : ""}
                        {Number(change).toFixed(2)}%
                    </span>
                )}
            </div>
        </div>
    );
}

// ── Nav items ─────────────────────────────────────────────────────────────────
const NAV_ITEMS = [
    {
        id: "dashboard",
        label: "Dashboard",
        icon: (
            <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
        )
    },
    {
        id: "market",
        label: "Market Watch",
        icon: (
            <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
                <polyline points="16 7 22 7 22 13" />
            </svg>
        )
    },
    {
        id: "scanner",
        label: "Scanner",
        icon: (
            <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                <polyline points="11 8 11 11 13 13" />
            </svg>
        )
    },
    {
        id: "analytics",
        label: "Analytics",
        icon: (
            <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <line x1="18" y1="20" x2="18" y2="10" />
                <line x1="12" y1="20" x2="12" y2="4" />
                <line x1="6" y1="20" x2="6" y2="14" />
            </svg>
        )
    },
    {
        id: "backtest",
        label: "Backtest",
        icon: (
            <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <polyline points="3 12 7 16 13 8 17 12 21 6" />
                <path d="M3 21h18" />
            </svg>
        )
    },
    {
        id: "index-trade",
        label: "Index Trade",
        icon: (
            <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path d="M2 20h20" />
                <path d="M5 20V10l4-6 4 8 4-4 4 6v6" />
            </svg>
        )
    },
    {
        id: "equity-scan",
        label: "Equity Scan",
        icon: (
            <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="3" y1="9" x2="21" y2="9" />
                <line x1="3" y1="15" x2="21" y2="15" />
                <line x1="9" y1="9" x2="9" y2="21" />
            </svg>
        )
    },
    {
        id: "settings",
        label: "Settings",
        icon: (
            <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
            </svg>
        )
    }
];

// ── Main Sidebar component ────────────────────────────────────────────────────
export default function Sidebar({
    activePage,
    onNavigate,
    collapsed,
    onToggleCollapse,
    theme,
    onToggleTheme,
    pollingStatus,
    signalCount,
    orderCount,
    testMode,
    onToggleTestMode,
    tickerConnected,
    showSettings = false
}) {
    const isLive = pollingStatus === "running";
    const isMarket = activePage === "market";
    // Settings tab is hidden by default (visible only when ?setting=1 is in the URL).
    // All other tabs — including analytics — are always visible.
    const visibleNav = NAV_ITEMS.filter(item => item.id !== "settings" || showSettings);
    const scanAlerts = useAppStore(s => s.scanAlerts);
    const scanCount = scanAlerts.length;

    // Instrument list data — only needed when on market page
    const watchlist = useAppStore(s => s.watchlist);
    const macroData = useAppStore(s => s.macroData);
    const selectedInstrument = useAppStore(s => s.selectedInstrument);
    const setSelectedInstrument = useAppStore(s => s.setSelectedInstrument);

    const indexSidebarItems = Object.entries(TAB_INDEX).map(([key, info]) => {
        const inst = watchlist.find(i => i.tradingsymbol === info.match);
        return { key, label: info.label, token: inst?.instrumentToken ?? null };
    });

    function selectInstrument(item) {
        setSelectedInstrument(item);
        // Navigate to market page if not already there
        if (activePage !== "market") onNavigate("market");
    }

    return (
        <aside
            className={`sidebar ${collapsed ? "sidebar--collapsed" : ""} ${
                isMarket && !collapsed ? "sidebar--market" : ""
            }`}
        >
            {/* Brand */}
            <div className="sidebar-brand">
                <div className="brand-logo">
                    <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="var(--blue)"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
                        <polyline points="16 7 22 7 22 13" />
                    </svg>
                </div>
                {!collapsed && <span className="brand-text">TWP</span>}
                <button
                    className="sidebar-collapse-btn"
                    onClick={onToggleCollapse}
                    title={collapsed ? "Expand" : "Collapse"}
                >
                    <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        {collapsed ? <polyline points="9 18 15 12 9 6" /> : <polyline points="15 18 9 12 15 6" />}
                    </svg>
                </button>
            </div>

            {/* Connection status indicators */}
            {/* <div className={`sidebar-conn-status ${collapsed ? 'sidebar-conn-status--collapsed' : ''}`}>
        <div
          className={`conn-indicator ${isLive ? 'conn-indicator--on' : 'conn-indicator--off'}`}
          title={isLive ? 'Telegram: polling active' : 'Telegram: stopped'}
        >
          <span className={`conn-indicator-dot ${isLive ? 'conn-indicator-dot--on' : 'conn-indicator-dot--off'}`} />
          {!collapsed && (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="conn-indicator-icon">
                <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.12 14.12l-2.96-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.828.44z"/>
              </svg>
              <span className="conn-indicator-label">Telegram</span>
            </>
          )}
        </div>
        <div
          className={`conn-indicator ${tickerConnected ? 'conn-indicator--on' : 'conn-indicator--off'}`}
          title={tickerConnected ? 'Kite ticker: connected' : 'Kite ticker: disconnected'}
        >
          <span className={`conn-indicator-dot ${tickerConnected ? 'conn-indicator-dot--on' : 'conn-indicator-dot--off'}`} />
          {!collapsed && (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="conn-indicator-icon">
                <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
                <polyline points="16 7 22 7 22 13" />
              </svg>
              <span className="conn-indicator-label">Kite Ticker</span>
            </>
          )}
        </div>
      </div> */}

            {/* Navigation */}
            <nav className="sidebar-nav">
                {visibleNav.map(item => (
                    <button
                        key={item.id}
                        className={`sidebar-nav-item ${activePage === item.id ? "sidebar-nav-item--active" : ""}`}
                        onClick={() => onNavigate(item.id)}
                        title={collapsed ? item.label : undefined}
                    >
                        <span className="nav-icon">{item.icon}</span>
                        {!collapsed && <span className="nav-label">{item.label}</span>}
                        {!collapsed && item.id === "dashboard" && signalCount > 0 && (
                            <span className="nav-badge">{signalCount}</span>
                        )}
                        {!collapsed && item.id === "scanner" && scanCount > 0 && (
                            <span className="nav-badge nav-badge--scan">{scanCount}</span>
                        )}
                    </button>
                ))}
            </nav>

            {/* ── Instrument list — shown when on Market Watch page and not collapsed ── */}
            {isMarket && !collapsed && (
                <div className="sidebar-instruments">
                    {/* Indices */}
                    <div className="sidebar-inst-section">Indices</div>
                    {indexSidebarItems.map(item => (
                        <InstItem
                            key={item.key}
                            token={item.token}
                            label={item.label}
                            active={selectedInstrument?.type === "index" && selectedInstrument.key === item.key}
                            onClick={() =>
                                selectInstrument({ type: "index", key: item.key, token: item.token, label: item.label })
                            }
                        />
                    ))}

                    {/* Macro */}
                    <div className="sidebar-inst-section">Macro</div>
                    {MACRO_KEYS.map(m => {
                        const md = macroData?.[m.key];
                        const token = md?.instrumentToken ?? null;
                        const sub = md?.tradingsymbol ?? "";
                        return (
                            <InstItem
                                key={m.key}
                                token={token}
                                label={m.label}
                                sublabel={sub}
                                active={selectedInstrument?.type === "macro" && selectedInstrument.key === m.key}
                                onClick={() =>
                                    selectInstrument({
                                        type: "macro",
                                        key: m.key,
                                        token,
                                        label: m.label,
                                        sublabel: sub
                                    })
                                }
                            />
                        );
                    })}

                    {/* Spacer + Manage button */}
                    <div style={{ flex: 1, minHeight: 8 }} />
                    <button
                        className={`sidebar-manage-btn ${
                            selectedInstrument?.type === "manage" ? "sidebar-manage-btn--active" : ""
                        }`}
                        onClick={() => selectInstrument({ type: "manage" })}
                    >
                        ⚙ Manage Stocks
                    </button>
                </div>
            )}

            {/* Quick stats — hidden when market instruments are visible */}
            {!(isMarket && !collapsed) && (
                <div className="sidebar-stats">
                    <div className="sidebar-stat">
                        <span className="stat-number">{signalCount}</span>
                        <span className="stat-label">Signals</span>
                    </div>
                    <div className="sidebar-stat">
                        <span className="stat-number">{orderCount}</span>
                        <span className="stat-label">Orders</span>
                    </div>
                </div>
            )}

            {/* Test mode toggle */}
            <div
                className="sidebar-testmode"
                title={collapsed ? (testMode ? "Test Mode ON" : "Test Mode OFF") : undefined}
            >
                <button
                    className={`sidebar-testmode-btn ${testMode ? "sidebar-testmode-btn--on" : ""}`}
                    onClick={onToggleTestMode}
                >
                    <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="12" y1="18" x2="12" y2="12" />
                        <line x1="9" y1="15" x2="15" y2="15" />
                    </svg>
                    {!collapsed && (
                        <>
                            <span>Test Mode</span>
                            <span className={`testmode-pill ${testMode ? "testmode-pill--on" : "testmode-pill--off"}`}>
                                {testMode ? "ON" : "OFF"}
                            </span>
                        </>
                    )}
                </button>
            </div>

            {/* Footer */}
            <div className="sidebar-footer">
                <button
                    className="sidebar-footer-btn"
                    onClick={onToggleTheme}
                    title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                >
                    {theme === "dark" ? (
                        <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <circle cx="12" cy="12" r="5" />
                            <line x1="12" y1="1" x2="12" y2="3" />
                            <line x1="12" y1="21" x2="12" y2="23" />
                            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                            <line x1="1" y1="12" x2="3" y2="12" />
                            <line x1="21" y1="12" x2="23" y2="12" />
                            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                        </svg>
                    ) : (
                        <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                        </svg>
                    )}
                    {!collapsed && <span>{theme === "dark" ? "Light Mode" : "Dark Mode"}</span>}
                </button>
            </div>
        </aside>
    );
}
