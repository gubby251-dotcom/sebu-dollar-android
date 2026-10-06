import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { getFirestore } from "firebase-admin/firestore";

const CANDLE_API_URL = "https://biquote.io/api/XAUUSD/ohlc";

const TIMEFRAME_MS = 30 * 60 * 1000;

const TOPIC = "sebu_signal_users";

const CANDLE_LIMIT = 80;

/*
=========================================================
FIRESTORE
=========================================================
*/

const STATE_COLLECTION = "signal_scanner_state";
const STATE_DOCUMENT = "xauusd_m30";

const SENT_COLLECTION = "sent_signals";

/*
=========================================================
TIME
=========================================================
*/

function normalizeTime(value) {
  if (value === null || value === undefined) return NaN;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return NaN;

    return value > 9999999999
      ? value
      : value * 1000;
  }

  const numeric = Number(value);

  if (Number.isFinite(numeric)) {
    return numeric > 9999999999
      ? numeric
      : numeric * 1000;
  }

  const parsed = Date.parse(String(value));

  return Number.isFinite(parsed)
    ? parsed
    : NaN;
}

/*
=========================================================
CANDLE NORMALIZER
=========================================================
*/

function normalizeCandles(payload) {
  let bars = [];

  if (Array.isArray(payload)) {
    bars = payload;
  } else if (Array.isArray(payload?.bars)) {
    bars = payload.bars;
  } else if (Array.isArray(payload?.values)) {
    bars = payload.values;
  } else if (Array.isArray(payload?.data)) {
    bars = payload.data;
  } else if (Array.isArray(payload?.result)) {
    bars = payload.result;
  } else if (Array.isArray(payload?.result?.bars)) {
    bars = payload.result.bars;
  }

  const candles = bars
    .map((c) => ({
      time: normalizeTime(
        c?.openTime ??
        c?.open_time ??
        c?.datetime ??
        c?.time ??
        c?.timestamp ??
        c?.t
      ),

      open: Number(c?.open ?? c?.o),

      high: Number(c?.high ?? c?.h),

      low: Number(c?.low ?? c?.l),

      close: Number(c?.close ?? c?.c)
    }))

    .filter((c) =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )

    .sort((a, b) => a.time - b.time);

  /*
  Remove duplicate candle timestamps
  */

  const result = [];

  for (const candle of candles) {
    if (
      result.length > 0 &&
      result[result.length - 1].time === candle.time
    ) {
      result[result.length - 1] = candle;
    } else {
      result.push(candle);
    }
  }

  return result;
}

/*
=========================================================
CANDLE TYPES
=========================================================
*/

function isBullish(c) {
  return c.close > c.open;
}

function isBearish(c) {
  return c.close < c.open;
}

/*
=========================================================
BULLISH ENGULFING
=========================================================
*/

function bullishEngulfing(c1, c2) {
  const body1 =
    Math.abs(c1.close - c1.open);

  const body2 =
    Math.abs(c2.close - c2.open);

  return (
    isBearish(c1) &&
    isBullish(c2) &&
    body2 > body1 &&
    c2.open <= c1.close &&
    c2.close >= c1.open
  );
}

/*
=========================================================
BEARISH ENGULFING
=========================================================
*/

function bearishEngulfing(c1, c2) {
  const body1 =
    Math.abs(c1.close - c1.open);

  const body2 =
    Math.abs(c2.close - c2.open);

  return (
    isBullish(c1) &&
    isBearish(c2) &&
    body2 > body1 &&
    c2.open >= c1.close &&
    c2.close <= c1.open
  );
}

/*
=========================================================
SETUP 1
=========================================================
*/

function setup1(candles, direction) {

  const n = candles.length;

  const required =
    direction === "BUY"
      ? "bearish"
      : "bullish";

  let count = 0;

  for (
    let i = n - 3;
    i >= 0;
    i--
  ) {

    const valid =
      required === "bearish"
        ? isBearish(candles[i])
        : isBullish(candles[i]);

    if (!valid) {
      break;
    }

    count++;
  }

  return count >= 2;
}

/*
=========================================================
SETUP 2
RULE 1 OR RULE 2
=========================================================
*/

function setup2(candles, direction) {

  const n = candles.length;

  if (n < 6) {
    return false;
  }

  const preC1Index = n - 3;

  const c1Index = n - 2;

  const c2Index = n - 1;

  const preC1 = candles[preC1Index];

  const c1 = candles[c1Index];

  const c2 = candles[c2Index];

  /*
  RULE 1
  */

  let rule1 = false;

  if (direction === "SELL") {

    rule1 =
      isBullish(preC1) &&
      isBullish(c1) &&
      isBearish(c2) &&
      c2.open >= c1.close &&
      c2.close <= c1.open;
  }

  if (direction === "BUY") {

    rule1 =
      isBearish(preC1) &&
      isBearish(c1) &&
      isBullish(c2) &&
      c2.open <= c1.close &&
      c2.close >= c1.open;
  }

  /*
  RULE 2
  */

  let rule2 = false;

  if (n >= 15) {

    const previous12 =
      candles.slice(
        c1Index - 12,
        c1Index
      );

    if (previous12.length === 12) {

      if (direction === "SELL") {

        const previousPeak =
          Math.max(
            ...previous12.map(
              (x) => Number(x.high)
            )
          );

        rule2 =
          isBearish(preC1) &&
          isBullish(c1) &&
          Number(c1.high) > previousPeak &&
          bearishEngulfing(c1, c2);
      }

      if (direction === "BUY") {

        const previousTrough =
          Math.min(
            ...previous12.map(
              (x) => Number(x.low)
            )
          );

        rule2 =
          isBullish(preC1) &&
          isBearish(c1) &&
          Number(c1.low) < previousTrough &&
          bullishEngulfing(c1, c2);
      }
    }
  }

  /*
  RULE 1 OR RULE 2
  */

  return rule1 || rule2;
}

/*
=========================================================
SETUP 3
=========================================================
*/

function setup3(candles, direction) {

  const n = candles.length;

  if (n < 7) {
    return false;
  }

  const c2 = candles[n - 1];

  const c1 = candles[n - 2];

  const p1 = candles[n - 3];

  /*
  PULLBACK
  */

  if (direction === "BUY") {

    if (
      !isBearish(p1) ||
      !isBearish(c1)
    ) {
      return false;
    }
  }

  if (direction === "SELL") {

    if (
      !isBullish(p1) ||
      !isBullish(c1)
    ) {
      return false;
    }
  }

  /*
  TREND
  */

  const t1 = candles[n - 4];

  const t2 = candles[n - 5];

  if (direction === "BUY") {

    if (
      !isBullish(t1) ||
      !isBullish(t2)
    ) {
      return false;
    }
  }

  if (direction === "SELL") {

    if (
      !isBearish(t1) ||
      !isBearish(t2)
    ) {
      return false;
    }
  }

  /*
  FINAL ENGULFING
  */

  if (direction === "BUY") {
    return bullishEngulfing(c1, c2);
  }

  return bearishEngulfing(c1, c2);
}

/*
=========================================================
DETECT MARKET SETUP
=========================================================
*/

function detectMarketSetup(
  candles,
  direction
) {

  if (
    setup3(
      candles,
      direction
    )
  ) {

    return {
      number: 3,
      name: "CONTINUATION"
    };
  }

  if (
    setup1(
      candles,
      direction
    )
  ) {

    return {
      number: 1,
      name: "REVERSAL BERURUTAN"
    };
  }

  if (
    setup2(
      candles,
      direction
    )
  ) {

    return {
      number: 2,
      name: "REVERSAL PULLBACK"
    };
  }

  return null;
}

/*
=========================================================
FINAL SIGNAL ENGINE

C2 CLOSED
ENTRY 50% BODY C2
SL WICK C1/C2
TP RR 1:1
=========================================================
*/

function evaluateSignal(
  candles,
  now
) {

  if (candles.length < 5) {
    return null;
  }

  const c2 =
    candles[candles.length - 1];

  const c1 =
    candles[candles.length - 2];

  /*
  C2 HARUS SUDAH CLOSED
  */

  if (
    Number(c2.time) +
    TIMEFRAME_MS >
    now
  ) {

    return null;
  }

  const buySignal =
    bullishEngulfing(
      c1,
      c2
    );

  const sellSignal =
    bearishEngulfing(
      c1,
      c2
    );

  if (
    !buySignal &&
    !sellSignal
  ) {

    return null;
  }

  const direction =
    buySignal
      ? "BUY"
      : "SELL";

  const setup =
    detectMarketSetup(
      candles,
      direction
    );

  if (!setup) {
    return null;
  }

  /*
  ENTRY = 50% BODY C2
  */

  const bodyLow =
    Math.min(
      Number(c2.open),
      Number(c2.close)
    );

  const bodyHigh =
    Math.max(
      Number(c2.open),
      Number(c2.close)
    );

  const entry =
    bodyLow +
    (
      bodyHigh -
      bodyLow
    ) / 2;

  /*
  SL = WICK C1 / C2
  */

  const sl =
    direction === "BUY"

      ? Math.min(
          Number(c1.low),
          Number(c2.low)
        )

      : Math.max(
          Number(c1.high),
          Number(c2.high)
        );

  const risk =
    Math.abs(
      entry - sl
    );

  if (
    !Number.isFinite(entry) ||
    !Number.isFinite(sl) ||
    !(risk > 0)
  ) {

    return null;
  }

  /*
  TP = RR 1:1
  */

  const tp =
    direction === "BUY"

      ? entry + risk

      : entry - risk;

  return {

    type: direction,

    entry,

    sl,

    tp,

    riskDistance: risk,

    candleTime:
      Number(c2.time),

    setupNumber:
      setup.number,

    setupName:
      setup.name
  };
}

/*
=========================================================
FIREBASE INITIALIZATION
=========================================================
*/

function initializeFirebase() {

  const raw =
    process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!raw) {

    throw new Error(
      "Secret FIREBASE_SERVICE_ACCOUNT belum ditemukan."
    );
  }

  let serviceAccount;

  try {

    serviceAccount =
      JSON.parse(raw);

  } catch {

    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT bukan JSON Firebase Service Account yang valid."
    );
  }

  if (
    getApps().length === 0
  ) {

    initializeApp({
      credential:
        cert(serviceAccount)
    });
  }

  console.log(
    "Firebase Admin berhasil diinisialisasi."
  );
}

/*
=========================================================
FETCH BIQUOTE
=========================================================
*/

async function fetchCandles() {

  const url =
    `${CANDLE_API_URL}?interval=30m&limit=${CANDLE_LIMIT}`;

  console.log(
    `Mengambil candle: ${url}`
  );

  const response =
    await fetch(
      url,
      {
        method: "GET",

        headers: {
          accept:
            "application/json"
        },

        signal:
          AbortSignal.timeout(
            15000
          )
      }
    );

  if (!response.ok) {

    const errorText =
      await response.text();

    throw new Error(
      `BiQuote HTTP ${response.status}: ${errorText.slice(0,300)}`
    );
  }

  let payload;

  try {

    payload =
      await response.json();

  } catch {

    throw new Error(
      "Response BiQuote bukan JSON yang valid."
    );
  }

  const candles =
    normalizeCandles(
      payload
    );

  if (!candles.length) {

    throw new Error(
      "BiQuote tidak mengembalikan candle XAUUSD yang valid."
    );
  }

  return candles;
}

/*
=========================================================
FIRESTORE STATE
=========================================================
*/

async function getScannerState() {

  const db =
    getFirestore();

  const snapshot =
    await db
      .collection(
        STATE_COLLECTION
      )
      .doc(
        STATE_DOCUMENT
      )
      .get();

  if (!snapshot.exists) {
    return {};
  }

  return (
    snapshot.data() || {}
  );
}

/*
=========================================================
SAVE CHECKPOINT
=========================================================
*/

async function saveScannerState(
  candleTime
) {

  const db =
    getFirestore();

  await db
    .collection(
      STATE_COLLECTION
    )
    .doc(
      STATE_DOCUMENT
    )
    .set(
      {
        lastProcessedCandleTime:
          Number(candleTime),

        updatedAt:
          new Date().toISOString()
      },
      {
        merge: true
      }
    );
}

/*
=========================================================
CLAIM SIGNAL

Signal hanya boleh dikirim sekali.

Transaction mencegah dua scanner
mengirim signal yang sama.
=========================================================
*/

async function claimSignal(
  signal
) {

  const db =
    getFirestore();

  const key =
    `${signal.candleTime}_${signal.type}`;

  const reference =
    db
      .collection(
        SENT_COLLECTION
      )
      .doc(key);

  return db.runTransaction(
    async (transaction) => {

      const snapshot =
        await transaction.get(
          reference
        );

      if (snapshot.exists) {

        return false;
      }

      transaction.create(
        reference,
        {
          type:
            signal.type,

          setupNumber:
            signal.setupNumber,

          setupName:
            signal.setupName,

          entry:
            signal.entry,

          sl:
            signal.sl,

          tp:
            signal.tp,

          candleTime:
            signal.candleTime,

          createdAt:
            new Date().toISOString(),

          status:
            "SENDING"
        }
      );

      return true;
    }
  );
}

/*
=========================================================
RELEASE CLAIM

Jika FCM gagal,
signal tidak dianggap berhasil.

Run berikutnya akan mencoba lagi.
=========================================================
*/

async function releaseSignalClaim(
  signal
) {

  const db =
    getFirestore();

  const key =
    `${signal.candleTime}_${signal.type}`;

  await db
    .collection(
      SENT_COLLECTION
    )
    .doc(key)
    .delete();
}

/*
=========================================================
MARK SIGNAL SENT
=========================================================
*/

async function markSignalSent(
  signal,
  messageId
) {

  const db =
    getFirestore();

  const key =
    `${signal.candleTime}_${signal.type}`;

  await db
    .collection(
      SENT_COLLECTION
    )
    .doc(key)
    .update(
      {
        status:
          "SENT",

        fcmMessageId:
          String(messageId),

        sentAt:
          new Date().toISOString()
      }
    );
}

/*
=========================================================
FORMAT PRICE
=========================================================
*/

function formatPrice(
  value
) {

  const number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {

    return "0.00";
  }

  return number.toFixed(2);
}

/*
=========================================================
SEND FCM
=========================================================
*/

async function sendSignal(
  signal
) {

  const title =
    `SEBU DOLLAR AI — ${signal.type} SAYANG`;

  const body =
    `SETUP ${signal.setupNumber} — ${signal.setupName} | ` +
    `XAUUSD M30 | ` +
    `Entry: ${formatPrice(signal.entry)} | ` +
    `SL: ${formatPrice(signal.sl)} | ` +
    `TP: ${formatPrice(signal.tp)} | ` +
    `RR 1:1`;

  const message = {

    topic:
      TOPIC,

    notification: {

      title,

      body
    },

    data: {

      title,

      body,

      type:
        String(signal.type),

      symbol:
        "XAUUSD",

      timeframe:
        "M30",

      entry:
        formatPrice(
          signal.entry
        ),

      sl:
        formatPrice(
          signal.sl
        ),

      tp:
        formatPrice(
          signal.tp
        ),

      setup:
        String(
          signal.setupNumber
        ),

      setupName:
        String(
          signal.setupName
        ),

      candleTime:
        String(
          signal.candleTime
        )
    },

    android: {

      priority:
        "high",

      ttl:
        60 * 1000,

      notification: {

        channelId:
          "sebu_signal_channel_v2",

        sound:
          "default",

        defaultSound:
          true,

        defaultVibrateTimings:
          true
      }
    }
  };

  const messageId =
    await getMessaging()
      .send(message);

  console.log(
    `FCM BERHASIL DIKIRIM: ${messageId}`
  );

  console.log(
    `${signal.type} | ` +
    `Setup ${signal.setupNumber} | ` +
    `Entry ${formatPrice(signal.entry)} | ` +
    `SL ${formatPrice(signal.sl)} | ` +
    `TP ${formatPrice(signal.tp)}`
  );

  await markSignalSent(
    signal,
    messageId
  );
}

/*
=========================================================
MAIN SCANNER
=========================================================
*/

async function main() {

  console.log(
    "========================================"
  );

  console.log(
    "SEBU DOLLAR AI"
  );

  console.log(
    "RELIABLE M30 SIGNAL SCANNER"
  );

  console.log(
    "========================================"
  );

  const now =
    Date.now();

  /*
  FIREBASE
  */

  initializeFirebase();

  /*
  BIQUOTE
  */

  const allCandles =
    await fetchCandles();

  /*
  ONLY CLOSED M30 CANDLES
  */

  const closedCandles =
    allCandles.filter(
      (candle) =>
        Number(candle.time) +
        TIMEFRAME_MS <=
        now
    );

  console.log(
    `Total candle: ${allCandles.length}`
  );

  console.log(
    `Candle CLOSED: ${closedCandles.length}`
  );

  if (
    closedCandles.length < 5
  ) {

    throw new Error(
      "Candle M30 closed belum cukup."
    );
  }

  /*
  FIRESTORE STATE
  */

  const state =
    await getScannerState();

  const previous =
    Number(
      state.lastProcessedCandleTime
    ) || 0;

  const newest =
    closedCandles[
      closedCandles.length - 1
    ].time;

  /*
  FIRST RUN

  Jangan mengirim signal lama.
  Hanya membuat baseline.
  */

  if (!previous) {

    await saveScannerState(
      newest
    );

    console.log(
      `Baseline dibuat: ${new Date(newest).toISOString()}`
    );

    console.log(
      "Tidak mengirim signal historis."
    );

    return;
  }

  /*
  =======================================================
  CATCH-UP SCANNER

  Bukan hanya candle terakhir.

  Semua candle closed yang lebih baru
  dari checkpoint akan diperiksa.
  =======================================================
  */

  const signals = [];

  for (
    let i = 4;
    i < closedCandles.length;
    i++
  ) {

    const currentCandles =
      closedCandles.slice(
        0,
        i + 1
      );

    const candidate =
      evaluateSignal(
        currentCandles,
        now
      );

    if (
      candidate &&
      candidate.candleTime >
        previous
    ) {

      signals.push(
        candidate
      );
    }
  }

  /*
  REMOVE DUPLICATE CANDIDATE
  */

  const uniqueSignals = [];

  const seen =
    new Set();

  for (
    const signal of signals
  ) {

    const key =
      `${signal.candleTime}-${signal.type}`;

    if (
      seen.has(key)
    ) {
      continue;
    }

    seen.add(key);

    uniqueSignals.push(
      signal
    );
  }

  console.log(
    `Candidate signal ditemukan: ${uniqueSignals.length}`
  );

  /*
  =======================================================
  SEND EVERY NEW SIGNAL
  =======================================================
  */

  for (
    const signal of uniqueSignals
  ) {

    /*
    CLAIM FIRST

    Hanya satu runner yang boleh
    mengirim signal ini.
    */

    const claimed =
      await claimSignal(
        signal
      );

    if (!claimed) {

      console.log(
        `Signal sudah pernah diproses: ` +
        `${signal.candleTime}-${signal.type}`
      );

      continue;
    }

    try {

      /*
      FCM HARUS BERHASIL
      */

      await sendSignal(
        signal
      );

    } catch (error) {

      /*
      FCM GAGAL

      Hapus claim supaya run berikutnya
      dapat mencoba kembali.
      */

      console.error(
        "FCM gagal. Signal akan dicoba kembali."
      );

      await releaseSignalClaim(
        signal
      );

      throw error;
    }
  }

  /*
  =======================================================
  CHECKPOINT

  Baru maju setelah seluruh candidate
  selesai diproses.
  =======================================================
  */

  await saveScannerState(
    newest
  );

  console.log(
    `Checkpoint tersimpan: ${new Date(newest).toISOString()}`
  );

  console.log(
    "========================================"
  );

  console.log(
    "RELIABLE SCANNER SELESAI"
  );

  console.log(
    "========================================"
  );
}

/*
=========================================================
ERROR HANDLER
=========================================================
*/

main()

  .then(() => {

    console.log(
      "Scanner selesai tanpa error."
    );

    process.exit(0);
  })

  .catch((error) => {

    console.error(
      "========================================"
    );

    console.error(
      "SCANNER ERROR"
    );

    console.error(
      error?.stack ||
      error?.message ||
      error
    );

    console.error(
      "========================================"
    );

    process.exit(1);
  });
