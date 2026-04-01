require("dotenv").config();

const fs = require("fs");
const http = require("http");
const twilio = require("twilio");

if (process.env.GOOGLE_CREDENTIALS_JSON) {
  const targetPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS || "/tmp/gcp.json";

  fs.writeFileSync(targetPath, process.env.GOOGLE_CREDENTIALS_JSON, "utf8");
  console.log(`Google credentials written to ${targetPath}`);
}

const helpers = require("./helpers");
const { createReceiptWorker } = require("./src/workers/receiptWorker");
const { createBotService } = require("./src/services/botService");
const { createApp } = require("./src/app");
const { createAdminRoutes } = require("./src/routes/adminRoutes");

const noopKeepAliveJob = {
  start() {},
};

const noopRateLimiter = {
  async checkRateLimit() {
    return { allowed: true, warning: null };
  },
  async recordMessageSent() {
    return true;
  },
};

function createWebhookRouter(botService) {
  const express = require("express");
  const router = express.Router();

  const skipValidation = process.env.SKIP_TWILIO_VALIDATION === "true";
  const validateTwilio = skipValidation
    ? (_req, _res, next) => next()
    : twilio.webhook(process.env.TWILIO_AUTH_TOKEN, { validate: true });

  router.get("/health", botService.health);
  router.post("/", validateTwilio, botService.handleWhatsappWebhook);

  return router;
}

process.on("unhandledRejection", (reason) => {
  console.error("[fatal] Unhandled promise rejection:", reason);
  process.exit(1);
});

async function bootstrap() {
  const worker = createReceiptWorker();

  worker.on("completed", (job) => {
    console.log(`[worker] Job completed: ${job.id}`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[worker] Job failed: ${job?.id} - ${err.message}`);
  });

  const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  const botService = createBotService({
    twilioClient,
    keepAliveJob: noopKeepAliveJob,
    helpers,
    rateLimiter: noopRateLimiter,
    config: {},
  });

  const webhookRouter = createWebhookRouter(botService);
  const adminRouter = createAdminRoutes({ botService });
  const app = createApp({ webhookRouter, adminRouter });

  const port = Number(process.env.PORT || 3000);
  const server = http.createServer(app);

  server.listen(port, () => {
    console.log(`[server] listening on :${port}`);
    console.log("[worker] receipt worker started");
  });

  function gracefulShutdown(signal) {
    console.log(`[server] ${signal} received, shutting down gracefully`);
    server.close(() => {
      console.log("[server] HTTP server closed");
      worker.close().then(() => {
        console.log("[worker] BullMQ worker closed");
        process.exit(0);
      }).catch(() => process.exit(1));
    });
    setTimeout(() => {
      console.error("[server] Forced shutdown after 30s timeout");
      process.exit(1);
    }, 30000).unref();
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

bootstrap().catch((error) => {
  console.error("[fatal] bootstrap failed:", error);
  process.exit(1);
});