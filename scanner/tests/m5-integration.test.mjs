
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { detectM5Snr, resolveLockedM5Snr, TF_MS } from '../m5-engine.mjs';

const scannerUrl = new URL('../m5-auto-scanner.mjs', import.meta.url);
const engineUrl = new URL('../m5-engine.mjs', import.meta.url);
const monitorUrl = new URL('../status-monitor.mjs', import.meta.url);

const [scanner, engine, monitor] = await Promise.all([
  readFile(scannerUrl, 'utf8'),
  readFile(engineUrl, 'utf8'),
  readFile(monitorUrl, 'utf8')
]);

test('scanner imports the M5 engine functions', () => {
  assert.match(scanner, /from ['"]\.\/m5-engine\.mjs['"]/);
  assert.match(scanner, /closedCandles/);
  assert.match(scanner, /detectH4Snr/);
  assert.match(scanner, /detectM5Snr/);
  assert.match(scanner, /evaluateM5Signal/);
  assert.match(scanner, /evaluateM5Signal\(m5, \{ h4Snr, m5Snr \}\)/);
});

test('scanner fetches M5 and H4 candle data', () => {
  assert.match(scanner, /fetchTf\(['"]5m['"]\)/);
  assert.match(scanner, /fetchTf\(['"]4h['"]\)/);
});

test('scanner rejects incomplete candle data', () => {
  assert.match(scanner, /Candle M5 tertutup tidak cukup/);
  assert.match(scanner, /Belum ada candle H4 tertutup/);
});

test('scanner publishes H4 and M5 SNR to Firestore', () => {
  assert.match(scanner, /market_analysis/);
  assert.match(scanner, /xauusd_snr/);
  assert.match(scanner, /h4Resistance/);
  assert.match(scanner, /h4Support/);
  assert.match(scanner, /m5Resistance/);
  assert.match(scanner, /m5Support/);
});

test('scanner uses an M5-only processing checkpoint', () => {
  assert.match(scanner, /xauusd_m5/);
  assert.match(scanner, /lastProcessedCandleTime/);
  assert.match(scanner, /last\.time\s*<=\s*previous/);
});

test('scanner prevents duplicate signal claims', () => {
  assert.match(scanner, /sent_signals/);
  assert.match(scanner, /runTransaction/);
  assert.match(scanner, /tx\.create/);
  assert.match(scanner, /DUPLICATE BLOCKED/);
});

test('FCM notification contains M5 signal data without setup labels', () => {
  assert.match(scanner, /getMessaging\(\)\.send/);
  assert.match(scanner, /NEW_SIGNAL/);
  assert.match(scanner, /timeframe:\s*['"]M5['"]/);
  assert.match(scanner, /timeframeMinutes:\s*['"]5['"]/);
  assert.doesNotMatch(scanner, /setupNumber|setupName|SETUP 1|SETUP 2|SETUP 3/);
});

test('engine exports the required M5 and SNR functions', () => {
  assert.match(engine, /export function normalizeCandles/);
  assert.match(engine, /export function closedCandles/);
  assert.match(engine, /export function detectH4Snr/);
  assert.match(engine, /export function detectM5Snr/);
  assert.match(engine, /export function evaluateM5Rejection/);
});

test('status monitor must not execute legacy M30/M15 signals', () => {
  assert.doesNotMatch(
    monitor,
    /TF_MINUTES\s*=\s*\{[^}]*M30[^}]*M15/s
  );
  assert.doesNotMatch(
    monitor,
    /timeframe:\s*['"]M30['"]|timeframe:\s*['"]M15['"]/
  );
});


test('scanner includes the newest fully closed M5 candle when updating locked SNR touch and break state', () => {
  // The newest closed candle must update touch/break state immediately.
  // Signal evaluation still uses m5 and keeps its own C2 confirmation rules.
  assert.match(scanner, /detectM5Snr\(m5, last\.close, 2\)/);
  assert.match(scanner, /resolveLockedM5Snr\(m5, last\.close, detectedM5Snr, previousState\)/);
  assert.match(scanner, /evaluateM5Signal\(m5, \{ h4Snr, m5Snr \}\)/);
  assert.doesNotMatch(scanner, /m5History\s*=\s*m5\.slice\(0,\s*-1\)/);
});

test('M5 SNR integration retires a resistance only after a later body close above it', () => {
  const base = Date.UTC(2026, 0, 1);
  const c = (i, open, high, low, close) => ({ time: base + i * TF_MS.M5, open, high, low, close });
  const candles = [
    c(0,100,105,98,101), c(1,101,108,99,102), c(2,102,110,100,103),
    c(3,103,107,97,100), c(4,100,104,95,99),
    c(5,109,112,108,111),
    c(6,111,113,109,112), c(7,112,114,110,113),
    c(8,113,115,111,114), c(9,113,114,110,112), c(10,112,113,109,112)
  ];
  const levels = detectM5Snr(candles, 112, 2);
  assert.equal(levels.resistance, 115);
  assert.equal(levels.resistanceLevels.includes(110), false);
});


test('M5 SNR integration retires a support only after a later body close below it', () => {
  const base = Date.UTC(2026, 0, 1);
  const c = (i, open, high, low, close) => ({ time: base + i * TF_MS.M5, open, high, low, close });
  const candles = [
    c(0,100,105,95,101), c(1,101,104,92,100), c(2,100,103,90,99),
    c(3,99,104,94,101), c(4,101,105,95,102),
    c(5,91,93,88,89),
    c(6,89,94,87,92), c(7,92,96,88,94),
    c(8,94,98,85,93), c(9,93,97,87,92), c(10,92,96,88,93)
  ];
  const levels = detectM5Snr(candles, 90, 2);
  assert.equal(levels.support, 85);
  assert.equal(levels.supportLevels.includes(90), false);
});

test('M5 SNR integration keeps a support after wick-only penetration', () => {
  const base = Date.UTC(2026, 0, 1);
  const c = (i, open, high, low, close) => ({ time: base + i * TF_MS.M5, open, high, low, close });
  const candles = [
    c(0,100,105,95,101), c(1,101,104,92,100), c(2,100,103,90,99),
    c(3,99,104,94,101), c(4,101,105,95,102),
    c(5,91,93,88,90.5), c(6,90.5,94,89,92),
    c(7,92,96,91,94), c(8,94,98,92,93)
  ];
  const levels = detectM5Snr(candles, 95, 2);
  assert.equal(levels.support, 90);
  assert.equal(levels.supportLevels.includes(90), true);
});

test('M5 SNR integration keeps a resistance after wick-only penetration', () => {
  const base = Date.UTC(2026, 0, 1);
  const c = (i, open, high, low, close) => ({ time: base + i * TF_MS.M5, open, high, low, close });
  const candles = [
    c(0,100,105,98,101), c(1,101,108,99,102), c(2,102,110,100,103),
    c(3,103,107,97,100), c(4,100,104,95,99),
    c(5,109,112,108,109.5), c(6,109.5,109.8,108,109),
    c(7,109,109.5,107,108), c(8,108,109,106,108)
  ];
  const levels = detectM5Snr(candles, 108, 2);
  assert.equal(levels.resistance, 110);
  assert.equal(levels.resistanceLevels.includes(110), true);
});


test('scanner persists locked M5 SNR state between polling cycles', () => {
  assert.match(scanner, /resolveLockedM5Snr/);
  assert.match(scanner, /m5SnrLock/);
  assert.match(scanner, /state\.get\('m5SnrLock'\)/);
  assert.match(scanner, /m5ResistanceTouched/);
  assert.match(scanner, /m5SupportTouched/);
});

test('locked M5 SNR resolver preserves an untouched level until a closer new structure forms', () => {
  const base = Date.UTC(2026, 0, 1);
  const c = (i, open, high, low, close) => ({time:base+i*TF_MS.M5,open,high,low,close});
  const candles = [c(3,100,109,97,102),c(4,102,108,98,103),c(5,103,107,99,104)];
  const detected = {
    supportCandidates:[{price:90,time:base},{price:96,time:base+2*TF_MS.M5}],
    resistanceCandidates:[{price:120,time:base},{price:112,time:base+2*TF_MS.M5}]
  };
  const previous = {support:{price:90,time:base,touched:false},resistance:{price:120,time:base,touched:false}};
  const result = resolveLockedM5Snr(candles,104,detected,previous);
  assert.equal(result.snr.support,96);
  assert.equal(result.snr.resistance,112);
});
