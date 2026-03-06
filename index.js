require("dotenv").config();

const fs = require("fs");

if (process.env.GOOGLE_CREDENTIALS_JSON) {
  const targetPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || "/tmp/gcp.json";
  fs.writeFileSync(targetPath, process.env.GOOGLE_CREDENTIALS_JSON, "utf8");
  console.log(`Google credentials written to ${targetPath}`);
}

const { createReceiptWorker } = require("./src/workers/receiptWorker");

const worker = createReceiptWorker();

worker.on("completed", (job) => {
  console.log(`[worker] Job completed: ${job.id}`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] Job failed: ${job?.id} - ${err.message}`);
});

console.log("[worker] receipt worker started");