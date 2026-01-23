
async function calculateFraudScore({
  imageFraudSummary,
  templateCheck,
  openAiAssessment,
  receiptFraudSignals,
  wpUrl,
  wpAuth
}) {
  let score = 0;
  const reasons = [];

  /* ---------------- IMAGE-LEVEL SUMMARY ---------------- */

  if (imageFraudSummary.anyAiDetected) {
    score += 60;
    reasons.push('AI-generated image detected');
  }

  if (imageFraudSummary.anyTooPerfect) {
    score += 10;
    reasons.push('One or more images unusually clean/perfect');
  }

  if (imageFraudSummary.duplicateImages) {
    score += 25;
    reasons.push('Duplicate images detected in submission');
  }

  if (imageFraudSummary.duplicateInSystem) {
    score += 35;
    reasons.push('Receipt image already submitted before');
  }

  if (imageFraudSummary.redFlags.length) {
    imageFraudSummary.redFlags.forEach(flag => {
      reasons.push(flag);
    });
  }

  /* ---------------- RECEIPT-LEVEL VALIDATORS ---------------- */

  if (receiptFraudSignals?.nonEnglish) {
    score += 25;
    reasons.push('Receipt is not in English');
  }

  if (receiptFraudSignals?.nonSingapore) {
    score += 40;
    reasons.push('Receipt is not from Singapore');
  }

  if (receiptFraudSignals?.dateOutOfRange) {
    score += 50;
    reasons.push('Receipt date is outside allowed time range');
  }

  if (receiptFraudSignals?.redFlags?.length) {
    receiptFraudSignals.redFlags.forEach(flag => reasons.push(flag));
  }

  /* ---------------- TEMPLATE CHECK ---------------- */

  if (!templateCheck.matched) {
    score += 20;
    reasons.push('Does not match known merchant template');
  } else if (templateCheck.score < 30) {
    score += 10;
    reasons.push('Weak merchant template match');
  }

  /* ---------------- OPENAI SEMANTIC CHECKS ---------------- */

  if (!openAiAssessment.checks.math_consistent) {
    score += 35;
    reasons.push('Math inconsistency (subtotal + tax ≠ total)');
  }

  if (!openAiAssessment.checks.tax_plausible) {
    score += 20;
    reasons.push('Tax rate implausible for country');
  }

  if (!openAiAssessment.checks.formatting_plausible) {
    score += 15;
    reasons.push('Receipt formatting suspicious');
  }

  if (!openAiAssessment.checks.merchant_plausible) {
    score += 10;
    reasons.push('Merchant name/details implausible');
  }

  const patternScore = Math.min(
    25,
    openAiAssessment.checks.suspicious_patterns.length * 5
  );

  if (patternScore > 0) {
    score += patternScore;
    reasons.push(
      `${openAiAssessment.checks.suspicious_patterns.length} suspicious patterns detected`
    );
  }

  score += Math.round(openAiAssessment.fraud_likelihood * 30);

  /* ---------------- FINAL NORMALIZATION ---------------- */

  score = Math.max(0, Math.min(100, score));

  let decision = 'ACCEPT';
  if (score >= 70) decision = 'REJECT';
  else if (score >= 40) decision = 'REVIEW';

  return {
    score,
    decision,
    reasons: [...new Set(reasons)], // dedupe
    details: {
      image_count: imageFraudSummary.imageCount,
      ai_detected: imageFraudSummary.anyAiDetected,
      duplicate_images: imageFraudSummary.duplicateImages,
      template_matched: templateCheck.matched,
      openai_score: Math.round(openAiAssessment.fraud_likelihood * 30)
    }
  };
}




module.exports = {
  calculateFraudScore,
};