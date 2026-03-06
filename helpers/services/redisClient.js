const Redis = require("ioredis");

let redis;

function getRedis() {
  if (redis) return redis;

  if (!process.env.REDIS_URL) {
    throw new Error("Missing REDIS_URL");
  }

  redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
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