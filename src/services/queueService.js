const crypto = require("crypto");
const { Queue } = require("bullmq");
const { getRedis } = require("../../helpers/services/redisClient");

const RECEIPT_QUEUE_NAME = "receipt-processing";

let receiptQueue;

function getReceiptQueue() {
  if (receiptQueue) return receiptQueue;

  const connection = getRedis();

  receiptQueue = new Queue(RECEIPT_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 5000,
      },
      removeOnComplete: 100,
      removeOnFail: 200,
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

async function enqueueReceiptJob({ phone, profileId, files, sourceMessageSid }) {
  const queue = getReceiptQueue();
  const batchHash = hashBatch(files);

  const job = await queue.add(
    "process-receipt",
    {
      phone,
      profileId,
      files,
      sourceMessageSid,
      batchHash,
    },
    {
      jobId: `receipt:${phone}:${batchHash}`,
    }
  );

  return { jobId: job.id, batchHash };
}

module.exports = {
  RECEIPT_QUEUE_NAME,
  getReceiptQueue,
  enqueueReceiptJob,
  hashBatch,
};