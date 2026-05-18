/**
 * alertBus.js
 *
 * Lightweight internal EventEmitter that decouples scan sources
 * (backgroundScanner, liveScanner, manual scan route) from the autoTrader.
 *
 * Usage:
 *   alertBus.emit('alert', alertPayload, source)
 *   alertBus.on('alert', (alert, source) => { ... })
 */
const { EventEmitter } = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(20); // suppress warnings if multiple listeners attach
module.exports = bus;
