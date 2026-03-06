const { createConfig } = require("./config");
const { createLogger } = require("./logger");
const { createStateService } = require("./services/stateService");
const { createMediaService } = require("./services/mediaService");
const { createWpService } = require("./services/wpService");
const { createFraudPipeline } = require("./services/fraudPipeline");
const { createIdempotencyService } = require("./services/idempotencyService");
const { createJobQueueService } = require("./services/jobQueueService");

const config = createConfig();
const logger = createLogger(config);

const stateService = createStateService(config, logger);
const mediaService = createMediaService(config, logger);
const wpService = createWpService(config, logger);
const fraudPipeline = createFraudPipeline(config, logger, { wpService });
const idempotencyService = createIdempotencyService(config, logger);
const jobQueueService = createJobQueueService(config, logger, {});

module.exports = {
  getJwtToken: wpService.getJwtToken,
  logToFile: logger.logToFile,

  getChatState: stateService.getChatState,
  updateChatState: stateService.updateChatState,
  clearChatState: stateService.clearChatState,

  checkOrCreateUserProfile: wpService.checkOrCreateUserProfile,
  uploadReceiptImages: fraudPipeline.uploadReceiptImages,

  getPurchaseHistory: wpService.getPurchaseHistory,
  getLoyaltyPoints: wpService.getLoyaltyPoints,
  getAvailableRewards: wpService.getAvailableRewards,

  fetchImageFromTwilio: mediaService.fetchImageFromTwilio,

  getPromotions: wpService.getPromotions,
  getDefaultMessage: wpService.getDefaultMessage,

  claimWebhookOnce: idempotencyService.claimWebhookOnce,
  claimReceiptBatchOnce: idempotencyService.claimReceiptBatchOnce,
  jobQueueService,
};