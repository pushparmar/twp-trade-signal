/**
 * TradeExporter
 *
 * OOP class that converts paper trades into a downloadable CSV report.
 * Each row includes trade data, pattern metadata, and a human-readable
 * explanation of WHY the pattern fired — derived from predefined logic
 * definitions per pattern and the live fields stored on the trade.
 *
 * Usage:
 *   const csv = TradeExporter.toCSV(trades, '2025-05-21');
 *   res.setHeader('Content-Disposition', `attachment; filename="trades-2025-05-21.csv"`);
 *   res.type('text/csv').send(csv);
 */

'use strict';

// IST offset — used to format timestamps and filter "today's" trades.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

class TradeExporter {

  // ─────────────────────────────────────────────────────────────────────────
  // Predefined pattern logic definitions.
  //
  // Each entry has:
  //   name        — display label
  //   description — what the pattern looks for (setup logic)
  //   timeframes  — best timeframes for this pattern
  //   signals     — signal-specific entry rationale (bullish / bearish)
  //   exitLogic   — how to manage the trade once entered
  //   volumeRole  — what volume confirmation adds to conviction
  // ─────────────────────────────────────────────────────────────────────────
  static PATTERN_DEFINITIONS = {

    'kumo-base-entry': {
      name:        'Kumo Base Entry',
      description: 'Price built a tight consolidation base just outside a thick Kumo cloud, then entered the cloud from the near edge. The fat cloud represents concentrated support/resistance. A base below/above it shows supply-demand balance before the traverse attempt.',
      timeframes:  ['15m', '1h', '4h', '1d'],
      signals: {
        bullish: 'Price was below the cloud, coiling in a tight range (base). It has now entered the cloud from the bottom edge. Target: traverse the full cloud and exit above cloudTop. The thick cloud means the move, if sustained, will be meaningful.',
        bearish: 'Price was above the cloud, coiling in a tight range (base). It has now entered the cloud from the top edge. Target: traverse the full cloud and exit below cloudBottom. Bears must push through the thick cloud to confirm the breakdown.',
      },
      exitLogic:   'SL = below the base low (bullish) or above the base high (bearish). Target = far cloud edge, then swing structure beyond it. Trail SL to cloud entry edge once price reaches mid-cloud.',
      volumeRole:  'Volume confirmation on the cloud-entry bar increases conviction. High relative volume at entry means institutional participation; low volume = caution.',
    },

    'kumo-breakout': {
      name:        'Kumo Breakout',
      description: 'Price broke out of the Kumo cloud within the last 3 bars with TK lines aligned in the breakout direction. The cloud breakout signals a potential trend change or continuation after a cloud-test period.',
      timeframes:  ['15m', '1h', '4h', '1d'],
      signals: {
        bullish: 'Price crossed above cloudTop (bullish breakout). Tenkan > Kijun confirms upward momentum. The cloud below now acts as support. Target: next structural resistance or natural swing high.',
        bearish: 'Price crossed below cloudBottom (bearish breakdown). Tenkan < Kijun confirms downward momentum. The cloud above now acts as resistance. Target: next structural support or natural swing low.',
      },
      exitLogic:   'SL = below cloudBottom (bullish) or above cloudTop (bearish) — re-entry into the cloud invalidates the breakout. Target = measured move from cloud width or swing structure.',
      volumeRole:  'A breakout on above-average volume is a high-conviction signal. Breakout on thin volume may be a false break — wait for a retest of the cloud edge.',
    },

    'kumo-bounce': {
      name:        'Kumo Bounce',
      description: 'Price pulled back to the cloud edge from outside and formed a reversal candle. The Kumo acts as dynamic support (when price is above) or resistance (when below). A wick touch-and-reject at the cloud boundary is a high-probability continuation entry.',
      timeframes:  ['15m', '1h', '4h'],
      signals: {
        bullish: 'Price is above the cloud and pulled back to cloudTop. The wick touched the cloud but the close held above. Bullish continuation — rejecting cloud support.',
        bearish: 'Price is below the cloud and rallied back to cloudBottom. The wick touched the cloud but the close held below. Bearish continuation — rejecting cloud resistance.',
      },
      exitLogic:   'SL = inside the cloud (a close through the cloud edge = bounce failed). Target = prior swing high/low in the direction of the trend.',
      volumeRole:  'Declining volume on the pullback into the cloud edge, followed by expanding volume on the rejection candle, is the ideal pattern.',
    },

    'cloud-support': {
      name:        'Cloud Support / Resistance',
      description: 'Price has held its position above or below the cloud for 3–5 consecutive bars, with cloud color confirming the direction. Extended adherence to the cloud boundary shows that the market is respecting it as a structural level — not a transient cross.',
      timeframes:  ['1h', '4h', '1d'],
      signals: {
        bullish: 'Price above cloud for 3+ consecutive bars. Cloud is green (SenkouA > SenkouB), TK aligned bullish. The cloud floor is acting as rising support. Score 3–5 means multiple Ichimoku conditions agree.',
        bearish: 'Price below cloud for 3+ consecutive bars. Cloud is red (SenkouB > SenkouA), TK aligned bearish. The cloud ceiling is acting as falling resistance. Score 3–5 means multiple Ichimoku conditions agree.',
      },
      exitLogic:   'SL = far cloud edge (bullish: cloudBottom; bearish: cloudTop). A full cloud penetration invalidates the setup. Target = trend extension using Chikou confirmation.',
      volumeRole:  'Sustained above-average volume during the cloud-adherence period adds confidence. Volume decay on the approach to cloud suggests fading momentum.',
    },

    'kijun-bounce': {
      name:        'Kijun Support / Resistance',
      description: 'Price tested the Kijun-sen (26-period midpoint / base line) as support or resistance within the last 2–3 candles. The Kijun is the equilibrium price for the last 26 bars — a touch-and-reject signals that mean-reversion buyers/sellers are active at this level.',
      timeframes:  ['15m', '1h', '4h', '1d'],
      signals: {
        bullish: 'Price pulled back to Kijun from above. Wick touched the Kijun but close held above. Bullish continuation — Kijun support holding. Entry on the next bar above the wick high.',
        bearish: 'Price rallied to Kijun from below. Wick touched the Kijun but close held below. Bearish continuation — Kijun resistance holding. Entry on the next bar below the wick low.',
      },
      exitLogic:   'SL = Kijun level itself with ATR buffer. A close through the Kijun means support/resistance has broken. Target = next structural level or cloud edge.',
      volumeRole:  'Rejection from Kijun on declining volume (low-conviction test) is a stronger signal than rejection on expanding volume (battle at the level).',
    },

  };

  // ─────────────────────────────────────────────────────────────────────────
  // explainPattern()
  //
  // Generates a dynamic, trade-specific explanation by combining the
  // predefined pattern description with the actual numbers from the trade.
  // ─────────────────────────────────────────────────────────────────────────
  static explainPattern(trade) {
    const def     = TradeExporter.PATTERN_DEFINITIONS[trade.patternId];
    const signal  = trade.signal ?? (trade.action === 'BUY' ? 'bullish' : 'bearish');

    if (!def) {
      // Unknown / telegram / manual trade
      return trade.source === 'telegram'
        ? 'Signal received via Telegram bot — entry based on the signal message text.'
        : 'Manual trade — no pattern logic recorded.';
    }

    // Start with the signal-specific rationale
    const signalLine = def.signals[signal] ?? def.description;

    // Append live trade metrics where available
    const parts = [signalLine];

    if (trade.rrRatio != null) {
      parts.push(`R:R = ${trade.rrRatio}:1.`);
    }
    if (trade.riskPerUnit != null) {
      parts.push(`Risk/unit = ₹${trade.riskPerUnit}.`);
    }
    if (trade.tfLabel) {
      parts.push(`Scanned on ${trade.tfLabel} timeframe.`);
    }
    if (trade.mtfAligned) {
      parts.push('Multi-timeframe alignment confirmed.');
    }
    if (trade.volumeConfirmed) {
      parts.push('Volume ≥ 1.2× 20-bar average — high conviction entry.');
    }
    if (trade.rsi14 != null) {
      const rsiVal = trade.rsi14;
      let rsiNote;
      if (rsiVal >= 70)      rsiNote = `RSI(14) = ${rsiVal} — overbought territory.`;
      else if (rsiVal <= 30) rsiNote = `RSI(14) = ${rsiVal} — oversold territory.`;
      else                   rsiNote = `RSI(14) = ${rsiVal}.`;
      parts.push(rsiNote);
    }

    return parts.join(' ');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // _toISTString()  — format a Unix-ms timestamp as "HH:MM:SS IST"
  // _toISTDate()    — format as "YYYY-MM-DD"
  // ─────────────────────────────────────────────────────────────────────────
  static _toISTString(tsMs) {
    if (!tsMs) return '';
    const d = new Date(tsMs + IST_OFFSET_MS);
    return d.toISOString().replace('T', ' ').slice(0, 19) + ' IST';
  }

  static _toISTDate(tsMs) {
    if (!tsMs) return '';
    const d = new Date(tsMs + IST_OFFSET_MS);
    return d.toISOString().slice(0, 10);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // _csvCell()  — escape a value for CSV (quote if it contains comma / quote / newline)
  // ─────────────────────────────────────────────────────────────────────────
  static _csvCell(value) {
    if (value == null) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // buildRow()
  //
  // Converts a single paper trade into a flat object whose keys become
  // CSV column headers.
  // ─────────────────────────────────────────────────────────────────────────
  static buildRow(trade) {
    const def        = TradeExporter.PATTERN_DEFINITIONS[trade.patternId] ?? null;
    const signal     = trade.signal ?? (trade.action === 'BUY' ? 'bullish' : 'bearish');
    const pnlDisplay = trade.pnl != null
      ? (trade.pnl >= 0 ? `+${trade.pnl.toFixed(2)}` : trade.pnl.toFixed(2))
      : '';

    return {
      'Date':                TradeExporter._toISTDate(trade.ts),
      'Time (IST)':          TradeExporter._toISTString(trade.ts),
      'Symbol':              trade.symbol         ?? '',
      'Exchange':            trade.exchange        ?? '',
      'Action':              trade.action          ?? '',
      'Signal':              signal,
      'Status':              trade.status          ?? '',
      'Source':              trade.source          ?? '',
      // ── Pattern ──────────────────────────────────────────────────────────
      'Pattern ID':          trade.patternId       ?? '',
      'Pattern Name':        trade.patternLabel ?? def?.name ?? '',
      'Timeframe':           trade.tfLabel         ?? '',
      // ── Price levels ─────────────────────────────────────────────────────
      'Entry Price (₹)':     trade.entryPrice      ?? '',
      'SL (₹)':              trade.sl              ?? '',
      'Target (₹)':          trade.target          ?? '',
      'Exit Price (₹)':      trade.exitPrice       ?? '',
      // ── Outcome ──────────────────────────────────────────────────────────
      'PnL (₹)':             pnlDisplay,
      'R:R Ratio':           trade.rrRatio         ?? '',
      'Risk/Unit (₹)':       trade.riskPerUnit     ?? '',
      'Qty':                 trade.quantity        ?? '',
      'Lot Size':            trade.lotSize         ?? 1,
      // ── Quality signals ───────────────────────────────────────────────────
      'RSI (14)':            trade.rsi14           ?? '',
      'Volume Confirmed':    trade.volumeConfirmed ? 'Yes' : 'No',
      'MTF Aligned':         trade.mtfAligned      ? 'Yes' : 'No',
      // ── Timestamps ───────────────────────────────────────────────────────
      'Closed At (IST)':     TradeExporter._toISTString(trade.closedTs),
      // ── Pattern logic ─────────────────────────────────────────────────────
      'Pattern Description': def?.description      ?? '',
      'Entry Logic':         def ? (def.signals[signal] ?? '') : '',
      'Exit Logic':          def?.exitLogic         ?? '',
      'Volume Role':         def?.volumeRole        ?? '',
      'Trade Explanation':   TradeExporter.explainPattern(trade),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // toCSV()
  //
  // Accepts an array of trades and an optional IST date string (YYYY-MM-DD).
  // When date is provided, only trades that opened on that IST date are
  // included.  Returns the full CSV as a UTF-8 string with a BOM prefix so
  // Excel on Windows opens it with correct encoding.
  // ─────────────────────────────────────────────────────────────────────────
  static toCSV(trades, date = null) {
    // Filter to the requested date if provided
    const filtered = date
      ? trades.filter((t) => TradeExporter._toISTDate(t.ts) === date)
      : trades;

    if (filtered.length === 0) {
      // Return a CSV with just headers and a "no data" row so the file is not
      // blank when the user opens it in Excel.
      const headers = Object.keys(TradeExporter.buildRow({ ts: Date.now() }));
      return '﻿' + headers.join(',') + '\r\n' + headers.map(() => '').join(',') + '\r\n';
    }

    const rows    = filtered.map((t) => TradeExporter.buildRow(t));
    const headers = Object.keys(rows[0]);

    const csvLines = [
      headers.map(TradeExporter._csvCell).join(','),
      ...rows.map((row) =>
        headers.map((h) => TradeExporter._csvCell(row[h])).join(',')
      ),
    ];

    // UTF-8 BOM (﻿) so Excel auto-detects encoding
    return '﻿' + csvLines.join('\r\n') + '\r\n';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // filename()
  //
  // Returns a safe filename for the given date, e.g. "trades-2025-05-21.csv"
  // ─────────────────────────────────────────────────────────────────────────
  static filename(date) {
    return `trades-${date ?? TradeExporter._toISTDate(Date.now())}.csv`;
  }
}

module.exports = TradeExporter;
