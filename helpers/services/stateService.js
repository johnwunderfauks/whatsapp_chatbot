const { getRedis } = require("./redisClient");

function createStateService(config, logger) {
  const redis = getRedis();
  const ttlSeconds = Math.max(
    60,
    Math.floor((config.state?.ttlMs || 86400000) / 1000)
  );

  function key(phone) {
    return `chat_state:${phone}`;
  }

  async function getChatState(phone) {
    const raw = await redis.get(key(phone));
    if (!raw) return {};

    try {
      return JSON.parse(raw);
    } catch (err) {
      logger.logToFile(
        `[warn] Failed to parse chat state for ${phone}: ${err.message}`
      );
      return {};
    }
  }

  async function updateChatState(phone, patch = {}) {
    const current = await getChatState(phone);
    const next = {
      ...(current || {}),
      ...(patch || {}),
      updatedAt: new Date().toISOString(),
    };

    await redis.set(key(phone), JSON.stringify(next), "EX", ttlSeconds);
    return next;
  }

  async function clearChatState(phone) {
    await redis.del(key(phone));
  }

  return {
    getChatState,
    updateChatState,
    clearChatState,
  };
}

module.exports = { createStateService };