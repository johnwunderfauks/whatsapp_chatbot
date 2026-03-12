const Redis = require("ioredis");

let redis;

function getRedis() {
  const rawRedisUrl = process.env.REDIS_URL;

console.log("[debug] REDIS_URL type:", typeof rawRedisUrl);
console.log("[debug] REDIS_URL json:", JSON.stringify(rawRedisUrl));
console.log(
  "[debug] REDIS_URL trimmed length:",
  (rawRedisUrl || "").trim().length
);

const redisUrl = (rawRedisUrl || "").trim();

if (!redisUrl) {
  throw new Error("Missing REDIS_URL");
}

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