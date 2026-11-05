/*
 * SEBU DOLLAR AI — deterministic M5 signal/SNR engine.
 * Pure functions: no Firebase, network, browser or clock side effects.
 * Only fully closed candles may be passed to the detection functions.
 */

export const TF_MS = Object.freeze({ M5: 5 * 60_000, H4: 4 * 60 * 60_000 });

export function normalizeCandles(rows) {
  if (!Array.isArray(rows)) return [];
  const byTime = new Map();
  for (const row of rows) {
    const rawTime = row?.time ?? row?.timestamp ?? row?.datetime ?? row?.openTime ?? row?.t;
    let time = typeof rawTime === 'number' ? rawTime : Number(rawTime);
    if (!Number.isFinite(time)) time = Date.parse(String(rawTime ?? ''));
    if (Number.isFinite(time) && time < 1e12) time *= 1000;
    const rawIsOpen = row?.isOpen ?? row?.is_open;
    const isOpen = rawIsOpen === true || String(rawIsOpen).toLowerCase() === 'true';
    const candle = { time, open: Number(row?.open ?? row?.o), high: Number(row?.high ?? row?.h), low: Number(row?.low ?? row?.l), close: Number(row?.close ?? row?.c), ...(rawIsOpen !== undefined ? { isOpen } : {}) };
    if (![candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) continue;
    if (candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close) || candle.high < candle.low) continue;
    byTime.set(candle.time, candle);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export function closedCandles(candles, timeframeMs, now = Date.now()) {
  if (!Number.isFinite(timeframeMs) || timeframeMs <= 0) throw new TypeError('timeframeMs must be positive');
  // BiQuote candle timestamps are authoritative. Do not require Unix-epoch
  // alignment: broker/session H4 boundaries may be offset from UTC multiples.
  // A candle is closed when its own open time + timeframe has elapsed.
  return normalizeCandles(candles).filter(c =>
    c.isOpen !== true &&
    c.time + timeframeMs <= now
  );
}

// H4 levels are refreshed from the most recently completed H4 candle.
export function detectH4Snr(h4Candles) {
  const candles = normalizeCandles(h4Candles);
  if (!candles.length) return null;
  const last = candles.at(-1);
  return {
    resistance: last.high,
    support: last.low,
    candleTime: last.time,
    candleCloseTime: last.time + TF_MS.H4,
    source: 'H4_LAST_CLOSED_CANDLE_WICK'
  };
}

// Confirmed M5 swing points: two candles on each side must have closed.
export function detectM5Snr(m5Candles, currentPrice, leftRight = 2) {
  const candles = normalizeCandles(m5Candles);
  const price = Number(currentPrice);
  if (!Number.isFinite(price) || candles.length < leftRight * 2 + 1) return null;
  const highs = [], lows = [];
  for (let i = leftRight; i < candles.length - leftRight; i++) {
    const p = candles[i];
    const before = candles.slice(i - leftRight, i);
    const after = candles.slice(i + 1, i + leftRight + 1);
    if (before.every(x => p.high > x.high) && after.every(x => p.high >= x.high)) highs.push({ price: p.high, time: p.time });
    if (before.every(x => p.low < x.low) && after.every(x => p.low <= x.low)) lows.push({ price: p.low, time: p.time });
  }
  // A confirmed BODY close through a swing permanently invalidates that old
  // M5 level. Wick-only penetrations do not invalidate it.
  const activeHighs = highs.filter(level => !candles.some(c => c.time > level.time && c.close > level.price));
  const activeLows = lows.filter(level => !candles.some(c => c.time > level.time && c.close < level.price));
  const resistances = activeHighs.filter(x => x.price > price).sort((a,b) => a.price-b.price);
  const supports = activeLows.filter(x => x.price < price).sort((a,b) => b.price-a.price);
  return {
    resistance: resistances[0]?.price ?? null,
    resistanceTime: resistances[0]?.time ?? null,
    support: supports[0]?.price ?? null,
    supportTime: supports[0]?.time ?? null,
    resistanceLevels: activeHighs.map(x => x.price).sort((a,b) => a-b),
    supportLevels: activeLows.map(x => x.price).sort((a,b) => b-a),
    resistanceCandidates: activeHighs,
    supportCandidates: activeLows,
    source: 'M5_CONFIRMED_SWING_2x2'
  };
}

/**
 * Stateful M5 SNR selection.
 * - Keep the current level until a later candle body closes through it.
 * - Record wick touches without treating them as breaks.
 * - Before first touch, allow a newer, closer confirmed structure to replace it.
 * - A replacement candidate must itself remain untouched after its pivot.
 * Persist the returned state between scanner runs.
 */
export function resolveLockedM5Snr(m5Candles, currentPrice, detected, previousState = {}) {
  const candles = normalizeCandles(m5Candles);
  const price = Number(currentPrice);
  const candidates = detected || {};
  const isTouchedAfter = (candidate, side) => candles.some(c =>
    c.time > candidate.time &&
    (side === 'support' ? c.low <= candidate.price : c.high >= candidate.price)
  );
  const isBrokenAfter = (level, side) => candles.some(c =>
    c.time > level.time &&
    (side === 'support'
      ? c.close < level.price
      : c.close > level.price)
  );

  function resolveSide(side) {
    const candidateKey = side === 'support' ? 'supportCandidates' : 'resistanceCandidates';
    const candidatesForSide = Array.isArray(candidates[candidateKey]) ? candidates[candidateKey] : [];
    const isCloser = (candidate, current) => side === 'support'
      ? candidate.price > current.price && candidate.price < price
      : candidate.price < current.price && candidate.price > price;
    const nearest = list => [...list].sort((a, b) =>
      side === 'support' ? b.price - a.price : a.price - b.price
    )[0] || null;

    let locked = previousState?.[side] && Number.isFinite(Number(previousState[side].price))
      ? { price: Number(previousState[side].price), time: Number(previousState[side].time), touched: Boolean(previousState[side].touched) }
      : null;

    const validUntouched = candidatesForSide.filter(x =>
      Number.isFinite(Number(x.price)) && Number.isFinite(Number(x.time)) &&
      (side === 'support' ? x.price < price : x.price > price) &&
      !isBrokenAfter(x, side) && !isTouchedAfter(x, side)
    );

    if (locked && isBrokenAfter(locked, side)) locked = null;

    if (!locked) {
      const next = nearest(validUntouched);
      return next ? { price: next.price, time: next.time, touched: false } : null;
    }

    const touched = locked.touched || isTouchedAfter(locked, side);
    if (!touched) {
      const newerCloser = validUntouched.filter(x => x.time > locked.time && isCloser(x, locked));
      const next = nearest(newerCloser);
      if (next) return { price: next.price, time: next.time, touched: false };
    }
    return { ...locked, touched };
  }

  const support = resolveSide('support');
  const resistance = resolveSide('resistance');
  return {
    support,
    resistance,
    snr: {
      support: support?.price ?? null,
      supportTime: support?.time ?? null,
      resistance: resistance?.price ?? null,
      resistanceTime: resistance?.time ?? null,
      supportLevels: support ? [support.price] : [],
      resistanceLevels: resistance ? [resistance.price] : [],
      source: 'M5_LOCKED_CONFIRMED_STRUCTURE'
    }
  };
}

const bullish = c => c.close > c.open;
const bearish = c => c.close < c.open;

function validRiskSignal(type, entry, sl, candle, pattern) {
  const risk = type === 'BUY' ? entry - sl : sl - entry;
  if (!(risk > 0) || !Number.isFinite(risk)) return null;
  const tp = type === 'BUY' ? entry + risk : entry - risk;
  if (!Number.isFinite(tp)) return null;
  return {
    type, timeframe: 'M5', timeframeMinutes: 5, entry, sl, tp,
    riskDistance: risk, rr: 1, candleTime: candle.time,
    candleCloseTime: candle.time + TF_MS.M5, pattern
  };
}

function touches(level, candle) {
  return Number.isFinite(Number(level)) && candle.low <= Number(level) && candle.high >= Number(level);
}

/**
 * Rejection reversal:
 * two candles in the approach direction, C1 reverses, C2 confirms beyond
 * C1's wick. C2 is the latest closed candle supplied by the caller.
 */
export function evaluateM5Rejection(m5Candles, { h4Snr, m5Snr } = {}) {
  const c = normalizeCandles(m5Candles);
  if (c.length < 4 || !h4Snr || !m5Snr) return null;
  const approach = c.at(-4), beforeC1 = c.at(-3), c1 = c.at(-2), c2 = c.at(-1);
  const sellPattern = bullish(approach) && bullish(beforeC1) && bearish(c1) && bearish(c2) && c2.open >= c1.low && c2.close < c1.low;
  const buyPattern = bearish(approach) && bearish(beforeC1) && bullish(c1) && bullish(c2) && c2.open <= c1.high && c2.close > c1.high;
  const atResistance = [h4Snr.resistance, m5Snr.resistance].some(level => touches(level, c1));
  const atSupport = [h4Snr.support, m5Snr.support].some(level => touches(level, c1));
  if (sellPattern && atResistance) return validRiskSignal('SELL', c2.close, Math.max(c1.high, beforeC1.high), c2, 'M5_SNR_REJECTION_C1_C2');
  if (buyPattern && atSupport) return validRiskSignal('BUY', c2.close, Math.min(c1.low, beforeC1.low), c2, 'M5_SNR_REJECTION_C1_C2');
  return null;
}

/**
 * Breakout/retest confirmation. A closed candle must break a level, a later
 * candle must retest and hold it, then C1/C2 confirm in the breakout direction.
 * C1 is the first directional candle after retest; C2 must close beyond C1 wick.
 */
export function evaluateM5BreakoutRetest(m5Candles, { h4Snr, m5Snr } = {}) {
  const c = normalizeCandles(m5Candles);
  if (c.length < 5 || !h4Snr || !m5Snr) return null;
  const c2 = c.at(-1), c1 = c.at(-2), retest = c.at(-3);
  const history = c.slice(0, -3);
  const resistanceLevels = [...new Set([h4Snr.resistance, m5Snr.resistance, ...(m5Snr.resistanceLevels || [])].map(Number).filter(Number.isFinite))];
  const supportLevels = [...new Set([h4Snr.support, m5Snr.support, ...(m5Snr.supportLevels || [])].map(Number).filter(Number.isFinite))];

  // BUY only follows a confirmed resistance break, hold above, retest, then C1/C2 confirmation.
  if (bullish(c1) && bullish(c2) && c2.close > c1.high) {
    for (const level of resistanceLevels) {
      const breakIndex = history.findIndex(x => x.close > level && x.open <= level);
      if (breakIndex < 0) continue;
      const held = history.slice(breakIndex + 1).every(x => x.close >= level);
      if (!held || retest.low > level || retest.close < level || c1.close < level || c2.close <= level) continue;
      const signal = validRiskSignal('BUY', c2.close, Math.min(c1.low, retest.low), c2, 'M5_SNR_BREAKOUT_RETEST');
      if (signal) return signal;
    }
  }

  // SELL only follows a confirmed support break, hold below, retest, then C1/C2 confirmation.
  if (bearish(c1) && bearish(c2) && c2.close < c1.low) {
    for (const level of supportLevels) {
      const breakIndex = history.findIndex(x => x.close < level && x.open >= level);
      if (breakIndex < 0) continue;
      const held = history.slice(breakIndex + 1).every(x => x.close <= level);
      if (!held || retest.high < level || retest.close > level || c1.close > level || c2.close >= level) continue;
      const signal = validRiskSignal('SELL', c2.close, Math.max(c1.high, retest.high), c2, 'M5_SNR_BREAKOUT_RETEST');
      if (signal) return signal;
    }
  }
  return null;
}

export function evaluateM5Signal(m5Candles, levels) {
  return evaluateM5Rejection(m5Candles, levels) || evaluateM5BreakoutRetest(m5Candles, levels);
}
