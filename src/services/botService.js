// src/services/botService.js
/* eslint-disable no-console */

const { MessagingResponse } = require("twilio").twiml;
const { fromBuffer } = require("pdf2pic");
const { htmlToText } = require("html-to-text");

/**
 * BotService encapsulates:
 * - / health endpoint
 * - /whatsapp Twilio inbound webhook
 * - /whatsapp/notify-user internal notify endpoint (template or fallback text)
 * - receipt media debounce + background processing (OCR/fraud via helpers.uploadReceiptImages)
 * - rate limiting
 *
 * Dependencies are injected (Twilio client, helpers, rate limiter, keepAlive job),
 * so the service is testable and production-friendly.
 */

const TEMPLATE_MAP = {
  otp_login: { contentSid: "HXa83dae8644668753ede2d6399d240a1a" },
  receipt_processed: { contentSid: "HXcbc467bb689e70d6ef952e1bbbb67a3a" },
  loyalty_points_earned: { contentSid: "HXfdfbba9819f103e0fae544997350cf3b" },
  reward_redemption: { contentSid: "HX1a299b161936b0281ed4c7dcd24ea434" },
  reward_request_confirmation: { contentSid: "HX9e0b92c8b13caeabb78b729271aa744b" },
  reward_cancelled: { contentSid: "HXf5e41934c379fceca43bfb2f80d68c17" },
  reward_pending: { contentSid: "HX68824005f8e305ccd2b2e8de1f51b2af" },
  how_to_use_service: { contentSid: "HXd87581d945c882e6dfd46a1b4094f789" },
  receipt_approved: { contentSid: "HXbb179f1c52819107db1a3842d4ca5644" },
  receipt_rejected: { contentSid: "HX2b114f7707799cab556ca644409063fa" },
  points_adjusted_increase: { contentSid: "HX2e231767a1f855df0631910b865b5798" },
  points_adjusted_decrease: { contentSid: "HX1959b66f13dd91f13290d09d88bd27bc" },
};

function createBotService({
  twilioClient,
  keepAliveJob, // optional: job from keepAlive
  helpers,
  rateLimiter,
  config = {},
}) {
  if (!helpers) throw new Error("BotService: missing helpers");
  if (!twilioClient) throw new Error("BotService: missing twilioClient");
  if (!rateLimiter) throw new Error("BotService: missing rateLimiter");

  const {
    logToFile,
    getChatState,
    updateChatState,
    checkOrCreateUserProfile,
    uploadReceiptImages,
    getLoyaltyPoints,
    fetchImageFromTwilio,
    getPromotions,
    getDefaultMessage,
  } = helpers;

  const { checkRateLimit, recordMessageSent } = rateLimiter;

  const TWILIO_WHATSAPP_FROM =
    process.env.TWILIO_WHATSAPP_FROM || config.twilioWhatsAppFrom || "whatsapp:+15557969091";

  // Debounce timers per phone
  const receiptTimers = new Map();

  const RECEIPT_DEBOUNCE_MS = Number(process.env.RECEIPT_DEBOUNCE_MS || 2000);

  // --------- helpers ----------
  function normalizeIncomingText(body) {
    return (body || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function isMatch(text, patterns = []) {
    return patterns.some((p) => p.test(text));
  }

  function twimlReply(res, message) {
    const twiml = new MessagingResponse();
    twiml.message(message);
    return res.type("text/xml").send(twiml.toString());
  }

  function emptyTwiML(res) {
    // silent drop
    return res.type("text/xml").send("<Response></Response>");
  }

  async function convertPdfToImages(pdfBuffer) {
    // NOTE: PDF media is currently disabled in your webhook intake.
    // This function remains production-ready if you re-enable it.
    const converter = fromBuffer(pdfBuffer, {
      density: 150,
      format: "jpeg",
      width: 1200,
      height: 1600,
      quality: 100,
    });

    const result = await converter.bulk(-1); // convert all pages
    return result.map((page) => Buffer.from(page.base64, "base64"));
  }

  async function processReceiptFilesAsync({ files, phone, profileId }) {
    try {
      logToFile(`[info] Processing ${files.length} receipt file(s) for ${phone}`);

      const imageBuffers = [];

      // 1) Download and normalize files to images
      for (const file of files) {
        const buffer = await fetchImageFromTwilio(file.url);

        if (file.type === "image") {
          imageBuffers.push(buffer);
          continue;
        }

        if (file.type === "pdf") {
          logToFile(`[info] Converting PDF to images for ${phone}`);
          const pdfPages = await convertPdfToImages(buffer);
          for (const pageBuffer of pdfPages) imageBuffers.push(pageBuffer);
          continue;
        }

        logToFile(`[warn] Unsupported file type during processing: ${file.type}`);
      }

      if (imageBuffers.length === 0) {
        throw new Error("No valid receipt images found after processing.");
      }

      // 2) Upload + OCR + Fraud pipeline (your helper owns this)
      const result = await uploadReceiptImages(
        imageBuffers,
        `receipt_${profileId}_${Date.now()}.jpg`,
        profileId
      );

      const score = result?.fraud_result?.score;
      const decision = result?.fraud_result?.decision;

      logToFile(
        `[info] Receipt processing complete for ${phone}. Fraud score: ${score}, Decision: ${decision}`
      );
    } catch (error) {
      logToFile(`[error] Receipt processing failed: ${error.message}`);
      logToFile(`[error] Stack: ${error.stack}`);

      // Notify user on failure (out-of-band; webhook already acked)
      try {
        await twilioClient.messages.create({
          from: TWILIO_WHATSAPP_FROM,
          to: `whatsapp:${phone}`,
          body: "❌ There was an error processing your receipt. Please try uploading again or contact support.",
        });
      } catch (sendErr) {
        logToFile(`[error] Failed to send receipt processing error message: ${sendErr.message}`);
      }
    }
  }

  // --------- controllers ----------
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
      console.log("🔄 Keep-alive job started (pings every 14 minutes)");
    }
  }

  async function handleWhatsappWebhook(req, res) {
    const from = req.body.From?.replace("whatsapp:", "") || "";
    const body = (req.body.Body || "").trim();
    const name = req.body.ProfileName || "Unknown";
    const text = normalizeIncomingText(body);

    logToFile(`[info] Incoming Twilio message from ${name} (${from}) -> ${body}`);

    // 1) WP profile sync
    let userProfile;
    try {
      userProfile = await checkOrCreateUserProfile({ phone: from, name });
    } catch (err) {
      logToFile(`[error] WP profile sync failed: ${err.message}`);
      return twimlReply(res, "There was an error processing your profile. Please try again later.");
    }

    const profileId = userProfile?.profileId;
    if (!profileId) {
      logToFile(`[error] Missing profileId for ${from} - userProfile=${JSON.stringify(userProfile)}`);
      return twimlReply(res, "There was an error processing your profile. Please try again later.");
    }

    // 2) Rate limit
    const { allowed, warning } = await checkRateLimit(profileId);

    if (!allowed) {
      if (warning) {
        logToFile(`[rate-limit] Sending daily limit warning to ${from}`);
        return twimlReply(res, warning);
      }
      logToFile(`[rate-limit] Silently dropping message from ${from} (limit reached)`);
      return emptyTwiML(res);
    }

    // 3) Receipt flow (expects image)
    const state = await getChatState(from);

    const numMedia = parseInt(req.body.NumMedia || "0", 10);

    if (state.expectingImage && numMedia > 0) {
      try {
        // Acknowledge only on first media in the batch
        if (!state.receiptFiles || state.receiptFiles.length === 0) {
          await recordMessageSent(profileId);
          // sendReply but DO NOT await; Twilio expects quick response
          twimlReply(res, "📸 Receipt received. Processing now...");
        }

        let files = Array.isArray(state.receiptFiles) ? [...state.receiptFiles] : [];

        // Collect media
        for (let i = 0; i < numMedia; i++) {
          const mediaUrl = req.body[`MediaUrl${i}`];
          const mediaType = req.body[`MediaContentType${i}`];

          if (!mediaUrl || !mediaType) continue;

          if (mediaType.startsWith("image/")) {
            files.push({ url: mediaUrl, type: "image" });
            continue;
          }

          // PDF currently disabled in your intake logic; keep ready if you re-enable
          // if (mediaType === "application/pdf") {
          //   files.push({ url: mediaUrl, type: "pdf" });
          //   continue;
          // }

          logToFile(`[warn] Unsupported media type from ${from}: ${mediaType}`);
          // If headers already sent due to ack, no additional response can be sent safely.
          if (!res.headersSent) {
            return twimlReply(res, "❌ Unsupported file type. Please send a receipt image only.");
          }
          return;
        }

        // Save state
        await updateChatState(from, { receiptFiles: files });
        logToFile(`[info] Collected ${files.length} receipt file(s) from ${from}`);

        // Reset debounce timer
        if (receiptTimers.has(from)) {
          clearTimeout(receiptTimers.get(from));
        }

        const timer = setTimeout(async () => {
          const finalState = await getChatState(from);
          const finalFiles = finalState.receiptFiles || [];

          logToFile(`[info] Debounced processing ${finalFiles.length} receipt file(s) for ${from}`);

          // Clear state BEFORE processing
          await updateChatState(from, { expectingImage: false, receiptFiles: [] });
          receiptTimers.delete(from);

          // Background processing
          processReceiptFilesAsync({ files: finalFiles, phone: from, profileId }).catch((err) => {
            logToFile(`[error] Background receipt processing failed: ${err.message}`);
          });
        }, RECEIPT_DEBOUNCE_MS);

        receiptTimers.set(from, timer);

        // We already responded if it was first media; otherwise we should respond silently
        if (!res.headersSent) return emptyTwiML(res);
        return;
      } catch (err) {
        logToFile(`[error] Receipt handling failed: ${err.message}`);
        if (!res.headersSent) {
          return twimlReply(res, "There was an error uploading your receipt. Please try again later.");
        }
        return;
      }
    }

    // 4) Commands/menu
    if (/help/i.test(body)) {
      await recordMessageSent(profileId);
      const msg = await getDefaultMessage();
      return twimlReply(res, msg);
    }

    if (/stop/i.test(body)) {
      await updateChatState(from, { expectingImage: false, receiptFiles: [] });
      await recordMessageSent(profileId);
      return twimlReply(res, "You have exited the chatbot. Type *help* to return anytime.");
    }

    // 1) Upload receipt
    if (
      isMatch(text, [/^1$/, /upload/, /send.*receipt/, /submit.*receipt/, /receipt/, /photo/, /image/])
    ) {
      await updateChatState(from, { expectingImage: true, receiptFiles: [] });
      await recordMessageSent(profileId);
      return twimlReply(res, "Please upload your receipt image now 📸");
    }

    // 2) Loyalty points
    if (isMatch(text, [/^2$/, /points?/, /loyalty/, /rewards?/, /balance/, /my points/])) {
      try {
        const profile = await getLoyaltyPoints(profileId);
        const points = profile?.loyalty_points || 0;
        const rewards = Array.isArray(profile?.rewards) ? profile.rewards : [];

        let rewardMessage = "None available at the moment.";

        if (rewards.length > 0) {
          rewardMessage = rewards
            .map((r) => {
              const canRedeem = points >= r.points_cost && r.current_quantity > 0;
              const status =
                r.current_quantity <= 0
                  ? "❌ Out of stock"
                  : canRedeem
                    ? "✅ Redeemable"
                    : `Need ${r.points_cost - points} more pts`;

              return `• ${r.name}\n   Cost: ${r.points_cost} pts\n   Stock: ${r.current_quantity}\n   ${status}`;
            })
            .join("\n\n");
        }

        await recordMessageSent(profileId);
        return twimlReply(
          res,
          `⭐ *Your Loyalty Points:* ${points}\n\n🎁 *Available Rewards:*\n${rewardMessage}`
        );
      } catch (err) {
        logToFile(`[error] Loyalty lookup failed: ${err.message}`);
        return twimlReply(res, "There was an error retrieving your loyalty information.");
      }
    }

    // 3) Support
    if (isMatch(text, [/^3$/, /agent/, /support/, /help me/, /talk to/, /contact/])) {
      await recordMessageSent(profileId);
      return twimlReply(res, "💬 Please send your issue to support@naturellving.com");
    }

    // 4) Promotions
    if (isMatch(text, [/^4$/, /promo/, /promotion/, /promotions/, /offer/, /offers/, /discount/, /deals?/])) {
      try {
        const data = await getPromotions();
        const promotions = data?.promotions || [];

        if (!promotions.length) {
          await recordMessageSent(profileId);
          return twimlReply(res, "🎉 There are no active promotions at the moment.");
        }

        const twiml = new MessagingResponse();

        promotions.forEach((promo) => {
          let message = `🎉 *${promo.title}*\n\n`;

          if (promo.content) {
            const cleanContent = htmlToText(promo.content, { wordwrap: false });
            message += `${cleanContent}\n\n`;
          }

          if (promo.expiry_date) message += `⏳ Valid until: ${promo.expiry_date}\n\n`;
          if (promo.promo_link) message += `🔗 ${promo.promo_link}`;

          const msg = twiml.message(message);

          if (promo.media?.url) {
            msg.media(promo.media.url);
          }
        });

        await recordMessageSent(profileId);
        return res.type("text/xml").send(twiml.toString());
      } catch (err) {
        logToFile(`[error] Promotion lookup failed: ${err.message}`);
        return twimlReply(res, "There was an error retrieving promotions.");
      }
    }

    // fallback
    await recordMessageSent(profileId);
    const msg = await getDefaultMessage();
    return twimlReply(res, msg);
  }

  async function handleNotifyUser(req, res) {
    try {
      const {
        phone,
        message,
        receipt_id,
        use_template,
        template_name,
        template_params = [],
      } = req.body || {};

      if (!phone) {
        return res.status(400).json({ success: false, message: "Missing phone" });
      }

      let twilioResponse;
      let usedFallback = false;

      // Template path
      if (use_template && template_name && TEMPLATE_MAP[template_name]) {
        try {
          const contentVariables = {};
          template_params.forEach((value, index) => {
            contentVariables[String(index + 1)] = String(value);
          });

          twilioResponse = await twilioClient.messages.create({
            from: TWILIO_WHATSAPP_FROM,
            to: `whatsapp:${phone}`,
            contentSid: TEMPLATE_MAP[template_name].contentSid,
            contentVariables: JSON.stringify(contentVariables),
          });

          logToFile(
            `[info] Template "${template_name}" sent to ${phone}. SID: ${twilioResponse.sid}`
          );
        } catch (templateError) {
          usedFallback = true;
          logToFile(
            `[warn] Template "${template_name}" failed for ${phone}: ${templateError.message}. Falling back to text message.`
          );
        }
      } else if (use_template) {
        usedFallback = true;
        logToFile(
          `[warn] Invalid or missing template_name "${template_name}". Falling back to text message.`
        );
      }

      // Fallback text path
      if (!twilioResponse) {
        if (!message) {
          return res.status(400).json({
            success: false,
            message: "Missing message for fallback delivery",
          });
        }

        twilioResponse = await twilioClient.messages.create({
          from: TWILIO_WHATSAPP_FROM,
          to: `whatsapp:${phone}`,
          body: message,
        });

        logToFile(`[info] Text message sent to ${phone} for receipt ${receipt_id || "n/a"}`);
      }

      return res.json({
        success: true,
        sid: twilioResponse.sid,
        fallback_used: usedFallback,
      });
    } catch (error) {
      helpers.logToFile?.(`[error] Notification failed: ${error.message}`);
      if (!res.headersSent) {
        return res.status(500).json({ success: false, message: error.message });
      }
    }
  }

  return {
    health,
    startKeepAlive,
    handleWhatsappWebhook,
    handleNotifyUser,
  };
}

module.exports = { createBotService };