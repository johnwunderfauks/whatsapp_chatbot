const { matchMerchantTemplate, merchantTemplates } = require('../../fraud-detection/merchant-templates');

describe('merchantTemplates', () => {
  test('exports a non-empty array of templates', () => {
    expect(Array.isArray(merchantTemplates)).toBe(true);
    expect(merchantTemplates.length).toBeGreaterThan(0);
  });

  test('every template has required fields', () => {
    for (const t of merchantTemplates) {
      expect(t.id).toBeDefined();
      expect(t.displayName).toBeDefined();
      expect(Array.isArray(t.keywords)).toBe(true);
      expect(Array.isArray(t.requiredPatterns)).toBe(true);
    }
  });
});

describe('matchMerchantTemplate', () => {
  describe('Singapore merchants', () => {
    test('matches NTUC FairPrice with valid receipt text', () => {
      const ocrText = 'NTUC FairPrice\nTotal: $25.00\nGST: $2.13\nSGD\nReceipt No. 12345';
      const result = matchMerchantTemplate(ocrText, 'SG');
      expect(result.matched).toBe(true);
      expect(result.template.id).toBe('ntuc_fairprice_sg');
      expect(result.score).toBeGreaterThanOrEqual(20);
    });

    test('matches Grab Singapore with booking receipt', () => {
      const ocrText = 'GrabFood Order\nTotal: $18.50\n$SGD\nBooking ID: GRAB-ABC123\nReceipt';
      const result = matchMerchantTemplate(ocrText, 'SG');
      expect(result.matched).toBe(true);
      expect(result.template.id).toBe('grab_sg');
    });

    test("matches McDonald's Singapore", () => {
      const ocrText = "McDonald's Restaurant\nTotal: $12.50\n$SGD\nGST included\nOrder No: 1234";
      const result = matchMerchantTemplate(ocrText, 'SG');
      expect(result.matched).toBe(true);
      expect(result.template.id).toBe('mcdonalds_sg');
    });

    test('matches Sheng Siong', () => {
      const ocrText = 'Sheng Siong Supermarket\nTotal: $45.00\n$SGD\nGST: $3.82\nReceipt No: 99876';
      const result = matchMerchantTemplate(ocrText, 'SG');
      expect(result.matched).toBe(true);
      expect(result.template.id).toBe('sheng_siong_sg');
    });

    test('matches Cold Storage', () => {
      const ocrText = 'Cold Storage Singapore\nTotal: $60.00\n$\nGST\nReceipt No: 55432';
      const result = matchMerchantTemplate(ocrText, 'SG');
      expect(result.matched).toBe(true);
      expect(result.template.id).toBe('cold_storage_sg');
    });
  });

  describe('Thailand merchants', () => {
    test('matches 7-Eleven Thailand when country hint is TH', () => {
      const ocrText = '7-Eleven\nTotal: ฿50\nVAT: ฿3.50\nTHB\n01/01/2024\nReceipt No: A123456';
      const result = matchMerchantTemplate(ocrText, 'TH');
      expect(result.matched).toBe(true);
      expect(result.template.id).toBe('7eleven_th');
    });

    test('matches Lotus Thailand', () => {
      const ocrText = "Lotus's Store Thailand\nTotal: ฿120\nVAT: ฿8.40\nTHB\nReceipt No: LTS98765";
      const result = matchMerchantTemplate(ocrText, 'TH');
      expect(result.matched).toBe(true);
      expect(result.template.id).toBe('lotus_th');
    });

    test('matches KFC Thailand', () => {
      const ocrText = 'KFC Thailand\nTotal: ฿200\nVAT: ฿14\nTHB\nOrder No: 123456';
      const result = matchMerchantTemplate(ocrText, 'TH');
      expect(result.matched).toBe(true);
      expect(result.template.id).toBe('kfc_th');
    });
  });

  describe('Country filtering', () => {
    test('does not match TH merchant when country hint is SG', () => {
      const ocrText = '7-Eleven\nTotal: ฿50\nVAT: ฿3.50\nTHB';
      const result = matchMerchantTemplate(ocrText, 'SG');
      expect(result.matched).toBe(false);
    });

    test('matches country-agnostic Starbucks for any country hint', () => {
      const ocrText = 'Starbucks Coffee\nTotal: $10.00\n10:30\nStore Receipt';
      const result = matchMerchantTemplate(ocrText, 'SG');
      expect(result.matched).toBe(true);
      expect(result.template.id).toBe('starbucks_generic');
    });

    test('matches when no country hint provided', () => {
      const ocrText = 'Starbucks Coffee\nTotal: $10.00\n10:30\nStore Receipt';
      const result = matchMerchantTemplate(ocrText);
      expect(result.matched).toBe(true);
    });
  });

  describe('No match cases', () => {
    test('returns not matched for completely unknown merchant', () => {
      const ocrText = 'Random Unknown Store\nTotal: $10.00';
      const result = matchMerchantTemplate(ocrText, 'SG');
      expect(result.matched).toBe(false);
      expect(result.template).toBeNull();
      expect(result.mismatchReasons).toContain('No merchant keyword match');
      expect(result.score).toBe(0);
    });

    test('keyword matches but missing required patterns = not matched', () => {
      // FairPrice keyword but missing Total, $ and GST patterns
      const ocrText = 'FairPrice Shop';
      const result = matchMerchantTemplate(ocrText, 'SG');
      expect(result.matched).toBe(false);
      expect(result.score).toBeLessThan(20);
    });

    test('returns mismatch reasons when keyword found but patterns missing', () => {
      const ocrText = 'FairPrice Shop - no total here';
      const result = matchMerchantTemplate(ocrText, 'SG');
      expect(result.matched).toBe(false);
      expect(result.mismatchReasons.length).toBeGreaterThan(0);
    });
  });

  describe('Scoring', () => {
    test('score increases with more matched required patterns', () => {
      const partialText = 'FairPrice\nTotal: $10';   // matches keyword + 2 of 3 required patterns
      const fullText = 'FairPrice\nTotal: $10\n$SGD\nGST: $0.85\nReceipt No: 12345';
      const partial = matchMerchantTemplate(partialText, 'SG');
      const full = matchMerchantTemplate(fullText, 'SG');
      expect(full.score).toBeGreaterThan(partial.score);
    });

    test('receipt ID match adds 10 to score', () => {
      const withId = 'FairPrice\nTotal: $10\n$SGD\nGST\nReceipt No: 12345';
      const withoutId = 'FairPrice\nTotal: $10\n$SGD\nGST';
      const r1 = matchMerchantTemplate(withId, 'SG');
      const r2 = matchMerchantTemplate(withoutId, 'SG');
      expect(r1.score).toBeGreaterThanOrEqual(r2.score);
    });
  });
});
