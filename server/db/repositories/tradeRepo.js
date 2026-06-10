/**
 * tradeRepo.js
 *
 * Repository for paper trades (equity/commodity paper trading).
 * Uses shared baseTradeRepo for CRUD and analytics.
 *
 * Collection: paper_trades
 */

const { createTradeRepo } = require('./baseTradeRepo');

// ── Document mapper: MongoDB doc → in-memory trade object ────────────────────

function mapTradeDocument(doc) {
  return {
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
    status:          doc.status          ?? 'OPEN',
    pnl:             doc.pnl             ?? null,
    closedTs:        doc.closedAt instanceof Date ? doc.closedAt.getTime() : null,
    exitReason:      doc.exitReason      ?? null,
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
    // Pending/trigger order fields
    triggerPrice:    doc.triggerPrice    ?? null,
    triggerDir:      doc.triggerDir      ?? null,
    activatedTs:     doc.activatedTs     ?? null,
    // Indicator snapshot
    rsi14:           doc.rsi14           ?? null,
    volumeConfirmed: doc.volumeConfirmed ?? null,
    volumeRatio:     doc.volumeRatio     ?? null,
    mtfAligned:      doc.mtfAligned      ?? false,
  };
}

// ── Document builder: trade object → MongoDB doc ─────────────────────────────

function buildTradeDocument(trade) {
  return {
    tradeId:         trade.id,
    // Instrument
    symbol:          trade.symbol                   ?? null,
    token:           trade.token ? Number(trade.token) : null,
    exchange:        trade.exchange                 ?? null,
    // Trade details
    action:          trade.action                   ?? null,
    lots:            trade.lots                     ?? 1,
    lotSize:         trade.lotSize                  ?? 1,
    quantity:        trade.quantity                 ?? null,
    entryPrice:      trade.entryPrice               ?? null,
    exitPrice:       trade.exitPrice                ?? null,
    sl:              trade.sl                       ?? null,
    initialSl:       trade.initialSl                ?? null,
    target:          trade.target                   ?? null,
    targetSource:    trade.targetSource             ?? null,
    status:          trade.status                   ?? 'OPEN',
    pnl:             trade.pnl                      ?? null,
    exitReason:      trade.exitReason               ?? null,
    // Pattern context
    patternId:       trade.patternId                ?? null,
    patternLabel:    trade.patternLabel             ?? null,
    signal:          trade.signal                   ?? null,
    interval:        trade.interval                 ?? null,
    tfLabel:         trade.tfLabel                  ?? null,
    // TSL fields
    tslActivated:    trade.tslActivated             ?? false,
    peakPrice:       trade.peakPrice                ?? null,
    // Indicator snapshot
    rsi14:           trade.rsi14                    ?? null,
    volumeConfirmed: trade.volumeConfirmed          ?? null,
    volumeRatio:     trade.volumeRatio              ?? null,
    mtfAligned:      trade.mtfAligned               ?? false,
    // Source
    source:          trade.source                   ?? null,
    autoSource:      trade.autoSource               ?? null,
    // Pending/trigger order fields
    triggerPrice:    trade.triggerPrice             ?? null,
    triggerDir:      trade.triggerDir               ?? null,
    activatedTs:     trade.activatedTs              ?? null,
    // Timestamps
    openedAt:        new Date(trade.ts || Date.now()),
    closedAt:        trade.closedTs ? new Date(trade.closedTs) : null,
    updatedAt:       new Date(),
  };
}

// Create the repository using shared base
const repo = createTradeRepo(
  'paper_trades',
  'tradeRepo',
  mapTradeDocument,
  buildTradeDocument,
  [] // No extra indexes needed
);

module.exports = repo;
