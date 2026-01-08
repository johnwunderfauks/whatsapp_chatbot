// keepAlive.js
const cron = require("cron");
const https = require("https");

const job = new cron.CronJob("*/14 * * * *", function () {
  https
    .get("https://whatsapp-chatbot-3tkc.onrender.com", (res) => {
      if (res.statusCode === 200) {
        console.log("✅ Ping successful at", new Date().toLocaleTimeString());
      } else {
        console.log("⚠️ Ping failed:", res.statusCode);
      }
    })
    .on("error", (e) => {
      console.error("❌ Ping error:", e.message);
    });
});


module.exports = {
  job,
};