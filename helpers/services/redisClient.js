const Redis = require("ioredis");

let redis;

/**
 * Returns the shared ioredis singleton.
 *
 * Configuration notes:
 *  - maxRetriesPerRequest: null  — required by BullMQ; lets each command retry
 *    indefinitely while the connection is being re-established.
 *  - enableReadyCheck: false     — required by BullMQ; don't wait for LOADING.
 *  - retryStrategy              — exponential back-off with jitter; gives up
 *    after 10 consecutive failures so the process can restart via Railway.
 *  - reconnectOnError           — reconnect on READONLY (Redis Sentinel/Cluster
 *    failover where a replica becomes primary).
 *  - connectTimeout             — fail fast on initial connect rather than
 *    hanging indefinitely during a bad deploy.
 */
function getRedis() {
  if (redis) return redis;

  const redisUrl = (process.env.REDIS_URL || "").trim();

  if (!redisUrl) {
    throw new Error("Missing REDIS_URL");
  }

  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,

    connectTimeout: 10_000,

    retryStrategy(times) {
      if (times > 10) {
        console.error(
          `[redis] ${times} consecutive connection failures — giving up. ` +
          `Process will exit and Railway will restart it.`
        );
        return null; // stop retrying; ioredis emits 'end' event
      }
      // Exponential back-off: 100 ms → 200 ms → 400 ms … capped at 3 s, plus jitter.
      const base  = Math.min(100 * Math.pow(2, times - 1), 3_000);
      const jitter = Math.floor(Math.random() * 200);
      console.warn(`[redis] reconnect attempt ${times} in ${base + jitter} ms`);
      return base + jitter;
    },

    reconnectOnError(err) {
      // Reconnect when a replica is promoted to primary (READONLY error).
      return err.message.includes("READONLY");
    },
  });

  redis.on("connect", () => {
    console.log("[redis] connected");
  });

  redis.on("ready", () => {
    console.log("[redis] ready");
  });

  redis.on("error", (err) => {
    console.error("[redis] error:", err.message);
  });

  redis.on("close", () => {
    console.warn("[redis] connection closed");
  });

  redis.on("reconnecting", (delay) => {
    console.warn(`[redis] reconnecting in ${delay} ms`);
  });

  redis.on("end", () => {
    console.error("[redis] connection ended — all retries exhausted");
    // Allow the process to exit naturally so the PaaS can restart it.
    process.exit(1);
  });

  return redis;
}

module.exports = { getRedis };
