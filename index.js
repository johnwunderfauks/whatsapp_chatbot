const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
require('dotenv').config();
const { job } = require('./keepAlive');
const receiptTimers = new Map();
const { fromBuffer } = require("pdf2pic");
const { htmlToText } = require("html-to-text");

const options = {
  density: 100,
  saveFilename: "pdf_image",
  savePath: "./images",
  format: "png",
  width: 600,
  height: 600
};


const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const defaultMessage = `Here are your options:

1️⃣ Upload a receipt (📸 Image files only – JPG, JPEG, PNG)
2️⃣ Check loyalty points & rewards
3️⃣ Contact/Support Instructions
4️⃣ View current promotions 🎉

⚠️ Please upload clear images of your receipt.
PDF files are not supported.

Type *help* to view the menu again.`;

const {
  logToFile,
  getChatState,
  updateChatState,
  checkOrCreateUserProfile,
  uploadReceiptImages,
  getPurchaseHistory,
  getLoyaltyPoints,
  fetchImageFromTwilio,
  getAvailableRewards, 
  getPromotions
} = require('./helpers');

async function sendReply(res, message) {
  const twiml = new MessagingResponse();
  twiml.message(message);
  return res.type('text/xml').send(twiml.toString());
}

function isMatch(text, patterns = []) {
  return patterns.some(p => p.test(text));
}

app.get('/', (req, res) => {
  res.status(200).json({ 
    status: 'alive', 
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    service: 'WhatsApp Receipt Bot'
  });
});

job.start();
console.log('🔄 Keep-alive job started (pings every 14 minutes)');

app.post('/whatsapp', async (req, res) => {

  const from = req.body.From?.replace('whatsapp:', '') || '';
  const body = (req.body.Body || '').trim();
  const name = req.body.ProfileName || 'Unknown';
  const text = (body || "")
  .trim()
  .toLowerCase()
  .replace(/\s+/g, " ");

  logToFile(`[info] Incoming Twilio message from ${name} (${from}) -> ${body}`);

  let userProfile;
  try {
    userProfile = await checkOrCreateUserProfile({ phone: from, name });
  } catch (err) {
    logToFile(`[error] WP profile sync failed: ${err.message}`);
    return sendReply(res, 'There was an error processing your profile. Please try again later.');
  }

  const profileId = userProfile.profileId;
  if (!profileId) {
    logToFile(`[error] Missing profileId for ${from}`);
    return sendReply(res, 'There was an error processing your profile. Please try again later.');
  }


  const state = await getChatState(from);

  console.log("chat state", state.expectingImage, req.body.NumMedia)


  if (state.expectingImage && req.body.NumMedia && parseInt(req.body.NumMedia) > 0) {

    const numMedia = parseInt(req.body.NumMedia);

    try {

      // 1️⃣ Acknowledge ONLY on first media
      if (!state.receiptFiles || state.receiptFiles.length === 0) {
        sendReply(res, '📸 Receipt received. Processing now...');
      }

      let files = Array.isArray(state.receiptFiles)
        ? [...state.receiptFiles]
        : [];

      // 2️⃣ Loop through all uploaded media
      for (let i = 0; i < numMedia; i++) {

        const mediaUrl = req.body[`MediaUrl${i}`];
        const mediaType = req.body[`MediaContentType${i}`];

        if (!mediaUrl || !mediaType) continue;

        // ✅ Allow images
        if (mediaType.startsWith("image/")) {
          files.push({
            url: mediaUrl,
            type: "image"
          });
          continue;
        }

        // ✅ Allow PDF
        // if (mediaType === "application/pdf") {
        //   files.push({
        //     url: mediaUrl,
        //     type: "pdf"
        //   });
        //   continue;
        // }

        // ❌ Reject unsupported types
        logToFile(`[warn] Unsupported media type from ${from}: ${mediaType}`);
        sendReply(res, "❌ Unsupported file type. Please send a receipt image only.");
        return;
      }

      // 3️⃣ Save to state
      await updateChatState(from, {
        receiptFiles: files
      });

      logToFile(`[info] Collected ${files.length} receipt file(s) from ${from}`);

      // 4️⃣ Reset processing timer (debounce)
      if (receiptTimers.has(from)) {
        clearTimeout(receiptTimers.get(from));
      }

      const timer = setTimeout(async () => {

        const finalState = await getChatState(from);
        const finalFiles = finalState.receiptFiles || [];

        logToFile(`[info] Processing ${finalFiles.length} receipt file(s) for ${from}`);

        // ✅ Clear state BEFORE processing
        await updateChatState(from, {
          expectingImage: false,
          receiptFiles: []
        });

        receiptTimers.delete(from);

        // ✅ Process ONCE
        processReceiptFilesAsync(finalFiles, from, profileId).catch(err => {
          logToFile(`[error] Background processing failed: ${err.message}`);
        });

      }, 2000); // wait 2 seconds after last upload

      receiptTimers.set(from, timer);

      return;

    } catch (err) {

      logToFile(`[error] Receipt handling failed: ${err.message}`);

      if (!res.headersSent) {
        return sendReply(res, 'There was an error uploading your receipt. Please try again later.');
      }
    }
  }




  if (/help/i.test(body)) {
    return sendReply(res, defaultMessage);
  }

  if (/stop/i.test(body)) {
    return sendReply(res, 'You have exited the chatbot. Type *help* to return anytime.');
  }

  
  if (isMatch(text, [
    /^1$/,
    /upload/,
    /send.*receipt/,
    /submit.*receipt/,
    /receipt/,
    /photo/,
    /image/
    ])) {
      console.log("upload receipt")
    await updateChatState(from, { expectingImage: true });
    return sendReply(res, 'Please upload your receipt image now 📸');
  }

  // if (isMatch(text, [
  //   /^2$/,
  //   /history/,
  //   /orders?/,
  //   /purchases?/,
  //   /my receipts/,
  //   /past receipts/
  //   ])) {
  //   try {
  //     const receipts = await getPurchaseHistory(profileId);

  //     if (!receipts?.length) {
  //       return sendReply(res, 'No purchase history found yet.');
  //     }

  //     const list = receipts
  //       .map(r => `🛒 ${new Date(r.date_uploaded).toLocaleDateString()} — ${r.receipt_image}`)
  //       .join('\n');

  //     return sendReply(res, `Here is your purchase history:\n\n${list}`);

  //   } catch (err) {
  //     logToFile(`[error] Fetch receipts failed: ${err.message}`);
  //     return sendReply(res, 'There was an error fetching your purchase history.');
  //   }
  // }

  if (isMatch(text, [
    /^2$/,
    /points?/,
    /loyalty/,
    /rewards?/,
    /balance/,
    /my points/
  ])) {
    try {
      const profile = await getLoyaltyPoints(profileId);

      const points = profile.loyalty_points || 0;
      const rewards = Array.isArray(profile.rewards) ? profile.rewards : [];

      let rewardMessage = 'None available at the moment.';

      if (rewards.length > 0) {
        rewardMessage = rewards
          .map(r => {
            const canRedeem = points >= r.points_cost && r.current_quantity > 0;
            const status = r.current_quantity <= 0
              ? '❌ Out of stock'
              : canRedeem
                ? '✅ Redeemable'
                : `Need ${r.points_cost - points} more pts`;

            return `• ${r.name}\n   Cost: ${r.points_cost} pts\n   Stock: ${r.current_quantity}\n   ${status}`;
          })
          .join('\n\n');
      }

      return sendReply(
        res,
        `⭐ *Your Loyalty Points:* ${points}\n\n🎁 *Available Rewards:*\n${rewardMessage}`
      );

    } catch (err) {
      logToFile(`[error] Loyalty lookup failed: ${err.message}`);
      return sendReply(res, 'There was an error retrieving your loyalty information.');
    }
  }

  if (isMatch(text, [
    /^3$/,
    /agent/,
    /support/,
    /help me/,
    /talk to/,
    /contact/
    ])) {
    return sendReply(res, '💬 Please send your issue to support@naturellving.com');
  }

  if (isMatch(text, [
    /^4$/,
    /promo/,
    /promotion/,
    /promotions/,
    /offer/,
    /offers/,
    /discount/,
    /deals?/
  ])) {

    try {

      const data = await getPromotions();
      const promotions = data.promotions || [];

      if (!promotions.length) {
        return sendReply(res, "🎉 There are no active promotions at the moment.");
      }

      const twiml = new MessagingResponse();

      promotions.forEach(promo => {

        let message = `🎉 *${promo.title}*\n\n`;

        if (promo.content) {
          const cleanContent = htmlToText(promo.content, {
            wordwrap: false
          });

          message += `${cleanContent}\n\n`;
        }

        if (promo.expiry_date) {
          message += `⏳ Valid until: ${promo.expiry_date}\n\n`;
        }

        if (promo.promo_link) {
          message += `🔗 ${promo.promo_link}`;
        }

        const msg = twiml.message(message);

        // If media exists → attach it
        if (promo.media && promo.media.url) {
          msg.media(promo.media.url);
        }
      });

      return res.type('text/xml').send(twiml.toString());

    } catch (err) {
      logToFile(`[error] Promotion lookup failed: ${err.message}`);
      return sendReply(res, 'There was an error retrieving promotions.');
    }
  }



    //   fallback
  return sendReply(res, defaultMessage);
});

async function processReceiptFilesAsync(files, phone, profileId) {

  let receiptId = null;

  try {

    logToFile(`[info] Processing ${files.length} receipt file(s) for ${phone}`);

    const imageBuffers = [];

    // 1️⃣ Download and normalize files
    for (const file of files) {

      const buffer = await fetchImageFromTwilio(file.url);

      if (file.type === "image") {

        imageBuffers.push(buffer);

      } else if (file.type === "pdf") {

        logToFile(`[info] Converting PDF to images for ${phone}`);

        // ⚠️ You must implement this helper
        const pdfPages = await convertPdfToImages(buffer);

        for (const pageBuffer of pdfPages) {
          imageBuffers.push(pageBuffer);
        }

      } else {

        logToFile(`[warn] Unsupported file type during processing: ${file.type}`);
      }
    }

    if (imageBuffers.length === 0) {
      throw new Error("No valid receipt images found after processing.");
    }

    // 2️⃣ Upload + OCR + Fraud pipeline
    const result = await uploadReceiptImages(
      imageBuffers,
      `receipt_${profileId}_${Date.now()}.jpg`,
      profileId
    );

    logToFile(
      `[info] Processing complete. Fraud score: ${result.fraud_result.score}, Decision: ${result.fraud_result.decision}`
    );

    // 3️⃣ Send menu after slight delay
    // setTimeout(async () => {
    //   try {
    //     await client.messages.create({
    //       from: 'whatsapp:+15557969091',
    //       to: `whatsapp:${phone}`,
    //       body: defaultMessage
    //     });

    //     logToFile(`[info] Menu sent to ${phone}`);

    //   } catch (menuErr) {
    //     logToFile(`[error] Menu send failed: ${menuErr.message}`);
    //   }
    // }, 2000);

  } catch (error) {

    logToFile(`[error] Receipt processing failed: ${error.message}`);
    logToFile(`[error] Stack: ${error.stack}`);

    try {
      await client.messages.create({
        from: 'whatsapp:+15557969091',
        to: `whatsapp:${phone}`,
        body: '❌ There was an error processing your receipt. Please try uploading again or contact support.'
      });

    } catch (sendErr) {
      logToFile(`[error] Failed to send error message: ${sendErr.message}`);
    }
  }
}

async function convertPdfToImages(pdfBuffer) {
  try {
    const converter = fromBuffer(pdfBuffer, {
      density: 150,
      format: "jpeg",
      width: 1200,
      height: 1600,
      quality: 100
    });

    const result = await converter.bulk(-1); // -1 = convert ALL pages

    // result = array of objects with base64
    const imageBuffers = result.map(page =>
      Buffer.from(page.base64, "base64")
    );

    return imageBuffers;

  } catch (err) {
    console.error("PDF conversion failed:", err.message);
    throw err;
  }
}

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")     // convert <br> to newline
    .replace(/<\/p>/gi, "\n\n")        // paragraph spacing
    .replace(/<[^>]*>?/gm, "")         // remove remaining tags
    .replace(/&amp;/g, "&")            // decode common entities
    .trim();
}

// app.post('/whatsapp/notify-user', async (req, res) => {
//   try {
//     const { phone, message, receipt_id, use_template, template_name, template_params } = req.body;
//     console.log(use_template, template_name, template_params, use_template && template_name)
    
//     if (!phone) {
//       return res.status(400).json({ success: false, message: 'Missing phone' });
//     }

//     if (!use_template && !message) {
//       return res.status(400).json({ success: false, message: 'Missing message' });
//     }

//     if (use_template && template_name) {
//       // Using Twilio Content API with approved template
//       console.log("otp content template")
//       const twilioMessage = await client.messages.create({
//         from: 'whatsapp:+15557969091',
//         to: `whatsapp:${phone}`,
//         contentSid: 'HXdcdd359845fc13bcb68c13031cdfb9b1', 
//         contentVariables: JSON.stringify({
//           '1': template_params[0] // OTP code
//         })
//       });
      
//       logToFile(`[info] Template OTP sent to ${phone}. SID: ${twilioMessage.sid}`);
//     } else {
      
//       // Send WhatsApp message
//       await client.messages.create({
//         from: 'whatsapp:+15557969091', 
//         to: `whatsapp:${phone}`,
//         body: message
//      });

//      res.json({ 
//       success: true, 
//       message: 'Notification is being sent...'
//     });
    
//     logToFile(`[info] Notification sent to ${phone} for receipt ${receipt_id}`);
//   }
    
//     // res.json({ success: true, message: 'Notification sent' });
//   } catch (error) {
//     logToFile(`[error] Notification failed: ${error.message}`);
//     if (!res.headersSent) {
//       return res.status(500).json({
//         success: false,
//         message: error.message
//       });
//     }
//   }
// });


const TEMPLATE_MAP = {
  otp_login: {
    contentSid: 'HXa83dae8644668753ede2d6399d240a1a'
  },
  receipt_processed: {
    contentSid: 'HXcbc467bb689e70d6ef952e1bbbb67a3a'
  },
  loyalty_points_earned: {
    contentSid: 'HXfdfbba9819f103e0fae544997350cf3b'
  },
  reward_redemption: {
    contentSid: 'HX1a299b161936b0281ed4c7dcd24ea434'
  },
  reward_request_confirmation: {
    contentSid: 'HX9e0b92c8b13caeabb78b729271aa744b'
  },
  reward_cancelled: {
    contentSid: 'HXf5e41934c379fceca43bfb2f80d68c17'
  },
  reward_pending: {
    contentSid: 'HX68824005f8e305ccd2b2e8de1f51b2af'
  },
  how_to_use_service: {
    contentSid: 'HXd87581d945c882e6dfd46a1b4094f789'
  }
};

app.post('/whatsapp/notify-user', async (req, res) => {
  try {
    const {
      phone,
      message,
      receipt_id,
      use_template,
      template_name,
      template_params = []
    } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: 'Missing phone'
      });
    }

    let twilioResponse;
    let usedFallback = false;

    
    if (use_template && template_name && TEMPLATE_MAP[template_name]) {
      try {
     
        const contentVariables = {};
        template_params.forEach((value, index) => {
          contentVariables[String(index + 1)] = String(value);
        });

        console.log(
          'Using template:',
          template_name,
          contentVariables
        );

        twilioResponse = await client.messages.create({
          from: 'whatsapp:+15557969091',
          to: `whatsapp:${phone}`,
          contentSid: TEMPLATE_MAP[template_name].contentSid,
          contentVariables: JSON.stringify(contentVariables)
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
          message: 'Missing message for fallback delivery'
        });
      }

      twilioResponse = await client.messages.create({
        from: 'whatsapp:+15557969091',
        to: `whatsapp:${phone}`,
        body: message
      });

      logToFile(
        `[info] Text message sent to ${phone} for receipt ${receipt_id}`
      );
    }

    res.json({
      success: true,
      sid: twilioResponse.sid,
      fallback_used: usedFallback
    });


    // Wait a moment before sending the menu (so messages arrive in order)
    // setTimeout(async () => {
    //   try {
    //     await client.messages.create({
    //       from: 'whatsapp:+15557969091',
    //       to: `whatsapp:${phone}`,
    //       body: defaultMessage // Send as regular message, not using sendReply
    //     });
        
    //     logToFile(`[info] Default menu sent to ${phone}`);
    //   } catch (menuError) {
    //     logToFile(`[error] Failed to send default menu to ${phone}: ${menuError.message}`);
    //   }
    // }, 1500); // 1.5 second delay

    
    return;

  } catch (error) {
    logToFile(`[error] Notification failed: ${error.message}`);

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
});



app.listen(3000, () => {
  console.log('Express server listening on port 3000');
});
