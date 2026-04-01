require("dotenv").config();

const fs = require("fs");

if (process.env.GOOGLE_CREDENTIALS_JSON) {
  const targetPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || "/tmp/gcp.json";
  fs.writeFileSync(targetPath, process.env.GOOGLE_CREDENTIALS_JSON, "utf8");
  console.log(`Google credentials written to ${targetPath}`);
}

const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const { job } = require("./keepAlive");
const helpers = require("./helpers");
const rateLimiter = require("./fraud-detection/message-rate-limiter");
const { createBotService } = require("./src/services/botService");

const app = express();

// Trust Railway / Render reverse-proxy so req.protocol returns "https"
app.set("trust proxy", 1);

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const botService = createBotService({
  twilioClient: client,
  keepAliveJob: job,
  helpers,
  rateLimiter,
});

const skipValidation = process.env.SKIP_TWILIO_VALIDATION === "true";
const validateTwilio = skipValidation
  ? (_req, _res, next) => next()
  : twilio.webhook(process.env.TWILIO_AUTH_TOKEN, { validate: true });

app.get("/", botService.health);
botService.startKeepAlive();

app.post("/whatsapp", validateTwilio, botService.handleWhatsappWebhook);
app.post("/whatsapp/notify-user", botService.handleNotifyUser);

const PORT = Number(process.env.PORT || 3000);
const server = app.listen(PORT, () =>
  console.log(`Express server listening on port ${PORT}`)
);

process.on("unhandledRejection", (reason) => {
  console.error("[fatal] Unhandled promise rejection:", reason);
  process.exit(1);
});

function gracefulShutdown(signal) {
  console.log(`[server] ${signal} received, shutting down gracefully`);
  server.close(() => {
    console.log("[server] HTTP server closed");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("[server] Forced shutdown after 30s timeout");
    process.exit(1);
  }, 30000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
