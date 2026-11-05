import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandles, closedCandles, detectH4Snr, detectM5Snr, evaluateM5Rejection, evaluateM5BreakoutRetest, evaluateM5Signal, resolveLockedM5Snr, TF_MS } from '../m5-engine.mjs';

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


test('H4 SNR uses exactly the latest single fully closed candle wick pair', () => {
  const h4Start = Date.UTC(2026, 10, 5, 0, 0, 0);
  const rows = [
    { openTime: h4Start, open: 4065.527, high: 4147.028, low: 4061.479, close: 4140.587, isOpen: false },
    { openTime: h4Start + TF_MS.H4, open: 4140.665, high: 4145.416, low: 4108.993, close: 4122.070, isOpen: true }
  ];
  const closed = closedCandles(rows, TF_MS.H4, h4Start + TF_MS.H4 + 60_000);
  assert.equal(closed.length, 1);
  const levels = detectH4Snr(closed);
  assert.equal(levels.resistance, 4147.028);
  assert.equal(levels.support, 4061.479);
  assert.equal(levels.candleTime, h4Start);
  assert.equal(levels.candleCloseTime, h4Start + TF_MS.H4);
});

test('H4 SNR rolls to the new candle only after its four-hour close', () => {
  const h4Start = Date.UTC(2026, 10, 5, 0, 0, 0);
  const rows = [
    { openTime: h4Start, open: 4065, high: 4147, low: 4061, close: 4140, isOpen: false },
    { openTime: h4Start + TF_MS.H4, open: 4140, high: 4155, low: 4108, close: 4148, isOpen: false }
  ];
  const beforeClose = closedCandles(rows, TF_MS.H4, h4Start + 2 * TF_MS.H4 - 1);
  assert.equal(beforeClose.length, 1);
  const afterClose = closedCandles(rows, TF_MS.H4, h4Start + 2 * TF_MS.H4);
  assert.equal(afterClose.length, 2);
  const levels = detectH4Snr(afterClose);
  assert.equal(levels.resistance, 4155);
  assert.equal(levels.support, 4108);
  assert.equal(levels.candleTime, h4Start + TF_MS.H4);
});


test('BUY breakout-retest is active through the combined M5 signal dispatcher', () => {
  const rows = [
    candle(0,99,102,98,101),   // body closes above resistance 100
    candle(1,101,103,100.5,102),
    candle(2,102,104,101,103),
    candle(3,103,104,99.8,102), // retest holds above 100
    candle(4,102,105,101,104),  // C1 bullish
    candle(5,104,108,103,107)   // C2 confirms above C1 high
  ];
  const levels = { h4Snr:{resistance:100,support:90}, m5Snr:{resistance:100,support:90,resistanceLevels:[100],supportLevels:[90]} };
  const signal = evaluateM5Signal(rows, levels);
  assert.equal(signal.type, 'BUY');
  assert.equal(signal.pattern, 'M5_SNR_BREAKOUT_RETEST');
  assert.equal(signal.entry, 107);
  assert.equal(signal.rr, 1);
});

test('SELL breakout-retest is active through the combined M5 signal dispatcher', () => {
  const rows = [
    candle(0,101,102,98,99),   // body closes below support 100
    candle(1,99,99.5,97,98),
    candle(2,98,99,96,97),
    candle(3,97,100.2,96,98),  // retest holds below 100
    candle(4,98,99,95,96),     // C1 bearish
    candle(5,96,97,92,93)      // C2 confirms below C1 low
  ];
  const levels = { h4Snr:{resistance:110,support:100}, m5Snr:{resistance:110,support:100,resistanceLevels:[110],supportLevels:[100]} };
  const signal = evaluateM5Signal(rows, levels);
  assert.equal(signal.type, 'SELL');
  assert.equal(signal.pattern, 'M5_SNR_BREAKOUT_RETEST');
  assert.equal(signal.entry, 93);
  assert.equal(signal.rr, 1);
});


test('locked M5 SNR moves to a newer closer untouched market-structure level', () => {
  const rows = [
    candle(3,100,109,97,102),
    candle(4,102,108,98,103),
    candle(5,103,107,99,104)
  ];
  const detected = {
    supportCandidates: [{price:90,time:base},{price:96,time:base+2*TF_MS.M5}],
    resistanceCandidates: [{price:120,time:base},{price:112,time:base+2*TF_MS.M5}]
  };
  const previous = {
    support:{price:90,time:base,touched:false},
    resistance:{price:120,time:base,touched:false}
  };
  const result = resolveLockedM5Snr(rows,104,detected,previous);
  assert.equal(result.support.price,96);
  assert.equal(result.resistance.price,112);
  assert.equal(result.support.touched,false);
  assert.equal(result.resistance.touched,false);
});

test('a wick touch locks the existing M5 SNR and blocks structure-only replacement', () => {
  const rows = [
    candle(2,100,108,90,102), // wick touches old support 95
    candle(3,102,109,97,104),
    candle(4,104,110,98,105)
  ];
  const detected = {
    supportCandidates:[{price:95,time:base},{price:99,time:base+TF_MS.M5}],
    resistanceCandidates:[{price:120,time:base}]
  };
  const previous = {
    support:{price:95,time:base,touched:false},
    resistance:{price:120,time:base,touched:false}
  };
  const result = resolveLockedM5Snr(rows,105,detected,previous);
  assert.equal(result.support.price,95);
  assert.equal(result.support.touched,true);
});

test('a body close through locked M5 support retires it and selects the next untouched support', () => {
  const rows = [
    candle(2,100,108,94,101),
    candle(3,101,106,92,99),
    candle(4,99,103,89,90), // wick below 95 but close still at 90: body crosses from above
    candle(5,90,94,88,91),
    candle(6,91,96,90,93)
  ];
  const detected = {
    supportCandidates:[{price:95,time:base},{price:85,time:base+TF_MS.M5}],
    resistanceCandidates:[]
  };
  const previous = {support:{price:95,time:base,touched:true},resistance:null};
  const result = resolveLockedM5Snr(rows,93,detected,previous);
  assert.equal(result.support.price,85);
});

test('a wick-only touch does not retire locked M5 support', () => {
  const rows = [
    candle(2,100,108,94,101), // wick through 95, body remains above
    candle(3,101,107,96,102),
    candle(4,102,108,97,104)
  ];
  const detected = {supportCandidates:[{price:95,time:base},{price:90,time:base+TF_MS.M5}],resistanceCandidates:[]};
  const previous = {support:{price:95,time:base,touched:false},resistance:null};
  const result = resolveLockedM5Snr(rows,104,detected,previous);
  assert.equal(result.support.price,95);
  assert.equal(result.support.touched,true);
});


test('H4 closed-candle filter accepts BiQuote session timestamps not aligned to UTC 4-hour epoch', () => {
  const sessionStart = Date.UTC(2026, 10, 5, 1, 0, 0); // deliberately not divisible by 4h
  const rows = [
    { time: sessionStart, open: 100, high: 125, low: 95, close: 115 },
    { time: sessionStart + TF_MS.H4, open: 115, high: 130, low: 105, close: 120 }
  ];
  const beforeNextClose = closedCandles(rows, TF_MS.H4, sessionStart + 2 * TF_MS.H4 - 1);
  assert.equal(beforeNextClose.length, 1);
  const afterNextClose = closedCandles(rows, TF_MS.H4, sessionStart + 2 * TF_MS.H4);
  assert.equal(afterNextClose.length, 2);
  const levels = detectH4Snr(afterNextClose);
  assert.equal(levels.resistance, 130);
  assert.equal(levels.support, 105);
  assert.equal(levels.candleTime, sessionStart + TF_MS.H4);
});

test('locked M5 level records a wick touch on the newest closed candle', () => {
  const rows = [
    candle(10, 100, 105, 96, 102),
    candle(11, 102, 106, 97, 103),
    candle(12, 103, 107, 98, 104),
    candle(13, 104, 108, 94, 105)
  ];
  const detected = {
    supportCandidates: [{ price: 95, time: base }],
    resistanceCandidates: [{ price: 120, time: base }]
  };
  const previous = { support: { price: 95, time: base, touched: false }, resistance: { price: 120, time: base, touched: false } };
  const result = resolveLockedM5Snr(rows, 105, detected, previous);
  assert.equal(result.support.price, 95);
  assert.equal(result.support.touched, true);
});
