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
  const baseURL = config.wp.url.replace(/\/$/, "");
  const token = Buffer.from(`${config.wp.user}:${config.wp.appPassword}`).toString("base64");

  const endpoints = {
    storeUser: process.env.WP_STORE_USER_ENDPOINT || "/wp-json/custom/v1/store-whatsapp-user",
    receipts: process.env.WP_RECEIPTS_ENDPOINT || "/wp-json/custom/v1/receipts",
    userProfile: process.env.WP_USER_PROFILE_ENDPOINT || "/wp-json/custom/v1/user-profile",
    upload: process.env.WP_UPLOAD_ENDPOINT || "/wp-json/custom/v1/upload",
    promotions: process.env.WP_PROMOTIONS_ENDPOINT || "/wp-json/custom/v1/promotions",
    campaigns: process.env.WP_CAMPAIGNS_ENDPOINT || "/wp-json/custom/v1/campaign/list",
    duplicateHash: process.env.WP_DUPLICATE_HASH_ENDPOINT || "/wp-json/custom/v1/check-duplicate-hash",
  };

  const http = axios.create({
    baseURL,
    timeout: config.httpTimeoutMs,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    headers: {
      "User-Agent": config.wp.userAgent,
      Authorization: `Basic ${token}`,
    },
  });

  function getJwtToken() {
    return token;
  }

  function logAxiosError(prefix, err) {
    logger.logToFile(`[error] ${prefix}: ${err.message}`);
    logger.logToFile(`[error] ${prefix} status: ${err.response?.status || "n/a"}`);
    logger.logToFile(
      `[error] ${prefix} data: ${JSON.stringify(err.response?.data || {})}`
    );
  }

  async function checkOrCreateUserProfile({ phone, name }) {
    try {
      const res = await http.post(
        endpoints.storeUser,
        { phone, name },
        { headers: { "Content-Type": "application/json" } }
      );
      const profileId = res.data?.profileId || res.data?.post_id || res.data?.id;
      return { profileId, ...res.data };
    } catch (err) {
      logAxiosError("checkOrCreateUserProfile failed", err);
      throw err;
    }
  }

  async function getPurchaseHistory(profileId) {
    const res = await http.get(endpoints.receipts, {
      params: { profile_id: profileId },
    });
    return res.data;
  }

  async function getLoyaltyPoints(profileId) {
    const res = await http.get(endpoints.userProfile, {
      params: { profile_id: profileId },
    });
    return res.data;
  }

  async function getAvailableRewards(profileId) {
    const res = await http.get("/wp-json/custom/v1/rewards", {
      params: { profile_id: profileId },
    });
    return res.data;
  }

  async function getPromotions() {
    const res = await http.get(endpoints.promotions);
    return res.data;
  }

  async function getCampaignsForMenu() {
    const res = await http.get(endpoints.campaigns);
    return res.data?.campaigns || res.data || [];
  }

  async function getDefaultMessage() {
    let campaignLine = "";
    try {
      const campaigns = await getCampaignsForMenu();
      const active = campaigns.filter(
        (c) => c.status === "active" || c.campaign_status === "active"
      );

      campaignLine =
        active.length > 0
          ? `\n\n🎯 *Active Campaigns:*\n${active.map((c) => `• ${c.title || c.name}`).join("\n")}`
          : "\n\n📭 No campaigns are running at the moment.";
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
    if (!Array.isArray(filenames) || filenames.length !== imageBuffers.length) {
      throw new Error("filenames must be an array with one entry per image buffer");
    }

    try {
      const primaryForm = new FormData();
      primaryForm.append("file", bufferToStream(imageBuffers[0]), {
        filename: filenames[0],
        contentType: "image/jpeg",
      });
      primaryForm.append("profile_id", profileId);
      primaryForm.append("total_images", imageBuffers.length);

      logger.logToFile(
        `[debug] Uploading primary image to WP: profileId=${profileId}, filename=${filenames[0]}, total_images=${imageBuffers.length}`
      );

      const uploadResponse = await http.post(endpoints.upload, primaryForm, {
        headers: {
          ...primaryForm.getHeaders(),
          Authorization: `Basic ${token}`,
        },
      });

      logger.logToFile(
        `[debug] Primary upload response: ${JSON.stringify(uploadResponse.data)}`
      );

      const receiptId = uploadResponse.data?.receipt_id;
      if (!receiptId) throw new Error("Upload succeeded but receipt_id missing");

      if (imageBuffers.length > 1) {
        for (let i = 1; i < imageBuffers.length; i++) {
          const extraForm = new FormData();
          extraForm.append("file", bufferToStream(imageBuffers[i]), {
            filename: filenames[i],
            contentType: "image/jpeg",
          });
          extraForm.append("receipt_id", receiptId);
          extraForm.append("index", i);

          logger.logToFile(
            `[debug] Uploading extra image ${i + 1}/${imageBuffers.length}: filename=${filenames[i]}, receiptId=${receiptId}`
          );

          await http.post(endpoints.upload, extraForm, {
            headers: {
              ...extraForm.getHeaders(),
              Authorization: `Basic ${token}`,
            },
          });
        }
      }

      return { receiptId };
    } catch (err) {
      logAxiosError("uploadPrimaryAndExtraImages failed", err);
      throw err;
    }
  }

  async function saveReceiptDetails({
    receiptId,
    profileId,
    parsed,
    combinedOCR,
    fraudResult,
    imageFraudSummary,
    imageAnalyses,
  }) {
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
      { headers: { "Content-Type": "application/json" } }
    );
  }

  async function checkDuplicateHash(receipt_id) {
    try {
      const res = await http.post(
        endpoints.duplicateHash,
        { receipt_id },
        {
          timeout: config.wp.duplicateCheckTimeoutMs,
          headers: { "Content-Type": "application/json" },
        }
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