/**
 * SEBU DOLLAR AI — COMPATIBILITY ENTRY POINT
 *
 * Legacy M30/M15 scanner removed.
 * All signal generation is delegated to the M5 SNR engine.
 * The canonical workflow executes m5-auto-scanner.mjs directly.
 *
 * Keeping this file prevents stale workflow references from reactivating
 * the former M30/M15/50%-body implementation.
 */
import "./m5-auto-scanner.mjs";
