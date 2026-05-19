/**
 * tradeRepo.js
 *
 * Write-through repository for paper trades.
 *
 * Every open/close action on a paper trade is mirrored here so we can later
 * correlate trades with the scan alerts that triggered them and measure
 * per-pattern win rates and average P&L.
 *
 * Design principles:
 *   • Fire-and-forget — all writes are non-blocking.  Errors are logged but
 *     never thrown so a DB outage cannot affect trade execution or balance
 *     calculations (those live in the in-memory store.js).
 *   • Upsert on tradeId — safe to call multiple times for the same trade
 *     (e.g. re-submitting a POST /api/paper/ after a network retry).
 *   • No balance logic — balances are computed from the live in-memory array;
 *     this repo only stores the raw trade events for offline analysis.
 *
 * Collection: paper_trades
 *
 * Indexes (created once on first connection):
 *   { tradeId: 1 }        — unique; primary lookup key
 *   { status: 1 }         — filter OPEN vs CLOSED
 *   { patternId: 1 }      — pattern → P&L correlation
 *   { openedAt: -1 }      — chronological listing
 */

const mongo = require('../../services/mongoClient');

const COLLECTION = 'paper_trades';

// ── Index bootstrap ───────────────────────────────────────────────────────────

/**
 * Create indexes if they don't already exist.
 * Called once on first connection (from db/index.js).
 */
async function createIndexes() {
  if (!mongo.isReady()) return;
  const col = mongo.db().collection(COLLECTION);
  try {
    await col.createIndex({ tradeId: 1 }, { unique: true });
    await col.createIndex({ status: 1 });
    await col.createIndex({ patternId: 1 });
    await col.createIndex({ openedAt: -1 });
    console.log(`[tradeRepo] Indexes ensured on "${COLLECTION}"`);
  } catch (err) {
    console.warn('[tradeRepo] createIndexes failed:', err.message);
  }
}

// ── Write helpers ─────────────────────────────────────────────────────────────

/**
 * Insert or update a trade record when a paper trade is opened.
 * Fire-and-forget — the caller must NOT await this function.
 *
 * @param {object} trade  The trade object from store.addPaperTrade().
 */
function upsertTrade(trade) {
  if (!mongo.isReady()) {
    console.warn(`[tradeRepo] upsertTrade skipped — MongoDB not ready (trade=${trade?.id ?? '?'})`);
    return;
  }
  if (!trade?.id) {
    console.warn('[tradeRepo] upsertTrade skipped — trade has no id');
    return;
  }

  const doc = {
    tradeId:      trade.id,
    // Instrument
    symbol:       trade.symbol                   ?? null,
    token:        trade.token ? Number(trade.token) : null,
    exchange:     trade.exchange                 ?? null,
    // Trade details
    action:       trade.action                   ?? null,
    lots:         trade.lots                     ?? 1,
    lotSize:      trade.lotSize                  ?? 1,
    quantity:     trade.quantity                 ?? null,
    entryPrice:   trade.entryPrice               ?? null,
    exitPrice:    trade.exitPrice                ?? null,
    sl:           trade.sl                       ?? null,
    target:       trade.target                   ?? null,
    targetSource: trade.targetSource              ?? null,
    status:       trade.status                   ?? 'OPEN',
    pnl:          trade.pnl                      ?? null,
    // Pattern context
    patternId:    trade.patternId                ?? null,
    patternLabel: trade.patternLabel             ?? null,
    signal:       trade.signal                   ?? null,
    interval:     trade.interval                 ?? null,
    tfLabel:      trade.tfLabel                  ?? null,
    // Derivative instrument
    tradingMode:       trade.tradingMode          ?? null,
    derivativeSymbol:  trade.derivativeSymbol     ?? null,
    derivativeToken:   trade.derivativeToken      ?? null,
    derivativeExchange: trade.derivativeExchange  ?? null,
    optionType:        trade.optionType           ?? null,
    strike:            trade.strike               ?? null,
    expiry:            trade.expiry               ?? null,
    premium:           trade.premium              ?? null,
    spotEntry:         trade.spotEntry            ?? null,
    initialSl:         trade.initialSl            ?? null,
    // Source
    source:       trade.source                   ?? null,
    // Timestamps
    openedAt:     new Date(trade.ts || Date.now()),
    closedAt:     trade.closedTs ? new Date(trade.closedTs) : null,
    updatedAt:    new Date(),
  };

  mongo.db().collection(COLLECTION)
    .updateOne(
      { tradeId: trade.id },
      { $set: doc, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    )
    .then((r) => {
      const action = r.upsertedCount > 0 ? 'inserted' : 'updated';
      console.log(`[tradeRepo] ${action} ${trade.symbol} (${trade.id.slice(0,8)}…) → MongoDB`);
    })
    .catch((err) => {
      console.warn('[tradeRepo] upsertTrade FAILED:', err.message);
    });
}

/**
 * Mark a trade as CLOSED and record the exit price + P&L.
 * Fire-and-forget — the caller must NOT await this function.
 *
 * @param {object} trade  The closed trade object returned by store.closePaperTrade().
 */
function closeTrade(trade) {
  if (!mongo.isReady()) return;
  if (!trade?.id) return;

  mongo.db().collection(COLLECTION)
    .updateOne(
      { tradeId: trade.id },
      {
        $set: {
          status:    'CLOSED',
          exitPrice: trade.exitPrice ?? null,
          pnl:       trade.pnl       ?? null,
          closedAt:  trade.closedTs ? new Date(trade.closedTs) : new Date(),
          updatedAt: new Date(),
        },
      },
    )
    .catch((err) => {
      console.warn('[tradeRepo] closeTrade failed:', err.message);
    });
}

// ── Read helpers ──────────────────────────────────────────────────────────────

/**
 * Fetch all OPEN trades from MongoDB.
 *
 * Used on server boot to restore the in-memory trade list when
 * trades-current.json is missing (e.g. after a Railway redeploy without a
 * persistent volume, or an accidental file deletion).
 *
 * Returns the documents re-shaped to match the plain JS trade object used by
 * store.addPaperTrade() so the result can be dropped straight in.
 *
 * @returns {Promise<Array>}
 */
async function getOpenTrades() {
  if (!mongo.isReady()) return [];
  try {
    const docs = await mongo.db().collection(COLLECTION)
      .find({ status: 'OPEN' })
      .sort({ openedAt: -1 })
      .toArray();

    return docs.map((doc) => ({
      id:              doc.tradeId,
      ts:              doc.openedAt instanceof Date ? doc.openedAt.getTime() : Date.now(),
      source:          doc.source          ?? 'auto',
      autoSource:      doc.autoSource      ?? null,
      symbol:          doc.symbol          ?? '',
      token:           doc.token           ?? null,
      exchange:        doc.exchange        ?? 'NSE',
      action:          doc.action          ?? 'BUY',
      quantity:        doc.quantity        ?? 1,
      lots:            doc.lots            ?? 1,
      lotSize:         doc.lotSize         ?? 1,
      entryPrice:      doc.entryPrice      ?? 0,
      exitPrice:       doc.exitPrice       ?? null,
      sl:              doc.sl              ?? null,
      initialSl:       doc.initialSl       ?? doc.sl ?? null,
      target:          doc.target          ?? null,
      status:          'OPEN',
      pnl:             null,
      closedTs:        null,
      // Derivative fields
      tradingMode:        doc.tradingMode        ?? null,
      derivativeSymbol:   doc.derivativeSymbol   ?? null,
      derivativeToken:    doc.derivativeToken    ?? null,
      derivativeExchange: doc.derivativeExchange ?? null,
      optionType:         doc.optionType         ?? null,
      strike:             doc.strike             ?? null,
      expiry:             doc.expiry             ?? null,
      premium:            doc.premium            ?? null,
      spotEntry:          doc.spotEntry          ?? null,
      // Pattern + risk
      patternId:       doc.patternId       ?? null,
      patternLabel:    doc.patternLabel    ?? null,
      signal:          doc.signal          ?? null,
      interval:        doc.interval        ?? null,
      tfLabel:         doc.tfLabel         ?? null,
      riskPerUnit:     doc.riskPerUnit     ?? null,
      rrRatio:         doc.rrRatio         ?? null,
      potentialProfit: doc.potentialProfit ?? null,
      targetSource:    doc.targetSource    ?? null,
      tslActivated:    doc.tslActivated    ?? false,
      peakPrice:       doc.peakPrice       ?? doc.entryPrice ?? null,
    }));
  } catch (err) {
    console.warn('[tradeRepo] getOpenTrades failed:', err.message);
    return [];
  }
}

// ── Analytics helpers ─────────────────────────────────────────────────────────

/**
 * Aggregate daily P&L grouped by IST date.
 * Returns an array of { date, totalPnl, wins, losses, count }.
 *
 * @param {{ fromDate?: Date, toDate?: Date }} [opts]
 * @returns {Promise<Array>}
 */
async function dailyPnl(opts = {}) {
  if (!mongo.isReady()) return [];
  try {
    const match = { status: 'CLOSED', pnl: { $ne: null } };
    if (opts.fromDate || opts.toDate) {
      match.closedAt = {};
      if (opts.fromDate) match.closedAt.$gte = opts.fromDate;
      if (opts.toDate)   match.closedAt.$lte = opts.toDate;
    }
    return await mongo.db().collection(COLLECTION).aggregate([
      { $match: match },
      {
        $group: {
          _id:      { $dateToString: { format: '%Y-%m-%d', date: '$closedAt', timezone: '+05:30' } },
          totalPnl: { $sum: '$pnl' },
          wins:     { $sum: { $cond: [{ $gt: ['$pnl', 0] }, 1, 0] } },
          losses:   { $sum: { $cond: [{ $lt: ['$pnl', 0] }, 1, 0] } },
          count:    { $sum: 1 },
        },
      },
      { $sort: { _id: -1 } },
    ]).toArray();
  } catch (err) {
    console.warn('[tradeRepo] dailyPnl failed:', err.message);
    return [];
  }
}

/**
 * Pattern-level win rate: for each patternId, returns { count, wins, winRate, avgPnl }.
 * Helps identify which Ichimoku patterns produce the best paper-trade outcomes.
 *
 * @returns {Promise<Array>}
 */
async function patternWinRate() {
  if (!mongo.isReady()) return [];
  try {
    return await mongo.db().collection(COLLECTION).aggregate([
      { $match: { status: 'CLOSED', patternId: { $ne: null }, pnl: { $ne: null } } },
      {
        $group: {
          _id:    '$patternId',
          count:  { $sum: 1 },
          wins:   { $sum: { $cond: [{ $gt: ['$pnl', 0] }, 1, 0] } },
          avgPnl: { $avg: '$pnl' },
        },
      },
      {
        $addFields: {
          winRate: {
            $cond: [
              { $gt: ['$count', 0] },
              { $divide: ['$wins', '$count'] },
              0,
            ],
          },
        },
      },
      { $sort: { winRate: -1 } },
    ]).toArray();
  } catch (err) {
    console.warn('[tradeRepo] patternWinRate failed:', err.message);
    return [];
  }
}

/**
 * Sum of realized PnL across all CLOSED trades in MongoDB.
 * Used on startup to restore the in-memory cumulative PnL counter so the
 * paper balance is accurate even after Railway redeploys or config.json loss.
 *
 * @returns {Promise<number>}
 */
async function getCumulativePnl() {
  if (!mongo.isReady()) return null; // null = not available, caller uses fallback
  try {
    const rows = await mongo.db().collection(COLLECTION).aggregate([
      { $match: { status: 'CLOSED', pnl: { $ne: null } } },
      { $group: { _id: null, total: { $sum: '$pnl' } } },
    ]).toArray();
    return Math.round((rows[0]?.total ?? 0) * 100) / 100;
  } catch (err) {
    console.warn('[tradeRepo] getCumulativePnl failed:', err.message);
    return null;
  }
}

module.exports = { createIndexes, upsertTrade, closeTrade, getOpenTrades, getCumulativePnl, dailyPnl, patternWinRate };
