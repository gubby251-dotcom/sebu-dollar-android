import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandles, closedCandles, detectH4Snr, detectM5Snr, evaluateM5Rejection, TF_MS } from '../m5-engine.mjs';

const base = Date.UTC(2026, 0, 1, 0, 0, 0);
const candle = (i, o, h, l, c) => ({ time: base + i * TF_MS.M5, open:o, high:h, low:l, close:c });

test('normalizer sorts, de-duplicates and rejects malformed candles', () => {
  const rows = [candle(1,10,12,9,11), candle(0,10,11,9,10), candle(1,10,13,9,12), {time:base,open:5,high:4,low:3,close:5}];
  const out = normalizeCandles(rows);
  assert.equal(out.length, 2); assert.equal(out[0].time, base); assert.equal(out[1].high, 13);
});

test('closed candle filter excludes the currently forming M5 candle', () => {
  const rows = [candle(0,10,11,9,10), candle(1,10,11,9,10)];
  assert.equal(closedCandles(rows, TF_MS.M5, base + TF_MS.M5 + 1).length, 1);
});

test('H4 SNR reads wick high/low of latest closed candle', () => {
  const h4 = [{time:base,open:100,high:120,low:90,close:110},{time:base+TF_MS.H4,open:110,high:130,low:95,close:115}];
  const levels = detectH4Snr(h4); assert.equal(levels.resistance,130); assert.equal(levels.support,95);
});

test('M5 SNR chooses nearest confirmed resistance above and support below price', () => {
  const rows = [
    candle(0,100,105,98,101), candle(1,101,108,99,102), candle(2,102,110,100,103), candle(3,103,107,97,100), candle(4,100,104,95,99),
    candle(5,99,103,96,100), candle(6,100,106,97,101), candle(7,101,104,98,100), candle(8,100,102,94,99)
  ];
  const levels = detectM5Snr(rows, 100);
  assert.equal(levels.resistance, 106); assert.equal(levels.support, 95);
});

test('SELL rejection requires two bullish candles, bearish C1/C2 and C2 close below C1 low', () => {
  const rows = [candle(0,100,103,99,102), candle(1,102,106,101,105), candle(2,105,107,100,103), candle(3,103,104,98,99)];
  const signal = evaluateM5Rejection(rows, {h4Snr:{resistance:107,support:90},m5Snr:{resistance:107,support:90}});
  assert.equal(signal.type,'SELL'); assert.equal(signal.entry,99); assert.equal(signal.sl,107); assert.equal(signal.tp,91);
});

test('BUY rejection is inverse and uses C2 close for entry', () => {
  const rows = [candle(0,102,103,99,100), candle(1,100,101,96,97), candle(2,97,104,95,101), candle(3,101,106,100,105)];
  const signal = evaluateM5Rejection(rows, {h4Snr:{resistance:120,support:95},m5Snr:{resistance:120,support:95}});
  assert.equal(signal.type,'BUY'); assert.equal(signal.entry,105); assert.equal(signal.sl,95); assert.equal(signal.tp,115);
});

test('no signal when pattern is not at matching SNR', () => {
  const rows = [candle(0,100,103,99,102), candle(1,102,106,101,105), candle(2,105,107,100,103), candle(3,103,104,98,99)];
  assert.equal(evaluateM5Rejection(rows, {h4Snr:{resistance:120,support:90},m5Snr:{resistance:125,support:90}}), null);
});

test('signal risk and reward are equal (RR 1:1)', () => {
  const rows = [candle(0,100,103,99,102), candle(1,102,106,101,105), candle(2,105,107,100,103), candle(3,103,104,98,99)];
  const signal = evaluateM5Rejection(rows, {h4Snr:{resistance:107,support:90},m5Snr:{resistance:107,support:90}});
  assert.equal(signal.riskDistance, Math.abs(signal.tp - signal.entry));
});


test('M5 resistance is retired only after body crosses and closes above it', () => {
  const rows = [
    candle(0,100,104,98,102),
    candle(1,102,107,100,105),
    candle(2,105,110,103,106),
    candle(3,106,108,102,104),
    candle(4,104,107,101,103),
    candle(5,108,112,107,111), // body opens below and closes above 110
    candle(6,110,111,106,109)  // pullback below the broken level
  ];
  const levels = detectM5Snr(rows, 109, 2);
  assert.equal(levels.resistanceLevels.includes(110), false);
  assert.notEqual(levels.resistance, 110);
  assert.ok(levels.brokenResistanceLevels.some(x => x.price === 110));
});

test('M5 wick-only probe does not retire resistance', () => {
  const rows = [
    candle(0,100,104,98,102),
    candle(1,102,107,100,105),
    candle(2,105,110,103,106),
    candle(3,106,108,102,104),
    candle(4,104,107,101,103),
    candle(5,108,112,107,109), // wick above 110, body closes below
    candle(6,109,110,106,108)
  ];
  const levels = detectM5Snr(rows, 108, 2);
  assert.ok(levels.resistanceLevels.includes(110));
  assert.equal(levels.brokenResistanceLevels.some(x => x.price === 110), false);
});

test('M5 support is retired only after body crosses and closes below it', () => {
  const rows = [
    candle(0,110,112,106,108),
    candle(1,108,110,103,105),
    candle(2,105,107,100,104),
    candle(3,104,108,102,106),
    candle(4,106,109,103,107),
    candle(5,102,103,98,99), // body opens above and closes below 100
    candle(6,100,104,99,102) // pullback above broken level
  ];
  const levels = detectM5Snr(rows, 102, 2);
  assert.equal(levels.supportLevels.includes(100), false);
  assert.notEqual(levels.support, 100);
  assert.ok(levels.brokenSupportLevels.some(x => x.price === 100));
});


test('M5 breakout levels are sourced only from M5 SNR, not H4 levels', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../m5-engine.mjs', import.meta.url), 'utf8');
  const breakout = source.split('export function evaluateM5BreakoutRetest')[1]
    .split('export function evaluateM5Signal')[0];
  assert.match(breakout, /Breakout\/retest state is exclusively M5-driven/);
  assert.match(breakout, /\[m5Snr\.resistance, \.\.\.\(m5Snr\.resistanceLevels/);
  assert.match(breakout, /\[m5Snr\.support, \.\.\.\(m5Snr\.supportLevels/);
  assert.doesNotMatch(breakout, /h4Snr/);
});
