// helpers/services/wpService.js
const axios = require("axios");
const FormData = require("form-data");
const { Readable } = require("stream");

function bufferToStream(buffer) {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

function createWpService(config, logger) {
  const token = Buffer.from(`${config.wp.user}:${config.wp.appPassword}`).toString("base64");

  const http = axios.create({
    baseURL: config.wp.url,
    timeout: config.httpTimeoutMs,
    headers: {
      "User-Agent": config.wp.userAgent,
      "Content-Type": "application/json",
      Authorization: `Basic ${token}`,
    },
  });

  function getJwtToken() {
    // for backward compatibility: this is Basic auth token
    return token;
  }

  async function checkOrCreateUserProfile({ phone, name }) {
    const res = await http.post(`/wp-json/custom/v1/store-whatsapp-user`, { phone, name });
    const profileId = res.data?.profileId || res.data?.post_id || res.data?.id;
    return { profileId, ...res.data };
  }

  async function getPurchaseHistory(profileId) {
    const res = await http.get(`/wp-json/custom/v1/receipts`, {
      params: { profile_id: profileId },
    });
    return res.data;
  }

  async function getLoyaltyPoints(profileId) {
    const res = await http.get(`/wp-json/custom/v1/user-profile`, {
      params: { profile_id: profileId },
    });
    return res.data;
  }

  async function getAvailableRewards(profileId) {
    const res = await http.get(`/wp-json/custom/v1/rewards`, {
      params: { profile_id: profileId },
    });
    return res.data;
  }

  async function getPromotions() {
    const res = await http.get(`/wp-json/custom/v1/promotions`);
    return res.data;
  }

  async function getCampaignsForMenu() {
    // used by getDefaultMessage
    const res = await http.get(`/wp-json/custom/v1/campaign/list`);
    const campaigns = res.data?.campaigns || res.data || [];
    return campaigns;
  }

  async function getDefaultMessage() {
    let campaignLine = "";
    try {
      const campaigns = await getCampaignsForMenu();
      const active = campaigns.filter((c) => c.status === "active" || c.campaign_status === "active");
      if (active.length > 0) {
        const names = active.map((c) => `• ${c.title || c.name}`).join("\n");
        campaignLine = `\n\n🎯 *Active Campaigns:*\n${names}`;
      } else {
        campaignLine = "\n\n📭 No campaigns are running at the moment.";
      }
    } catch (err) {
      logger.logToFile(`[warn] Could not fetch campaigns for default message: ${err.message}`);
    }

    return `Here are your options:

1️⃣ Upload a receipt (📸 Image files only – JPG, JPEG, PNG)
2️⃣ Check loyalty points & rewards
3️⃣ Contact/Support Instructions
4️⃣ View current promotions 🎉${campaignLine}

⚠️ Please upload clear images of your receipt.
PDF files are not supported.

Type *help* to view the menu again.`;
  }

  async function uploadPrimaryAndExtraImages({ imageBuffers, filenames, profileId }) {
    if (!profileId) throw new Error("Profile ID is not defined");
    if (!imageBuffers?.length) throw new Error("No images to upload");

    // Primary upload
    const primaryForm = new FormData();
    primaryForm.append("file", bufferToStream(imageBuffers[0]), {
      filename: filenames[0],
      contentType: "image/jpeg",
    });
    primaryForm.append("profile_id", profileId);
    primaryForm.append("total_images", imageBuffers.length);

    const uploadResponse = await http.post(`/wp-json/custom/v1/upload`, primaryForm, {
      headers: { ...primaryForm.getHeaders(), Authorization: `Basic ${token}` },
    });

    const receiptId = uploadResponse.data?.receipt_id;
    if (!receiptId) throw new Error("Upload succeeded but receipt_id missing");

    // Extra uploads
    if (imageBuffers.length > 1) {
      for (let i = 1; i < imageBuffers.length; i++) {
        const extraForm = new FormData();
        extraForm.append("file", bufferToStream(imageBuffers[i]), {
          filename: filenames[i],
          contentType: "image/jpeg",
        });
        extraForm.append("receipt_id", receiptId);
        extraForm.append("index", i);

        await http.post(`/wp-json/custom/v1/upload`, extraForm, {
          headers: { ...extraForm.getHeaders(), Authorization: `Basic ${token}` },
        });
      }
    }

    return { receiptId };
  }

  async function saveReceiptDetails({ receiptId, profileId, parsed, combinedOCR, fraudResult, imageFraudSummary, imageAnalyses }) {
    await http.post(
      `/wp-json/custom/v1/receipt/${receiptId}`,
      {
        profile_id: profileId,
        receipt_id: parsed.receipt_id || "Unknown Receipt ID",
        store_name: parsed.store_name || "Unknown Store",
        purchase_date: parsed.purchase_date || null,
        total_amount: parsed.total_amount || null,
        currency: parsed.currency || "SGD",
        items: parsed.items || [],
        raw_text: combinedOCR,

        fraud_score: fraudResult.score,
        fraud_decision: fraudResult.decision,
        fraud_reasons: fraudResult.reasons,
        image_fraud_summary: imageFraudSummary,
        per_image_analysis: imageAnalyses,
      },
      { headers: { Authorization: `Basic ${token}` } }
    );
  }

  async function checkDuplicateHash(receipt_id) {
    try {
      const res = await http.post(
        `/wp-json/custom/v1/check-duplicate-hash`,
        { receipt_id },
        { timeout: config.wp.duplicateCheckTimeoutMs }
      );
      return res.data?.is_duplicate || false;
    } catch (err) {
      logger.logToFile(`[warn] Duplicate check failed: ${err.message}`);
      return false;
    }
  }

  return {
    getJwtToken,
    checkOrCreateUserProfile,
    getPurchaseHistory,
    getLoyaltyPoints,
    getAvailableRewards,
    getPromotions,
    getDefaultMessage,
    uploadPrimaryAndExtraImages,
    saveReceiptDetails,
    checkDuplicateHash,
  };
}

module.exports = { createWpService };