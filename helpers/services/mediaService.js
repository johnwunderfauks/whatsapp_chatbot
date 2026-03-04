// helpers/services/mediaService.js
const axios = require("axios");

function createMediaService(config, logger) {
  const http = axios.create({ timeout: config.httpTimeoutMs });

  async function fetchImageFromTwilio(mediaUrl) {
    logger.logToFile(`[info] Fetching image from Twilio: ${mediaUrl}`);

    if (!mediaUrl) throw new Error("fetchImageFromTwilio: mediaUrl is required");
    if (!config.twilio.accountSid || !config.twilio.authToken) {
      throw new Error("Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN");
    }

    try {
      const res = await http.get(mediaUrl, {
        responseType: "arraybuffer",
        auth: {
          username: config.twilio.accountSid,
          password: config.twilio.authToken,
        },
      });

      return Buffer.from(res.data);
    } catch (err) {
      logger.logToFile(`[error] Failed to fetch Twilio image: ${err.message}`);
      throw new Error("Failed to download media from Twilio");
    }
  }

  return { fetchImageFromTwilio };
}

module.exports = { createMediaService };