const axios     = require("axios");
const FormData  = require("form-data");
const { Readable } = require("stream");
const nodeHttp  = require("http");
const nodeHttps = require("https");
const { getRedis } = require("./redisClient");

function bufferToStream(buffer) {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

function createWpService(config, logger) {
  const baseURL = config.wp.url.replace(/\/$/, "");
  const token = Buffer.from(
    `${config.wp.user}:${config.wp.appPassword}`
  ).toString("base64");

  const endpoints = {
    storeUser:
      process.env.WP_STORE_USER_ENDPOINT ||
      "/wp-json/custom/v1/store-whatsapp-user",
    receipts:
      process.env.WP_RECEIPTS_ENDPOINT || "/wp-json/custom/v1/receipts",
    userProfile:
      process.env.WP_USER_PROFILE_ENDPOINT || "/wp-json/custom/v1/user-profile",
    upload:
      process.env.WP_UPLOAD_ENDPOINT || "/wp-json/custom/v1/upload",
    promotions:
      process.env.WP_PROMOTIONS_ENDPOINT || "/wp-json/custom/v1/promotions",
    campaigns:
      process.env.WP_CAMPAIGNS_ENDPOINT || "/wp-json/custom/v1/campaign/list",
    duplicateHash:
      process.env.WP_DUPLICATE_HASH_ENDPOINT ||
      "/wp-json/custom/v1/check-duplicate-hash",
    receiptJobStatus:
      process.env.WP_RECEIPT_JOB_STATUS_ENDPOINT ||
      "/wp-json/custom/v1/receipt-job/status",
    receiptJobs:
      process.env.WP_RECEIPT_JOBS_ENDPOINT ||
      "/wp-json/custom/v1/receipt-jobs",
    receiptJobRetry:
      process.env.WP_RECEIPT_JOB_RETRY_ENDPOINT ||
      "/wp-json/custom/v1/receipt-job/retry",
  };

  // Persistent keep-alive agents so TCP connections to WordPress are reused
  // across requests. Without this every WP API call opens a new connection —
  // at 2500 simultaneous users that saturates OS file-descriptor limits.
  // maxSockets caps concurrency to WP; requests beyond that queue in Node.js
  // (far cheaper than spawning thousands of TCP connections).
  const wpHttpAgent  = new nodeHttp.Agent({
    keepAlive:  true,
    maxSockets: Number(process.env.WP_MAX_SOCKETS || 25),
  });
  const wpHttpsAgent = new nodeHttps.Agent({
    keepAlive:  true,
    maxSockets: Number(process.env.WP_MAX_SOCKETS || 25),
  });

  const http = axios.create({
    baseURL,
    timeout: config.httpTimeoutMs,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    httpAgent:  wpHttpAgent,
    httpsAgent: wpHttpsAgent,
    headers: {
      "User-Agent": config.wp.userAgent,
      Authorization: `Basic ${token}`,
    },
  });

  const redis = getRedis();
  const PROFILE_CACHE_TTL = Number(process.env.PROFILE_CACHE_TTL_SECONDS || 3600);

  function getJwtToken() {
    return token;
  }

  function logAxiosError(prefix, err) {
    logger.logToFile(`[error] ${prefix}: ${err.message}`);
    logger.logToFile(
      `[error] ${prefix} status: ${err.response?.status || "n/a"}`
    );
    logger.logToFile(
      `[error] ${prefix} data: ${JSON.stringify(err.response?.data || {})}`
    );
  }

  /**
   * Guard against WordPress returning an HTML page (e.g. a SiteGround security
   * captcha or Cloudflare challenge) instead of JSON.  Axios treats these as
   * successful responses (HTTP 200) so they would silently corrupt the caller.
   *
   * Throws with a clear message so the error surfaces in logs and is not
   * accidentally cached or treated as valid profile/receipt data.
   */
  function assertJsonResponse(res, context) {
    const contentType = res.headers["content-type"] || "";
    const isJson = contentType.includes("application/json");

    // axios parses JSON automatically when the Content-Type is correct, so
    // res.data will be a string only when the server sent non-JSON (e.g. HTML).
    const isHtml =
      !isJson &&
      typeof res.data === "string" &&
      res.data.trimStart().startsWith("<");

    if (isHtml) {
      // Extract a short snippet for the log without dumping the whole page.
      const snippet = res.data.replace(/\s+/g, " ").slice(0, 200);
      throw new Error(
        `[${context}] WordPress returned HTML instead of JSON ` +
        `(status=${res.status}, likely a security challenge). ` +
        `Snippet: ${snippet}`
      );
    }
  }

  async function checkOrCreateUserProfile({ phone, name }) {
    const cacheKey = `profile_cache:${phone}`;

    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        // Evict corrupted cache entries (e.g. HTML spread into an object from
        // a previous SiteGround security-challenge response).
        if (parsed?.profileId) {
          return parsed;
        }
        logger.logToFile(
          `[warn] Evicting invalid profile cache for ${phone} (no profileId)`
        );
        await redis.del(cacheKey);
      }
    } catch (err) {
      logger.logToFile(`[warn] Profile cache read failed: ${err.message}`);
    }

    try {
      const res = await http.post(
        endpoints.storeUser,
        { phone, name },
        { headers: { "Content-Type": "application/json" } }
      );

      assertJsonResponse(res, "checkOrCreateUserProfile");

      const profileId = res.data?.profileId || res.data?.post_id || res.data?.id;
      const profile = { profileId, ...res.data };

      try {
        await redis.set(cacheKey, JSON.stringify(profile), "EX", PROFILE_CACHE_TTL);
      } catch (err) {
        logger.logToFile(`[warn] Profile cache write failed: ${err.message}`);
      }

      return profile;
    } catch (err) {
      logAxiosError("checkOrCreateUserProfile failed", err);
      throw err;
    }
  }

  async function getPurchaseHistory(profileId) {
    const res = await http.get(endpoints.receipts, {
      params: { profile_id: profileId },
    });
    assertJsonResponse(res, "getPurchaseHistory");
    return res.data;
  }

  async function getLoyaltyPoints(profileId) {
    const res = await http.get(endpoints.userProfile, {
      params: { profile_id: profileId },
    });
    assertJsonResponse(res, "getLoyaltyPoints");
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
          ? `\n\n *Active Campaigns:*\n${active
              .map((c) => `• ${c.title || c.name}`)
              .join("\n")}`
          : "\n\n No campaigns are running at the moment.";
    } catch (err) {
      logger.logToFile(
        `[warn] Could not fetch campaigns for default message: ${err.message}`
      );
    }

    return `Here are your options:
1️⃣ Upload a receipt ( Image files only – JPG, JPEG, PNG)
2️⃣ Check loyalty points & rewards
3️⃣ Contact/Support Instructions
4️⃣ View current promotions
${campaignLine}

⚠️ Please upload clear images of your receipt.
PDF files are not supported.
Type *help* to view the menu again.`;
  }

  async function uploadPrimaryAndExtraImages({
    imageBuffers,
    filenames,
    profileId,
  }) {
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

      assertJsonResponse(uploadResponse, "uploadPrimaryAndExtraImages");
      logger.logToFile(
        `[debug] Primary upload response: ${JSON.stringify(uploadResponse.data)}`
      );

      const receiptId = uploadResponse.data?.receipt_id;
      if (!receiptId) throw new Error("Upload succeeded but receipt_id missing");

      if (imageBuffers.length > 1) {
        for (let i = 1; i < imageBuffers.length; i += 1) {
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

  async function upsertReceiptJobStatus(job) {
    try {
      const res = await http.post(endpoints.receiptJobStatus, job, {
        headers: { "Content-Type": "application/json" },
      });
      return res.data;
    } catch (err) {
      logAxiosError("upsertReceiptJobStatus failed", err);
      throw err;
    }
  }

  async function listReceiptJobs(params = {}) {
    try {
      const res = await http.get(endpoints.receiptJobs, { params });
      return res.data;
    } catch (err) {
      logAxiosError("listReceiptJobs failed", err);
      throw err;
    }
  }

  async function requestReceiptJobRetry(jobId) {
    try {
      const res = await http.post(
        endpoints.receiptJobRetry,
        { job_id: jobId },
        { headers: { "Content-Type": "application/json" } }
      );
      return res.data;
    } catch (err) {
      logAxiosError("requestReceiptJobRetry failed", err);
      throw err;
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
    upsertReceiptJobStatus,
    listReceiptJobs,
    requestReceiptJobRetry,
  };
}

module.exports = { createWpService };