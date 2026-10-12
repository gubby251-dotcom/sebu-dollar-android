import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const CANDLE_API_URL = "https://biquote.io/api/XAUUSD/ohlc";
const TOPIC = "sebu_signal_users";
const TF_MINUTES = { M30: 30, M15: 15, M5: 5 };
const COLLECTION = "sent_signals";

function initializeFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!raw) {
    throw new Error("Secret FIREBASE_SERVICE_ACCOUNT belum ditemukan.");
  }

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

/* Mengenali format timeframe dari dokumen signal. */
function normalizeTimeframe(doc) {
  const raw = String(
    doc.timeframe ??
    doc.timeFrame ??
    doc.tf ??
    ""
  ).trim().toUpperCase();

  const aliases = {
    "30": "M30",
    "30M": "M30",
    "M30": "M30",
    "15": "M15",
    "15M": "M15",
    "M15": "M15",
    "5": "M5",
    "5M": "M5",
    "M5": "M5"
  };

  if (aliases[raw]) {
    return aliases[raw];
  }

  const minutes = Number(doc.timeframeMinutes);

  if (minutes === 30) return "M30";
  if (minutes === 15) return "M15";
  if (minutes === 5) return "M5";

  return "";
}

function normalizeTime(value) {
  if (value === null || value === undefined) {
    return NaN;
  }

  if (
    typeof value === "number" ||
    /^\d+(\.\d+)?$/.test(String(value))
  ) {
    const n = Number(value);
    return n > 9999999999 ? n : n * 1000;
  }

  const parsed = Date.parse(String(value));

  return Number.isFinite(parsed) ? parsed : NaN;
}

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

  const sorted = bars
    .map(c => ({
      time: normalizeTime(
        c?.openTime ??
        c?.open_time ??
        c?.datetime ??
        c?.time ??
        c?.timestamp ??
        c?.t
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

  if (!minutes) {
    throw new Error(`Timeframe tidak didukung: ${timeframe}`);
  }

  const url =
    `${CANDLE_API_URL}?interval=${minutes}m&limit=80`;

  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(
      `BiQuote ${timeframe} HTTP ${response.status}`
    );
  }

  const candles = normalizeCandles(await response.json());
  const tfMs = minutes * 60 * 1000;

  return candles.filter(c =>
    c.time % tfMs === 0 &&
    c.time + tfMs <= now
  );
}

/*
 * Memantau candle yang sudah ditutup pada timeframe signal.
 * Jika Entry dan TP/SL tersentuh dalam candle yang sama,
 * urutannya tidak diketahui dari OHLC sehingga tidak ditebak.
 */
function evaluateSignal(doc, candles, now) {
  const timeframe = normalizeTimeframe(doc);
  const tfMinutes = TF_MINUTES[timeframe];
  const tfMs = tfMinutes * 60 * 1000;

  const signalTime = normalizeTime(doc.candleTime);

  const savedClose = normalizeTime(doc.candleCloseTime);
  const signalClose = Number.isFinite(savedClose)
    ? savedClose
    : signalTime + tfMs;

  const entry = Number(doc.entry);
  const sl = Number(doc.sl);
  const tp = Number(doc.tp);
  const type = String(doc.type || "").toUpperCase();

  if (
    !timeframe ||
    !["BUY", "SELL"].includes(type) ||
    ![
      entry,
      sl,
      tp,
      signalTime,
      signalClose
    ].every(Number.isFinite)
  ) {
    return null;
  }

  let entryTouched = Boolean(doc.entryTouched);
  let entryTouchedAt =
    normalizeTime(doc.entryTouchedAt);

  if (!Number.isFinite(entryTouchedAt)) {
    entryTouchedAt = null;
  }

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

    // Jangan menggunakan candle Entry yang sama untuk TP/SL.
    if (
      entryTouchedAt &&
      candle.time < entryTouchedAt
    ) {
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

  return {
    entryTouched,
    entryTouchedAt
  };
}

async function publishStatus(
  doc,
  documentId,
  status,
  result
) {
  const setup = String(doc.setupNumber ?? "");
  const timeframe = normalizeTimeframe(doc);

  const payload = {
    event: "STATUS_UPDATE",
    title: "SEBU DOLLAR AI — STATUS SIGNAL",
    body: `Setup ${setup} ${timeframe}: ${status}`,
    status,
    type: String(doc.type || "").toUpperCase(),
    timeframe,
    timeframeMinutes: String(TF_MINUTES[timeframe]),
    setup,
    setupNumber: setup,
    candleTime: String(doc.candleTime ?? ""),
    candleCloseTime: String(
      doc.candleCloseTime ?? ""
    ),
    closePrice: String(result.closePrice ?? ""),
    closedAt: String(result.closedAt ?? "")
  };

  // Kirim update FCM terlebih dahulu.
  await getMessaging().send({
    topic: TOPIC,
    data: payload,
    android: {
      priority: "high",
      ttl: 60 * 60 * 1000
    }
  });

  // Simpan status akhir setelah FCM menerima pesan.
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

  console.log(
    `STATUS ${documentId}: ${status} + FCM broadcast OK`
  );
}

async function main() {
  initializeFirebase();

  const db = getFirestore();

  const snapshot = await db
    .collection(COLLECTION)
    .where("status", "==", "SENT")
    .get();

  if (snapshot.empty) {
    console.log(
      "Tidak ada signal SENT yang perlu dipantau."
    );
    return;
  }

  const now = Date.now();
  const candlesByTf = new Map();

  for (const item of snapshot.docs) {
    const doc = item.data();
    const timeframe = normalizeTimeframe(doc);

    if (!timeframe) {
      console.warn(
        `Lewati ${item.id}: timeframe tidak dikenal. ` +
        `timeframe=${doc.timeframe}, ` +
        `timeframeMinutes=${doc.timeframeMinutes}`
      );
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

      if (!result) {
        console.warn(
          `Lewati ${item.id}: data signal tidak lengkap atau tidak valid.`
        );
        continue;
      }

      const update = {
        entryTouched: Boolean(result.entryTouched),
        entryTouchedAt: result.entryTouchedAt ?? null
      };

      if (result.ambiguous) {
        update.ambiguousAt = result.ambiguousAt;
        update.monitorNote =
          "TP dan SL sama-sama tersentuh pada satu candle; status tidak ditebak.";

        await item.ref.update(update);

        console.warn(
          `AMBIGUOUS ${item.id}: status tidak ditebak.`
        );

        continue;
      }

      if (result.status) {
        await item.ref.update(update);

        await publishStatus(
          doc,
          item.id,
          result.status,
          result
        );
      } else if (
        result.entryTouched &&
        !doc.entryTouched
      ) {
        await item.ref.update(update);

        console.log(
          `ENTRY TERSENTUH ${item.id}; ` +
          `lanjut pantau candle berikutnya.`
        );
      }
    } catch (error) {
      console.error(
        `Gagal memantau ${item.id}:`,
        error?.message || error
      );
    }
  }

  console.log("Status monitor selesai.");
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
