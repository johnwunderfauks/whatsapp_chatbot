// helpers/config.js
function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error("Missing ENV:", name);
    process.exit(1);
  }
  return v;
}

function createConfig() {
  return {
    httpTimeoutMs: Number(process.env.HTTP_TIMEOUT_MS || 20000),
    wp: {
      url: (process.env.WP_URL || "https://wunderfauksw18.sg-host.com/").replace(/\/$/, ""),
      user: required("WP_USER"),
      appPassword: required("WP_APP_PASSWORD"),
      userAgent: process.env.BOT_USER_AGENT || "WhatsApp-Bot/1.0",
      duplicateCheckTimeoutMs: Number(process.env.DUPLICATE_CHECK_TIMEOUT_MS || 5000),
    },
    log: {
      file: process.env.BOT_LOG_FILE || "./chatbot_logs.txt",
    },
    state: {
      ttlMs: Number(process.env.STATE_TTL_MS || 24 * 60 * 60 * 1000),
    },
    gcp: {
      // GOOGLE_APPLICATION_CREDENTIALS is used by google sdk automatically
      enabled: Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS),
    },
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID || "",
      authToken: process.env.TWILIO_AUTH_TOKEN || "",
    },
  };
}

module.exports = { createConfig };