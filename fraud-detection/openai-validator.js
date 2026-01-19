const axios = require('axios');

async function validateReceiptWithOpenAI(ocrText, countryHint = 'TH', merchantCandidates = []) {
  const prompt = `You are a receipt fraud detection system.

INPUTS:
- OCR_TEXT: raw OCR text from a receipt image
- COUNTRY_HINT: ${countryHint}
- MERCHANT_CANDIDATES: ${merchantCandidates.length ? merchantCandidates.join(', ') : 'none'}

TASK:
1) Extract key fields (merchant, date, time, currency, subtotal, tax, total, receipt_id)
2) Validate internal consistency:
   - subtotal + tax ≈ total (allow small rounding ±0.02)
   - tax rate plausible for ${countryHint} (Thailand VAT = 7%)
   - formatting & layout plausibility
   - date format consistency
3) Detect suspicious patterns:
   - Overly perfect text with no OCR errors
   - Inconsistent formatting
   - Missing typical receipt elements
   - Wrong currency for country
   - Impossible prices or dates
4) If merchantCandidates exist, check if receipt matches

Return ONLY valid JSON (no markdown, no explanations outside JSON):
{
  "merchant": {
    "name": "string or null",
    "confidence": 0.0-1.0,
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
    "math_consistent": boolean,
    "tax_plausible": boolean,
    "formatting_plausible": boolean,
    "merchant_plausible": boolean,
    "suspicious_patterns": ["string array"]
  },
  "fraud_likelihood": 0.0-1.0,
  "explanation": "string"
}

OCR_TEXT:
"""
${ocrText}
"""`;

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{
          role: "system",
          content: "You are a receipt fraud detection expert. Return only valid JSON."
        }, {
          role: "user",
          content: prompt
        }],
        temperature: 0,
        response_format: { type: "json_object" }
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );

    const text = response.data.choices[0].message.content.trim();
    return JSON.parse(text);
    
  } catch (error) {
    console.error('OpenAI validation error:', error.message);
    
    return {
      merchant: { name: null, confidence: 0, matched_template: null },
      extracted: {
        currency: null, date: null, time: null,
        subtotal: null, tax: null, total: null, receipt_id: null
      },
      checks: {
        math_consistent: false,
        tax_plausible: false,
        formatting_plausible: false,
        merchant_plausible: false,
        suspicious_patterns: ['OpenAI validation failed']
      },
      fraud_likelihood: 0.5,
      explanation: 'Could not complete validation check'
    };
  }
}

module.exports = {
  validateReceiptWithOpenAI
};