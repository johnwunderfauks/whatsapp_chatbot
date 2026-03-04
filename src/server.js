// src/server.js
require("dotenv").config();
const config = require("../config");
const { createApp } = require("./app");
const { createWebhookRouter } = require("./routes/webhook");
const { createWebhookController } = require("./controllers/webhookController");
const { createBotService } = require("./services/botService");

const botService = createBotService({ config });
const webhookController = createWebhookController({ botService });
const webhookRouter = createWebhookRouter({ webhookController });

const app = createApp({ webhookRouter });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));