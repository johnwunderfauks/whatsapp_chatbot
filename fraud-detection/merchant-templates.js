const merchantTemplates = [
  // =========================
  // 7-Eleven Thailand
  // =========================
  {
    id: "7eleven_th",
    displayName: "7-Eleven (Thailand)",
    keywords: ["7-eleven", "เซเว่น", "cp all"],
    country: "TH",
    currency: "THB",
    requiredPatterns: [
      /total/i,
      /vat|tax/i,
      /฿|\bthb\b/i,
      /\b\d{2}\/\d{2}\/\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/
    ],
    receiptIdPatterns: [
      /\b(receipt|bill|inv)\s*(no\.?|#|id)?\s*[:\-]?\s*[A-Z0-9\-]{6,}\b/i
    ],
    taxRate: 0.07
  },

  // =========================
  // Starbucks (Generic)
  // =========================
  {
    id: "starbucks_generic",
    displayName: "Starbucks",
    keywords: ["starbucks"],
    country: null,
    requiredPatterns: [
      /total/i,
      /\b\d{2}:\d{2}\b/,
      /store|receipt/i
    ],
    receiptIdPatterns: [
      /\b(order|receipt)\s*(no\.?|#)?\s*[:\-]?\s*\d{4,}\b/i
    ]
  },

  // =========================
  // Lotus's Thailand
  // =========================
  {
    id: "lotus_th",
    displayName: "Lotus's (Thailand)",
    keywords: ["lotus", "tesco lotus", "โลตัส"],
    country: "TH",
    currency: "THB",
    requiredPatterns: [
      /total/i,
      /vat/i,
      /฿|\bthb\b/i
    ],
    receiptIdPatterns: [
      /\b(receipt|txn)\s*(no\.?|#)?\s*[:\-]?\s*[A-Z0-9]{6,}\b/i
    ],
    taxRate: 0.07
  },

  // =========================
  // KFC Thailand
  // =========================
  {
    id: "kfc_th",
    displayName: "KFC (Thailand)",
    keywords: ["kfc", "kentucky fried chicken"],
    country: "TH",
    currency: "THB",
    requiredPatterns: [
      /total/i,
      /vat/i,
      /฿|\bthb\b/i
    ],
    receiptIdPatterns: [
      /\b(order|receipt|bill)\s*(no\.?|#)?\s*[:\-]?\s*\d{5,}\b/i
    ],
    taxRate: 0.07
  },

  // =========================
  // Big C Thailand
  // =========================
  {
    id: "bigc_th",
    displayName: "Big C (Thailand)",
    keywords: ["big c", "bigc", "บิ๊กซี"],
    country: "TH",
    currency: "THB",
    requiredPatterns: [
      /total/i,
      /vat/i,
      /฿|\bthb\b/i
    ],
    receiptIdPatterns: [
      /\b(receipt|txn|transaction)\s*(no\.?|#)?\s*[:\-]?\s*[A-Z0-9]{6,}\b/i
    ],
    taxRate: 0.07
  },

  // =========================
  // Naturel Singapore
  // =========================
  {
    id: "naturel_sg",
    displayName: "Naturel (Singapore)",
    keywords: ["naturel"],
    country: "SG",
    currency: "SGD",
    requiredPatterns: [
      /total/i,
      /\$|\bsgd\b/i,
      /\b\d{2}\/\d{2}\/\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/
    ],
    receiptIdPatterns: [
      /\b(receipt|invoice|order)\s*(no\.?|#)?\s*[:\-]?\s*[A-Z0-9]{5,}\b/i
    ],
    taxRate: 0.09 // Singapore GST (current)
  },

  // =========================
  // Shopee Singapore
  // =========================
  {
    id: "shopee_sg",
    displayName: "Shopee (Singapore)",
    keywords: ["shopee", "sea ltd"],
    country: "SG",
    currency: "SGD",
    requiredPatterns: [
      /total/i,
      /\$|\bsgd\b/i,
      /order\s*id|receipt/i
    ],
    receiptIdPatterns: [
      /\b(order|invoice)\s*(id|no\.?|#)?\s*[:\-]?\s*[A-Z0-9\-]{6,}\b/i
    ],
    taxRate: 0.09
  },

  // =========================
  // RedMart Singapore
  // =========================
  {
    id: "redmart_sg",
    displayName: "RedMart (Singapore)",
    keywords: ["redmart"],
    country: "SG",
    currency: "SGD",
    requiredPatterns: [
      /total/i,
      /\$|\bsgd\b/i,
      /order|receipt/i
    ],
    receiptIdPatterns: [
      /\b(order|invoice)\s*(no\.?|#)?\s*[:\-]?\s*[A-Z0-9\-]{6,}\b/i
    ],
    taxRate: 0.09
  },

  // =========================
  // NTUC FairPrice
  // =========================
  {
    id: "ntuc_fairprice_sg",
    displayName: "NTUC FairPrice",
    keywords: ["fairprice", "ntuc"],
    country: "SG",
    currency: "SGD",
    requiredPatterns: [
      /total/i,
      /\$|\bsgd\b/i,
      /gst/i
    ],
    receiptIdPatterns: [
      /\b(receipt|txn|transaction)\s*(no\.?|#)?\s*[:\-]?\s*\d{5,}\b/i
    ],
    taxRate: 0.09
  },

  // =========================
  // Sheng Siong
  // =========================
  {
    id: "sheng_siong_sg",
    displayName: "Sheng Siong",
    keywords: ["sheng siong"],
    country: "SG",
    currency: "SGD",
    requiredPatterns: [
      /total/i,
      /\$|\bsgd\b/i,
      /gst/i
    ],
    receiptIdPatterns: [
      /\b(receipt|txn)\s*(no\.?|#)?\s*[:\-]?\s*\d{5,}\b/i
    ],
    taxRate: 0.09
  },

  // =========================
  // Cold Storage Singapore
  // =========================
  {
    id: "cold_storage_sg",
    displayName: "Cold Storage",
    keywords: ["cold storage"],
    country: "SG",
    currency: "SGD",
    requiredPatterns: [
      /total/i,
      /\$|\bsgd\b/i,
      /gst/i
    ],
    receiptIdPatterns: [
      /\b(receipt|txn)\s*(no\.?|#)?\s*[:\-]?\s*\d{5,}\b/i
    ],
    taxRate: 0.09
  },

  // =========================
  // Grab Singapore
  // =========================
  {
    id: "grab_sg",
    displayName: "Grab (Singapore)",
    keywords: ["grab", "grabfood", "grabmart"],
    country: "SG",
    currency: "SGD",
    requiredPatterns: [
      /total/i,
      /\$|\bsgd\b/i,
      /booking|receipt|invoice/i
    ],
    receiptIdPatterns: [
      /\b(booking|order|receipt)\s*(id|no\.?|#)?\s*[:\-]?\s*[A-Z0-9\-]{6,}\b/i
    ],
    taxRate: 0.09
  },

  // =========================
  // McDonald's Singapore
  // =========================
  {
    id: "mcdonalds_sg",
    displayName: "McDonald's (Singapore)",
    keywords: ["mcdonald", "mcdonald's"],
    country: "SG",
    currency: "SGD",
    requiredPatterns: [
      /total/i,
      /\$|\bsgd\b/i,
      /gst/i
    ],
    receiptIdPatterns: [
      /\b(order|receipt)\s*(no\.?|#)?\s*[:\-]?\s*\d{4,}\b/i
    ],
    taxRate: 0.09
  }
];

function matchMerchantTemplate(ocrText, countryHint = 'SG') {
  const t = ocrText.toLowerCase();
  
  const candidates = merchantTemplates
    .filter(tmp => !tmp.country || !countryHint || tmp.country === countryHint)
    .filter(tmp => tmp.keywords.some(kw => t.includes(kw.toLowerCase())));
  
  if (!candidates.length) {
    return { 
      matched: false, 
      template: null, 
      mismatchReasons: ['No merchant keyword match'],
      score: 0
    };
  }
  
  const scored = candidates.map(tmp => {
    const missingRequired = tmp.requiredPatterns.filter(p => !p.test(ocrText));
    const hasReceiptId = tmp.receiptIdPatterns?.some(p => p.test(ocrText)) ?? false;
    
    let score = 0;
    score += (tmp.requiredPatterns.length - missingRequired.length) * 10;
    if (hasReceiptId) score += 10;
    
    const mismatchReasons = [];
    if (missingRequired.length) {
      mismatchReasons.push(`Missing ${missingRequired.length} required patterns`);
    }
    if (!hasReceiptId) {
      mismatchReasons.push('No receipt ID found');
    }
    
    return { tmp, score, mismatchReasons };
  });
  
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const matched = best.score >= 20;
  
  return {
    matched,
    template: best.tmp,
    mismatchReasons: matched ? [] : best.mismatchReasons,
    score: best.score
  };
}

module.exports = {
  merchantTemplates,
  matchMerchantTemplate
};