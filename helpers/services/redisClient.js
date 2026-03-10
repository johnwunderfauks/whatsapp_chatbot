const Redis = require("ioredis");

let redis;

function getRedis() {
  console.log("[debug] REDIS_URL present:", Boolean(process.env.REDIS_URL));
console.log("[debug] REDIS_URL length:", process.env.REDIS_URL ? process.env.REDIS_URL.length : 0);
  if (redis) return redis;

  if (!process.env.REDIS_URL) {
    throw new Error("Missing REDIS_URL");
  }

  redis = new Redis(process.env.REDIS_URL, {
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