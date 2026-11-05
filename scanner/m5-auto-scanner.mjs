import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { closedCandles, detectH4Snr, detectM5Snr, evaluateM5Rejection, normalizeCandles } from './m5-engine.mjs';

const API = process.env.CANDLE_API_URL || 'https://biquote.io/api/XAUUSD/ohlc';
const TOPIC = process.env.FCM_TOPIC || 'sebu_signal_users';
const LIMIT = 160;

function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT belum tersedia');
  let account;
  try { account = JSON.parse(raw); } catch { throw new Error('FIREBASE_SERVICE_ACCOUNT bukan JSON valid'); }
  if (!getApps().length) initializeApp({ credential: cert(account) });
}

async function fetchTf(interval) {
  const url = `${API}?interval=${interval}&limit=${LIMIT}`;
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${interval} HTTP ${response.status}`);
  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload : payload?.bars ?? payload?.values ?? payload?.data ?? payload?.result?.bars ?? payload?.result ?? [];
  const candles = normalizeCandles(rows);
  if (!candles.length) throw new Error(`${interval}: API tidak mengembalikan candle valid`);
  return candles;
}

const price = n => Number(n).toFixed(2);

async function main() {
  initFirebase();
  const db = getFirestore();
  const now = Date.now();
  const [rawM5, rawH4] = await Promise.all([fetchTf('5m'), fetchTf('4h')]);
  const m5 = closedCandles(rawM5, 5 * 60_000, now);
  const h4 = closedCandles(rawH4, 4 * 60 * 60_000, now);
  if (m5.length < 8) throw new Error(`Candle M5 tertutup tidak cukup: ${m5.length}`);
  if (!h4.length) throw new Error('Belum ada candle H4 tertutup');
  const h4Snr = detectH4Snr(h4);
  const last = m5.at(-1);
  const m5Snr = detectM5Snr(m5.slice(0, -1), last.close, 2);
  // Keep publishing the valid H4 levels even when the current M5 window has
  // no confirmed swing on one side. The UI will show BELUM TERSEDIA for that side.

  const snrDoc = {
    symbol: 'XAUUSD', timeframe: 'M5',
    h4Resistance: h4Snr.resistance, h4Support: h4Snr.support,
    h4CandleTime: h4Snr.candleTime,
    m5Resistance: m5Snr?.resistance ?? null, m5Support: m5Snr?.support ?? null,
    m5ResistanceTime: m5Snr?.resistanceTime ?? null, m5SupportTime: m5Snr?.supportTime ?? null,
    m5CandleTime: last.time, currentPrice: last.close,
    updatedAt: new Date().toISOString(), source: 'BIQUOTE_CLOSED_CANDLES'
  };
  await db.collection('market_analysis').doc('xauusd_snr').set(snrDoc, { merge: true });
  console.log('SNR UPDATED', JSON.stringify(snrDoc));

  // Process only the newest fully closed M5 candle; Firestore claim makes retries idempotent.
  const stateRef = db.collection('signal_scanner_state').doc('xauusd_m5');
  const state = await stateRef.get();
  const previous = Number(state.get('lastProcessedCandleTime') || 0);
  if (last.time <= previous) {
    console.log(`No new closed M5 candle. last=${last.time} checkpoint=${previous}`);
    return;
  }
  const signal = m5Snr ? evaluateM5Rejection(m5, { h4Snr, m5Snr }) : null;
  if (signal && signal.candleTime === last.time) {
    const id = `M5_${signal.candleTime}_${signal.type}`;
    const ref = db.collection('sent_signals').doc(id);
    const claimed = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;
      tx.create(ref, { ...signal, symbol: 'XAUUSD', status: 'SENDING', source: 'M5_SNR_ENGINE', createdAt: new Date().toISOString() });
      return true;
    });
    if (claimed) {
      try {
        const title = `SEBU DOLLAR AI — ${signal.type} XAUUSD M5`;
        const body = `${signal.type} XAUUSD M5 | Entry ${price(signal.entry)} | SL ${price(signal.sl)} | TP ${price(signal.tp)} | SNR rejection`;
        const messageId = await getMessaging().send({ topic: TOPIC, data: {
          event: 'NEW_SIGNAL', title, body, type: signal.type, symbol: 'XAUUSD', timeframe: 'M5', timeframeMinutes: '5',
          entry: price(signal.entry), sl: price(signal.sl), tp: price(signal.tp), candleTime: String(signal.candleTime),
          candleCloseTime: String(signal.candleCloseTime), signalKey: id
        }, android: { priority: 'high', ttl: 60_000 } });
        await ref.update({ status: 'SENT', fcmMessageId: messageId, sentAt: new Date().toISOString() });
        console.log('SIGNAL SENT', id, messageId);
      } catch (error) {
        await ref.delete();
        throw error;
      }
    } else console.log('DUPLICATE BLOCKED', id);
  } else console.log('No valid M5 signal on', new Date(last.time).toISOString());

  await stateRef.set({ lastProcessedCandleTime: last.time, updatedAt: new Date().toISOString(), timeframe: 'M5' }, { merge: true });
}

main().then(() => process.exit(0)).catch(error => { console.error('M5 AUTO SCANNER ERROR:', error?.stack || error); process.exit(1); });
