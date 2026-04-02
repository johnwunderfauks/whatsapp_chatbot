/* eslint-disable no-console */
const { MessagingResponse } = require("twilio").twiml;
const { fromBuffer } = require("pdf2pic");
const { htmlToText } = require("html-to-text");
const {
  enqueueReceiptJob,
  retryReceiptQueueJob,
} = require("./queueService");

function createBotService({
  twilioClient,
  keepAliveJob,
  helpers,
  rateLimiter,
  config = {},
}) {
  if (!helpers) throw new Error("BotService: missing helpers");
  if (!twilioClient) throw new Error("BotService: missing twilioClient");
  if (!rateLimiter) throw new Error("BotService: missing rateLimiter");

  const requiredHelperFns = [
    "logToFile",
    "getChatState",
    "updateChatState",
    "checkOrCreateUserProfile",
    "getLoyaltyPoints",
    "fetchImageFromTwilio",
    "getPromotions",
    "getDefaultMessage",
    "receiptJobService",
    "appendReceiptFiles",
    "drainReceiptFiles",
  ];

  for (const fn of requiredHelperFns) {
    if (!(fn in helpers)) {
      throw new Error(`BotService: helpers.${fn} is missing`);
    }
  }

  if (typeof rateLimiter.checkRateLimit !== "function") {
    throw new Error("BotService: rateLimiter.checkRateLimit is missing");
  }

  if (typeof rateLimiter.recordMessageSent !== "function") {
    throw new Error("BotService: rateLimiter.recordMessageSent is missing");
  }

  const {
    logToFile,
    getChatState,
    updateChatState,
    checkOrCreateUserProfile,
    getLoyaltyPoints,
    fetchImageFromTwilio,
    getPromotions,
    getDefaultMessage,
    receiptJobService,
    appendReceiptFiles,
    drainReceiptFiles,
  } = helpers;

  const { checkRateLimit, recordMessageSent } = rateLimiter;

  // null  → key not configured, admin endpoints are unprotected (intentional dev/internal setup)
  // ""    → key set to empty string, misconfiguration — refuse all access
  // value → key set, validate every request
  const ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? null;

  const TWILIO_WHATSAPP_FROM =
    process.env.TWILIO_WHATSAPP_FROM ||
    config.twilioWhatsAppFrom ||
    "whatsapp:+15557969091";

  const RECEIPT_DEBOUNCE_MS = Number(process.env.RECEIPT_DEBOUNCE_MS || 2000);

  const receiptTimers = new Map();

  function normalizeIncomingText(body) {
    return (body || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function safeStringify(value) {
    try {
      return JSON.stringify(value);
    } catch (error) {
      return `[unserializable:${error.message}]`;
    }
  }

  function twimlReply(res, message) {
    if (res.headersSent) return undefined;
    const twiml = new MessagingResponse();
    twiml.message(message);
    return res.type("text/xml").send(twiml.toString());
  }

  function emptyTwiML(res) {
    if (res.headersSent) return undefined;
    return res.type("text/xml").send("");
  }

  function assertAdmin(req) {
    // Key not set at all → unprotected (intentional for dev/internal deployments)
    if (ADMIN_API_KEY === null) return;

    // Key set to empty string → misconfiguration, refuse all access
    if (ADMIN_API_KEY === "") {
      const error = new Error("Admin API key misconfigured on server");
      error.statusCode = 503;
      throw error;
    }

    const authHeader = req.headers.authorization || "";
    const bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";

    const headerToken =
      req.headers["x-admin-api-key"] ||
      req.headers["x-internal-api-key"] ||
      bearerToken;

    if (headerToken !== ADMIN_API_KEY) {
      const error = new Error("Unauthorized");
      error.statusCode = 401;
      throw error;
    }
  }

  async function convertPdfToImages(pdfBuffer) {
    const converter = fromBuffer(pdfBuffer, {
      density: 150,
      format: "jpeg",
      width: 1200,
      height: 1600,
      quality: 100,
    });

    const result = await converter.bulk(-1);
    return result.map((page) => Buffer.from(page.base64, "base64"));
  }

  async function enqueueTrackedReceiptJob({
    files,
    phone,
    profileId,
    sourceMessageSid,
  }) {
    const { jobId, batchHash } = await enqueueReceiptJob({
      files,
      phone,
      profileId,
      sourceMessageSid,
    });

    await receiptJobService.createQueuedJob({
      jobId,
      phone,
      profileId,
      files,
      batchHash,
      sourceMessageSid,
      attemptsAllowed: Number(process.env.RECEIPT_JOB_MAX_ATTEMPTS || 3),
    });

    await updateChatState(phone, {
      expectingImage: false,
      receiptFiles: [],
      lastReceiptJobId: jobId,
      lastReceiptBatchHash: batchHash,
      lastReceiptJobStatus: "queued",
    });

    return { jobId, batchHash };
  }

  function health(req, res) {
    res.status(200).json({
      status: "alive",
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      service: "WhatsApp Receipt Bot",
    });
  }

  function startKeepAlive() {
    if (keepAliveJob?.start) {
      keepAliveJob.start();
      console.log("Keep-alive job started");
    }
  }

  async function handleListReceiptJobs(req, res) {
    try {
      assertAdmin(req);
      const limit = Number(req.query.limit || 50);
      const jobs = await receiptJobService.listRecentJobs(limit);
      return res.status(200).json({ ok: true, jobs });
    } catch (error) {
      return res
        .status(error.statusCode || 500)
        .json({ ok: false, error: error.message });
    }
  }

  async function handleListFailedReceiptJobs(req, res) {
    try {
      assertAdmin(req);
      const limit = Number(req.query.limit || 50);
      const jobs = await receiptJobService.listFailedJobs(limit);
      return res.status(200).json({ ok: true, jobs });
    } catch (error) {
      return res
        .status(error.statusCode || 500)
        .json({ ok: false, error: error.message });
    }
  }

  async function handleListDeadLetterReceiptJobs(req, res) {
    try {
      assertAdmin(req);
      const limit = Number(req.query.limit || 50);
      const jobs = await receiptJobService.listDeadLetterJobs(limit);
      return res.status(200).json({ ok: true, jobs });
    } catch (error) {
      return res
        .status(error.statusCode || 500)
        .json({ ok: false, error: error.message });
    }
  }

  async function handleGetReceiptJob(req, res) {
    try {
      assertAdmin(req);
      const job = await receiptJobService.getJob(req.params.jobId);

      if (!job) {
        return res.status(404).json({ ok: false, error: "Job not found" });
      }

      return res.status(200).json({ ok: true, job });
    } catch (error) {
      return res
        .status(error.statusCode || 500)
        .json({ ok: false, error: error.message });
    }
  }

  async function handleNotifyUser(req, res) {
    try {
      assertAdmin(req);

      const { phone, message } = req.body;

      if (!phone || !message) {
        return res
          .status(400)
          .json({ ok: false, error: "phone and message are required" });
      }

      const to = phone.startsWith("whatsapp:") ? phone : `whatsapp:${phone}`;

      const result = await twilioClient.messages.create({
        from: TWILIO_WHATSAPP_FROM,
        to,
        body: message,
      });

      logToFile(`[info] Notify-user sent to ${to}, sid=${result.sid}`);

      return res.status(200).json({ ok: true, sid: result.sid });
    } catch (error) {
      logToFile(`[error] handleNotifyUser failed: ${error.message}`);
      return res
        .status(error.statusCode || 500)
        .json({ ok: false, error: error.message });
    }
  }

  async function handleRetryReceiptJob(req, res) {
    try {
      assertAdmin(req);
      const { jobId } = req.params;

      const existing = await receiptJobService.getJob(jobId);
      if (!existing) {
        return res.status(404).json({ ok: false, error: "Job not found" });
      }

      await receiptJobService.markRetryQueued(jobId, {
        retryRequestedAt: new Date().toISOString(),
      });

      const result = await retryReceiptQueueJob(jobId);

      return res.status(200).json({
        ok: true,
        jobId,
        result,
      });
    } catch (error) {
      return res
        .status(error.statusCode || 500)
        .json({ ok: false, error: error.message });
    }
  }

  async function handleWhatsappWebhook(req, res) {
    const from = req.body.From?.replace("whatsapp:", "") || "";
    const body = (req.body.Body || "").trim();
    const name = req.body.ProfileName || "Unknown";
    const text = normalizeIncomingText(body);
    const numMedia = parseInt(req.body.NumMedia || "0", 10);

    logToFile(
      `[info] Incoming Twilio message from ${name} (${from}) -> ${
        body || "[media/no text]"
      }`
    );

    logToFile(
      `[debug] Webhook media summary: numMedia=${numMedia}, mediaType0=${
        req.body.MediaContentType0 || ""
      }, mediaUrl0=${req.body.MediaUrl0 || ""}`
    );

    if (!from) {
      logToFile("[warn] Incoming webhook missing From");
      return emptyTwiML(res);
    }

    let userProfile;

    try {
      userProfile = await checkOrCreateUserProfile({ phone: from, name });
    } catch (err) {
      logToFile(`[error] WP profile sync failed: ${err.message}`);
      return twimlReply(
        res,
        "There was an error processing your profile. Please try again later."
      );
    }

    const profileId = userProfile?.profileId;
    if (!profileId) {
      logToFile(
        `[error] Missing profileId for ${from} - userProfile=${safeStringify(
          userProfile
        )}`
      );
      return twimlReply(
        res,
        "There was an error processing your profile. Please try again later."
      );
    }

    const { allowed, warning } = await checkRateLimit(profileId);

    if (!allowed) {
      if (warning) {
        logToFile(`[rate-limit] Sending daily limit warning to ${from}`);
        return twimlReply(res, warning);
      }

      logToFile(
        `[rate-limit] Silently dropping message from ${from} (limit reached)`
      );
      return emptyTwiML(res);
    }

    const state = await getChatState(from);
    logToFile(`[debug] Current state for ${from}: ${safeStringify(state)}`);

    if (state.expectingImage && numMedia > 0) {
      try {
        // ── Step 1: parse this request's media into newFiles[] ───────────────
        // We collect first and append atomically, so an early return for an
        // unsupported type never leaves partial state in Redis.
        const newFiles = [];

        for (let i = 0; i < numMedia; i += 1) {
          const mediaUrl  = req.body[`MediaUrl${i}`];
          const mediaType = req.body[`MediaContentType${i}`];

          logToFile(
            `[debug] Inspecting media[${i}] url=${mediaUrl || ""} type=${mediaType || ""}`
          );

          if (!mediaUrl || !mediaType) {
            logToFile(`[warn] Missing mediaUrl/mediaType for index ${i}`);
            continue;
          }

          if (mediaType.startsWith("image/")) {
            newFiles.push({ url: mediaUrl, type: "image" });
            continue;
          }

          if (mediaType === "application/pdf") {
            newFiles.push({ url: mediaUrl, type: "pdf" });
            continue;
          }

          logToFile(`[warn] Unsupported media type from ${from}: ${mediaType}`);

          if (!res.headersSent) {
            return twimlReply(
              res,
              "Unsupported file type. Please send a receipt image or PDF only."
            );
          }

          return undefined;
        }

        // ── Step 2: atomically append to the per-user Redis list ─────────────
        // RPUSH is atomic — concurrent requests for the same user cannot
        // overwrite each other's files (no read-modify-write race).
        const newQueueLength = await appendReceiptFiles(from, newFiles);
        logToFile(
          `[info] Appended ${newFiles.length} file(s) for ${from} (queue length=${newQueueLength})`
        );

        // Send confirmation only the first time (queue was empty before this append).
        if (newQueueLength === newFiles.length && newFiles.length > 0) {
          await recordMessageSent(profileId);
          twimlReply(res, "Receipt received. Processing now...");
        }

        // ── Step 3: reset debounce timer ─────────────────────────────────────
        if (receiptTimers.has(from)) {
          clearTimeout(receiptTimers.get(from));
          receiptTimers.delete(from);
          logToFile(`[debug] Cleared existing debounce timer for ${from}`);
        }

        const messageSid = req.body.MessageSid || null;

        const timer = setTimeout(async () => {
          try {
            // Atomically drain all accumulated files for this user.
            // LRANGE + DEL in a pipeline — no concurrent request can observe
            // a partial drain.
            const finalFiles = await drainReceiptFiles(from);

            if (finalFiles.length === 0) {
              logToFile(
                `[warn] No files accumulated for ${from} after debounce — skipping enqueue`
              );
              return;
            }

            logToFile(
              `[info] Debounced enqueue for ${finalFiles.length} receipt file(s) from ${from}`
            );

            const { jobId } = await enqueueTrackedReceiptJob({
              files: finalFiles,
              phone: from,
              profileId,
              sourceMessageSid: messageSid,
            });

            logToFile(`[info] Enqueued receipt job ${jobId} for ${from}`);
          } catch (err) {
            logToFile(`[error] Background receipt enqueue failed: ${err.message}`);
            logToFile(
              `[error] Background enqueue stack: ${err.stack || "no stack"}`
            );
          } finally {
            receiptTimers.delete(from);
          }
        }, RECEIPT_DEBOUNCE_MS);

        receiptTimers.set(from, timer);
        logToFile(
          `[debug] Set debounce timer (${RECEIPT_DEBOUNCE_MS}ms) for ${from}`
        );

        if (!res.headersSent) {
          return emptyTwiML(res);
        }

        return undefined;
      } catch (err) {
        logToFile(`[error] Receipt handling failed: ${err.message}`);
        logToFile(
          `[error] Receipt handling stack: ${err.stack || "no stack"}`
        );

        if (!res.headersSent) {
          return twimlReply(
            res,
            "There was an error uploading your receipt. Please try again later."
          );
        }

        return undefined;
      }
    }

    if (/help/i.test(body)) {
      await recordMessageSent(profileId);
      const msg = await getDefaultMessage();
      return twimlReply(res, msg);
    }

    if (/stop/i.test(body)) {
      await updateChatState(from, { expectingImage: false, receiptFiles: [] });
      await recordMessageSent(profileId);
      return twimlReply(res, "You have exited the chatbot.");
    }

    if (text === "1" || /upload a receipt/i.test(text)) {
      await updateChatState(from, {
        expectingImage: true,
        receiptFiles: [],
      });
      await recordMessageSent(profileId);
      return twimlReply(
        res,
        "Please send a clear image of your receipt. You can send multiple images."
      );
    }

    if (text === "2" || /loyalty/i.test(text) || /points/i.test(text)) {
      await recordMessageSent(profileId);
      const points = await getLoyaltyPoints(profileId);
      const message = htmlToText(
        points?.message || `Your current points: ${points?.loyalty_points || 0}`,
        { wordwrap: false }
      );
      return twimlReply(res, message);
    }

    if (text === "4" || /promotion/i.test(text)) {
      await recordMessageSent(profileId);
      const promotions = await getPromotions();
      const message =
        promotions?.message ||
        "No active promotions are available at the moment.";
      return twimlReply(res, htmlToText(message, { wordwrap: false }));
    }

    await recordMessageSent(profileId);
    return twimlReply(res, await getDefaultMessage());
  }

  return {
    health,
    startKeepAlive,
    handleWhatsappWebhook,
    handleNotifyUser,
    handleListReceiptJobs,
    handleListFailedReceiptJobs,
    handleListDeadLetterReceiptJobs,
    handleGetReceiptJob,
    handleRetryReceiptJob,
  };
}

module.exports = { createBotService };