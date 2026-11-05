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
    const candle = { time, open: Number(row?.open ?? row?.o), high: Number(row?.high ?? row?.h), low: Number(row?.low ?? row?.l), close: Number(row?.close ?? row?.c) };
    if (![candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) continue;
    if (candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close) || candle.high < candle.low) continue;
    byTime.set(candle.time, candle);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export function closedCandles(candles, timeframeMs, now = Date.now()) {
  if (!Number.isFinite(timeframeMs) || timeframeMs <= 0) throw new TypeError('timeframeMs must be positive');
  return normalizeCandles(candles).filter(c => c.time % timeframeMs === 0 && c.time + timeframeMs <= now);
}

// H4 levels are refreshed from the most recently completed H4 candle.
export function detectH4Snr(h4Candles) {
  const candles = normalizeCandles(h4Candles);
  if (!candles.length) return null;
  const last = candles.at(-1);
  return { resistance: last.high, support: last.low, candleTime: last.time, source: 'H4_CLOSED_WICK' };
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
  const resistances = highs.filter(x => x.price > price).sort((a,b) => a.price-b.price);
  const supports = lows.filter(x => x.price < price).sort((a,b) => b.price-a.price);
  return {
    resistance: resistances[0]?.price ?? null,
    resistanceTime: resistances[0]?.time ?? null,
    support: supports[0]?.price ?? null,
    supportTime: supports[0]?.time ?? null,
    source: 'M5_CONFIRMED_SWING_2x2'
  };
}

const bullish = c => c.close > c.open;
const bearish = c => c.close < c.open;

export function evaluateM5Rejection(m5Candles, { h4Snr, m5Snr } = {}) {
  const c = normalizeCandles(m5Candles);
  if (c.length < 4 || !h4Snr || !m5Snr) return null;
  const beforeC1 = c.at(-3), c1 = c.at(-2), c2 = c.at(-1);
  // BUY is the exact inverse of SELL. C2 is required to be a closed candle by caller.
  const sellPattern = bullish(beforeC1) && bullish(c.at(-4)) && bearish(c1) && bearish(c2) && c2.close < c1.low;
  const buyPattern = bearish(beforeC1) && bearish(c.at(-4)) && bullish(c1) && bullish(c2) && c2.close > c1.high;
  const atResistance = [h4Snr.resistance, m5Snr.resistance].some(level => Number.isFinite(Number(level)) && c1.high >= Number(level) && c1.low <= Number(level));
  const atSupport = [h4Snr.support, m5Snr.support].some(level => Number.isFinite(Number(level)) && c1.low <= Number(level) && c1.high >= Number(level));
  if (!sellPattern && !buyPattern) return null;
  if (sellPattern && !atResistance) return null;
  if (buyPattern && !atSupport) return null;
  const type = buyPattern ? 'BUY' : 'SELL';
  const entry = c2.close;
  const sl = type === 'BUY' ? Math.min(c1.low, beforeC1.low) : Math.max(c1.high, beforeC1.high);
  const risk = type === 'BUY' ? entry - sl : sl - entry;
  if (!(risk > 0) || !Number.isFinite(risk)) return null;
  const tp = type === 'BUY' ? entry + risk : entry - risk;
  if (!Number.isFinite(tp) || (type === 'BUY' ? !(sl < entry && tp > entry) : !(sl > entry && tp < entry))) return null;
  return { type, timeframe: 'M5', timeframeMinutes: 5, entry, sl, tp, riskDistance: risk, rr: 1, candleTime: c2.time, candleCloseTime: c2.time + TF_MS.M5, c1Time: c1.time, pattern: 'SNR_REJECTION_C1_C2' };
}
