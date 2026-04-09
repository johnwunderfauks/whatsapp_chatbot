const { Worker } = require("bullmq");
const { getRedis } = require("../../helpers/services/redisClient");
const helpers = require("../../helpers");
const {
  hashBatch,
  RECEIPT_QUEUE_NAME,
} = require("../services/queueService");

const PROFILE_QUEUE_NAME = "profile-sync";

const {
  logToFile,
  uploadReceiptImages,
  fetchImageFromTwilio,
  claimReceiptBatchOnce,
  receiptJobService,
} = helpers;

async function processReceiptFiles({ files, phone, profileId }) {
  logToFile(`[worker] Starting receipt job for ${phone}`);
  logToFile(`[worker] files=${JSON.stringify(files)}`);

  const imageBuffers = [];

  for (const file of files) {
    if (!file?.url || !file?.type) {
      logToFile(
        `[worker][warn] Invalid file entry skipped: ${JSON.stringify(file)}`
      );
      continue;
    }

    logToFile(`[worker] Downloading media from Twilio: ${file.url}`);
    const buffer = await fetchImageFromTwilio(file.url);

    if (file.type === "image") {
      imageBuffers.push(buffer);
      continue;
    }

    logToFile(`[worker][warn] Unsupported file type skipped: ${file.type}`);
  }

  if (imageBuffers.length === 0) {
    throw new Error("No valid receipt images found after processing.");
  }

  const ts = Date.now();
  const filenames = imageBuffers.map(
    (_, i) => `receipt_${profileId}_${ts}_${i + 1}.jpg`
  );

  logToFile(
    `[worker] Uploading ${imageBuffers.length} image(s) to WordPress for profileId=${profileId}`
  );

  const result = await uploadReceiptImages(imageBuffers, filenames, profileId);

  logToFile(
    `[worker] Receipt processing complete for ${phone}. receipt_id=${result?.receipt_id || "n/a"}`
  );

  return {
    receiptId: result?.receipt_id || null,
    fraudScore: result?.fraud_result?.score ?? null,
    fraudDecision: result?.fraud_result?.decision || null,
    rawResult: result,
    fileCount: imageBuffers.length,
  };
}

function createReceiptWorker() {
  const connection = getRedis();

  const worker = new Worker(
    RECEIPT_QUEUE_NAME,
    async (job) => {
      const { phone, profileId, files, batchHash } = job.data;

      await receiptJobService.markProcessing(job.id, {
        attemptsMade: Number(job.attemptsMade || 0) + 1,
        queueName: RECEIPT_QUEUE_NAME,
        batchHash,
      });

      if (typeof claimReceiptBatchOnce === "function") {
        const claim = await claimReceiptBatchOnce(phone, batchHash);

        if (!claim.claimed) {
          const duplicatePayload = {
            skipped: true,
            reason: "duplicate_batch",
            receiptId: null,
            fraudScore: null,
            fraudDecision: "duplicate_batch",
          };

          await receiptJobService.markCompleted(job.id, {
            workerResult: duplicatePayload,
            fraudDecision: "duplicate_batch",
          });

          return duplicatePayload;
        }
      }

      const result = await processReceiptFiles({ files, phone, profileId });

      await receiptJobService.markCompleted(job.id, {
        receiptId: result.receiptId,
        fraudScore: result.fraudScore,
        fraudDecision: result.fraudDecision,
        workerResult: result.rawResult,
        fileCount: result.fileCount,
      });

      return result;
    },
    {
      connection,
      concurrency: Number(process.env.RECEIPT_WORKER_CONCURRENCY || 5),
    }
  );

  worker.on("failed", async (job, err) => {
    if (!job) {
      logToFile(`[worker][error] Failed event without job: ${err.message}`);
      return;
    }

    logToFile(`[worker][error] Job failed: ${job.id} - ${err.message}`);

    await receiptJobService.markFailed(job.id, err, {
      attemptsMade: Number(job.attemptsMade || 0),
      attemptsAllowed: Number(
        job.opts?.attempts || process.env.RECEIPT_JOB_MAX_ATTEMPTS || 3
      ),
      batchHash: job.data?.batchHash || hashBatch(job.data?.files || []),
      queueName: RECEIPT_QUEUE_NAME,
    });
  });

  worker.on("completed", (job) => {
    logToFile(`[worker] Job completed: ${job?.id || "unknown"}`);
  });

  return worker;
}

function createProfileWorker() {
  const connection = getRedis();

  const worker = new Worker(
    PROFILE_QUEUE_NAME,
    async (job) => {
      const { phone, name } = job.data;
      const cacheKey = `profile_cache:${phone}`;

      logToFile(`[profile-worker] Processing ${phone}`);

      try {
        const res = await axios.post(
          process.env.WP_URL + "/wp-json/custom/v1/store-whatsapp-user",
          { phone, name },
          {
            headers: { "Content-Type": "application/json" },
            timeout: 10000,
          }
        );

        const profileId =
          res.data?.profileId || res.data?.post_id || res.data?.id;

        const profile = { profileId, ...res.data };

        
        await connection.set(
          cacheKey,
          JSON.stringify(profile),
          "EX",
          Number(process.env.PROFILE_CACHE_TTL_SECONDS || 86400)
        );

        logToFile(`[profile-worker] Synced ${phone} → profileId=${profileId}`);

        return profile;
      } catch (err) {
        logToFile(
          `[profile-worker][error] Failed ${phone}: ${err.message}`
        );
        throw err;
      }
    },
    {
      connection,
      concurrency: Number(process.env.PROFILE_WORKER_CONCURRENCY || 5), 
    }
  );

  worker.on("failed", (job, err) => {
    logToFile(
      `[profile-worker][error] Job failed: ${job?.id} - ${err.message}`
    );
  });

  worker.on("completed", (job) => {
    logToFile(
      `[profile-worker] Job completed: ${job?.id || "unknown"}`
    );
  });

  return worker;
}

module.exports = { createReceiptWorker, createProfileWorker };