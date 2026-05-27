/**
 * useLocalState — drop-in replacement for useState with localStorage persistence.
 *
 * Initial value is read from localStorage on mount (JSON-parsed).
 * Every change is written back to localStorage immediately.
 * Falls back to `defaultValue` when nothing is stored yet or parsing fails.
 *
 * Usage:
 *   const [signalFilter, setSignalFilter] = useLocalState('scan:signalFilter', 'all');
 *
 * Key naming convention: 'namespace:key'
 *   scan:*    — ScanAlertsPage filters
 *   eqscan:*  — EquityScanPanel filters
 *   pt:*      — PaperTradingPanel preferences
 *   dash:*    — Dashboard preferences
 */

import { useState, useEffect } from 'react';

function useLocalState(key, defaultValue) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return defaultValue;
      return JSON.parse(raw);
    } catch {
      // Corrupted entry or unavailable storage — use default
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // localStorage quota exceeded or access denied — fail silently
    }
  }, [key, value]);

  return [value, setValue];
}

export default useLocalState;
