// helpers/services/jobQueueService.js
const { Queue, Worker, QueueEvents } = require("bullmq");
const IORedis = require("ioredis");

function createJobQueueService(config, logger, handlers = {}) {
  const connection = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  const queueName = process.env.RECEIPT_QUEUE_NAME || "receipt-processing";
  const queue = new Queue(queueName, { connection });
  const events = new QueueEvents(queueName, { connection });

  const statusKey = (jobId) => `receipt_job:${jobId}`;

  async function setJobStatus(jobId, patch = {}) {
    const payload = {
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await connection.hset(statusKey(jobId), payload);
    await connection.expire(statusKey(jobId), 60 * 60 * 24 * 30);
  }

  async function getJobStatus(jobId) {
    return connection.hgetall(statusKey(jobId));
  }

  async function listFailedJobs(limit = 50) {
    const jobs = await queue.getFailed(0, Math.max(0, limit - 1));
    const results = [];
    for (const job of jobs) {
      const meta = await getJobStatus(job.id);
      results.push({
        jobId: job.id,
        failedReason: job.failedReason,
        attemptsMade: job.attemptsMade,
        data: job.data,
        meta,
      });
    }
    return results;
  }

  async function enqueueReceiptJob(data) {
    const job = await queue.add("process-receipt", data, {
      attempts: Number(process.env.RECEIPT_JOB_ATTEMPTS || 3),
      backoff: {
        type: "exponential",
        delay: Number(process.env.RECEIPT_JOB_BACKOFF_MS || 5000),
      },
      removeOnComplete: false,
      removeOnFail: false,
    });

    await setJobStatus(job.id, {
      jobId: String(job.id),
      status: "queued",
      phone: data.phone,
      profileId: String(data.profileId || ""),
      receiptFileCount: String((data.files || []).length),
      createdAt: new Date().toISOString(),
    });

    return job;
  }

  async function retryJob(jobId) {
    const job = await queue.getJob(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    await job.retry();
    await setJobStatus(jobId, { status: "retry_queued" });
    return { ok: true, jobId };
  }

  const worker = new Worker(
    queueName,
    async (job) => {
      const { processReceiptJob } = handlers;
      if (typeof processReceiptJob !== "function") {
        throw new Error("Missing processReceiptJob handler");
      }

      await setJobStatus(job.id, {
        status: "active",
        attemptsMade: String(job.attemptsMade || 0),
      });

      const result = await processReceiptJob(job.data, job);

      await setJobStatus(job.id, {
        status: "completed",
        receiptId: result?.receiptId ? String(result.receiptId) : "",
        fraudScore: result?.fraudScore != null ? String(result.fraudScore) : "",
        fraudDecision: result?.fraudDecision || "",
      });

      return result;
    },
    { connection }
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
    logger.logToFile(`[error] Receipt job failed: jobId=${job.id} err=${err.message}`);
    await setJobStatus(job.id, {
      status: "failed",
      error: err.message,
      attemptsMade: String(job.attemptsMade || 0),
    });
  });

  worker.on("completed", async (job) => {
    logger.logToFile(`[info] Receipt job completed: jobId=${job.id}`);
  });

  return {
    queue,
    worker,
    events,
    enqueueReceiptJob,
    getJobStatus,
    listFailedJobs,
    retryJob,
    setJobStatus,
  };
}

module.exports = { createJobQueueService };