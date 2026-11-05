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

test('M5 resistance is invalidated only after a later candle body closes above it', () => {
  const rows = [
    candle(0,100,105,98,101), candle(1,101,108,99,102), candle(2,102,110,100,103),
    candle(3,103,107,97,100), candle(4,100,104,95,99),
    candle(5,109,112,108,111),
    candle(6,111,113,109,112), candle(7,112,114,110,113),
    candle(8,113,115,111,114), candle(9,113,114,110,112), candle(10,112,113,109,112)
  ];
  const levels = detectM5Snr(rows, 112, 2);
  assert.equal(levels.resistance, 115);
  assert.equal(levels.resistanceLevels.includes(110), false);
});

test('M5 wick-only penetration does not invalidate a resistance level', () => {
  const rows = [
    candle(0,100,105,98,101), candle(1,101,108,99,102), candle(2,102,110,100,103),
    candle(3,103,107,97,100), candle(4,100,104,95,99),
    candle(5,109,112,108,109.5), candle(6,109.5,109.8,108,109),
    candle(7,109,109.5,107,108), candle(8,108,109,106,108)
  ];
  const levels = detectM5Snr(rows, 108, 2);
  assert.equal(levels.resistance, 110);
});
