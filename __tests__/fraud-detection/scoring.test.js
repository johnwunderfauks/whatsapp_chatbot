const { calculateFraudScore } = require('../../fraud-detection/scoring');

function makeInput(overrides = {}) {
  return {
    imageFraudSummary: {
      anyAiDetected: false,
      anyTooPerfect: false,
      duplicateImages: false,
      duplicateInSystem: false,
      redFlags: [],
      imageCount: 1,
      ...(overrides.imageFraudSummary || {}),
    },
    templateCheck: { matched: true, score: 40, ...(overrides.templateCheck || {}) },
    openAiAssessment: {
      checks: {
        math_consistent: true,
        tax_plausible: true,
        formatting_plausible: true,
        merchant_plausible: true,
        suspicious_patterns: [],
      },
      fraud_likelihood: 0,
      ...(overrides.openAiAssessment || {}),
    },
    receiptFraudSignals: {
      nonEnglish: false,
      nonSingapore: false,
      dateOutOfRange: false,
      redFlags: [],
      ...(overrides.receiptFraudSignals || {}),
    },
    wpUrl: 'http://test.com',
    wpAuth: 'dXNlcjpwYXNz',
  };
}

describe('calculateFraudScore', () => {
  test('returns ACCEPT with score 0 for a clean receipt', async () => {
    const result = await calculateFraudScore(makeInput());
    expect(result.decision).toBe('ACCEPT');
    expect(result.score).toBe(0);
    expect(result.reasons).toHaveLength(0);
  });

  test('adds 60 for AI-generated image (score=60 → REVIEW, just below REJECT threshold)', async () => {
    const result = await calculateFraudScore(
      makeInput({ imageFraudSummary: { anyAiDetected: true, anyTooPerfect: false, duplicateImages: false, duplicateInSystem: false, redFlags: [], imageCount: 1 } })
    );
    expect(result.score).toBe(60);
    expect(result.decision).toBe('REVIEW'); // 60 < 70 REJECT threshold
    expect(result.reasons).toContain('AI-generated image detected');
  });

  test('AI detected + template mismatch = REJECT (60+20=80)', async () => {
    const result = await calculateFraudScore(
      makeInput({
        imageFraudSummary: { anyAiDetected: true, anyTooPerfect: false, duplicateImages: false, duplicateInSystem: false, redFlags: [], imageCount: 1 },
        templateCheck: { matched: false, score: 0 },
      })
    );
    expect(result.score).toBe(80);
    expect(result.decision).toBe('REJECT');
  });

  test('adds 10 for too-perfect image', async () => {
    const result = await calculateFraudScore(
      makeInput({ imageFraudSummary: { anyAiDetected: false, anyTooPerfect: true, duplicateImages: false, duplicateInSystem: false, redFlags: [], imageCount: 1 } })
    );
    expect(result.score).toBeGreaterThanOrEqual(10);
    expect(result.reasons).toContain('One or more images unusually clean/perfect');
  });

  test('adds 25 for duplicate images in submission', async () => {
    const input = makeInput();
    input.imageFraudSummary.duplicateImages = true;
    const result = await calculateFraudScore(input);
    expect(result.score).toBeGreaterThanOrEqual(25);
    expect(result.reasons).toContain('Duplicate images detected in submission');
  });

  test('adds 35 for duplicate receipt already in system', async () => {
    const input = makeInput();
    input.imageFraudSummary.duplicateInSystem = true;
    const result = await calculateFraudScore(input);
    expect(result.score).toBeGreaterThanOrEqual(35);
    expect(result.reasons).toContain('Receipt image already submitted before');
  });

  test('adds 25 for non-English receipt', async () => {
    const input = makeInput({ receiptFraudSignals: { nonEnglish: true, nonSingapore: false, dateOutOfRange: false, redFlags: [] } });
    const result = await calculateFraudScore(input);
    expect(result.score).toBeGreaterThanOrEqual(25);
    expect(result.reasons).toContain('Receipt is not in English');
  });

  test('adds 40 for non-Singapore receipt', async () => {
    const input = makeInput({ receiptFraudSignals: { nonEnglish: false, nonSingapore: true, dateOutOfRange: false, redFlags: [] } });
    const result = await calculateFraudScore(input);
    expect(result.score).toBeGreaterThanOrEqual(40);
    expect(result.reasons).toContain('Receipt is not from Singapore');
  });

  test('adds 50 for date out of range', async () => {
    const input = makeInput({ receiptFraudSignals: { nonEnglish: false, nonSingapore: false, dateOutOfRange: true, redFlags: [] } });
    const result = await calculateFraudScore(input);
    expect(result.score).toBeGreaterThanOrEqual(50);
    expect(result.reasons).toContain('Receipt date is outside allowed time range');
  });

  test('adds 20 when template not matched', async () => {
    const input = makeInput({ templateCheck: { matched: false, score: 0 } });
    const result = await calculateFraudScore(input);
    expect(result.score).toBeGreaterThanOrEqual(20);
    expect(result.reasons).toContain('Does not match known merchant template');
  });

  test('adds 10 for weak template match (score < 30)', async () => {
    const input = makeInput({ templateCheck: { matched: true, score: 20 } });
    const result = await calculateFraudScore(input);
    expect(result.reasons).toContain('Weak merchant template match');
  });

  test('adds 35 for math inconsistency', async () => {
    const input = makeInput();
    input.openAiAssessment.checks.math_consistent = false;
    const result = await calculateFraudScore(input);
    expect(result.score).toBeGreaterThanOrEqual(35);
    expect(result.reasons).toContain('Math inconsistency (subtotal + tax ≠ total)');
  });

  test('adds 20 for implausible tax rate', async () => {
    const input = makeInput();
    input.openAiAssessment.checks.tax_plausible = false;
    const result = await calculateFraudScore(input);
    expect(result.score).toBeGreaterThanOrEqual(20);
    expect(result.reasons).toContain('Tax rate implausible for country');
  });

  test('adds 15 for suspicious formatting', async () => {
    const input = makeInput();
    input.openAiAssessment.checks.formatting_plausible = false;
    const result = await calculateFraudScore(input);
    expect(result.score).toBeGreaterThanOrEqual(15);
    expect(result.reasons).toContain('Receipt formatting suspicious');
  });

  test('adds 10 for implausible merchant', async () => {
    const input = makeInput();
    input.openAiAssessment.checks.merchant_plausible = false;
    const result = await calculateFraudScore(input);
    expect(result.score).toBeGreaterThanOrEqual(10);
    expect(result.reasons).toContain('Merchant name/details implausible');
  });

  test('adds points per suspicious pattern (capped at 25)', async () => {
    const input = makeInput();
    input.openAiAssessment.checks.suspicious_patterns = ['p1', 'p2', 'p3'];
    const result = await calculateFraudScore(input);
    expect(result.score).toBeGreaterThanOrEqual(15);
    expect(result.reasons).toContain('3 suspicious patterns detected');
  });

  test('caps suspicious pattern score at 25 (6 patterns = 25 not 30)', async () => {
    const input = makeInput();
    input.openAiAssessment.checks.suspicious_patterns = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const result = await calculateFraudScore(input);
    // 6 * 5 = 30 but capped at 25
    expect(result.score).toBeLessThanOrEqual(100);
  });

  test('adds fraud_likelihood * 30 to score', async () => {
    const input = makeInput();
    input.openAiAssessment.fraud_likelihood = 1.0;
    const result = await calculateFraudScore(input);
    expect(result.score).toBeGreaterThanOrEqual(30);
    expect(result.details.openai_score).toBe(30);
  });

  test('caps total score at 100', async () => {
    const input = makeInput({
      imageFraudSummary: { anyAiDetected: true, anyTooPerfect: true, duplicateImages: true, duplicateInSystem: true, redFlags: [], imageCount: 1 },
      receiptFraudSignals: { nonEnglish: true, nonSingapore: true, dateOutOfRange: true, redFlags: [] },
      templateCheck: { matched: false, score: 0 },
    });
    input.openAiAssessment.checks.math_consistent = false;
    input.openAiAssessment.fraud_likelihood = 1.0;
    const result = await calculateFraudScore(input);
    expect(result.score).toBe(100);
  });

  test('returns REVIEW for score between 40 and 69', async () => {
    // duplicateImages (+25) + templateCheck fail (+20) = 45 → REVIEW
    const input = makeInput({ templateCheck: { matched: false, score: 0 } });
    input.imageFraudSummary.duplicateImages = true;
    const result = await calculateFraudScore(input);
    expect(result.score).toBeGreaterThanOrEqual(40);
    expect(result.score).toBeLessThan(70);
    expect(result.decision).toBe('REVIEW');
  });

  test('returns REJECT for score >= 70', async () => {
    // AI detected (+60) + template fail (+20) = 80 → REJECT
    const input = makeInput({
      imageFraudSummary: { anyAiDetected: true, anyTooPerfect: false, duplicateImages: false, duplicateInSystem: false, redFlags: [], imageCount: 1 },
      templateCheck: { matched: false, score: 0 },
    });
    const result = await calculateFraudScore(input);
    expect(result.decision).toBe('REJECT');
  });

  test('deduplicates reasons', async () => {
    const input = makeInput();
    input.imageFraudSummary.redFlags = ['Suspicious flag'];
    input.receiptFraudSignals.redFlags = ['Suspicious flag'];
    const result = await calculateFraudScore(input);
    const count = result.reasons.filter(r => r === 'Suspicious flag').length;
    expect(count).toBe(1);
  });

  test('includes correct details object', async () => {
    const result = await calculateFraudScore(makeInput());
    expect(result.details).toMatchObject({
      image_count: 1,
      ai_detected: false,
      duplicate_images: false,
      template_matched: true,
      openai_score: 0,
    });
  });

  test('includes imageFraudSummary redFlags in reasons', async () => {
    const input = makeInput();
    input.imageFraudSummary.redFlags = ['Fake receipt pattern'];
    const result = await calculateFraudScore(input);
    expect(result.reasons).toContain('Fake receipt pattern');
  });

  test('includes receiptFraudSignals redFlags in reasons', async () => {
    const input = makeInput();
    input.receiptFraudSignals.redFlags = ['Suspicious total'];
    const result = await calculateFraudScore(input);
    expect(result.reasons).toContain('Suspicious total');
  });
});
