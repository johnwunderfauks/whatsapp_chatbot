const express = require("express");

function createApp({ webhookRouter, adminRouter }) {
  const app = express();

  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.get("/", (req, res) => {
    res.json({
      name: "chatbot",
      description: "WhatsApp receipt chatbot",
      endpoints: {
        webhook: "/webhook",
        admin: "/admin",
      },
    });
  });

  app.use("/webhook", webhookRouter);

  if (adminRouter) {
    app.use("/admin", adminRouter);
  }

  return app;
}

module.exports = { createApp };