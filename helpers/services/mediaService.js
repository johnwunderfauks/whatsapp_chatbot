// helpers/services/mediaService.js
const axios = require("axios");

function createMediaService(config, logger) {
  const http = axios.create({ timeout: config.httpTimeoutMs });

  // 1×1 white JPEG — tiny valid image used in MOCK_EXTERNAL_APIS mode
  const MOCK_IMAGE_BUFFER = Buffer.from(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U" +
    "HRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgN" +
    "DRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy" +
    "MjL/wAARCAABAAEDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgUEB/8QAIRAA" +
    "AgIBBQEAAAAAAAAAAAAAAQIDBAUREiExQVH/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QA" +
    "FBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8Amk2barVoqWUotVT7DuSn3R5S" +
    "ANv3HQkepLbpPWn5bnvkxLYbHPPJBAAAAAAAAAAAAAAAAH//2Q==",
    "base64"
  );

  async function fetchImageFromTwilio(mediaUrl) {
    logger.logToFile(`[info] Fetching image from Twilio: ${mediaUrl}`);

    if (process.env.MOCK_EXTERNAL_APIS === "true") {
      return MOCK_IMAGE_BUFFER;
    }

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