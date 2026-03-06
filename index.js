// index.js
require("dotenv").config();

const fs = require("fs");
const path = require("path");

// Railway-friendly Google Vision bootstrap
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

const { createBotService } = require("./src/services/botService"); // adjust path if needed

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Twilio client
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Bot service
const botService = createBotService({
  twilioClient: client,
  keepAliveJob: job,
  helpers,
  rateLimiter,
});

// Routes
app.get("/", botService.health);
botService.startKeepAlive();

app.get("/debug/env-check", (req, res) => {
  res.json({
    hasTwilioSid: !!process.env.TWILIO_ACCOUNT_SID,
    hasTwilioToken: !!process.env.TWILIO_AUTH_TOKEN,
    hasWpUrl: !!process.env.WP_URL,
    hasWpUser: !!process.env.WP_USER,
    hasWpAppPassword: !!process.env.WP_APP_PASSWORD,
    googleCredPath: process.env.GOOGLE_APPLICATION_CREDENTIALS || null,
    hasGoogleCredJson: !!process.env.GOOGLE_CREDENTIALS_JSON,
  });
});

app.post("/whatsapp", (req, res, next) => {
  console.log("TWILIO WEBHOOK HIT", {
    from: req.body.From,
    body: req.body.Body,
    numMedia: req.body.NumMedia,
    mediaUrl0: req.body.MediaUrl0,
    mediaType0: req.body.MediaContentType0,
  });
  next();
}, botService.handleWhatsappWebhook);
app.post("/whatsapp/notify-user", botService.handleNotifyUser);

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Express server listening on port ${PORT}`));

console.log("ENV CHECK:", {
  WP_USER: process.env.WP_USER,
  WP_URL: process.env.WP_URL,
});