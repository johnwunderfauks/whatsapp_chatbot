// src/app.js
const express = require("express");

function createApp({ webhookRouter }) {
  const app = express();

  // Built-in parsers (you can remove body-parser dependency if you want)
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get("/", (req, res) => {
    res.json({
      name: "chatbot",
      description: "Simple WhatsApp chatbot for Wassenger",
      endpoints: { webhook: "/webhook" },
    });
  });

  app.use("/webhook", webhookRouter);

  return app;
}

module.exports = { createApp };