import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { getFirestore } from "firebase-admin/firestore";

/*
=========================================================
SEBU DOLLAR AI — RELIABLE SCANNER
SETUP 1 / 2 / 3 = M30
SETUP 4          = M15
SETUP 5          = M5

ENTRY:
  50% BODY C2

M30 SL:
  BUY  = lowest wick C1/C2
  SELL = highest wick C1/C2

M15/M5 SL:
  BUY  = lowest wick C1 and candle immediately before C1
  SELL = highest wick C1 and candle immediately before C1

TP:
  RR 1:1

C2 MUST BE CLOSED.
Each timeframe is scanned independently.
=========================================================
*/

const CANDLE_API_URL = "https://biquote.io/api/XAUUSD/ohlc";
const TOPIC = "sebu_signal_users";
const CANDLE_LIMIT = 80;

const TF = {
  M30: {
    minutes: 30,
    interval: "30m",
    stateDocument: "xauusd_m30"
  },

  M15: {
    minutes: 15,
    interval: "15m",
    stateDocument: "xauusd_m15"
  },

  M5: {
    minutes: 5,
    interval: "5m",
    stateDocument: "xauusd_m5"
  }
};

const STATE_COLLECTION = "signal_scanner_state";
const SENT_COLLECTION = "sent_signals";

/* =======================================================
   TIME
======================================================= */

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

/* =======================================================
   CANDLE NORMALIZER
======================================================= */

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

  const normalized = bars
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

  const unique = [];

  for (const candle of normalized) {
    const previous = unique[unique.length - 1];

    if (
      previous &&
      previous.time === candle.time
    ) {
      unique[unique.length - 1] = candle;
    } else {
      unique.push(candle);
    }
  }

  return unique;
}

/* =======================================================
   CANDLE TYPES
======================================================= */

function isBullish(c) {
  return Number(c.close) > Number(c.open);
}

function isBearish(c) {
  return Number(c.close) < Number(c.open);
}

/* =======================================================
   ENGULFING
======================================================= */

function isBullishEngulfing(c1, c2) {
  const open1 = Number(c1.open);
  const close1 = Number(c1.close);
  const high1 = Number(c1.high);

  const open2 = Number(c2.open);
  const close2 = Number(c2.close);

  const body1 =
    Math.abs(close1 - open1);

  const body2 =
    Math.abs(close2 - open2);

  return (
    isBearish(c1) &&
    isBullish(c2) &&
    body2 > body1 &&
    open2 <= close1 &&
    close2 > high1
  );
}

function isBearishEngulfing(c1, c2) {
  const open1 = Number(c1.open);
  const close1 = Number(c1.close);
  const low1 = Number(c1.low);

  const open2 = Number(c2.open);
  const close2 = Number(c2.close);

  const body1 =
    Math.abs(close1 - open1);

  const body2 =
    Math.abs(close2 - open2);

  return (
    isBullish(c1) &&
    isBearish(c2) &&
    body2 > body1 &&
    open2 >= close1 &&
    close2 < low1
  );
}

/* =======================================================
   SETUP 1 — M30
======================================================= */

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

    if (!valid) break;

    count++;
  }

  return count >= 2;
}

/* =======================================================
   SETUP 2 — M30
   RULE 1 OR RULE 2
======================================================= */

function setup2(candles, direction) {
  const n = candles.length;

  if (n < 6) return false;

  const preC1Index = n - 3;
  const c1Index = n - 2;
  const c2Index = n - 1;

  const preC1 =
    candles[preC1Index];

  const c1 =
    candles[c1Index];

  const c2 =
    candles[c2Index];

  let rule1 = false;

  if (direction === "SELL") {
    rule1 =
      isBullish(preC1) &&
      isBullish(c1) &&
      isBearish(c2) &&
      Number(c2.open) >=
        Number(c1.close) &&
      Number(c2.close) <=
        Number(c1.open);
  }

  if (direction === "BUY") {
    rule1 =
      isBearish(preC1) &&
      isBearish(c1) &&
      isBullish(c2) &&
      Number(c2.open) <=
        Number(c1.close) &&
      Number(c2.close) >=
        Number(c1.open);
  }

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
          Number(c1.high) >
            previousPeak &&
          isBearishEngulfing(
            c1,
            c2
          );
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
          Number(c1.low) <
            previousTrough &&
          isBullishEngulfing(
            c1,
            c2
          );
      }
    }
  }

  return rule1 || rule2;
}

/* =======================================================
   SETUP 3 — M30
======================================================= */

function setup3(candles, direction) {
  const n = candles.length;

  if (n < 7) return false;

  const c2 =
    candles[n - 1];

  const c1 =
    candles[n - 2];

  const p1 =
    candles[n - 3];

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

  const t1 =
    candles[n - 4];

  const t2 =
    candles[n - 5];

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

  return direction === "BUY"
    ? isBullishEngulfing(c1, c2)
    : isBearishEngulfing(c1, c2);
}

/* =======================================================
   M30 SETUP PRIORITY
======================================================= */

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

/* =======================================================
   ENTRY = 50% BODY C2
======================================================= */

function entry50Body(c2) {
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

  return (
    bodyLow +
    (bodyHigh - bodyLow) / 2
  );
}

/* =======================================================
   M30 — SETUP 1/2/3
======================================================= */

function evaluateM30(
  candles,
  now
) {
  if (
    !Array.isArray(candles) ||
    candles.length < 5
  ) {
    return null;
  }

  const c2 =
    candles[candles.length - 1];

  const c1 =
    candles[candles.length - 2];

  const tfMs =
    TF.M30.minutes *
    60 *
    1000;

  if (
    Number(c2.time) +
    tfMs >
    now
  ) {
    return null;
  }

  const buy =
    isBullishEngulfing(
      c1,
      c2
    );

  const sell =
    isBearishEngulfing(
      c1,
      c2
    );

  if (!buy && !sell) {
    return null;
  }

  const direction =
    buy
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

  const entry =
    entry50Body(c2);

  /*
  M30:
  BUY  = lowest wick C1/C2
  SELL = highest wick C1/C2
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
    candleCloseTime:
      Number(c2.time) + tfMs,
    setupNumber:
      setup.number,
    setupName:
      setup.name,
    timeframe: "M30",
    timeframeMinutes: 30,
    trendText:
      `SETUP ${setup.number} — ${setup.name}`,
    engulfText:
      "CONFIRMED"
  };
}

/* =======================================================
   SETUP 4 — M15
======================================================= */

function evaluateSetup4M15(
  candles,
  now
) {
  const c =
    Array.isArray(candles)
      ? candles
          .filter((x) =>
            x &&
            [
              x.time,
              x.open,
              x.high,
              x.low,
              x.close
            ].every(
              (v) =>
                Number.isFinite(
                  Number(v)
                )
            )
          )
          .sort(
            (a, b) =>
              Number(a.time) -
              Number(b.time)
          )
      : [];

  if (c.length < 4) {
    return null;
  }

  const c2 =
    c[c.length - 1];

  const c1 =
    c[c.length - 2];

  const beforeC1 =
    c[c.length - 3];

  const beforeBeforeC1 =
    c[c.length - 4];

  const tfMs =
    TF.M15.minutes *
    60 *
    1000;

  const c2Time =
    Number(c2.time);

  if (
    !Number.isFinite(c2Time) ||
    c2Time % tfMs !== 0 ||
    c2Time + tfMs > now
  ) {
    return null;
  }

  const twoBeforeBullish =
    isBullish(beforeC1) &&
    isBullish(beforeBeforeC1);

  const twoBeforeBearish =
    isBearish(beforeC1) &&
    isBearish(beforeBeforeC1);

  const c1BullishBodyEngulf =
    isBearish(beforeC1) &&
    isBullish(c1) &&
    Number(c1.open) <=
      Number(beforeC1.close) &&
    Number(c1.close) >=
      Number(beforeC1.open) &&
    Math.abs(
      Number(c1.close) -
      Number(c1.open)
    ) >=
      Math.abs(
        Number(beforeC1.close) -
        Number(beforeC1.open)
      );

  const c1BearishBodyEngulf =
    isBullish(beforeC1) &&
    isBearish(c1) &&
    Number(c1.open) >=
      Number(beforeC1.close) &&
    Number(c1.close) <=
      Number(beforeC1.open) &&
    Math.abs(
      Number(c1.close) -
      Number(c1.open)
    ) >=
      Math.abs(
        Number(beforeC1.close) -
        Number(beforeC1.open)
      );

  const c2BuyBodyBreaksC1High =
    isBullish(c2) &&
    Number(c2.open) <=
      Number(c1.high) &&
    Number(c2.close) >
      Number(c1.high);

  const c2SellBodyBreaksC1Low =
    isBearish(c2) &&
    Number(c2.open) >=
      Number(c1.low) &&
    Number(c2.close) <
      Number(c1.low);

  const buy =
    twoBeforeBearish &&
    c1BullishBodyEngulf &&
    c2BuyBodyBreaksC1High;

  const sell =
    twoBeforeBullish &&
    c1BearishBodyEngulf &&
    c2SellBodyBreaksC1Low;

  if (!buy && !sell) {
    return null;
  }

  const type =
    buy
      ? "BUY"
      : "SELL";

  const entry =
    entry50Body(c2);

  /*
  M15:
  BUY  = lowest wick C1 + candle immediately before C1
  SELL = highest wick C1 + candle immediately before C1
  */

  const sl =
    type === "BUY"
      ? Math.min(
          Number(c1.low),
          Number(beforeC1.low)
        )
      : Math.max(
          Number(c1.high),
          Number(beforeC1.high)
        );

  const risk =
    Math.abs(
      entry - sl
    );

  if (
    !(risk > 0) ||
    !Number.isFinite(entry) ||
    !Number.isFinite(sl)
  ) {
    return null;
  }

  const tp =
    type === "BUY"
      ? entry + risk
      : entry - risk;

  return {
    type,
    entry,
    sl,
    tp,
    riskDistance: risk,
    candleTime: c2Time,
    candleCloseTime:
      c2Time + tfMs,
    setupNumber: 4,
    setupName:
      "M15 REVERSAL CONFIRMATION",
    timeframe: "M15",
    timeframeMinutes: 15,
    trendText:
      "SETUP 4 — M15 CONFIRMATION",
    engulfText:
      "M15 CONFIRMED"
  };
}

/* =======================================================
   SETUP 5 — M5
======================================================= */

function evaluateSetup5M5(
  candles,
  now
) {
  const c =
    Array.isArray(candles)
      ? candles
          .filter((x) =>
            x &&
            [
              x.time,
              x.open,
              x.high,
              x.low,
              x.close
            ].every(
              (v) =>
                Number.isFinite(
                  Number(v)
                )
            )
          )
          .sort(
            (a, b) =>
              Number(a.time) -
              Number(b.time)
          )
      : [];

  if (c.length < 4) {
    return null;
  }

  const c2 =
    c[c.length - 1];

  const c1 =
    c[c.length - 2];

  const beforeC1 =
    c[c.length - 3];

  const beforeBeforeC1 =
    c[c.length - 4];

  const tfMs =
    TF.M5.minutes *
    60 *
    1000;

  const c2Time =
    Number(c2.time);

  if (
    !Number.isFinite(c2Time) ||
    c2Time % tfMs !== 0 ||
    c2Time + tfMs > now
  ) {
    return null;
  }

  const twoBeforeBullish =
    isBullish(beforeC1) &&
    isBullish(beforeBeforeC1);

  const twoBeforeBearish =
    isBearish(beforeC1) &&
    isBearish(beforeBeforeC1);

  const c1BullishBodyEngulf =
    isBearish(beforeC1) &&
    isBullish(c1) &&
    Number(c1.open) <=
      Number(beforeC1.close) &&
    Number(c1.close) >=
      Number(beforeC1.open) &&
    Math.abs(
      Number(c1.close) -
      Number(c1.open)
    ) >=
      Math.abs(
        Number(beforeC1.close) -
        Number(beforeC1.open)
      );

  const c1BearishBodyEngulf =
    isBullish(beforeC1) &&
    isBearish(c1) &&
    Number(c1.open) >=
      Number(beforeC1.close) &&
    Number(c1.close) <=
      Number(beforeC1.open) &&
    Math.abs(
      Number(c1.close) -
      Number(c1.open)
    ) >=
      Math.abs(
        Number(beforeC1.close) -
        Number(beforeC1.open)
      );

  const c2BuyBodyBreaksC1High =
    isBullish(c2) &&
    Number(c2.open) <=
      Number(c1.high) &&
    Number(c2.close) >
      Number(c1.high);

  const c2SellBodyBreaksC1Low =
    isBearish(c2) &&
    Number(c2.open) >=
      Number(c1.low) &&
    Number(c2.close) <
      Number(c1.low);

  const buy =
    twoBeforeBearish &&
    c1BullishBodyEngulf &&
    c2BuyBodyBreaksC1High;

  const sell =
    twoBeforeBullish &&
    c1BearishBodyEngulf &&
    c2SellBodyBreaksC1Low;

  if (!buy && !sell) {
    return null;
  }

  const type =
    buy
      ? "BUY"
      : "SELL";

  const entry =
    entry50Body(c2);

  /*
  M5:
  BUY  = lowest wick C1 + candle immediately before C1
  SELL = highest wick C1 + candle immediately before C1
  */

  const sl =
    type === "BUY"
      ? Math.min(
          Number(c1.low),
          Number(beforeC1.low)
        )
      : Math.max(
          Number(c1.high),
          Number(beforeC1.high)
        );

  const risk =
    Math.abs(
      entry - sl
    );

  if (
    !(risk > 0) ||
    !Number.isFinite(entry) ||
    !Number.isFinite(sl)
  ) {
    return null;
  }

  const tp =
    type === "BUY"
      ? entry + risk
      : entry - risk;

  return {
    type,
    entry,
    sl,
    tp,
    riskDistance: risk,
    candleTime: c2Time,
    candleCloseTime:
      c2Time + tfMs,
    setupNumber: 5,
    setupName:
      "M5 REVERSAL CONFIRMATION",
    timeframe: "M5",
    timeframeMinutes: 5,
    trendText:
      "SETUP 5 — M5 CONFIRMATION",
    engulfText:
      "M5 CONFIRMED"
  };
}

/* =======================================================
   FETCH BIQUOTE
======================================================= */

async function fetchCandles(
  timeframe
) {
  const config =
    TF[timeframe];

  const url =
    `${CANDLE_API_URL}?interval=${config.interval}&limit=${CANDLE_LIMIT}`;

  console.log(
    `[${timeframe}] Mengambil candle: ${url}`
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
      `[${timeframe}] BiQuote HTTP ${response.status}: ${errorText.slice(0, 300)}`
    );
  }

  let payload;

  try {
    payload =
      await response.json();
  } catch {
    throw new Error(
      `[${timeframe}] Response BiQuote bukan JSON yang valid.`
    );
  }

  const candles =
    normalizeCandles(
      payload
    );

  if (!candles.length) {
    throw new Error(
      `[${timeframe}] BiQuote tidak mengembalikan candle XAUUSD yang valid.`
    );
  }

  return candles;
}

/* =======================================================
   CLOSED CANDLES
======================================================= */

function getClosedCandles(
  candles,
  timeframe,
  now
) {
  const tfMs =
    TF[timeframe].minutes *
    60 *
    1000;

  return candles
    .filter((c) => {
      const t =
        Number(c.time);

      if (!Number.isFinite(t)) {
        return false;
      }

      if (
        timeframe !== "M30" &&
        t % tfMs !== 0
      ) {
        return false;
      }

      return (
        t + tfMs <= now
      );
    })
    .sort(
      (a, b) =>
        Number(a.time) -
        Number(b.time)
    );
}

/* =======================================================
   FIREBASE
======================================================= */

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

/* =======================================================
   FIRESTORE STATE
======================================================= */

async function getScannerState(
  timeframe
) {
  const db =
    getFirestore();

  const snapshot =
    await db
      .collection(
        STATE_COLLECTION
      )
      .doc(
        TF[timeframe]
          .stateDocument
      )
      .get();

  if (!snapshot.exists) {
    return {};
  }

  return (
    snapshot.data() || {}
  );
}

async function saveScannerState(
  timeframe,
  candleTime
) {
  const db =
    getFirestore();

  await db
    .collection(
      STATE_COLLECTION
    )
    .doc(
      TF[timeframe]
        .stateDocument
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

/* =======================================================
   CLAIM SIGNAL
======================================================= */

function signalKey(
  signal
) {
  return (
    `${signal.timeframe}_${signal.candleTime}_${signal.type}`
  );
}

async function claimSignal(
  signal
) {
  const db =
    getFirestore();

  const reference =
    db
      .collection(
        SENT_COLLECTION
      )
      .doc(
        signalKey(signal)
      );

  return db.runTransaction(
    async (transaction) => {
      const snapshot =
        await transaction.get(
          reference
        );

      if (
        snapshot.exists
      ) {
        return false;
      }

      transaction.create(
        reference,
        {
          type:
            signal.type,

          timeframe:
            signal.timeframe,

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

          candleCloseTime:
            signal.candleCloseTime,

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

async function releaseSignalClaim(
  signal
) {
  const db =
    getFirestore();

  await db
    .collection(
      SENT_COLLECTION
    )
    .doc(
      signalKey(signal)
    )
    .delete();
}

async function markSignalSent(
  signal,
  messageId
) {
  const db =
    getFirestore();

  await db
    .collection(
      SENT_COLLECTION
    )
    .doc(
      signalKey(signal)
    )
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

/* =======================================================
   FORMAT
======================================================= */

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

/* =======================================================
   SEND FCM
======================================================= */

async function sendSignal(
  signal
) {
  const title =
    `SEBU DOLLAR AI — ${signal.type} SAYANG`;

  const body =
    `SETUP ${signal.setupNumber} — ${signal.setupName} | ` +
    `XAUUSD ${signal.timeframe} | ` +
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
        String(signal.timeframe),

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
        ),

      candleCloseTime:
        String(
          signal.candleCloseTime
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
    `${signal.timeframe} | ` +
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

/* =======================================================
   FIND M30 SIGNALS
======================================================= */

function findM30Signals(
  closedCandles,
  previous,
  now
) {
  const signals = [];

  for (
    let i = 4;
    i < closedCandles.length;
    i++
  ) {
    const current =
      closedCandles.slice(
        0,
        i + 1
      );

    const candidate =
      evaluateM30(
        current,
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

  return signals;
}

/* =======================================================
   FIND M15 SIGNALS
======================================================= */

function findM15Signals(
  closedCandles,
  previous,
  now
) {
  const signals = [];

  for (
    let i = 3;
    i < closedCandles.length;
    i++
  ) {
    const current =
      closedCandles.slice(
        0,
        i + 1
      );

    const candidate =
      evaluateSetup4M15(
        current,
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

  return signals;
}

/* =======================================================
   FIND M5 SIGNALS
======================================================= */

function findM5Signals(
  closedCandles,
  previous,
  now
) {
  const signals = [];

  for (
    let i = 3;
    i < closedCandles.length;
    i++
  ) {
    const current =
      closedCandles.slice(
        0,
        i + 1
      );

    const candidate =
      evaluateSetup5M5(
        current,
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

  return signals;
}

/* =======================================================
   UNIQUE SIGNALS
======================================================= */

function uniqueSignals(
  signals
) {
  const seen =
    new Set();

  const result =
    [];

  for (
    const signal of signals
  ) {
    const key =
      signalKey(signal);

    if (
      seen.has(key)
    ) {
      continue;
    }

    seen.add(key);

    result.push(
      signal
    );
  }

  return result.sort(
    (a, b) =>
      Number(a.candleTime) -
      Number(b.candleTime)
  );
}

/* =======================================================
   SCAN ONE TIMEFRAME
======================================================= */

async function scanTimeframe(
  timeframe,
  now
) {
  console.log("");

  console.log(
    "========================================"
  );

  console.log(
    `SCAN ${timeframe}`
  );

  console.log(
    "========================================"
  );

  const allCandles =
    await fetchCandles(
      timeframe
    );

  const closedCandles =
    getClosedCandles(
      allCandles,
      timeframe,
      now
    );

  console.log(
    `[${timeframe}] Total candle: ${allCandles.length}`
  );

  console.log(
    `[${timeframe}] Candle CLOSED: ${closedCandles.length}`
  );

  const minimum =
    timeframe === "M30"
      ? 5
      : 4;

  if (
    closedCandles.length <
    minimum
  ) {
    console.log(
      `[${timeframe}] Candle closed belum cukup.`
    );

    return;
  }

  const state =
    await getScannerState(
      timeframe
    );

  const previous =
    Number(
      state.lastProcessedCandleTime
    ) || 0;

  const newest =
    Number(
      closedCandles[
        closedCandles.length - 1
      ].time
    );

  /*
  FIRST RUN:
  Baseline only.
  */

  if (!previous) {
    await saveScannerState(
      timeframe,
      newest
    );

    console.log(
      `[${timeframe}] Baseline dibuat: ${new Date(newest).toISOString()}`
    );

    return;
  }

  let signals = [];

  if (
    timeframe === "M30"
  ) {
    signals =
      findM30Signals(
        closedCandles,
        previous,
        now
      );
  }

  if (
    timeframe === "M15"
  ) {
    signals =
      findM15Signals(
        closedCandles,
        previous,
        now
      );
  }

  if (
    timeframe === "M5"
  ) {
    signals =
      findM5Signals(
        closedCandles,
        previous,
        now
      );
  }

  signals =
    uniqueSignals(
      signals
    );

  console.log(
    `[${timeframe}] Candidate signal: ${signals.length}`
  );

  for (
    const signal of signals
  ) {
    const claimed =
      await claimSignal(
        signal
      );

    if (!claimed) {
      console.log(
        `[${timeframe}] Signal sudah diproses: ${signalKey(signal)}`
      );

      continue;
    }

    try {
      await sendSignal(
        signal
      );

    } catch (error) {
      console.error(
        `[${timeframe}] FCM gagal. Claim dilepas agar bisa dicoba lagi.`
      );

      await releaseSignalClaim(
        signal
      );

      throw error;
    }
  }

  await saveScannerState(
    timeframe,
    newest
  );

  console.log(
    `[${timeframe}] Checkpoint: ${new Date(newest).toISOString()}`
  );
}

/* =======================================================
   MAIN
======================================================= */

async function main() {
  console.log(
    "========================================"
  );

  console.log(
    "SEBU DOLLAR AI"
  );

  console.log(
    "RELIABLE SCANNER — SETUP 1/2/3/4/5"
  );

  console.log(
    "M30 + M15 + M5"
  );

  console.log(
    "========================================"
  );

  initializeFirebase();

  const now =
    Date.now();

  /*
  M30, M15 and M5
  are independent.
  */

  await scanTimeframe(
    "M30",
    now
  );

  await scanTimeframe(
    "M15",
    now
  );

  await scanTimeframe(
    "M5",
    now
  );

  console.log(
    "========================================"
  );

  console.log(
    "RELIABLE SCANNER SETUP 1/2/3/4/5 SELESAI"
  );

  console.log(
    "========================================"
  );
}

/* =======================================================
   ERROR HANDLER
======================================================= */

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
