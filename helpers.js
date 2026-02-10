const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const FormData = require('form-data');
const { Readable } = require('stream');
const vision = require('@google-cloud/vision');
const visionClient = new vision.ImageAnnotatorClient();
const crypto = require('crypto');

const chatStateStore = new Map();
const { analyzeImageMetadata, checkImageQuality } = require('./fraud-detection/metadata-check');
const { matchMerchantTemplate } = require('./fraud-detection/merchant-templates');
const { validateReceiptWithOpenAI } = require('./fraud-detection/openai-validator');
const { calculateFraudScore } = require('./fraud-detection/scoring');

const {
  WP_USER,
  WP_PASS,
  WP_APP_PASSWORD,
  WP_URL = 'https://wunderfauksw18.sg-host.com/'
} = process.env;

const receiptFraudSignals = {
    nonEnglish: false,
    nonSingapore: false,
    dateOutOfRange: false,
    redFlags: []
};


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
  // console.log(WP_APP_PASSWORD)
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');
  // return data.token;
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
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
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
- receipt_id (string)
- store_name (string)
- purchase_date (string, format: YYYY-MM-DD if possible)
- total_amount (string, number only)
- items (array of strings, item names with prices if visible)
- currency (string, e.g. "USD", "THB")

Example: {"receipt_id": "12345","store_name":"7-Eleven","purchase_date":"2024-01-15","total_amount":"150.50","items":["Water 15.00","Sandwich 35.50"],"currency":"THB"}`
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

    console.log(cleanText)
    
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
  try {
    const token = getJwtToken();
    const response = await axios.post(
      `${WP_URL}/wp-json/custom/v1/store-whatsapp-user`,
      { phone, name },
      {
        headers: {
          Authorization: `Basic ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'WhatsApp-Bot/1.0'
        }
      }
    );


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

async function analyzeMultipleImages(imageBuffers) {
  const results = [];

  for (let i = 0; i < imageBuffers.length; i++) {
    const buffer = imageBuffers[i];

    const meta = await analyzeImageMetadata(buffer);
    const quality = await checkImageQuality(buffer);
    const hash = getImageHash(buffer);

    results.push({
      index: i,
      isPrimary: i === 0,
      meta,
      quality,
      hash
    });
  }

  return results;
}


async function uploadReceiptImages(imageBuffers, filenames, profileId) {
  if (!profileId) throw new Error('Profile ID is not defined');

  const token = getJwtToken();
  logToFile(`[fraud] Starting MULTI-IMAGE fraud detection pipeline...`);

  // =============================
  // 1️⃣ PER-IMAGE ANALYSIS
  // =============================
  const imageAnalyses = [];
  const ocrResults = [];

  for (let i = 0; i < imageBuffers.length; i++) {
    const buffer = imageBuffers[i];
    const isPrimary = i === 0;

    logToFile(`[fraud] Analyzing image ${i + 1}/${imageBuffers.length}`);

    const metaSignals = await analyzeImageMetadata(buffer);
    const qualityCheck = await checkImageQuality(buffer);
    const imageHash = getImageHash(buffer);
    const rawText = await extractReceiptText(buffer);

    imageAnalyses.push({
      index: i,
      isPrimary,
      metaSignals,
      qualityCheck,
      imageHash
    });

    ocrResults.push({
      index: i,
      text: rawText
    });

    logToFile(
      `[fraud] Image ${i + 1}: flags=${metaSignals.redFlags.length}, tooPerfect=${qualityCheck.tooPerfect}`
    );
  }


  // =============================
  // 3️⃣ OCR MERGE (ALL IMAGES)
  // =============================
  const combinedOCR = ocrResults
    .map(r => r.text)
    .join('\n\n---\n\n');

  logToFile(`[info] Combined OCR length: ${combinedOCR.length}`);

  // =============================
  //  MERCHANT TEMPLATE CHECK
  // =============================
  const templateCheck = matchMerchantTemplate(combinedOCR, 'SG');
  logToFile(`[fraud] Template matched=${templateCheck.matched}, score=${templateCheck.score}`);

  // =============================
  //  OPENAI SEMANTIC CHECK
  // =============================
  const merchantCandidates = templateCheck.template
    ? [templateCheck.template.displayName]
    : [];

  const openAiAssessment = await validateReceiptWithOpenAI(
    combinedOCR,
    'SG',
    merchantCandidates
  );

  logToFile(`[fraud] OpenAI likelihood=${openAiAssessment.fraud_likelihood}`);


  if (!isMostlyEnglish(combinedOCR)) {
    receiptFraudSignals.nonEnglish = true;
    // receiptFraudSignals.redFlags.push('Receipt language is not English');
  }

  // =============================
  //  PARSE + STORE RECEIPT
  // =============================
  const parsed = await parseReceipt(combinedOCR);

  // =============================
  //  AGGREGATE IMAGE FRAUD
  // =============================
  const imageFraudSummary = await summarizeImageFraudSignals(imageAnalyses,parsed,WP_URL,WP_APP_PASSWORD);
  
  console.log(imageFraudSummary)

  if (
    parsed.currency !== 'SGD' &&
    !looksLikeSingapore(combinedOCR)
  ) {
    receiptFraudSignals.nonSingapore = true;
    // receiptFraudSignals.redFlags.push('Receipt does not appear to be from Singapore');
  }

  if (!isWithinLastTwoWeeks(parsed.purchase_date)) {
    receiptFraudSignals.dateOutOfRange = true;
    // receiptFraudSignals.redFlags.push('Receipt date is older than 14 days');
  }

  // =============================
  //  FINAL FRAUD SCORE
  // =============================
  const fraudResult = await calculateFraudScore({
    imageFraudSummary,
    templateCheck,
    openAiAssessment,
    receiptFraudSignals,
    wpUrl: WP_URL,
    wpAuth: token
  });

  logToFile(`[fraud] DECISION=${fraudResult.decision}, score=${fraudResult.score}`);

  // =============================
  //  UPLOAD PRIMARY IMAGE
  // =============================
  const primaryForm = new FormData();
  primaryForm.append(
    'file',
    bufferToStream(imageBuffers[0]),
    { filename: filenames[0], contentType: 'image/jpeg' }
  );

  primaryForm.append('profile_id', profileId);
  primaryForm.append('total_images', imageBuffers.length);

  const uploadResponse = await axios.post(
    `${WP_URL}/wp-json/custom/v1/upload`,
    primaryForm,
    {
      headers: {
        Authorization: `Basic ${token}`,
        ...primaryForm.getHeaders()
      }
    }
  );

  const receiptId = uploadResponse.data.receipt_id;
  logToFile(`[info] Primary image uploaded. receipt_id=${receiptId}`);

  // =============================
  //  UPLOAD ADDITIONAL IMAGES
  // =============================
  if (imageBuffers.length > 1) {
    for (let i = 1; i < imageBuffers.length; i++) {
      const extraForm = new FormData();
      extraForm.append(
        'file',
        bufferToStream(imageBuffers[i]),
        { filename: filenames[i], contentType: 'image/jpeg' }
      );
      extraForm.append('receipt_id', receiptId);
      extraForm.append('index', i);

      await axios.post(
        `${WP_URL}/wp-json/custom/v1/upload`,
        extraForm,
        {
          headers: {
            Authorization: `Basic ${token}`,
            ...extraForm.getHeaders()
          }
        }
      );
    }
  }

  

  await axios.post(
    `${WP_URL}/wp-json/custom/v1/receipt/${receiptId}`,
    {
      profile_id: profileId,
      receipt_id: parsed.receipt_id || 'Unknown Receipt ID',
      store_name: parsed.store_name || 'Unknown Store',
      purchase_date: parsed.purchase_date || null,
      total_amount: parsed.total_amount || null,
      currency: parsed.currency || 'SGD',
      items: parsed.items || [],
      raw_text: combinedOCR,

      // Fraud data
      fraud_score: fraudResult.score,
      fraud_decision: fraudResult.decision,
      fraud_reasons: fraudResult.reasons,
      image_fraud_summary: imageFraudSummary,
      per_image_analysis: imageAnalyses
    },
    {
      headers: {
        Authorization: `Basic ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return {
    receipt_id: receiptId,
    parsed_data: parsed,
    fraud_result: fraudResult,
    openai_assessment: openAiAssessment,
    total_images: imageBuffers.length
  };
}

async function summarizeImageFraudSignals(
  imageAnalyses,
  parsed,
  wpUrl,
  wpAuth
) {
  const summary = {
    anyAiDetected: false,
    anyTooPerfect: false,
    duplicateImages: false,
    duplicateInSystem: false,
    redFlags: [],
    imageCount: imageAnalyses.length
  };

  const localHashes = new Set();

  for (const img of imageAnalyses) {

    // ======================
    // AI software detection
    // ======================
    if (img.metaSignals.aiSoftwareTag) {
      summary.anyAiDetected = true;
      summary.redFlags.push(
        `Image ${img.index + 1}: AI software detected (${img.metaSignals.softwareName || 'unknown'})`
      );
    }

    // ======================
    // Quality check
    // ======================
    if (img.qualityCheck.tooPerfect) {
      summary.anyTooPerfect = true;
      summary.redFlags.push(
        `Image ${img.index + 1}: Unusually clean / low noise`
      );
    }

    // ======================
    // Local duplicate check
    // ======================
    if (localHashes.has(img.imageHash)) {
      summary.duplicateImages = true;
      summary.redFlags.push(
        `Image ${img.index + 1}: Duplicate image in same upload`
      );
    }
    localHashes.add(img.imageHash);

    // ======================
    // Cross-system duplicate check
    // ======================
    // console.log("wp url",wpUrl)
    const existsInSystem = await checkDuplicateHash(
      parsed.receipt_id,
      wpUrl,
      wpAuth
    );

    if (existsInSystem) {
      summary.duplicateInSystem = true;
      summary.redFlags.push(
        `Image ${img.index + 1}: Previously used receipt image`
      );
    }

    // ======================
    // Metadata red flags
    // ======================
    if (img.metaSignals.redFlags?.length) {
      for (const flag of img.metaSignals.redFlags) {
        summary.redFlags.push(
          `Image ${img.index + 1}: ${flag}`
        );
      }
    }
  }

  // De-duplicate messages
  summary.redFlags = [...new Set(summary.redFlags)];

  return summary;
}



async function getPurchaseHistory(profileId) {
  const token = getJwtToken();
  
  console.log('========================================');
  console.log('📋 GET PURCHASE HISTORY DEBUG');
  console.log('========================================');
  console.log('Profile ID:', profileId);
  console.log('WP_URL:', WP_URL);
  console.log('Token:', token ? `${token.substring(0, 20)}...` : 'NULL');
  console.log('Full URL:', `${WP_URL}/wp-json/custom/v1/receipts?profile_id=${profileId}`);
  
  try {
    const { data } = await axios.get(
      `${WP_URL}/wp-json/custom/v1/receipts`,
      {
        params: { profile_id: profileId },
        headers: { 
          Authorization: `Basic ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'WhatsApp-Bot/1.0'
        }
      }
    );
    
    console.log('✅ Request successful');
    console.log('Response data:', JSON.stringify(data, null, 2));
    console.log('Number of receipts:', data?.receipts?.length || 0);
    console.log('========================================\n');
    
    return data;
    
  } catch (error) {
    console.error('❌ GET PURCHASE HISTORY ERROR');
    console.error('Error message:', error.message);
    console.error('Error code:', error.code);
    
    if (error.response) {
      // Server responded with error
      console.error('Response status:', error.response.status);
      console.error('Response data:', JSON.stringify(error.response.data, null, 2));
      console.error('Response headers:', error.response.headers);
    } else if (error.request) {
      // Request made but no response
      console.error('No response received');
      console.error('Request details:', error.request);
    } else {
      // Error setting up request
      console.error('Request setup error:', error.message);
    }
    
    console.error('Full error object:', error);
    console.log('========================================\n');
    
    throw error;
  }
}

async function getLoyaltyPoints(profileId) {
  const token = getJwtToken();
  
  console.log('========================================');
  console.log('💎 GET LOYALTY POINTS DEBUG');
  console.log('========================================');
  console.log('Profile ID:', profileId);
  console.log('WP_URL:', WP_URL);
  console.log('Token:', token ? `${token.substring(0, 20)}...` : 'NULL');
  console.log('Full URL:', `${WP_URL}/wp-json/custom/v1/user-profile?profile_id=${profileId}`);
  
  try {
    const { data } = await axios.get(
      `${WP_URL}/wp-json/custom/v1/user-profile`,
      {
        params: { profile_id: profileId },
        headers: { 
          Authorization: `Basic ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'WhatsApp-Bot/1.0'
        }
      }
    );
    
    console.log('✅ Request successful');
    console.log('Response data:', JSON.stringify(data, null, 2));
    console.log('Loyalty points:', data?.loyalty_points || 0);
    console.log('User name:', data?.name || 'N/A');
    console.log('========================================\n');
    
    return data;
    
  } catch (error) {
    console.error('❌ GET LOYALTY POINTS ERROR');
    console.error('Error message:', error.message);
    console.error('Error code:', error.code);
    
    if (error.response) {
      // Server responded with error
      console.error('Response status:', error.response.status);
      console.error('Response data:', JSON.stringify(error.response.data, null, 2));
      console.error('Response headers:', error.response.headers);
    } else if (error.request) {
      // Request made but no response
      console.error('No response received');
      console.error('Request details:', error.request);
    } else {
      // Error setting up request
      console.error('Request setup error:', error.message);
    }
    
    console.error('Full error object:', error);
    console.log('========================================\n');
    
    throw error;
  }
}


async function getAvailableRewards(profileId) {
  const token = getJwtToken();

  const { data } = await axios.get(
    `${WP_URL}/wp-json/custom/v1/rewards?profile_id=${profileId}`,
    { headers: { Authorization: `Basic ${token}`,'Content-Type': 'application/json',
          'User-Agent': 'WhatsApp-Bot/1.0' } }
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

async function checkDuplicateHash(receipt_id, wpUrl, wpAuth) {
  const token = getJwtToken();
  try {
    const response = await axios.post(
      `${WP_URL}/wp-json/custom/v1/check-duplicate-hash`,
      { receipt_id: receipt_id },
      {
        headers: {
          'Authorization': `Basic ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );
    
    return response.data.is_duplicate || false;
  } catch (error) {
    console.error('Duplicate check error:', error.message);
    return false;
  }
}

function getImageHash(imageBuffer) {
  return crypto.createHash('sha256').update(imageBuffer).digest('hex');
}


// basic level validators
function isMostlyEnglish(text) {
  if (!text) return false;

  // Remove numbers & punctuation first
  const lettersOnly = text.replace(/[^a-zA-Z\u0E00-\u0E7F\u4E00-\u9FFF]/g, '');

  if (!lettersOnly.length) return false;

  const englishLetters = lettersOnly.match(/[a-zA-Z]/g) || [];
  const englishRatio = englishLetters.length / lettersOnly.length;

  return englishRatio >= 0.7; // 70% English threshold
}

function looksLikeSingapore(text) {
  return /singapore|\bsg\b|\+65|\b\d{6}\b/i.test(text);
}

function isWithinLastTwoWeeks(dateStr) {
  if (!dateStr) return false;

  const receiptDate = new Date(dateStr);
  if (isNaN(receiptDate)) return false;

  const now = new Date();
  const diffDays = (now - receiptDate) / (1000 * 60 * 60 * 24);

  console.log(receiptDate, now, diffDays, diffDays >= 0 && diffDays <= 14)

  return diffDays >= 0 && diffDays <= 14;
}



module.exports = {
  getJwtToken,
  logToFile,
  getChatState,
  updateChatState,
  checkOrCreateUserProfile,
  uploadReceiptImages,
  getPurchaseHistory,
  getLoyaltyPoints,
  getAvailableRewards,
  fetchImageFromTwilio
};
