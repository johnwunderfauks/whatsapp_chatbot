const { createConfig } = require("./config");
const { createLogger } = require("./logger");
const { createStateService } = require("./services/stateService");
const { createMediaService } = require("./services/mediaService");
const { createWpService } = require("./services/wpService");
const { createFraudPipeline } = require("./services/fraudPipeLine");
const { createIdempotencyService } = require("./services/idempotencyService");
const { createReceiptJobService } = require("./services/receiptJobService");

const config = createConfig();
const logger = createLogger(config);
const stateService = createStateService(config, logger);
const mediaService = createMediaService(config, logger);
const wpService = createWpService(config, logger);
const fraudPipeline = createFraudPipeline(config, logger, { wpService });
const idempotencyService = createIdempotencyService(config, logger);
const receiptJobService = createReceiptJobService(config, logger, { wpService });

module.exports = {
  getJwtToken: wpService.getJwtToken,
  logToFile: logger.logToFile,
  getChatState: stateService.getChatState,
  updateChatState: stateService.updateChatState,
  clearChatState: stateService.clearChatState,
  appendReceiptFiles: stateService.appendReceiptFiles,
  drainReceiptFiles: stateService.drainReceiptFiles,
  checkOrCreateUserProfile: wpService.checkOrCreateUserProfile,
  uploadReceiptImages: fraudPipeline.uploadReceiptImages,
  getPurchaseHistory: wpService.getPurchaseHistory,
  getLoyaltyPoints: wpService.getLoyaltyPoints,
  fetchImageFromTwilio: mediaService.fetchImageFromTwilio,
  getPromotions: wpService.getPromotions,
  getDefaultMessage: wpService.getDefaultMessage,
  claimWebhookOnce: idempotencyService.claimWebhookOnce,
  claimReceiptBatchOnce: idempotencyService.claimReceiptBatchOnce,
  receiptJobService,
  wpService,
};