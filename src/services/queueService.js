const crypto = require("crypto");
const { Queue } = require("bullmq");
const { getRedis } = require("../../helpers/services/redisClient");

const RECEIPT_QUEUE_NAME =
  process.env.RECEIPT_QUEUE_NAME || "receipt-processing";

const PROFILE_QUEUE_NAME =
  process.env.PROFILE_QUEUE_NAME || "profile-sync";

let profileQueue;
let receiptQueue;

function getReceiptQueue() {
  if (receiptQueue) return receiptQueue;

  const connection = getRedis();

  receiptQueue = new Queue(RECEIPT_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: Number(process.env.RECEIPT_JOB_MAX_ATTEMPTS || 3),
      backoff: {
        type: "exponential",
        delay: Number(process.env.RECEIPT_JOB_BACKOFF_MS || 5000),
      },
      removeOnComplete: Number(process.env.RECEIPT_QUEUE_REMOVE_ON_COMPLETE || 100),
      removeOnFail: Number(process.env.RECEIPT_QUEUE_REMOVE_ON_FAIL || 200),
    },
  });

  return receiptQueue;
}

function hashBatch(files = []) {
  const normalized = files
    .map((f) => `${f.type || ""}:${f.url || ""}`)
    .sort()
    .join("|");

  return crypto.createHash("sha256").update(normalized).digest("hex");
}

async function enqueueReceiptJob({
  phone,
  profileId,
  files,
  sourceMessageSid,
}) {
  const queue = getReceiptQueue();
  const batchHash = hashBatch(files);

  const job = await queue.add(
    "process-receipt",
    {
      phone,
      profileId,
      files,
      sourceMessageSid: sourceMessageSid || null,
      batchHash,
    },
    {
      jobId: `receipt:${phone}:${batchHash}`,
    }
  );

  return { jobId: job.id, batchHash };
}

async function getReceiptQueueJob(jobId) {
  const queue = getReceiptQueue();
  return queue.getJob(jobId);
}

async function retryReceiptQueueJob(jobId) {
  const job = await getReceiptQueueJob(jobId);

  if (!job) {
    const error = new Error(`Receipt job not found: ${jobId}`);
    error.statusCode = 404;
    throw error;
  }

  const state = await job.getState();
  if (!["failed", "completed", "waiting", "delayed"].includes(state)) {
    const error = new Error(
      `Receipt job ${jobId} is not retryable from state "${state}"`
    );
    error.statusCode = 409;
    throw error;
  }

  if (state === "failed") {
    await job.retry();
    return { jobId: job.id, stateBeforeRetry: state };
  }

  await queueRequeueJob(job);

  return { jobId: job.id, stateBeforeRetry: state };
}

async function queueRequeueJob(job) {
  const queue = getReceiptQueue();

  await queue.add(job.name, job.data, {
    jobId: job.id,
    attempts: Number(process.env.RECEIPT_JOB_MAX_ATTEMPTS || 3),
    backoff: {
      type: "exponential",
      delay: Number(process.env.RECEIPT_JOB_BACKOFF_MS || 5000),
    },
    removeOnComplete: Number(process.env.RECEIPT_QUEUE_REMOVE_ON_COMPLETE || 100),
    removeOnFail: Number(process.env.RECEIPT_QUEUE_REMOVE_ON_FAIL || 200),
  });
}

async function listQueueJobs(kind = "failed", limit = 50) {
  const queue = getReceiptQueue();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));

  if (kind === "failed") {
    return queue.getFailed(0, safeLimit - 1);
  }

  if (kind === "waiting") {
    return queue.getWaiting(0, safeLimit - 1);
  }

  if (kind === "delayed") {
    return queue.getDelayed(0, safeLimit - 1);
  }

  if (kind === "active") {
    return queue.getActive(0, safeLimit - 1);
  }

  return queue.getJobs([kind], 0, safeLimit - 1);
}

function getProfileQueue() {
  if (profileQueue) return profileQueue;

  const connection = getRedis();

  profileQueue = new Queue(PROFILE_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: Number(process.env.PROFILE_JOB_MAX_ATTEMPTS || 3),
      backoff: {
        type: "exponential",
        delay: Number(process.env.PROFILE_JOB_BACKOFF_MS || 3000),
      },
      removeOnComplete: Number(
        process.env.PROFILE_QUEUE_REMOVE_ON_COMPLETE || 100
      ),
      removeOnFail: Number(
        process.env.PROFILE_QUEUE_REMOVE_ON_FAIL || 200
      ),
    },
  });

  return profileQueue;
}

module.exports = {
  RECEIPT_QUEUE_NAME,
  getReceiptQueue,
  enqueueReceiptJob,
  getReceiptQueueJob,
  retryReceiptQueueJob,
  listQueueJobs,
  hashBatch,
  getProfileQueue 
};