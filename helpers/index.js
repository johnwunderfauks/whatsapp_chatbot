// helpers/index.js
const { createConfig } = require("./config");
const { createLogger } = require("./logger");
const { createStateService } = require("./services/stateService");
const { createMediaService } = require("./services/mediaService");
const { createWpService } = require("./services/wpService");
const { createFraudPipeline } = require("./services/fraudPipeline");

const config = createConfig();
const logger = createLogger(config);

const stateService = createStateService(config, logger);
const mediaService = createMediaService(config, logger);
const wpService = createWpService(config, logger);
const fraudPipeline = createFraudPipeline(config, logger, { wpService });

module.exports = {
  // same exports as old helpers.js
  getJwtToken: wpService.getJwtToken,
  logToFile: logger.logToFile,

  getChatState: stateService.getChatState,
  updateChatState: stateService.updateChatState,

  checkOrCreateUserProfile: wpService.checkOrCreateUserProfile,
  uploadReceiptImages: fraudPipeline.uploadReceiptImages,

  getPurchaseHistory: wpService.getPurchaseHistory,
  getLoyaltyPoints: wpService.getLoyaltyPoints,
  getAvailableRewards: wpService.getAvailableRewards,

  fetchImageFromTwilio: mediaService.fetchImageFromTwilio,

  getPromotions: wpService.getPromotions,
  getDefaultMessage: wpService.getDefaultMessage,
};