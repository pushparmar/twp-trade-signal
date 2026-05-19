/**
 * Trade Archiver
 *
 * Fires every day at 06:00 AM IST (00:30 UTC).
 * Before clearing, writes all current paper trades to a dated JSON file
 * under data/history/ so they can be reviewed at end of month.
 *
 * Archive filename format: trades-YYYY-MM-DD.json
 * Each file includes a summary (total trades, P&L) and a full trade list
 * with pattern, signal, and timeframe fields for analysis.
 *
 * The scheduler uses a plain setTimeout — no external dependencies needed.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// Lazy-require store and sseHub to avoid circular dependencies at module load.
// Both are available by the time archiveAndClear() is called at runtime.
function _store()  { return require('../store'); }
function _hub()    { return require('../sseHub'); }

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

// ── Path helpers ─────────────────────────────────────────────────────────────

function _historyDir() {
  return process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, 'history')
    : path.join(__dirname, '..', 'data', 'history');
}

function _istDateStr(now = Date.now()) {
  return new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// ── Core: archive today's trades then clear ──────────────────────────────────

function archiveAndClear() {
  const store  = _store();
  const hub    = _hub();
  const trades = store.getPaperTrades();

  // Separate so OPEN trades can be carried forward to the new trading day.
  const openTrades   = trades.filter((t) => t.status === 'OPEN');
  const closedTrades = trades.filter((t) => t.status === 'CLOSED');

  // ── Write archive file (ALL trades — useful for end-of-month analysis) ────
  if (trades.length > 0) {
    const dir      = _historyDir();
    const dateStr  = _istDateStr();
    const filePath = path.join(dir, `trades-${dateStr}.json`);

    const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);

    const payload = {
      date:       dateStr,
      archivedAt: new Date().toISOString(),
      summary: {
        total:    trades.length,
        open:     openTrades.length,
        closed:   closedTrades.length,
        totalPnl: +totalPnl.toFixed(2),
      },
      // Include every field relevant for pattern-level analysis
      trades: trades.map((t) => ({
        id:           t.id,
        ts:           t.ts,
        closedTs:     t.closedTs     ?? null,
        symbol:       t.symbol,
        action:       t.action,
        lots:         t.lots         ?? 1,
        lotSize:      t.lotSize      ?? 1,
        quantity:     t.quantity,
        entryPrice:   t.entryPrice,
        exitPrice:    t.exitPrice    ?? null,
        sl:           t.sl           ?? null,
        target:       t.target       ?? null,
        status:       t.status,
        pnl:          t.pnl          ?? null,
        patternId:    t.patternId    ?? null,
        patternLabel: t.patternLabel ?? null,
        signal:       t.signal       ?? null,
        interval:     t.interval     ?? null,
        tfLabel:      t.tfLabel      ?? null,
      })),
    };

    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
      console.log(`[TradeArchiver] Archived ${trades.length} trades → ${filePath}`);
    } catch (err) {
      console.error('[TradeArchiver] Failed to write archive file:', err.message);
    }
  } else {
    console.log('[TradeArchiver] No trades to archive today');
  }

  // ── Clear ALL trades from store + disk ────────────────────────────────────
  store.clearPaperTrades();

  // Tell every browser tab to wipe its local state (closed trades are gone).
  hub.broadcast('paper_trades_cleared', {});

  // ── Carry forward OPEN trades to the new trading day ─────────────────────
  // OPEN positions are not day-specific — they stay active until SL/target/
  // manual close.  Re-add them to the store and re-broadcast so every
  // connected tab adds them back immediately.
  if (openTrades.length > 0) {
    for (const trade of openTrades) {
      store.addPaperTrade(trade);
      hub.broadcast('paper_trade', trade);
    }
    console.log(`[TradeArchiver] Carried forward ${openTrades.length} open trade(s) to new day`);
  }

  hub.broadcast('paper_balance', store.getPaperBalance());
  console.log(
    `[TradeArchiver] Daily 6 AM clear complete — ` +
    `${closedTrades.length} closed archived, ${openTrades.length} open carried forward`,
  );
}

// ── Scheduler ────────────────────────────────────────────────────────────────

/**
 * Returns milliseconds until the next 06:00 IST (= 00:30 UTC).
 */
function _msUntilNext6amIST(now = Date.now()) {
  const utcNow = new Date(now);
  const next   = new Date(utcNow);
  next.setUTCHours(0, 30, 0, 0);             // today's 00:30 UTC = 06:00 IST
  if (next.getTime() <= utcNow.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);   // already passed — aim for tomorrow
  }
  return next.getTime() - utcNow.getTime();
}

function start() {
  function schedule() {
    const delayMs = _msUntilNext6amIST();
    const fireAtIST = new Date(Date.now() + delayMs + IST_OFFSET_MS)
      .toISOString()
      .slice(0, 16)
      .replace('T', ' ');
    console.log(
      `[TradeArchiver] Next archive at ${fireAtIST} IST` +
      ` (in ${Math.round(delayMs / 60_000)} min)`
    );

    setTimeout(() => {
      archiveAndClear();
      schedule(); // reschedule for the next day
    }, delayMs);
  }

  schedule();
}

module.exports = { start, archiveAndClear };
