// src/controllers/webhookController.js
function createWebhookController({ botService }) {
  return {
    handleWebhook: async (req, res) => {
      const body = req.body;

      if (!body || !body.event || !body.data) {
        return res.status(400).json({ message: "Invalid payload body" });
      }

      // Wassenger inbound message event
      if (body.event !== "message:in:new") {
        return res
          .status(202)
          .json({ message: "Ignore webhook event: only message:in:new is accepted" });
      }

      // Reply fast; process async
      res.json({ ok: true });

      botService.processMessage(body).catch((err) => {
        botService.log?.(`processMessage error: ${err?.message || err}`);
      });
    },
  };
}

module.exports = { createWebhookController };