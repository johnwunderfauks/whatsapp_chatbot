const crypto = require('crypto');
const axios = require('axios');

async function calculateFraudScore({ 
  metaSignals, 
  qualityCheck, 
  templateCheck, 
  openAiAssessment, 
  imageHash,
  wpUrl,
  wpAuth 
}) {
  let score = 0;
  const reasons = [];
  
  if (metaSignals.whatsappStrippedExif && qualityCheck.tooPerfect) {
    score += 15;
    reasons.push('No EXIF + suspiciously clean image');
  } else if (metaSignals.whatsappStrippedExif) {
    score += 5;
    reasons.push('No EXIF metadata (common with WhatsApp)');
  }
  
  if (metaSignals.aiSoftwareTag) {
    score += 60;
    reasons.push('AI generation software detected in EXIF');
  }
  
  if (qualityCheck.tooPerfect) {
    score += 10;
    reasons.push('Image too clean/perfect');
  }
  
  metaSignals.redFlags.forEach(flag => {
    if (flag.includes('64-pixel alignment')) {
      score += 15;
      reasons.push(flag);
    }
  });
  
 
  const isDuplicate = await checkDuplicateHash(imageHash, wpUrl, wpAuth);
  if (isDuplicate) {
    score += 25;
    reasons.push('Duplicate image submitted before');
  }
  

  if (!templateCheck.matched) {
    score += 20;
    reasons.push('Does not match known merchant template');
  } else if (templateCheck.score < 30) {
    score += 10;
    reasons.push('Weak merchant template match');
  }
  
  
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
  
  const patternScore = Math.min(25, openAiAssessment.checks.suspicious_patterns.length * 5);
  if (patternScore > 0) {
    score += patternScore;
    reasons.push(`${openAiAssessment.checks.suspicious_patterns.length} suspicious patterns detected`);
  }
  
  score += Math.round(openAiAssessment.fraud_likelihood * 30);
  
  score = Math.max(0, Math.min(100, score));
  
  let decision = 'ACCEPT';
  if (score >= 70) {
    decision = 'REJECT';
  } else if (score >= 40) {
    decision = 'REVIEW';
  }
  
  return {
    score,
    decision,
    reasons,
    isDuplicate,
    details: {
      metadata_score: metaSignals.aiSoftwareTag ? 60 : (qualityCheck.tooPerfect ? 10 : 5),
      template_score: templateCheck.matched ? 0 : 20,
      openai_score: Math.round(openAiAssessment.fraud_likelihood * 30),
      duplicate: isDuplicate
    }
  };
}

async function checkDuplicateHash(imageHash, wpUrl, wpAuth) {
  try {
    const response = await axios.post(
      `${wpUrl}/wp-json/custom/v1/check-duplicate-hash`,
      { image_hash: imageHash },
      {
        headers: {
          'Authorization': `Basic ${wpAuth}`,
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

module.exports = {
  calculateFraudScore,
  getImageHash
};