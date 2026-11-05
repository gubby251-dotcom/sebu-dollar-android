
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
  assert.match(scanner, /evaluateM5Rejection/);
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
