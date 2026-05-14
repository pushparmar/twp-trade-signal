/**
 * Pattern-alert Telegram message builder.
 *
 * Shared by patternAlertWatcher (macro/index instruments) and liveScanner
 * (user watchlist stocks) so both produce identically-formatted Telegram
 * messages. Centralising this avoids drift between the two watchers when
 * pattern result fields change.
 *
 * Returned string uses Telegram HTML parse_mode tags (<b>, <i>).
 */

const STRENGTH_EMOJI = { strong: '💪', neutral: '➡️', weak: '⚠️' };

// Short labels for the per-check ✅/❌ summary line at the bottom
const CHECK_SHORT = {
  kumoBreakout: 'Breakout',
  cloudColor:   'Cloud',
  kumoTwist:    'Twist',
  chikou:       'Chikou',
  kijun:        'Kijun',
};

/**
 * Build a formatted Telegram message for a pattern match.
 *
 * @param {Object} args
 * @param {string} args.label         - Instrument display name, e.g. "RELIANCE25JUNFUT"
 * @param {string} args.tfLabel       - Timeframe label, e.g. "15m" / "1h" / "4h" / "1d"
 * @param {string} args.patternLabel  - Pattern label, e.g. "TK Cross (last 5 bars)"
 * @param {Object} args.result        - Pattern.run() result with signal, score, etc.
 * @param {string} [args.kind]        - Optional tag prefix: 'macro' | 'index' | 'stock'
 * @returns {string} HTML-formatted message body
 */
function build({ label, tfLabel, patternLabel, result, kind }) {
  const emoji   = result.signal === 'bullish' ? '🟢' : '🔴';
  const sigText = result.signal.toUpperCase();

  const lines = [
    `${emoji} <b>${patternLabel}</b>`,
    ``,
    `📊 <b>${label}</b>  ·  ${tfLabel}${kind ? ` · <i>${kind}</i>` : ''}`,
    `Signal : <b>${sigText}</b>`,
  ];

  if (result.strength != null) {
    const cap = result.strength.charAt(0).toUpperCase() + result.strength.slice(1);
    lines.push(`Strength : ${STRENGTH_EMOJI[result.strength] || ''} <b>${cap}</b>`);
  }
  if (result.cloudPosition != null)     lines.push(`Cloud pos: ${result.cloudPosition}`);
  if (result.score != null)             lines.push(`Score    : ${result.score}/5`);
  if (result.close != null)             lines.push(`Price    : ${result.close}`);
  if (result.barsAgo != null) {
    const prefix = result.crossType ? `${result.crossType} ` : '';
    lines.push(`${prefix}Cross : ${result.barsAgo} bar${result.barsAgo !== 1 ? 's' : ''} ago`);
  }
  if (result.twistBarsAgo != null)      lines.push(`Twist    : ${result.twistBarsAgo} bar${result.twistBarsAgo !== 1 ? 's' : ''} ago`);
  if (result.consecutiveBars != null)   lines.push(`Above/Below cloud : ${result.consecutiveBars} bar${result.consecutiveBars !== 1 ? 's' : ''}`);
  if (result.cloudThickness != null)    lines.push(`Cloud thickness : ${result.cloudThickness}`);

  // Per-check summary (kumo-breakout-twist 5/5 patterns)
  if (result.checks) {
    const checkParts = Object.entries(result.checks).map(([k, v]) => {
      const name = CHECK_SHORT[k] || k;
      return `${v === result.signal ? '✅' : '❌'} ${name}`;
    });
    lines.push(``, checkParts.join('  '));
  }

  return lines.join('\n');
}

module.exports = { build };
