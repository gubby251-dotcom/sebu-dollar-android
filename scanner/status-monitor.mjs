
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const CANDLE_API_URL = "https://biquote.io/api/XAUUSD/ohlc";
const TOPIC = "sebu_signal_users";
const TF_MINUTES = { M30: 30, M15: 15 };
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

function normalizeTime(value) {
  if (value === null || value === undefined || value === "") {
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

/* =======================================================
   NORMALIZE CANDLES
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
  } else if (Array.isArray(payload?.result?.data)) {
    bars = payload.result.data;
  }

  const sorted = bars
    .map((c) => ({
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
    .filter((c) =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low)
    )
    .sort((a, b) => a.time - b.time);

  return sorted.filter((c, i) =>
    i === 0 || c.time !== sorted[i - 1].time
  );
}

/* =======================================================
   ACTIVE SETUP GUARD
   Only Setup 1/2 on M30 and Setup 3 on M15 are active.
   This guard runs before timeframe resolution so old documents
   cannot be monitored just because they still contain M30/M15 metadata.
======================================================= */

function isActiveSetup(doc) {
  const rawSetup = doc?.setupNumber ?? doc?.setup;
  const setupNumber = Number(String(rawSetup ?? "").replace(/^SETUP\s*/i, "").trim());
  const rawTimeframe = String(doc?.timeframe ?? "").trim().toUpperCase();
  const minutes = Number(doc?.timeframeMinutes);

  const timeframeFromMinutes = minutes === 30 ? "M30" : minutes === 15 ? "M15" : null;
  const timeframeFromField = TF_MINUTES[rawTimeframe] ? rawTimeframe : null;

  // Reject contradictory or explicitly unsupported timeframe metadata.
  if (rawTimeframe && !timeframeFromField) return false;
  if (Number.isFinite(minutes) && minutes > 0 && !timeframeFromMinutes) return false;
  if (timeframeFromField && timeframeFromMinutes && timeframeFromField !== timeframeFromMinutes) return false;

  const timeframe = timeframeFromField || timeframeFromMinutes;
  if (setupNumber === 1 || setupNumber === 2) {
    return !timeframe || timeframe === "M30";
  }
  if (setupNumber === 3) {
    return !timeframe || timeframe === "M15";
  }
  return false;
}

/* =======================================================
   TIMEFRAME RESOLVER
======================================================= */

function getTimeframe(doc, documentId = "") {
  const raw = String(doc.timeframe || "")
    .trim()
    .toUpperCase();

  if (TF_MINUTES[raw]) {
    return raw;
  }

  const idPrefix = String(documentId)
    .trim()
    .toUpperCase()
    .match(/^(M30|M15)_/);

  if (idPrefix && TF_MINUTES[idPrefix[1]]) {
    return idPrefix[1];
  }

  const minutes = Number(doc.timeframeMinutes);

  const minutesMatch = Object.entries(TF_MINUTES)
    .find(([, value]) => value === minutes);

  if (minutesMatch) {
    return minutesMatch[0];
  }

  const setupNumber = Number(doc.setupNumber);

  // Fallback only when older documents lack timeframe metadata.
  // Current active mapping: Setup 1/2 = M30, Setup 3 = M15.
  // Legacy Setup 4/5 and M5 documents are not monitored as active signals.
  if ([1, 2].includes(setupNumber)) {
    return "M30";
  }

  if (setupNumber === 3) {
    return "M15";
  }

  return null;
}

/* =======================================================
   FETCH CLOSED CANDLES
======================================================= */

async function fetchClosedCandles(timeframe, now) {
  const minutes = TF_MINUTES[timeframe];
  const url = `${CANDLE_API_URL}?interval=${minutes}m&limit=80`;

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

  return candles.filter((c) =>
    c.time % tfMs === 0 &&
    c.time + tfMs <= now
  );
}

/* =======================================================
   EVALUATE SIGNAL
======================================================= */

function evaluateSignal(doc, candles, now, timeframe) {
  const tfMinutes = TF_MINUTES[timeframe];
  const tfMs = tfMinutes * 60 * 1000;

  const signalTime = normalizeTime(doc.candleTime);

  const storedCloseTime = normalizeTime(doc.candleCloseTime);

  const signalClose = Number.isFinite(storedCloseTime)
    ? storedCloseTime
    : signalTime + tfMs;

  const entry = Number(doc.entry);
  const sl = Number(doc.sl);
  const tp = Number(doc.tp);
  const type = String(doc.type || "").toUpperCase();

  if (
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
  let entryTouchedAt = normalizeTime(doc.entryTouchedAt);

  if (!Number.isFinite(entryTouchedAt)) {
    entryTouchedAt = null;
  }

  const startTime = entryTouchedAt || signalClose;

  const relevant = candles.filter((c) =>
    c.time >= startTime &&
    c.time >= signalClose &&
    c.time + tfMs <= now
  );

  let firstAmbiguousAt = null;

  for (const candle of relevant) {
    // Confirm Entry only when the closed candle range actually contains it.
    // A candle entirely beyond Entry cannot prove the Entry was traded.
    const entryHit = candle.low <= entry && candle.high >= entry;

    if (!entryTouched) {
      if (entryHit) {
        entryTouched = true;
        entryTouchedAt = candle.time + tfMs;
      }

      // Tidak menebak urutan Entry dan TP/SL
      // pada candle yang sama.
      continue;
    }

    // Candle Entry pertama tidak dipakai untuk
    // menentukan hasil TP/SL.
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
      // Do not guess the order inside this candle. Remember the ambiguity,
      // then continue: a later candle can establish the eventual outcome.
      firstAmbiguousAt ??= candle.time + tfMs;
      continue;
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

  if (firstAmbiguousAt !== null) {
    return {
      entryTouched,
      entryTouchedAt,
      ambiguous: true,
      ambiguousAt: firstAmbiguousAt
    };
  }

  return { entryTouched, entryTouchedAt };
}

/* =======================================================
   PUBLISH STATUS
======================================================= */

async function publishStatus(
  doc,
  documentId,
  status,
  result,
  timeframe
) {
  const setup = String(doc.setupNumber ?? "");

  const signalTime = normalizeTime(doc.candleTime);
  const storedCloseTime = normalizeTime(doc.candleCloseTime);

  const candleCloseTime = Number.isFinite(storedCloseTime)
    ? storedCloseTime
    : signalTime + TF_MINUTES[timeframe] * 60 * 1000;

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
    candleTime: String(signalTime),
    candleCloseTime: String(candleCloseTime),
    closePrice: String(result.closePrice ?? ""),
    closedAt: String(result.closedAt ?? ""),
    signalKey: documentId
  };

  const db = getFirestore();
  const signalRef = db.collection(COLLECTION).doc(documentId);
  const terminalStatuses = new Set(["HIT TP", "HIT SL"]);

  // Commit once, atomically. A stale or concurrent monitor cannot reverse a terminal result.
  const commit = await db.runTransaction(async (tx) => {
    const fresh = await tx.get(signalRef);
    if (!fresh.exists) return { committed: false, reason: "MISSING" };
    const current = String(fresh.get("status") || "").toUpperCase();
    if (terminalStatuses.has(current)) {
      return { committed: false, reason: current === status ? "ALREADY_COMMITTED" : "CONFLICT", status: current };
    }
    if (!["SENT", "PENDING", ""].includes(current)) {
      return { committed: false, reason: "NOT_ACTIVE", status: current };
    }
    tx.update(signalRef, {
      status,
      resultStatus: status,
      timeframe,
      timeframeMinutes: TF_MINUTES[timeframe],
      entryTouched: Boolean(result.entryTouched),
      entryTouchedAt: result.entryTouchedAt ?? null,
      closePrice: result.closePrice ?? null,
      closedAt: result.closedAt ?? null,
      statusUpdatedAt: new Date().toISOString(),
      statusNotificationPending: true,
      statusNotificationPayload: payload
    });
    return { committed: true, reason: "COMMITTED", status };
  });

  if (!commit.committed) {
    console.warn(`STATUS SKIPPED ${documentId}: ${commit.reason}; stored=${commit.status || "missing"}; proposed=${status}`);
    return;
  }

  // Durable status comes first. FCM failure must not roll back the trading result.
  try {
    await getMessaging().send({
      topic: TOPIC,
      data: payload,
      android: { priority: "high", ttl: 60 * 60 * 1000 }
    });
    await signalRef.update({ statusNotificationPending: false, statusNotificationSentAt: new Date().toISOString() });
    console.log(`STATUS ${documentId}: ${status}; FCM accepted`);
  } catch (error) {
    console.error(`STATUS COMMITTED ${documentId}: ${status}; FCM failed; notification remains pending:`, error?.message || error);
  }
}

/* =======================================================
   MAIN MONITOR
======================================================= */

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

    if (!isActiveSetup(doc)) {
      console.warn(
        `Lewati ${item.id}: setup lama/tidak aktif ` +
        `(setup=${doc.setupNumber ?? doc.setup}, timeframe=${doc.timeframe}).`
      );
      continue;
    }

    const timeframe = getTimeframe(doc, item.id);

    if (!timeframe) {
      console.warn(
        `Lewati ${item.id}: timeframe tidak dikenal. ` +
        `timeframe=${doc.timeframe}, ` +
        `timeframeMinutes=${doc.timeframeMinutes}, ` +
        `setupNumber=${doc.setupNumber}.`
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
        now,
        timeframe
      );

      if (!result) {
        console.warn(
          `Lewati ${item.id}: data signal tidak lengkap atau tidak valid.`
        );
        continue;
      }

      const update = {
        timeframe,
        timeframeMinutes: TF_MINUTES[timeframe],
        entryTouched: Boolean(result.entryTouched),
        entryTouchedAt: result.entryTouchedAt ?? null
      };

      if (result.ambiguous) {
        update.ambiguousAt = result.ambiguousAt;
        update.monitorNote =
          "TP dan SL sama-sama tersentuh pada satu candle; hasil tidak ditebak.";

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
          result,
          timeframe
        );
      } else if (
        result.entryTouched &&
        !doc.entryTouched
      ) {
        await item.ref.update(update);

        console.log(
          `ENTRY TERSENTUH ${item.id}; pantau candle berikutnya.`
        );
      } else if (
        doc.timeframe !== timeframe ||
        Number(doc.timeframeMinutes) !== TF_MINUTES[timeframe]
      ) {
        // Lengkapi metadata timeframe dokumen lama.
        await item.ref.update({
          timeframe,
          timeframeMinutes: TF_MINUTES[timeframe]
        });

        console.log(
          `TIMEFRAME DIPERBAIKI ${item.id}: ${timeframe}`
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

/* =======================================================
   ERROR HANDLER
======================================================= */

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(
      "STATUS MONITOR ERROR:",
      error?.stack || error
    );

    process.exit(1);
  });
