const axios = require('axios');

/**
 * parseAndValidateReceipt
 *
 * Combines receipt parsing + fraud openAiAssessment into a single OpenAI call.
 * Previously two separate calls (parseReceipt + validateReceiptWithOpenAI),
 * now returns both parsed data and fraud analysis together.
 *
 * @param {string} rawText              - Raw OCR text from receipt image
 * @param {string} countryHint          - e.g. 'SG', 'TH'
 * @param {string[]} merchantCandidates - Optional known merchant names to match against
 *
 * @returns {object} { parsed, openAiAssessment }
 */
async function parseAndValidateReceipt(rawText, countryHint = 'SG', merchantCandidates = []) {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a receipt parser and fraud detection system combined.
Your job is to extract structured receipt data AND assess fraud risk in a single pass.
Return ONLY valid JSON. No markdown, no explanations outside the JSON.`
          },
          {
            role: 'user',
            content: `Analyze this receipt text and return a single JSON object with two sections: "parsed" and "openAiAssessment".

COUNTRY: ${countryHint}
KNOWN MERCHANTS (if any): ${merchantCandidates.length ? merchantCandidates.join(', ') : 'none'}

--- RECEIPT TEXT ---
${rawText}
--- END ---

Return this exact JSON structure:

{
  "parsed": {
    "receipt_id": "string or null",
    "store_name": "string or null",
    "purchase_date": "YYYY-MM-DD or null",
    "total_amount": "number as string, e.g. 15.50",
    "currency": "e.g. SGD, THB, USD",
    "items": [
      {
        "name": "string",
        "price": number,
        "quantity": number
      }
    ]
  },
  "openAiAssessment": {
    "merchant": {
      "name": "string or null",
      "confidence": 0.0,
      "matched_template": "string or null"
    },
    "extracted": {
      "currency": "string or null",
      "date": "YYYY-MM-DD or null",
      "time": "HH:MM or null",
      "subtotal": number or null,
      "tax": number or null,
      "total": number or null,
      "receipt_id": "string or null"
    },
    "checks": {
      "math_consistent": true,
      "tax_plausible": true,
      "formatting_plausible": true,
      "merchant_plausible": true,
      "suspicious_patterns": []
    },
    "fraud_likelihood": 0.0,
    "explanation": "string"
  }
}

Rules for "parsed":
- price and quantity inside items must be numbers, not strings
- quantity defaults to 1 if not shown
- total_amount is a string containing only the number

Rules for "openAiAssessment":
- math_consistent: subtotal + tax ≈ total (allow ±0.02 rounding)
- tax_plausible: check against country (SG GST = 9%, TH VAT = 7%)
- fraud_likelihood: 0.0 = clean, 1.0 = definitely fraud
- suspicious_patterns: list any red flags found`
          }
        ],
        temperature: 0,
        max_tokens: 800,
        response_format: { type: 'json_object' }
      },
      {
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );

    const result = JSON.parse(response.data.choices[0].message.content.trim());

    // Ensure both sections exist even if GPT partially fails
    if (!result.parsed)     result.parsed     = buildEmptyParsed();
    if (!result.openAiAssessment) result.openAiAssessment = buildEmptyValidation();

    return result;

  } catch (err) {
    console.error('[parseAndValidateReceipt] OpenAI error:', err.message);

    return {
      parsed:     buildEmptyParsed(),
      openAiAssessment: buildEmptyValidation('OpenAI call failed: ' + err.message),
    };
  }
}


// ── Fallback shapes ──────────────────────────────────────────

function buildEmptyParsed() {
  return {
    receipt_id:    null,
    store_name:    null,
    purchase_date: null,
    total_amount:  '0',
    currency:      null,
    items:         [],
  };
}

function buildEmptyValidation(reason = 'Validation unavailable') {
  return {
    merchant: { name: null, confidence: 0, matched_template: null },
    extracted: {
      currency: null, date: null, time: null,
      subtotal: null, tax: null, total: null, receipt_id: null,
    },
    checks: {
      math_consistent:      false,
      tax_plausible:        false,
      formatting_plausible: false,
      merchant_plausible:   false,
      suspicious_patterns:  [reason],
    },
    fraud_likelihood: 0.5,
    explanation: reason,
  };
}


module.exports = { parseAndValidateReceipt };