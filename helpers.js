const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const FormData = require('form-data');
const { Readable } = require('stream');
const vision = require('@google-cloud/vision');
const visionClient = new vision.ImageAnnotatorClient();

const chatStateStore = new Map();

const {
  WP_USER,
  WP_PASS,
  WP_APP_PASSWORD,
  WP_URL = 'https://wunderfauksw18.sg-host.com/'
} = process.env;


function getJwtToken() {
  // const { data } = await axios.post(
  //   `${WP_URL}/wp-json/jwt-auth/v1/token`,
  //   {
  //     username: WP_USER,
  //     password: WP_PASS
  //   },
  //   { headers: { 'Content-Type': 'application/json' } }
  // );
  // console.log(data)
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');
  return auth;
}

function bufferToStream(buffer) {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

async function extractReceiptText(imageBuffer) {
  const [result] = await visionClient.textDetection(imageBuffer);
  const text = result.fullTextAnnotation?.text || '';

  return text;
}

async function parseReceipt(rawText) {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{
          role: "system",
          content: "You are a receipt parser. Extract structured data and return ONLY valid JSON, no markdown, no explanations."
        }, {
          role: "user",
          content: `Parse this receipt text:

${rawText}

Return JSON with:
- store_name (string)
- purchase_date (string, format: YYYY-MM-DD if possible)
- total_amount (string, number only)
- items (array of strings, item names with prices if visible)
- currency (string, e.g. "USD", "THB")

Example: {"store_name":"7-Eleven","purchase_date":"2024-01-15","total_amount":"150.50","items":["Water 15.00","Sandwich 35.50"],"currency":"THB"}`
        }],
        temperature: 0,
        max_tokens: 500
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.choices[0].message.content.trim();
    
    // Remove markdown code blocks if present
    const cleanText = text.replace(/```json\n?|```\n?/g, '');
    
    return JSON.parse(cleanText);
    
  } catch (err) {
    logToFile(`[error] OpenAI parsing failed: ${err.message}`);
    throw err;
  }
}

function logToFile(message) {
  const logPath = path.resolve(__dirname, 'chatbot_logs.txt');
  const logMessage = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(logPath, logMessage, 'utf8');
}


async function getChatState(chatId) {
  return chatStateStore.get(chatId) || {};
}

async function updateChatState(chatId, update) {
  const currentState = chatStateStore.get(chatId) || {};
  chatStateStore.set(chatId, { ...currentState, ...update });
}

async function checkOrCreateUserProfile({ phone, name }) {
  console.log(phone,name)
  try {
    const token = getJwtToken();
    console.log(token)
    const response = await axios.post(
      `${WP_URL}/wp-json/custom/v1/store-whatsapp-user`,
      { phone, name },
      {
        headers: {
          Authorization: `Basic ${token}`
        }
      }
    );

    console.log(response)

    return {
      profileId:
        response.data.profileId ||
        response.data.post_id ||
        response.data.id,
      ...response.data
    };

  } catch (error) {
    console.error(
      'Error checking or creating user profile:',
      error.response?.data || error.message
    );
    throw new Error('Error checking or creating user profile.');
  }
}


async function uploadReceiptImage(imageBuffer,filename, profileId) {

  if (!profileId) throw new Error('Profile ID is not defined');

  const token = getJwtToken();

  const formData = new FormData();

  formData.append('file', bufferToStream(imageBuffer), {
    filename,
    contentType: 'image/jpeg'
  });
  formData.append('title', 'Receipt Upload');
  formData.append('alt_text', 'Uploaded receipt');
  formData.append('description', 'Receipt image uploaded by user');
  formData.append('profile_id', profileId);

  try {
    const uploadResponse = await axios.post(
      `${WP_URL}/wp-json/custom/v1/upload`,
      formData,
      {
        headers: {
          Authorization: `Basic ${token}`,
          ...formData.getHeaders()
        }
      }
    );

    logToFile(`[info] WP upload success: ${JSON.stringify(uploadResponse.data)}`);

    // 2️⃣ Extract text with Google Vision
    const rawText = await extractReceiptText(imageBuffer);
    logToFile(`[info] Raw OCR text: ${rawText}`);

    // 3️⃣ Parse with OpenAI
    const parsed = await parseReceipt(rawText);
    logToFile(`[info] Parsed receipt: ${JSON.stringify(parsed)}`);

    // 4️⃣ Store parsed data in WordPress
    const receiptId = uploadResponse.data.receipt_id; // This comes from your upload response

    try {
      const updateResponse = await axios.post(
        `${WP_URL}/wp-json/custom/v1/receipt/${receiptId}`,
        {
          profile_id: profileId,
          store_name: parsed.store_name || 'Unknown Store',
          purchase_date: parsed.purchase_date || null,
          total_amount: parsed.total_amount || null,
          currency: parsed.currency || 'THB',
          items: parsed.items || [],
          raw_text: rawText
        },
        {
          headers: {
            Authorization: `Basic ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      logToFile(`[info] Receipt details stored: ${JSON.stringify(updateResponse.data)}`);
      
      return {
        success: true,
        receipt_id: receiptId,
        receipt_data: parsed,
        wordpress_response: updateResponse.data
      };

    } catch (updateError) {
      logToFile(`[error] Failed to store receipt details: ${updateError.message}`);
      // Still return success since image was uploaded, just log the error
      return {
        success: true,
        receipt_id: receiptId,
        receipt_data: parsed,
        note: 'Image uploaded but details storage failed'
      };
  }

  } catch (err) {
    logToFile(`[error] Error uploading image to WordPress: ${err.message}`);
    throw new Error('Failed to upload image to WordPress');
  }
}

async function getPurchaseHistory(profileId) {
  const token = getJwtToken();

  const { data } = await axios.get(
    `${WP_URL}/wp-json/custom/v1/receipts`,
    {params: { profile_id: profileId }, headers: { Authorization: `Basic ${token}` } }
  );

  return data;
}

async function getLoyaltyPoints(profileId) {
  const token = getJwtToken();

  const { data } = await axios.get(
    `${WP_URL}/wp-json/custom/v1/user-profile`,
    {params: { profile_id: profileId }, headers: { Authorization: `Basic ${token}` } }
  );

  return data;
}


async function getAvailableRewards(profileId) {
  const token = getJwtToken();

  const { data } = await axios.get(
    `${WP_URL}/wp-json/custom/v1/rewards?profile_id=${profileId}`,
    { headers: { Authorization: `Basic ${token}` } }
  );

  return data;
}

async function fetchImageFromTwilio(mediaUrl) {
  logToFile(`[info] Fetching image from Twilio: ${mediaUrl}`);

  try {
    const res = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN
      }
    });

    return res.data; 
  } catch (err) {
    logToFile(`[error] Failed to fetch Twilio image: ${err.message}`);
    throw new Error('Failed to download media from Twilio');
  }
}

module.exports = {
  getJwtToken,
  logToFile,
  getChatState,
  updateChatState,
  checkOrCreateUserProfile,
  uploadReceiptImage,
  getPurchaseHistory,
  getLoyaltyPoints,
  getAvailableRewards,
  fetchImageFromTwilio
};
