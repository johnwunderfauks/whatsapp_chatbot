// src/routes/webhook.js
const express = require("express");

function createWebhookRouter({ webhookController }) {
  const router = express.Router();

  router.post("/", webhookController.handleWebhook);

  return router;
}

module.exports = { createWebhookRouter };