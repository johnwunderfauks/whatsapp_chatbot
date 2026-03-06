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

app.get("/", botService.health);
botService.startKeepAlive();

app.post("/whatsapp", botService.handleWhatsappWebhook);
app.post("/whatsapp/notify-user", botService.handleNotifyUser);

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Express server listening on port ${PORT}`));