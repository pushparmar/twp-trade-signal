const instrumentCache = require('./instrumentCache');
const foStockRegistry = require('./foStockRegistry');
const kiteService     = require('./kiteService');

/**
 * Resolve a scan alert into a concrete derivative instrument (future or option).
 *
 * @param {object} alert        Alert payload from backgroundScanner / liveScanner
 * @param {string} tradingMode  'futures' | 'options'
 * @returns {object|null}       Resolved instrument details, or null if not eligible
 */
async function resolve(alert, tradingMode) {
  if (!instrumentCache.isLoaded()) {
    console.warn('[DerivativeResolver] Instrument cache not loaded — skipping');
    return null;
  }

  const stock = foStockRegistry.getByToken(alert.token);
  if (!stock) {
    console.log(`[DerivativeResolver] Token ${alert.token} (${alert.label}) not in F&O registry — skipping`);
    return null;
  }

  if (tradingMode === 'futures') {
    return _resolveFutures(stock, alert);
  }
  return _resolveOptions(stock, alert);
}

async function _resolveFutures(stock, alert) {
  const exchange = stock.exchange === 'MCX' ? 'MCX' : 'NFO';
  const future = instrumentCache.getFrontMonthFuture(stock.name, exchange);
  if (!future) {
    console.warn(`[DerivativeResolver] No front-month future for ${stock.name} on ${exchange}`);
    return null;
  }

  let premium = null;
  try {
    const ltpKey = `${future.exchange}:${future.tradingsymbol}`;
    const ltpData = await kiteService.getLTP([ltpKey]);
    premium = ltpData[ltpKey]?.last_price ?? null;
  } catch (err) {
    console.warn(`[DerivativeResolver] Futures LTP failed for ${future.tradingsymbol}:`, err.message);
  }

  if (!premium) {
    premium = alert.close;
  }

  return {
    instrument:         future,
    premium:            premium,
    derivativeSymbol:   future.tradingsymbol,
    derivativeToken:    future.instrumentToken,
    derivativeExchange: future.exchange,
    lotSize:            future.lotSize || stock.lotSize || 1,
    optionType:         null,
    strike:             null,
    expiry:             future.expiry || null,
  };
}

async function _resolveOptions(stock, alert) {
  const optionType = alert.signal === 'bullish' ? 'CE' : 'PE';
  const exchange = stock.exchange === 'MCX' ? 'MCX' : 'NFO';

  const option = instrumentCache.getNearestATMOption(
    stock.name, exchange, alert.close, optionType,
  );
  if (!option) {
    console.warn(`[DerivativeResolver] No ATM ${optionType} for ${stock.name} at spot=${alert.close}`);
    return null;
  }

  let premium = null;
  try {
    const ltpKey = `${option.exchange}:${option.tradingsymbol}`;
    const ltpData = await kiteService.getLTP([ltpKey]);
    premium = ltpData[ltpKey]?.last_price ?? null;
  } catch (err) {
    console.warn(`[DerivativeResolver] Option LTP failed for ${option.tradingsymbol}:`, err.message);
  }

  if (!premium || premium <= 0) {
    console.warn(`[DerivativeResolver] Invalid premium for ${option.tradingsymbol} — skipping`);
    return null;
  }

  return {
    instrument:         option,
    premium:            premium,
    derivativeSymbol:   option.tradingsymbol,
    derivativeToken:    option.instrumentToken,
    derivativeExchange: option.exchange,
    lotSize:            option.lotSize || stock.lotSize || 1,
    optionType:         optionType,
    strike:             option.strike,
    expiry:             option.expiry || null,
  };
}

module.exports = { resolve };
