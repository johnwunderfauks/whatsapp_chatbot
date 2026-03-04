// helpers/services/fraudPipeline.js
const crypto = require("crypto");
const vision = require("@google-cloud/vision");

const { analyzeImageMetadata, checkImageQuality } = require("../../fraud-detection/metadata-check");
const { matchMerchantTemplate } = require("../../fraud-detection/merchant-templates");
const { calculateFraudScore } = require("../../fraud-detection/scoring");
const { runCampaignEngine } = require("../../campaign-engine/campaign-engine");
const { parseAndValidateReceipt } = require("../../fraud-detection/parseAndValidateReceipt");

function createFraudPipeline(config, logger, { wpService }) {
  const visionClient = new vision.ImageAnnotatorClient();

  function createReceiptFraudSignals() {
    return { nonEnglish: false, nonSingapore: false, dateOutOfRange: false, redFlags: [] };
  }

  async function extractReceiptText(imageBuffer) {
    const [result] = await visionClient.textDetection(imageBuffer);
    return result.fullTextAnnotation?.text || "";
  }

  function getImageHash(imageBuffer) {
    return crypto.createHash("sha256").update(imageBuffer).digest("hex");
  }

  function isMostlyEnglish(text) {
    if (!text) return false;
    const lettersOnly = text.replace(/[^a-zA-Z\u0E00-\u0E7F\u4E00-\u9FFF]/g, "");
    if (!lettersOnly.length) return false;
    const englishLetters = lettersOnly.match(/[a-zA-Z]/g) || [];
    return englishLetters.length / lettersOnly.length >= 0.7;
  }

  function looksLikeSingapore(text) {
    return /singapore|\bsg\b|\+65|\b\d{6}\b/i.test(text);
  }

  function isWithinLastTwoWeeks(dateStr) {
    if (!dateStr) return false;
    const receiptDate = new Date(dateStr);
    if (isNaN(receiptDate)) return false;
    const diffDays = (Date.now() - receiptDate.getTime()) / (1000 * 60 * 60 * 24);
    return diffDays >= 0 && diffDays <= 14;
  }

  async function summarizeImageFraudSignals(imageAnalyses, parsed) {
    const summary = {
      anyAiDetected: false,
      anyTooPerfect: false,
      duplicateImages: false,
      duplicateInSystem: false,
      redFlags: [],
      imageCount: imageAnalyses.length,
    };

    const localHashes = new Set();

    for (const img of imageAnalyses) {
      if (img.metaSignals.aiSoftwareTag) {
        summary.anyAiDetected = true;
        summary.redFlags.push(
          `Image ${img.index + 1}: AI software detected (${img.metaSignals.softwareName || "unknown"})`
        );
      }

      if (img.qualityCheck.tooPerfect) {
        summary.anyTooPerfect = true;
        summary.redFlags.push(`Image ${img.index + 1}: Unusually clean / low noise`);
      }

      if (localHashes.has(img.imageHash)) {
        summary.duplicateImages = true;
        summary.redFlags.push(`Image ${img.index + 1}: Duplicate image in same upload`);
      }
      localHashes.add(img.imageHash);

      const existsInSystem = await wpService.checkDuplicateHash(parsed.receipt_id);
      if (existsInSystem) {
        summary.duplicateInSystem = true;
        summary.redFlags.push(`Image ${img.index + 1}: Previously used receipt image`);
      }

      if (img.metaSignals.redFlags?.length) {
        for (const flag of img.metaSignals.redFlags) {
          summary.redFlags.push(`Image ${img.index + 1}: ${flag}`);
        }
      }
    }

    summary.redFlags = [...new Set(summary.redFlags)];
    return summary;
  }

  async function uploadReceiptImages(imageBuffers, filenames, profileId) {
    if (!profileId) throw new Error("Profile ID is not defined");

    const receiptFraudSignals = createReceiptFraudSignals();
    logger.logToFile(`[fraud] Starting MULTI-IMAGE fraud detection pipeline...`);

    const imageAnalyses = [];
    const ocrResults = [];

    for (let i = 0; i < imageBuffers.length; i++) {
      const buffer = imageBuffers[i];
      const isPrimary = i === 0;

      logger.logToFile(`[fraud] Analyzing image ${i + 1}/${imageBuffers.length}`);

      const metaSignals = await analyzeImageMetadata(buffer);
      const qualityCheck = await checkImageQuality(buffer);
      const imageHash = getImageHash(buffer);
      const rawText = await extractReceiptText(buffer);

      imageAnalyses.push({ index: i, isPrimary, metaSignals, qualityCheck, imageHash });
      ocrResults.push({ index: i, text: rawText });

      logger.logToFile(
        `[fraud] Image ${i + 1}: flags=${metaSignals.redFlags.length}, tooPerfect=${qualityCheck.tooPerfect}`
      );
    }

    const combinedOCR = ocrResults.map((r) => r.text).join("\n\n---\n\n");
    logger.logToFile(`[info] Combined OCR length: ${combinedOCR.length}`);

    const templateCheck = matchMerchantTemplate(combinedOCR, "SG");
    logger.logToFile(`[fraud] Template matched=${templateCheck.matched}, score=${templateCheck.score}`);

    const merchantCandidates = templateCheck.template ? [templateCheck.template.displayName] : [];

    const { parsed, openAiAssessment } = await parseAndValidateReceipt(combinedOCR, "SG", merchantCandidates);
    logger.logToFile(`[fraud] OpenAI likelihood=${openAiAssessment.fraud_likelihood}`);

    if (!isMostlyEnglish(combinedOCR)) receiptFraudSignals.nonEnglish = true;

    const imageFraudSummary = await summarizeImageFraudSignals(imageAnalyses, parsed);

    if (parsed.currency !== "SGD" && !looksLikeSingapore(combinedOCR)) {
      receiptFraudSignals.nonSingapore = true;
    }
    if (!isWithinLastTwoWeeks(parsed.purchase_date)) {
      receiptFraudSignals.dateOutOfRange = true;
    }

    const fraudResult = await calculateFraudScore({
      imageFraudSummary,
      templateCheck,
      openAiAssessment,
      receiptFraudSignals,
      wpUrl: config.wp.url,
      wpAuth: wpService.getJwtToken(),
    });

    logger.logToFile(`[fraud] DECISION=${fraudResult.decision}, score=${fraudResult.score}`);

    // Upload images
    const { receiptId } = await wpService.uploadPrimaryAndExtraImages({
      imageBuffers,
      filenames,
      profileId,
    });

    logger.logToFile(`[info] Primary image uploaded. receipt_id=${receiptId}`);

    await wpService.saveReceiptDetails({
      receiptId,
      profileId,
      parsed,
      combinedOCR,
      fraudResult,
      imageFraudSummary,
      imageAnalyses,
    });

    // Campaign engine
    let campaignResult = null;
    try {
      campaignResult = await runCampaignEngine({
        profileId,
        receiptId,
        parsedReceipt: parsed,
      });

      logger.logToFile(
        `[campaign] Points awarded: ${campaignResult.totalPointsAwarded}, new balance: ${campaignResult.newBalance}`
      );
    } catch (campaignErr) {
      logger.logToFile(`[campaign] Engine error (non-fatal): ${campaignErr.message}`);
    }

    return {
      receipt_id: receiptId,
      parsed_data: parsed,
      fraud_result: fraudResult,
      openai_assessment: openAiAssessment,
      total_images: imageBuffers.length,
      campaign_result: campaignResult,
    };
  }

  return { uploadReceiptImages };
}

module.exports = { createFraudPipeline };