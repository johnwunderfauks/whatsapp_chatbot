const Redis = require("ioredis");

let redis;

function getRedis() {
  if (redis) return redis;

  const redisUrl = (process.env.REDIS_URL || "").trim();

  if (!redisUrl) {
    throw new Error("Missing REDIS_URL");
  }

  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  redis.on("connect", () => {
    console.log("[redis] connected");
  });

  redis.on("error", (err) => {
    console.error("[redis] error:", err.message);
  });

  return redis;
}

module.exports = { getRedis };
