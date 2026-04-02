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

  // ── Atomic receipt file accumulation ────────────────────────────────────────
  //
  // Using a dedicated Redis list per user instead of storing receiptFiles inside
  // the chat-state JSON blob.  RPUSH is atomic — concurrent webhook requests
  // for the same user can safely append files without a read-modify-write race.
  //
  // TTL of 5 minutes: if the debounce timer never fires (e.g. the process dies),
  // orphaned entries are cleaned up automatically.

  function receiptQueueKey(phone) {
    return `receipt_queue:${phone}`;
  }

  /**
   * Atomically append one or more files to the per-user receipt queue.
   * Returns the new length of the list (0 if newFiles is empty).
   * A return value equal to newFiles.length means the list was empty beforehand
   * (i.e. this is the first batch received in the current debounce window).
   */
  async function appendReceiptFiles(phone, newFiles) {
    if (!Array.isArray(newFiles) || newFiles.length === 0) return 0;

    const qKey = receiptQueueKey(phone);
    const pipe  = redis.pipeline();

    for (const file of newFiles) {
      pipe.rpush(qKey, JSON.stringify(file));
    }
    // Reset TTL on every append so the window stays open while images arrive.
    pipe.expire(qKey, 300);

    const results = await pipe.exec();
    // pipeline results: [[err, val], ...]. The last RPUSH result is at index
    // newFiles.length - 1; EXPIRE is after that.
    const rpushResult = results[newFiles.length - 1];
    return rpushResult[1] ?? 0; // rpushResult = [err, newLength]
  }

  /**
   * Atomically read and delete all files accumulated for this user.
   * Uses a pipeline so no other caller can observe a partial drain.
   * Returns an empty array if the queue no longer exists.
   */
  async function drainReceiptFiles(phone) {
    const qKey = receiptQueueKey(phone);
    const pipe  = redis.pipeline();
    pipe.lrange(qKey, 0, -1);
    pipe.del(qKey);

    const [[, rawFiles]] = await pipe.exec();
    if (!Array.isArray(rawFiles) || rawFiles.length === 0) return [];

    return rawFiles
      .map((raw) => {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  return {
    getChatState,
    updateChatState,
    clearChatState,
    appendReceiptFiles,
    drainReceiptFiles,
  };
}

module.exports = { createStateService };