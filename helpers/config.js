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
      url: (process.env.WP_URL),
      user: required("WP_USER"),
      appPassword: required("WP_APP_PASSWORD"),
      userAgent: process.env.BOT_USER_AGENT || "WhatsApp-Bot/1.0",
      duplicateCheckTimeoutMs: Number(process.env.DUPLICATE_CHECK_TIMEOUT_MS || 5000),
    },
    log: {
      file: process.env.BOT_LOG_FILE,
    },
    state: {
      ttlMs: Number(process.env.STATE_TTL_MS || 24 * 60 * 60 * 1000),
    },
    gcp: {
      // GOOGLE_APPLICATION_CREDENTIALS is used by google sdk automatically
      enabled: Boolean(required("GOOGLE_APPLICATION_CREDENTIALS")),
    },
    twilio: {
      accountSid: required("TWILIO_ACCOUNT_SID"),
      authToken: required("TWILIO_AUTH_TOKEN"),
    },
    openai: {
      apiKey: required("OPENAI_API_KEY"),
    },
  };
}

module.exports = { createConfig };