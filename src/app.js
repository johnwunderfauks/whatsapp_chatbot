const express = require("express");

function createApp({ webhookRouter, adminRouter }) {
  const app = express();

  // Trust Railway / Render reverse-proxy so req.protocol returns "https"
  app.set("trust proxy", 1);

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