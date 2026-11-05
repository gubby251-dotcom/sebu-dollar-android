
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

test('web UI contains no old M30/M15 signal scanner definitions', async () => {
  const html = await read('public/index.html');

  for (const legacy of [
    'function setup1(',
    'function setup2(',
    'evaluateSetup3M15',
    'scanSetup3M15',
    'getBiQuoteM15Candles',
    'evaluateFourRules',
    'scanAllClosedEngulfings'
  ]) {
    assert.equal(
      html.includes(legacy),
      false,
      `legacy code remains: ${legacy}`
    );
  }

  assert.match(html, /function updateMarketSnr\(/);
  assert.match(html, /function receiveNativeSignalStatusUpdate\(/);
});

test('Android web asset is identical to public web UI', async () => {
  assert.equal(
    await read('public/index.html'),
    await read('app/src/main/assets/index.html')
  );
});

test('status monitor publishes ENTRY and terminal notifications', async () => {
  const monitor = await read('scanner/status-monitor.mjs');

  assert.match(monitor, /async function publishEntryTouch\(/);
  assert.match(monitor, /status:\s*"ENTRY"/);
  assert.match(monitor, /statusNotificationPending:\s*true/);
  assert.match(monitor, /retryPendingStatusNotifications/);
});

test('Android receives SNR snapshots from Firestore', async () => {
  const kotlin = await read(
    'app/src/main/java/com/gubby251/sebudollarai/MainActivity.kt'
  );

  assert.match(kotlin, /syncMarketSnrFromFirestore\(\)/);
  assert.match(kotlin, /collection\("market_analysis"\)/);
  assert.match(kotlin, /addSnapshotListener/);
  assert.match(kotlin, /updateMarketSnr/);
});


test('TradingView loader is asynchronous and avoids rebuilding an already active interval', async () => {
  const html = await read('public/index.html');
  assert.match(html, /function ensureTradingViewScript\(/);
  assert.match(html, /if\(sebuTvWidgetReady && sebuTvWidgetInterval===tf && !force\) return/);
  assert.match(html, /addEventListener\("online"/);
  assert.equal(html.includes('<script src="https://s3.tradingview.com/tv.js"></script>'), false);
});

test('Android WebView retains default cache and retries SNR delivery after page resume', async () => {
  const kotlin = await read('app/src/main/java/com/gubby251/sebudollarai/MainActivity.kt');
  assert.match(kotlin, /cacheMode\s*=\s*android\.webkit\.WebSettings\.LOAD_DEFAULT/);
  assert.match(kotlin, /override fun onResume\(\)/);
  assert.match(kotlin, /latestSnrPayload\?\.let/);
  assert.match(kotlin, /deliverMarketSnrToWebView/);
});
