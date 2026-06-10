/**
 * indexTradeRepo.js
 *
 * Repository for index option trades (NIFTY/BANKNIFTY/SENSEX options).
 * Uses shared baseTradeRepo for CRUD and analytics.
 *
 * Collection: index_trades
 *
 * Additional indexes beyond base:
 *   { strategyType: 1 }   — 'pattern' vs 'low-premium'
 *   { index: 1 }          — NIFTY vs BANKNIFTY correlation
 */

const { createTradeRepo } = require('./baseTradeRepo');

// ── Document mapper: MongoDB doc → in-memory trade object ────────────────────

function mapTradeDocument(doc) {
  return {
    id:               doc.tradeId,
    ts:               doc.openedAt instanceof Date ? doc.openedAt.getTime() : Date.now(),
    source:           doc.source           ?? 'index-trade',
    strategyType:     doc.strategyType     ?? 'pattern',
    // Index option details
    index:            doc.index            ?? null,
    symbol:           doc.symbol           ?? '',
    token:            doc.token            ?? null,
    optionType:       doc.optionType       ?? null,  // 'CE' or 'PE'
    strike:           doc.strike           ?? null,
    exchange:         doc.exchange         ?? 'NFO',
    // Trade details
    action:           doc.action           ?? 'BUY',
    quantity:         doc.quantity         ?? 1,
    lotSize:          doc.lotSize          ?? 1,
    entryPrice:       doc.entryPrice       ?? 0,
    exitPrice:        doc.exitPrice        ?? null,
    sl:               doc.sl               ?? null,
    initialSl:        doc.initialSl        ?? doc.sl ?? null,
    target:           doc.target           ?? null,
    status:           doc.status           ?? 'OPEN',
    pnl:              doc.pnl              ?? null,
    closedTs:         doc.closedAt instanceof Date ? doc.closedAt.getTime() : null,
    exitReason:       doc.exitReason       ?? null,
    // Low-premium specific fields (avg-down support)
    avgPrice:         doc.avgPrice         ?? null,
    lotCount:         doc.lotCount         ?? null,
    avgDownCount:     doc.avgDownCount     ?? null,
    avgDownAt:        doc.avgDownAt        ?? null,
    // TSL fields
    tslActivated:     doc.tslActivated     ?? false,
    peakPrice:        doc.peakPrice        ?? doc.entryPrice ?? null,
    // Pattern context
    patternId:        doc.patternId        ?? null,
    patternLabel:     doc.patternLabel     ?? null,
    signalDirection:  doc.signalDirection  ?? null,
    interval:         doc.interval         ?? null,
    tfLabel:          doc.tfLabel          ?? null,
    score:            doc.score            ?? null,
    rrRatio:          doc.rrRatio          ?? null,
  };
}

// ── Document builder: trade object → MongoDB doc ─────────────────────────────

function buildTradeDocument(trade) {
  return {
    tradeId:          trade.id,
    // Strategy classification
    source:           trade.source                   ?? 'index-trade',
    strategyType:     trade.strategyType             ?? 'pattern',
    // Index option details
    index:            trade.index                    ?? null,
    symbol:           trade.symbol                   ?? null,
    token:            trade.token ? Number(trade.token) : null,
    optionType:       trade.optionType               ?? null,
    strike:           trade.strike                   ?? null,
    exchange:         trade.exchange                 ?? 'NFO',
    // Trade details
    action:           trade.action                   ?? 'BUY',
    quantity:         trade.quantity                 ?? 1,
    lotSize:          trade.lotSize                  ?? 1,
    entryPrice:       trade.entryPrice               ?? null,
    exitPrice:        trade.exitPrice                ?? null,
    sl:               trade.sl                       ?? null,
    initialSl:        trade.initialSl                ?? null,
    target:           trade.target                   ?? null,
    status:           trade.status                   ?? 'OPEN',
    pnl:              trade.pnl                      ?? null,
    exitReason:       trade.exitReason               ?? null,
    // Low-premium specific fields (avg-down support)
    avgPrice:         trade.avgPrice                 ?? null,
    lotCount:         trade.lotCount                 ?? null,
    avgDownCount:     trade.avgDownCount             ?? null,
    avgDownAt:        trade.avgDownAt                ?? null,
    // TSL fields
    tslActivated:     trade.tslActivated             ?? false,
    peakPrice:        trade.peakPrice                ?? null,
    // Pattern context
    patternId:        trade.patternId                ?? null,
    patternLabel:     trade.patternLabel             ?? null,
    signalDirection:  trade.signalDirection          ?? null,
    interval:         trade.interval                 ?? null,
    tfLabel:          trade.tfLabel                  ?? null,
    score:            trade.score                    ?? null,
    rrRatio:          trade.rrRatio                  ?? null,
    // Timestamps
    openedAt:         new Date(trade.ts || Date.now()),
    closedAt:         trade.closedTs ? new Date(trade.closedTs) : null,
    updatedAt:        new Date(),
  };
}

// Create the repository using shared base with extra indexes for index trades
const repo = createTradeRepo(
  'index_trades',
  'indexTradeRepo',
  mapTradeDocument,
  buildTradeDocument,
  [
    { strategyType: 1 },  // 'pattern' vs 'low-premium'
    { index: 1 },         // NIFTY vs BANKNIFTY
  ]
);

module.exports = repo;
