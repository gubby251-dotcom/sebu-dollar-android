import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const CANDLE_API_URL = "https://biquote.io/api/XAUUSD/ohlc";
const TOPIC = "sebu_signal_users";
const TF_MINUTES = { M30: 30, M15: 15, M5: 5 };
const COLLECTION = "sent_signals";

function initializeFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("Secret FIREBASE_SERVICE_ACCOUNT belum ditemukan.");

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT bukan JSON valid.");
  }

  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }
}

function normalizeTime(value) {
  if (value === null || value === undefined) return NaN;

  if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value))) {
    const n = Number(value);
    return n > 9999999999 ? n : n * 1000;
  }

  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizeCandles(payload) {
  let bars = [];

  if (Array.isArray(payload)) bars = payload;
  else if (Array.isArray(payload?.bars)) bars = payload.bars;
  else if (Array.isArray(payload?.values)) bars = payload.values;
  else if (Array.isArray(payload?.data)) bars = payload.data;
  else if (Array.isArray(payload?.result)) bars = payload.result;
  else if (Array.isArray(payload?.result?.bars)) bars = payload.result.bars;

  const sorted = bars
    .map(c => ({
      time: normalizeTime(
        c?.openTime ?? c?.open_time ?? c?.datetime ??
        c?.time ?? c?.timestamp ?? c?.t
      ),
      high: Number(c?.high ?? c?.h),
      low: Number(c?.low ?? c?.l)
    }))
    .filter(c =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low)
    )
    .sort((a, b) => a.time - b.time);

  return sorted.filter((c, i) =>
    i === 0 || c.time !== sorted[i - 1].time
  );
}

async function fetchClosedCandles(timeframe, now) {
  const minutes = TF_MINUTES[timeframe];
  const url = `${CANDLE_API_URL}?interval=${minutes}m&limit=80`;

  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`BiQuote ${timeframe} HTTP ${response.status}`);
  }

  const candles = normalizeCandles(await response.json());
  const tfMs = minutes * 60 * 1000;

  return candles.filter(c =>
    c.time % tfMs === 0 && c.time + tfMs <= now
  );
}

/*
 * Memantau candle yang sudah ditutup pada timeframe signal.
 * Jika Entry dan TP/SL tersentuh dalam candle yang sama,
 * urutannya tidak diketahui dari data OHLC sehingga tidak ditebak.
 */
function evaluateSignal(doc, candles, now) {
  const timeframe = String(doc.timeframe || "").toUpperCase();
  const tfMinutes = Number(
    doc.timeframeMinutes || TF_MINUTES[timeframe]
  );
  const tfMs = tfMinutes * 60 * 1000;
  const signalTime = Number(doc.candleTime);
  const signalClose =
    Number(doc.candleCloseTime) || signalTime + tfMs;

  const entry = Number(doc.entry);
  const sl = Number(doc.sl);
  const tp = Number(doc.tp);
  const type = String(doc.type || "").toUpperCase();

  if (
    !TF_MINUTES[timeframe] ||
    !["BUY", "SELL"].includes(type) ||
    ![entry, sl, tp, signalTime, signalClose].every(Number.isFinite)
  ) {
    return null;
  }

  let entryTouched = Boolean(doc.entryTouched);
  let entryTouchedAt = Number(doc.entryTouchedAt) || null;
  const startTime = entryTouchedAt || signalClose;

  const relevant = candles.filter(c =>
    c.time >= startTime &&
    c.time >= signalClose &&
    c.time + tfMs <= now
  );

  for (const candle of relevant) {
    const entryHit = type === "BUY"
      ? candle.low <= entry
      : candle.high >= entry;

    if (!entryTouched) {
      if (entryHit) {
        entryTouched = true;
        entryTouchedAt = candle.time + tfMs;
      }

      // Jangan menebak urutan Entry dan TP/SL dalam candle ini.
      continue;
    }

    // Gunakan candle setelah candle Entry pertama tercatat.
    if (entryTouchedAt && candle.time < entryTouchedAt) {
      continue;
    }

    const hitTP = type === "BUY"
      ? candle.high >= tp
      : candle.low <= tp;

    const hitSL = type === "BUY"
      ? candle.low <= sl
      : candle.high >= sl;

    if (hitTP && hitSL) {
      return {
        entryTouched,
        entryTouchedAt,
        ambiguous: true,
        ambiguousAt: candle.time + tfMs
      };
    }

    if (hitTP) {
      return {
        status: "HIT TP",
        entryTouched,
        entryTouchedAt,
        closePrice: tp,
        closedAt: candle.time + tfMs
      };
    }

    if (hitSL) {
      return {
        status: "HIT SL",
        entryTouched,
        entryTouchedAt,
        closePrice: sl,
        closedAt: candle.time + tfMs
      };
    }
  }

  return { entryTouched, entryTouchedAt };
}

async function publishStatus(doc, documentId, status, result) {
  const setup = String(doc.setupNumber ?? "");
  const timeframe = String(doc.timeframe || "").toUpperCase();

  const payload = {
    event: "STATUS_UPDATE",
    title: "SEBU DOLLAR AI — STATUS SIGNAL",
    body: `Setup ${setup} ${timeframe}: ${status}`,
    status,
    type: String(doc.type),
    timeframe,
    timeframeMinutes: String(
      doc.timeframeMinutes || TF_MINUTES[timeframe]
    ),
    setup,
    setupNumber: setup,
    candleTime: String(doc.candleTime),
    candleCloseTime: String(doc.candleCloseTime || ""),
    closePrice: String(result.closePrice ?? ""),
    closedAt: String(result.closedAt ?? "")
  };

  // Kirim update terlebih dahulu.
  await getMessaging().send({
    topic: TOPIC,
    data: payload,
    android: {
      priority: "high",
      ttl: 60 * 60 * 1000
    }
  });

  // Ubah status final setelah FCM menerima pesan.
  await getFirestore()
    .collection(COLLECTION)
    .doc(documentId)
    .update({
      status,
      resultStatus: status,
      entryTouched: Boolean(result.entryTouched),
      entryTouchedAt: result.entryTouchedAt ?? null,
      closePrice: result.closePrice ?? null,
      closedAt: result.closedAt ?? null,
      statusUpdatedAt: new Date().toISOString()
    });

  console.log(`STATUS ${documentId}: ${status} + FCM broadcast OK`);
}

async function main() {
  initializeFirebase();

  const db = getFirestore();
  const snapshot = await db
    .collection(COLLECTION)
    .where("status", "==", "SENT")
    .get();

  if (snapshot.empty) {
    console.log("Tidak ada signal SENT yang perlu dipantau.");
    return;
  }

  const now = Date.now();
  const candlesByTf = new Map();

  for (const item of snapshot.docs) {
    const doc = item.data();
    const timeframe = String(doc.timeframe || "").toUpperCase();

    if (!TF_MINUTES[timeframe]) {
      console.warn(`Lewati ${item.id}: timeframe tidak dikenal.`);
      continue;
    }

    try {
      if (!candlesByTf.has(timeframe)) {
        candlesByTf.set(
          timeframe,
          await fetchClosedCandles(timeframe, now)
        );
      }

      const result = evaluateSignal(
        doc,
        candlesByTf.get(timeframe),
        now
      );

      if (!result) continue;

      const update = {
        entryTouched: Boolean(result.entryTouched),
        entryTouchedAt: result.entryTouchedAt ?? null
      };

      if (result.ambiguous) {
        update.ambiguousAt = result.ambiguousAt;
        update.monitorNote =
          "TP dan SL sama-sama tersentuh pada satu candle; status tidak ditebak.";

        await item.ref.update(update);
        console.warn(`AMBIGUOUS ${item.id}: status tidak ditebak.`);
        continue;
      }

      if (result.status) {
        await item.ref.update(update);
        await publishStatus(doc, item.id, result.status, result);
      } else if (result.entryTouched && !doc.entryTouched) {
        await item.ref.update(update);
        console.log(
          `ENTRY TERSENTUH ${item.id}; lanjut pantau candle berikutnya.`
        );
      }
    } catch (error) {
      console.error(
        `Gagal memantau ${item.id}:`,
        error?.message || error
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(
      "STATUS MONITOR ERROR:",
      error?.stack || error
    );
    process.exit(1);
  });
