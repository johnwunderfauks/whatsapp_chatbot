const { Worker } = require("bullmq");
const { getRedis } = require("../../helpers/services/redisClient");
const helpers = require("../../helpers");
const { hashBatch, RECEIPT_QUEUE_NAME } = require("../services/queueService");

const {
  logToFile,
  uploadReceiptImages,
  fetchImageFromTwilio,
  claimReceiptBatchOnce,
} = helpers;

async function processReceiptFiles({ files, phone, profileId }) {
  logToFile(`[worker] Starting receipt job for ${phone}`);
  logToFile(`[worker] files=${JSON.stringify(files)}`);

  const imageBuffers = [];

  for (const file of files) {
    if (!file?.url || !file?.type) {
      logToFile(`[worker][warn] Invalid file entry skipped: ${JSON.stringify(file)}`);
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

  return result;
}

function createReceiptWorker() {
  const connection = getRedis();

  return new Worker(
    RECEIPT_QUEUE_NAME,
    async (job) => {
      const { phone, profileId, files, batchHash } = job.data;

      if (typeof claimReceiptBatchOnce === "function") {
        const claim = await claimReceiptBatchOnce(phone, batchHash);
        if (!claim.claimed) {
          return { skipped: true, reason: "duplicate_batch" };
        }
      }

      return processReceiptFiles({ files, phone, profileId });
    },
    {
      connection,
      concurrency: 2,
    }
  );
}

module.exports = { createReceiptWorker };