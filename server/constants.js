/**
 * constants.js
 * Centralized application constants
 */

const EXCHANGES = {
  NSE: 'NSE',
  MCX: 'MCX',
  NFO: 'NFO',
  BSE: 'BSE',
};

const TRADE_STATUSES = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  PENDING: 'PENDING',
};

const EXIT_REASONS = {
  TARGET: 'TARGET',
  SL: 'SL',
  TSL: 'TSL',
  MANUAL: 'MANUAL',
};

const INTERVALS = {
  FIFTEEN_MIN: '15minute',
  ONE_HOUR: '60minute',
  FOUR_HOUR: '4h',
  DAILY: 'day',
};

const INTERVAL_LABELS = {
  '15minute': '15m',
  '60minute': '1h',
  '4h': '4h',
  'day': '1d',
};

// Indices (NIFTY, BANKNIFTY, SENSEX, VIX, etc.) cannot be traded directly;
// only their derivatives can.
const NON_TRADEABLE_TOKENS = new Set([
  256265,  // NIFTY 50  (NSE:NIFTY 50)
  260105,  // NIFTY BANK
  264969,  // India VIX
  274441,  // NIFTY FIN SERVICE (FINNIFTY)
  288009,  // NIFTY MIDCAP SELECT (MIDCPNIFTY)
  265,     // BSE SENSEX
  270857,  // BSE BANKEX
]);

// Label-based guard catches any future index that maps to a known name.
const NON_TRADEABLE_LABEL_RE =
  /\b(NIFTY|BANK\s?NIFTY|SENSEX|VIX|BANKEX|FINNIFTY|MIDCPNIFTY)\b/i;

module.exports = {
  EXCHANGES,
  TRADE_STATUSES,
  EXIT_REASONS,
  INTERVALS,
  INTERVAL_LABELS,
  NON_TRADEABLE_TOKENS,
  NON_TRADEABLE_LABEL_RE,
};
