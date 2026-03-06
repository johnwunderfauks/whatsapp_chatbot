/* eslint-disable no-console */

const { MessagingResponse } = require("twilio").twiml;
const { htmlToText } = require("html-to-text");
const { enqueueReceiptJob } = require("./queueService");

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
  keepAliveJob,
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
    clearChatState,
    checkOrCreateUserProfile,
    getLoyaltyPoints,
    getPromotions,
    getDefaultMessage,
    claimWebhookOnce,
  } = helpers;

  const { checkRateLimit, recordMessageSent } = rateLimiter;

  const TWILIO_WHATSAPP_FROM =
    process.env.TWILIO_WHATSAPP_FROM ||
    config.twilioWhatsAppFrom ||
    "whatsapp:+15557969091";

  const RECEIPT_DEBOUNCE_MS = Number(process.env.RECEIPT_DEBOUNCE_MS || 2000);
  const receiptTimers = new Map();

  function normalizeIncomingText(body) {
    return (body || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function isMatch(text, patterns = []) {
    return patterns.some((p) => p.test(text));
  }

  function safeStringify(value) {
    try {
      return JSON.stringify(value);
    } catch {
      return "[unserializable]";
    }
  }

  function twimlReply(res, message) {
    if (res.headersSent) return;
    const twiml = new MessagingResponse();
    twiml.message(message);
    return res.type("text/xml").send(twiml.toString());
  }

  function emptyTwiML(res) {
    if (res.headersSent) return;
    return res.type("text/xml").send("<Response></Response>");
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
      console.log("🔄 Keep-alive job started (pings every 14 minutes)");
    }
  }

  async function handleWhatsappWebhook(req, res) {
    const from = req.body.From?.replace("whatsapp:", "") || "";
    const body = (req.body.Body || "").trim();
    const name = req.body.ProfileName || "Unknown";
    const text = normalizeIncomingText(body);
    const numMedia = parseInt(req.body.NumMedia || "0", 10);
    const messageSid = req.body.MessageSid || req.body.SmsMessageSid || "";

    const mediaUrls = [];
    for (let i = 0; i < numMedia; i++) {
      if (req.body[`MediaUrl${i}`]) {
        mediaUrls.push(req.body[`MediaUrl${i}`]);
      }
    }

    logToFile(
      `[info] Incoming Twilio message from ${name} (${from}) -> ${body || "[media/no text]"}`
    );
    logToFile(
      `[debug] Webhook media summary: numMedia=${numMedia}, mediaType0=${req.body.MediaContentType0 || ""}, mediaUrl0=${req.body.MediaUrl0 || ""}`
    );

    if (!from) {
      logToFile("[warn] Incoming webhook missing From");
      return emptyTwiML(res);
    }

    if (typeof claimWebhookOnce === "function") {
      const idem = await claimWebhookOnce({
        messageSid,
        from,
        body,
        mediaUrls,
      });

      if (!idem.claimed) {
        return emptyTwiML(res);
      }
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
        `[error] Missing profileId for ${from} - userProfile=${safeStringify(userProfile)}`
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
      logToFile(`[rate-limit] Silently dropping message from ${from} (limit reached)`);
      return emptyTwiML(res);
    }

    const state = await getChatState(from);
    logToFile(`[debug] Current state for ${from}: ${safeStringify(state)}`);

    if (state.expectingImage && numMedia > 0) {
      try {
        const alreadyCollected = Array.isArray(state.receiptFiles)
          ? state.receiptFiles.length
          : 0;

        if (alreadyCollected === 0) {
          await recordMessageSent(profileId);
          twimlReply(res, "📸 Receipt received. Processing now...");
        }

        let files = Array.isArray(state.receiptFiles) ? [...state.receiptFiles] : [];

        for (let i = 0; i < numMedia; i++) {
          const mediaUrl = req.body[`MediaUrl${i}`];
          const mediaType = req.body[`MediaContentType${i}`];

          logToFile(
            `[debug] Inspecting media[${i}] url=${mediaUrl || ""} type=${mediaType || ""}`
          );

          if (!mediaUrl || !mediaType) continue;

          if (mediaType.startsWith("image/")) {
            files.push({ url: mediaUrl, type: "image" });
            continue;
          }

          logToFile(`[warn] Unsupported media type from ${from}: ${mediaType}`);
          if (!res.headersSent) {
            return twimlReply(res, "❌ Unsupported file type. Please send a receipt image only.");
          }
          return;
        }

        await updateChatState(from, { receiptFiles: files });
        logToFile(`[info] Collected ${files.length} receipt file(s) from ${from}`);

        if (receiptTimers.has(from)) {
          clearTimeout(receiptTimers.get(from));
          receiptTimers.delete(from);
          logToFile(`[debug] Cleared existing debounce timer for ${from}`);
        }

        const timer = setTimeout(async () => {
          try {
            const finalState = await getChatState(from);
            const finalFiles = Array.isArray(finalState.receiptFiles)
              ? finalState.receiptFiles
              : [];

            logToFile(
              `[info] Debounced processing ${finalFiles.length} receipt file(s) for ${from}`
            );

            if (typeof clearChatState === "function") {
              await clearChatState(from);
            } else {
              await updateChatState(from, {
                expectingImage: false,
                receiptFiles: [],
              });
            }

            receiptTimers.delete(from);

            const enqueued = await enqueueReceiptJob({
              phone: from,
              profileId,
              files: finalFiles,
              sourceMessageSid: messageSid,
            });

            logToFile(
              `[queue] Enqueued receipt job for ${from}. jobId=${enqueued.jobId}, batchHash=${enqueued.batchHash}`
            );
          } catch (err) {
            logToFile(`[error] Failed to enqueue/process receipt batch: ${err.message}`);
            logToFile(`[error] Enqueue stack: ${err.stack || "no stack"}`);
          }
        }, RECEIPT_DEBOUNCE_MS);

        receiptTimers.set(from, timer);
        logToFile(`[debug] Set debounce timer (${RECEIPT_DEBOUNCE_MS}ms) for ${from}`);

        if (!res.headersSent) {
          return emptyTwiML(res);
        }
        return;
      } catch (err) {
        logToFile(`[error] Receipt handling failed: ${err.message}`);
        logToFile(`[error] Receipt handling stack: ${err.stack || "no stack"}`);
        if (!res.headersSent) {
          return twimlReply(
            res,
            "There was an error uploading your receipt. Please try again later."
          );
        }
        return;
      }
    }

    if (/help/i.test(body)) {
      await recordMessageSent(profileId);
      const msg = await getDefaultMessage();
      return twimlReply(res, msg);
    }

    if (/stop/i.test(body)) {
      if (typeof clearChatState === "function") {
        await clearChatState(from);
      } else {
        await updateChatState(from, { expectingImage: false, receiptFiles: [] });
      }
      await recordMessageSent(profileId);
      return twimlReply(res, "You have exited the chatbot. Type *help* to return anytime.");
    }

    if (
      isMatch(text, [
        /^1$/,
        /upload/,
        /send.*receipt/,
        /submit.*receipt/,
        /receipt/,
        /photo/,
        /image/,
      ])
    ) {
      await updateChatState(from, { expectingImage: true, receiptFiles: [] });
      await recordMessageSent(profileId);
      logToFile(`[info] Receipt upload mode enabled for ${from}`);
      return twimlReply(res, "Please upload your receipt image now 📸");
    }

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

    if (isMatch(text, [/^3$/, /agent/, /support/, /help me/, /talk to/, /contact/])) {
      await recordMessageSent(profileId);
      return twimlReply(res, "💬 Please send your issue to support@naturellving.com");
    }

    if (
      isMatch(text, [
        /^4$/,
        /promo/,
        /promotion/,
        /promotions/,
        /offer/,
        /offers/,
        /discount/,
        /deals?/,
      ])
    ) {
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

          if (promo.expiry_date) {
            message += `⏳ Valid until: ${promo.expiry_date}\n\n`;
          }

          if (promo.promo_link) {
            message += `🔗 ${promo.promo_link}`;
          }

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

        logToFile(
          `[info] Text message sent to ${phone} for receipt ${receipt_id || "n/a"}`
        );
      }

      return res.json({
        success: true,
        sid: twilioResponse.sid,
        fallback_used: usedFallback,
      });
    } catch (error) {
      logToFile(`[error] Notification failed: ${error.message}`);
      logToFile(`[error] Notification stack: ${error.stack || "no stack"}`);
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