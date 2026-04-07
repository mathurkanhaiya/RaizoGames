import { Router } from "express";
import { confirmOxaPayDeposit } from "../bot/services/depositService";
import { processUpdate } from "../bot/bot";
import { logger } from "../lib/logger";

const router = Router();

// OxaPay webhook handler
// OxaPay sends: { type, status, trackId, orderId, amount, currency, txID, ... }
router.post("/webhook/oxapay", async (req, res) => {
  // Always respond 200 immediately — OxaPay retries on non-200
  res.json({ result: 100 });

  try {
    const body = req.body;

    // Log the FULL payload so we can debug in Railway logs
    logger.info({ body }, "OxaPay webhook received");

    const status: string = body.status || body.Status || "";
    // trackId may be number or string from OxaPay
    const trackId: string = String(body.trackId || body.TrackId || body.track_id || "");
    // Also try orderId as fallback lookup key
    const orderId: string = String(body.orderId || body.OrderId || body.order_id || "");
    // Amount in USDT
    const amount = parseFloat(body.amount || body.Amount || body.netAmount || "0");

    logger.info({ status, trackId, orderId, amount }, "OxaPay webhook parsed");

    // Accept Paid or Confirming as valid payment status
    if (status === "Paid" || status === "Confirming" || status === "paid" || status === "confirming") {
      if (amount <= 0) {
        logger.warn({ body }, "OxaPay webhook: amount is 0 or missing");
        return;
      }

      // Try trackId first, then orderId as fallback
      let confirmed = false;
      if (trackId) {
        confirmed = await confirmOxaPayDeposit(trackId, amount);
      }
      if (!confirmed && orderId) {
        confirmed = await confirmOxaPayDeposit(orderId, amount);
      }

      if (confirmed) {
        logger.info({ trackId, orderId, amount }, "OxaPay deposit confirmed — balance credited");
      } else {
        logger.warn({ trackId, orderId, amount }, "OxaPay webhook: deposit not found or already confirmed");
      }
    } else {
      logger.info({ status }, "OxaPay webhook: non-payment status, skipping");
    }
  } catch (err) {
    logger.error({ err }, "OxaPay webhook processing error");
  }
});

// Telegram webhook handler (used in production/Railway — webhook mode)
router.post("/webhook/telegram", (req, res) => {
  try {
    processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    logger.error({ err }, "Telegram webhook error");
    res.sendStatus(200); // Always 200 — Telegram retries on non-200
  }
});

export default router;
