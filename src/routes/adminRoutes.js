const express = require("express");

function createAdminRoutes({ botService }) {
  const router = express.Router();

  router.get("/receipt-jobs", botService.handleListReceiptJobs);
  router.get("/receipt-jobs/failed", botService.handleListFailedReceiptJobs);
  router.get(
    "/receipt-jobs/dead-letter",
    botService.handleListDeadLetterReceiptJobs
  );
  router.get("/receipt-jobs/:jobId", botService.handleGetReceiptJob);
  router.post("/receipt-jobs/:jobId/retry", botService.handleRetryReceiptJob);

  return router;
}

module.exports = { createAdminRoutes };