const Redis = require("ioredis");

let redis;

function getRedis() {
  console.log("[debug] env has REDIS_URL key:", "REDIS_URL" in process.env);
console.log("[debug] available env keys sample:", Object.keys(process.env).filter(k => k.includes("REDIS") || k.includes("RAILWAY")));
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