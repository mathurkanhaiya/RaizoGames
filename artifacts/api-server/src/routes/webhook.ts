import { Router } from "express";
import { confirmOxaPayDeposit } from "../bot/services/depositService";
import { logger } from "../lib/logger";

const router = Router();

// OxaPay webhook handler
router.post("/webhook/oxapay", async (req, res) => {
  try {
    const { status, trackId, amount, currency } = req.body;

    req.log.info({ trackId, status, amount }, "OxaPay webhook received");

    if (status === "Paid" || status === "Confirming") {
      const amountUSD = parseFloat(amount) || 0;
      const confirmed = await confirmOxaPayDeposit(trackId, amountUSD);

      if (confirmed) {
        req.log.info({ trackId, amountUSD }, "OxaPay deposit confirmed");
      }
    }

    res.json({ result: 100 });
  } catch (err) {
    logger.error({ err }, "OxaPay webhook error");
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

export default router;
