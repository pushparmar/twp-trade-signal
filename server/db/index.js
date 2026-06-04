/**
 * db/index.js
 *
 * Database initialisation orchestrator.
 *
 * Connects the MongoDB client, ensures all collection indexes exist, and
 * re-exports every repository so callers can do:
 *
 *   const db = require('./db');
 *   await db.init();                    // call once on boot
 *   db.alertRepo.insertAlert(payload);  // fire-and-forget writes
 *   db.tradeRepo.upsertTrade(trade);    // fire-and-forget writes
 *
 * This module is intentionally thin — it only wires dependencies together.
 * All MongoDB logic lives in the mongoClient and individual repo files.
 */

const mongo              = require('../services/mongoClient');
const alertRepo          = require('./repositories/alertRepo');
const tradeRepo          = require('./repositories/tradeRepo');
const indexTradeRepo     = require('./repositories/indexTradeRepo');
const signalOutcomeRepo  = require('./repositories/signalOutcomeRepo');
const settingsRepo       = require('./repositories/settingsRepo');
const equityScanRepo        = require('./repositories/equityScanRepo');
const equityCandleCacheRepo = require('./repositories/equityCandleCacheRepo');

/**
 * Connect to MongoDB and bootstrap collection indexes.
 *
 * Safe to call multiple times — mongo.init() is idempotent.
 * Never throws — all errors are logged inside mongoClient.init().
 *
 * @returns {Promise<boolean>} true when connected and indexes ensured
 */
async function init() {
  const connected = await mongo.init();
  if (!connected) return false;

  // Create indexes in parallel — all are safe to run concurrently.
  await Promise.all([
    alertRepo.createIndexes(),
    tradeRepo.createIndexes(),
    indexTradeRepo.createIndexes(),
    signalOutcomeRepo.createIndexes(),
    settingsRepo.createIndexes(),
    equityScanRepo.createIndexes(),
    equityCandleCacheRepo.createIndexes(),
  ]);

  return true;
}

/**
 * Graceful shutdown — called from the server's SIGTERM handler.
 */
async function close() {
  await mongo.close();
}

module.exports = { init, close, alertRepo, tradeRepo, indexTradeRepo, signalOutcomeRepo, settingsRepo, equityScanRepo, equityCandleCacheRepo };
