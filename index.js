const express = require('express');
const bodyParser = require('body-parser');
const { MessagingResponse } = require('twilio').twiml;
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
require('dotenv').config();
const { job } = require('./keepAlive');

job.start();
console.log('🔄 Keep-alive job started (pings every 14 minutes)');

const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const {
  logToFile,
  getChatState,
  updateChatState,
  checkOrCreateUserProfile,
  uploadReceiptImage,
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

  console.log(from)


  const state = await getChatState(from);


  if (state.expectingImage && req.body.NumMedia === '1') {

    const mediaUrl = req.body.MediaUrl0;
    logToFile(`[info] Twilio receipt media received: ${mediaUrl}`);

    try {
        
        const imageBuffer = await fetchImageFromTwilio(mediaUrl);

        
        await uploadReceiptImage(
        imageBuffer,
        `receipt_${profileId}_${Date.now()}.jpg`,
        profileId
        );

        
        await updateChatState(from, { expectingImage: false });


        return sendReply(
        res,
        '🧾 Thank you — your receipt has been uploaded successfully. Our team will review it shortly.'
        );

    } catch (err) {
        logToFile(`[error] Receipt upload failed: ${err.message}`);
        return sendReply(res, 'There was an error uploading your receipt. Please try again later.');
    }
  }

  
  const defaultMessage = `Here’s what you can do:

1️⃣ Upload a receipt
2️⃣ View purchase history
3️⃣ Check loyalty points & rewards
4️⃣ Contact support agent

Type *help* to see this again.`;

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
    contentSid: 'HX847815afd920cc7ca6f554c06dd46759'
  },
  receipt_processed: {
    contentSid: 'HXd7bf38a282b67d30bb3a0c98cbebeafb'
  },
  loyalty_points_earned: {
    contentSid: 'HXcf05356c153974ef490f326741cd174e'
  },
  reward_redemption: {
    contentSid: 'HXb7de458f1be8cb80bb085fc65671836d'
  },
  reward_fulfilled: {
    contentSid: 'HXd19dff3b867b2341dcac59c17556ac98'
  },
  reward_cancelled: {
    contentSid: 'HX19116ef948a322a0040b8fe20cc572ab'
  },
  reward_pending: {
    contentSid: 'HX2ac8f2a3bde6d15a91d42d07ce2264c5'
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

    // =============================
    // 1️⃣ Try template if requested
    // =============================
    if (use_template && template_name && TEMPLATE_MAP[template_name]) {
      try {
        // Build contentVariables: { "1": "...", "2": "..." }
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
        // 🚨 Template failed → fallback to text
        usedFallback = true;

        logToFile(
          `[warn] Template "${template_name}" failed for ${phone}: ${templateError.message}. Falling back to text message.`
        );
      }
    } else if (use_template) {
      // Template requested but invalid
      usedFallback = true;
      logToFile(
        `[warn] Invalid or missing template_name "${template_name}". Falling back to text message.`
      );
    }

    // =============================
    // 2️⃣ Fallback / normal message
    // =============================
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

    // =============================
    // 3️⃣ Final response (ONCE)
    // =============================
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
