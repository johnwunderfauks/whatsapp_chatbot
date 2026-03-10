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

  router.get("/health", botService.health);
  router.post("/", botService.handleWhatsappWebhook);

  return router;
}

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
}

bootstrap().catch((error) => {
  console.error("[fatal] bootstrap failed:", error);
  process.exit(1);
});