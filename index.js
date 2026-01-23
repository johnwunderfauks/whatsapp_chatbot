const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
require('dotenv').config();
const { job } = require('./keepAlive');
const receiptTimers = new Map();


const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const defaultMessage = `Here's what you can do:

1️⃣ Upload a receipt
2️⃣ View purchase history
3️⃣ Check loyalty points & rewards
4️⃣ Contact support agent

Type *help* to see this again.`;

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

    // const numMedia = parseInt(req.body.NumMedia);
    // logToFile(`[info] Received ${numMedia} image(s) from ${from}`);

    // try {
    //   // ✅ Send immediate acknowledgment
    //   if (numMedia === 1) {
    //     sendReply(res, '📸 Receipt received! Processing your image now...');
    //   } else {
    //     sendReply(res, `📸 Received ${numMedia} images! Processing your receipt now...`);
    //   }
      
    //   // ✅ Clear state
    //   await updateChatState(from, { expectingImage: false });
      
    //   // ✅ Collect all media URLs
    //   const mediaUrls = [];
    //   for (let i = 0; i < numMedia; i++) {
    //     const mediaUrl = req.body[`MediaUrl${i}`];
    //     if (mediaUrl) {
    //       mediaUrls.push(mediaUrl);
    //     }
    //   }
      
    //   logToFile(`[info] Processing ${mediaUrls.length} images for ${from}`);
      
    //   // ✅ Process all images in background
    //   processReceiptImagesAsync(mediaUrls, from, profileId).catch(err => {
    //     logToFile(`[error] Background processing failed: ${err.message}`);
    //   });
      
    //   return;

    // } catch (err) {
    //   logToFile(`[error] Receipt handling failed: ${err.message}`);
      
    //   if (!res.headersSent) {
    //     return sendReply(res, 'There was an error uploading your receipt. Please try again later.');
    //   }
    // }

    const mediaUrl = req.body.MediaUrl0;

    try {
      // 1️⃣ Acknowledge ONLY ON FIRST IMAGE
      if (!state.receiptImages || state.receiptImages.length === 0) {
        sendReply(res, '📸 Receipt image received. We will process and review the submission.');
      }

      // 2️⃣ Append image to state
      const images = Array.isArray(state.receiptImages)
        ? [...state.receiptImages, mediaUrl]
        : [mediaUrl];

      await updateChatState(from, {
        receiptImages: images
      });

      logToFile(`[info] Collected ${images.length} receipt image(s) from ${from}`);

      // 3️⃣ Reset processing timer
      if (receiptTimers.has(from)) {
        clearTimeout(receiptTimers.get(from));
      }

      const timer = setTimeout(async () => {
        const finalState = await getChatState(from);
        const finalImages = finalState.receiptImages || [];

        logToFile(`[info] Processing ${finalImages.length} images for ${from}`);

        // ✅ Clear state BEFORE processing
        await updateChatState(from, {
          expectingImage: false,
          receiptImages: []
        });

        receiptTimers.delete(from);

        // ✅ Process ONCE
        processReceiptImagesAsync(finalImages, from, profileId).catch(err => {
          logToFile(`[error] Background processing failed: ${err.message}`);
        });

      }, 2000); // ⏱️ wait 2 seconds after last image

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

  if (isMatch(text, [
    /^2$/,
    /history/,
    /orders?/,
    /purchases?/,
    /my receipts/,
    /past receipts/
    ])) {
    try {
      const receipts = await getPurchaseHistory(profileId);

      if (!receipts?.length) {
        return sendReply(res, 'No purchase history found yet.');
      }

      const list = receipts
        .map(r => `🛒 ${new Date(r.date_uploaded).toLocaleDateString()} — ${r.receipt_image}`)
        .join('\n');

      return sendReply(res, `Here is your purchase history:\n\n${list}`);

    } catch (err) {
      logToFile(`[error] Fetch receipts failed: ${err.message}`);
      return sendReply(res, 'There was an error fetching your purchase history.');
    }
  }

  if (isMatch(text, [
    /^3$/,
    /points?/,
    /loyalty/,
    /rewards?/,
    /balance/,
    /my points/
    ])) {
    try {
      const profile = await getLoyaltyPoints(profileId);

      return sendReply(
        res,
        `⭐ Loyalty Points: ${profile.loyalty_points}\n🎁 Rewards: ${profile.rewards || 'None yet'}`
      );

    } catch (err) {
      logToFile(`[error] Loyalty lookup failed: ${err.message}`);
      return sendReply(res, 'There was an error retrieving your loyalty information.');
    }
  }

  if (isMatch(text, [
    /^4$/,
    /agent/,
    /support/,
    /help me/,
    /talk to/,
    /contact/
    ])) {
    return sendReply(res, '💬 A support agent will contact you shortly.');
  }

    //   fallback
  return sendReply(res, defaultMessage);
});

async function processReceiptImagesAsync(mediaUrls, phone, profileId) {
  let receiptId = null;
  const additionalImageIds = [];
  try {
    logToFile(`[info] Processing ${mediaUrls.length} receipt images for ${phone}`);
    
    
    const imageBuffers = [];

    // 1️⃣ Download images
    for (const url of mediaUrls) {
      const buffer = await fetchImageFromTwilio(url);
      imageBuffers.push(buffer);
    }
    
    const result = await uploadReceiptImages(
      imageBuffers,
      `receipt_${profileId}_${Date.now()}.jpg`,
      profileId
    );
    
    logToFile(`[info] Processing complete. Fraud score: ${result.fraud_result.score}, Decision: ${result.fraud_result.decision}`);
    
    
    setTimeout(async () => {
      try {
        await client.messages.create({
          from: 'whatsapp:+15557969091',
          to: `whatsapp:${phone}`,
          body: defaultMessage
        });
        logToFile(`[info] Menu sent to ${phone}`);
      } catch (menuErr) {
        logToFile(`[error] Menu send failed: ${menuErr.message}`);
      }
    }, 2000);
    
  } catch (error) {
    console.log(error)
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


    // Wait a moment before sending the menu (so messages arrive in order)
    setTimeout(async () => {
      try {
        // await client.messages.create({
        //   from: 'whatsapp:+15557969091',
        //   to: `whatsapp:${phone}`,
        //   contentSid: TEMPLATE_MAP["how_to_use_service"].contentSid,
        // });
        sendReply(res, defaultMessage);
        
        logToFile(`[info] Default menu sent to ${phone}`);
      } catch (menuError) {
        logToFile(`[error] Failed to send default menu to ${phone}: ${menuError.message}`);
      }
    }, 1500); // 1.5 second delay

    
    return res.json({
      success: true,
      sid: twilioResponse.sid,
      fallback_used: usedFallback
    });

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
