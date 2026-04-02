const express   = require("express");
const rateLimit = require("express-rate-limit");

/**
 * Webhook rate limiter — applied before Twilio signature validation and all
 * business logic so non-Twilio floods are rejected at the edge.
 *
 * Defaults are tuned for a 2500-user burst event:
 *  - Twilio typically uses 5-20 source IPs.
 *  - 2500 msgs / 5 IPs = 500 per IP in a burst → limit set to 1500 for headroom.
 *  - Returns 200 + empty TwiML on exceed so Twilio does NOT retry the message.
 *
 * Overridable via env vars without a deploy:
 *  WEBHOOK_RATE_LIMIT_MAX        (default 1500 per window per IP)
 *  WEBHOOK_RATE_LIMIT_WINDOW_MS  (default 60 000 ms = 1 minute)
 */
function createWebhookLimiter() {
  return rateLimit({
    windowMs: Number(process.env.WEBHOOK_RATE_LIMIT_WINDOW_MS || 60_000),
    max:      Number(process.env.WEBHOOK_RATE_LIMIT_MAX       || 1_500),
    standardHeaders: true,
    legacyHeaders:   false,

    // Skip entirely in Jest (NODE_ENV=test) so unit/e2e tests are unaffected.
    skip: () => process.env.NODE_ENV === "test",

    // Return empty TwiML (HTTP 200) — prevents Twilio from retrying the webhook.
    handler(_req, res) {
      res
        .type("text/xml")
        .status(200)
        .send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    },

    // Use X-Forwarded-For set by Railway's proxy (trust proxy already set).
    keyGenerator: (req) => req.ip,
  });
}

function createApp({ webhookRouter, adminRouter }) {
  const app = express();

  // Trust Railway / Render reverse-proxy so req.protocol and req.ip are correct.
  app.set("trust proxy", 1);

  // Twilio webhook payloads are form-urlencoded and well under 10 KB even
  // with multiple media URLs. 100 KB is generous headroom while blocking
  // oversized payloads before they reach any parsing or handler logic.
  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ extended: true, limit: "100kb" }));

  app.get("/", (_req, res) => {
    res.json({
      name: "chatbot",
      description: "WhatsApp receipt chatbot",
      endpoints: {
        webhook: "/webhook",
        admin:   "/admin",
      },
    });
  });

  // Rate limiter sits in front of Twilio validation and all webhook handlers.
  app.use("/webhook", createWebhookLimiter());
  app.use("/webhook", webhookRouter);

  if (adminRouter) {
    app.use("/admin", adminRouter);
  }

  return app;
}

module.exports = { createApp };
