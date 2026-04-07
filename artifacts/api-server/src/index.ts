import app from "./app";
import { logger } from "./lib/logger";
import { initBot } from "./bot/bot";
import { setupDatabase } from "./bot/setupDatabase";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function main() {
  // Create all DB tables and seed default data on every cold start
  try {
    await setupDatabase();
  } catch (err) {
    // Log but never crash — server must start even if DB setup has a hiccup
    logger.error({ err }, "DB setup error — continuing startup anyway");
  }

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");

    // Initialize the Telegram bot
    try {
      initBot();
      logger.info("Telegram bot started");
    } catch (err) {
      logger.error({ err }, "Failed to start Telegram bot");
    }
  });
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
