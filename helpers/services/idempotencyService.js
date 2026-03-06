const crypto = require("crypto");
const { getRedis } = require("./redisClient");

function createIdempotencyService(config, logger) {
  const redis = getRedis();
  const ttlSeconds = Number(process.env.IDEMPOTENCY_TTL_SECONDS || 86400);

  function hash(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
  }

  function webhookKey({ messageSid, from, body, mediaUrls }) {
    if (messageSid) return `idem:webhook:${messageSid}`;

    return `idem:webhook:fallback:${hash(
      JSON.stringify({ from, body, mediaUrls })
    )}`;
  }

  async function claimWebhookOnce(payload) {
    const key = webhookKey(payload);
    const result = await redis.set(key, "1", "EX", ttlSeconds, "NX");
    const claimed = result === "OK";

    if (!claimed) {
      logger.logToFile(`[idempotency] Duplicate webhook skipped: ${key}`);
    }

    return { claimed, key };
  }

  function receiptBatchKey(phone, batchHash) {
    return `idem:receipt_batch:${phone}:${batchHash}`;
  }

  async function claimReceiptBatchOnce(phone, batchHash) {
    const key = receiptBatchKey(phone, batchHash);
    const result = await redis.set(key, "1", "EX", ttlSeconds, "NX");
    const claimed = result === "OK";

    if (!claimed) {
      logger.logToFile(`[idempotency] Duplicate receipt batch skipped: ${key}`);
    }

    return { claimed, key };
  }

  return {
    claimWebhookOnce,
    claimReceiptBatchOnce,
  };
}

module.exports = { createIdempotencyService };