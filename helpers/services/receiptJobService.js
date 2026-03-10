const { getRedis } = require("./redisClient");

const JOB_STATUS = Object.freeze({
  QUEUED: "queued",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
  DEAD_LETTER: "dead_letter",
  RETRY_QUEUED: "retry_queued",
});

function createReceiptJobService(config, logger, deps = {}) {
  const redis = getRedis();
  const wpService = deps.wpService || null;

  const namespace = process.env.RECEIPT_JOB_NAMESPACE || "receipt_job";
  const historyLimit = Number(process.env.RECEIPT_JOB_HISTORY_LIMIT || 500);
  const recordTtlSeconds = Number(
    process.env.RECEIPT_JOB_TTL_SECONDS || 60 * 60 * 24 * 30
  );
  const syncToWordPress =
    String(process.env.RECEIPT_JOB_SYNC_TO_WP || "true").toLowerCase() !== "false";

  function nowIso() {
    return new Date().toISOString();
  }

  function key(jobId) {
    return `${namespace}:${jobId}`;
  }

  function indexKey(name) {
    return `${namespace}:index:${name}`;
  }

  function phoneIndexKey(phone) {
    return `${namespace}:phone:${phone}`;
  }

  function normalizeError(error) {
    if (!error) return null;
    if (typeof error === "string") return { message: error };
    return {
      message: error.message || "Unknown error",
      stack: error.stack || null,
      name: error.name || "Error",
    };
  }

  async function safeSyncToWordPress(job) {
    if (!syncToWordPress || !wpService?.upsertReceiptJobStatus) {
      return;
    }

    try {
      await wpService.upsertReceiptJobStatus(job);
    } catch (error) {
      logger.logToFile(
        `[warn] Failed syncing receipt job ${job.jobId} to WordPress: ${error.message}`
      );
    }
  }

  async function persist(job) {
    const serialized = JSON.stringify(job);

    await redis.set(key(job.jobId), serialized, "EX", recordTtlSeconds);
    await redis.zadd(indexKey("all"), Date.now(), job.jobId);
    await redis.lpush(phoneIndexKey(job.phone || "unknown"), job.jobId);
    await redis.ltrim(phoneIndexKey(job.phone || "unknown"), 0, 49);
    await redis.expire(phoneIndexKey(job.phone || "unknown"), recordTtlSeconds);

    if (job.status === JOB_STATUS.FAILED) {
      await redis.zadd(indexKey("failed"), Date.now(), job.jobId);
      await redis.zrem(indexKey("dead_letter"), job.jobId);
    } else if (job.status === JOB_STATUS.DEAD_LETTER) {
      await redis.zadd(indexKey("dead_letter"), Date.now(), job.jobId);
      await redis.zadd(indexKey("failed"), Date.now(), job.jobId);
    } else {
      await redis.zrem(indexKey("failed"), job.jobId);
      await redis.zrem(indexKey("dead_letter"), job.jobId);
    }

    await redis.zremrangebyrank(indexKey("all"), 0, -(historyLimit + 1));
    await redis.zremrangebyrank(indexKey("failed"), 0, -(historyLimit + 1));
    await redis.zremrangebyrank(indexKey("dead_letter"), 0, -(historyLimit + 1));

    await safeSyncToWordPress(job);

    return job;
  }

  async function getJob(jobId) {
    const raw = await redis.get(key(jobId));
    if (!raw) return null;

    try {
      return JSON.parse(raw);
    } catch (error) {
      logger.logToFile(
        `[error] Failed parsing receipt job ${jobId}: ${error.message}`
      );
      return null;
    }
  }

  async function createQueuedJob({
    jobId,
    phone,
    profileId,
    files = [],
    batchHash = null,
    sourceMessageSid = null,
    attemptsAllowed = null,
  }) {
    const timestamp = nowIso();

    const job = {
      jobId,
      jobType: "receipt",
      phone,
      profileId: profileId || null,
      batchHash,
      sourceMessageSid,
      status: JOB_STATUS.QUEUED,
      fileCount: Array.isArray(files) ? files.length : 0,
      files: Array.isArray(files) ? files : [],
      attemptsMade: 0,
      attemptsAllowed:
        attemptsAllowed != null
          ? Number(attemptsAllowed)
          : Number(process.env.RECEIPT_JOB_MAX_ATTEMPTS || 3),
      createdAt: timestamp,
      updatedAt: timestamp,
      queuedAt: timestamp,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      deadLetterAt: null,
      receiptId: null,
      fraudScore: null,
      fraudDecision: null,
      lastError: null,
      workerResult: null,
    };

    return persist(job);
  }

  async function markProcessing(jobId, patch = {}) {
    const current = await getJob(jobId);
    if (!current) return null;

    const next = {
      ...current,
      ...patch,
      status: JOB_STATUS.PROCESSING,
      startedAt: current.startedAt || nowIso(),
      updatedAt: nowIso(),
      failedAt: null,
      deadLetterAt: null,
      lastError: null,
    };

    return persist(next);
  }

  async function markCompleted(jobId, patch = {}) {
    const current = await getJob(jobId);
    if (!current) return null;

    const next = {
      ...current,
      ...patch,
      status: JOB_STATUS.COMPLETED,
      completedAt: nowIso(),
      updatedAt: nowIso(),
      lastError: null,
    };

    return persist(next);
  }

  async function markRetryQueued(jobId, patch = {}) {
    const current = await getJob(jobId);
    if (!current) return null;

    const next = {
      ...current,
      ...patch,
      status: JOB_STATUS.RETRY_QUEUED,
      updatedAt: nowIso(),
    };

    return persist(next);
  }

  async function markFailed(jobId, error, patch = {}) {
    const current = await getJob(jobId);
    if (!current) return null;

    const err = normalizeError(error);
    const attemptsMade =
      patch.attemptsMade != null
        ? Number(patch.attemptsMade)
        : Number(current.attemptsMade || 0);

    const attemptsAllowed = Number(
      patch.attemptsAllowed != null
        ? patch.attemptsAllowed
        : current.attemptsAllowed || process.env.RECEIPT_JOB_MAX_ATTEMPTS || 3
    );

    const isDeadLetter = attemptsMade >= attemptsAllowed;

    const next = {
      ...current,
      ...patch,
      attemptsMade,
      attemptsAllowed,
      status: isDeadLetter ? JOB_STATUS.DEAD_LETTER : JOB_STATUS.FAILED,
      failedAt: nowIso(),
      deadLetterAt: isDeadLetter ? nowIso() : null,
      updatedAt: nowIso(),
      lastError: err,
    };

    return persist(next);
  }

  async function listJobsByIndex(name, limit = 50) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    const ids = await redis.zrevrange(indexKey(name), 0, safeLimit - 1);

    if (!ids.length) {
      return [];
    }

    const rawJobs = await Promise.all(ids.map((id) => getJob(id)));
    return rawJobs.filter(Boolean);
  }

  async function listRecentJobs(limit = 50) {
    return listJobsByIndex("all", limit);
  }

  async function listFailedJobs(limit = 50) {
    return listJobsByIndex("failed", limit);
  }

  async function listDeadLetterJobs(limit = 50) {
    return listJobsByIndex("dead_letter", limit);
  }

  async function listJobsForPhone(phone, limit = 20) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
    const ids = await redis.lrange(phoneIndexKey(phone), 0, safeLimit - 1);

    if (!ids.length) {
      return [];
    }

    const rawJobs = await Promise.all(ids.map((id) => getJob(id)));
    return rawJobs.filter(Boolean);
  }

  return {
    JOB_STATUS,
    createQueuedJob,
    getJob,
    markProcessing,
    markCompleted,
    markFailed,
    markRetryQueued,
    listRecentJobs,
    listFailedJobs,
    listDeadLetterJobs,
    listJobsForPhone,
  };
}

module.exports = {
  createReceiptJobService,
  JOB_STATUS,
};