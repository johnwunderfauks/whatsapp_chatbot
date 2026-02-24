/**
 * campaign-engine.js
 *
 * Runs at receipt submission time. Evaluates active campaign rules
 * against the parsed receipt and saves a SUGGESTION onto the receipt
 * post in WordPress. No points are written or awarded here.
 *
 * Points are only awarded later when an admin manually accepts
 * the receipt in the WP backend — that triggers /campaign/apply (PHP side).
 *
 * Flow:
 *   1. Fetch active campaigns        (GET  /campaign/list)
 *   2. Build receipt context
 *   3. Evaluate when/then rules
 *   4. For limited campaigns, check slots (GET /campaign/redemption-count)
 *   5. Save suggestion to receipt    (POST /campaign/save-suggestion)
 *   6. Return suggestion summary (for logging)
 */

const axios = require('axios');
require('dotenv').config();

const WP_URL          = process.env.WP_URL || 'https://wunderfauksw18.sg-host.com/';
const WP_USER         = process.env.WP_USER;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;

function wpHeaders() {
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');
  return {
    Authorization:  `Basic ${auth}`,
    'Content-Type': 'application/json',
    'User-Agent':   'WhatsApp-Bot/1.0',
  };
}


// ============================================================
// MAIN EXPORT — called from helpers.js after fraud scoring
// ============================================================

/**
 * runCampaignEngine
 *
 * @param {object} params
 * @param {number} params.profileId
 * @param {number} params.receiptId     — WP receipt post ID (available after upload)
 * @param {object} params.parsedReceipt — output of parseReceipt() / GPT
 *   { store_name, purchase_date, total_amount, currency, items: [{name, price, quantity}] }
 *
 * @returns {object}
 *   { matched: bool, totalSuggestedPoints, suggestions: [...], campaignsEvaluated }
 *
 * NOTE: No points are awarded here. The return value is for logging only.
 *       The suggestion is persisted on the WP receipt post for admin review.
 */
async function runCampaignEngine({ profileId, receiptId, parsedReceipt }) {

  // -------------------------------------------------------
  // 1. Build receipt context
  // -------------------------------------------------------
  const ctx = buildReceiptContext(parsedReceipt);

  console.log(`[campaign] Evaluating receipt #${receiptId} — store="${ctx.receipt.store_name}", total=${ctx.receipt.total} ${ctx.receipt.currency}, items=${ctx.receipt.items.length}`);

  // -------------------------------------------------------
  // 2. Fetch active campaigns
  // -------------------------------------------------------
  const campaigns = await fetchActiveCampaigns();
  console.log(`[campaign] ${campaigns.length} active campaign(s) found`);

  if (!campaigns.length) {
    await saveSuggestion(receiptId, { matched: false, suggestions: [], reason: 'No active campaigns' });
    return { matched: false, totalSuggestedPoints: 0, suggestions: [], campaignsEvaluated: 0 };
  }

  // -------------------------------------------------------
  // 3. Evaluate each campaign's rules
  // -------------------------------------------------------
  const suggestions = [];

  for (const campaign of campaigns) {

    const rules = campaign.rules?.rules;

    if (!Array.isArray(rules) || !rules.length) {
      console.log(`[campaign] "${campaign.title}" has no rules — skipping`);
      continue;
    }

    // Higher priority number = evaluated first
    const sortedRules = [...rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    for (const rule of sortedRules) {

      // ---- Evaluate when conditions ----
      const conditionsMet = evaluateWhen(rule.when, ctx);
      if (!conditionsMet) continue;

      // ---- Check limited redemption slots (suggestion-time preview) ----
      // We check slots here so admin knows if the slot is still available
      // at the time of submission. Slots are NOT consumed until admin approves.
      let slotAvailable = true;
      let slotsRemaining = null;

      if (rule.limit) {
        const slotInfo = await getRedemptionSlotInfo(campaign.campaign_post_id, profileId, rule);
        slotAvailable  = slotInfo.available;
        slotsRemaining = slotInfo.remaining;

        if (!slotAvailable) {
          console.log(`[campaign] Rule "${rule.id}" — limit reached at suggestion time, noting in suggestion`);
        }
      }

      // ---- Calculate suggested points ----
      const suggestedPoints = calculatePoints(rule.then, ctx);

      if (suggestedPoints <= 0 && slotAvailable) continue;

      console.log(`[campaign] Rule "${rule.id}" matched — suggesting ${suggestedPoints} pts`);

      suggestions.push({
        campaign_post_id:  campaign.campaign_post_id,
        campaign_title:    campaign.title,
        brand_id:          campaign.brand_id,
        rule_id:           rule.id,
        rule_label:        rule.label || rule.id,
        suggested_points:  suggestedPoints,
        slot_available:    slotAvailable,
        slots_remaining:   slotsRemaining,
        note:              rule.then?.[0]?.label || rule.label || rule.id,
        receipt_snapshot: {
          store_name:    ctx.receipt.store_name,
          total:         ctx.receipt.total,
          currency:      ctx.receipt.currency,
          purchase_date: ctx.receipt.purchase_date,
        },
      });
    }
  }

  // -------------------------------------------------------
  // 4. Save suggestion to WP receipt post
  // -------------------------------------------------------
  const totalSuggestedPoints = suggestions
    .filter(s => s.slot_available)
    .reduce((sum, s) => sum + s.suggested_points, 0);

  const suggestionPayload = {
    matched:               suggestions.length > 0,
    total_suggested_points: totalSuggestedPoints,
    suggestions,
    evaluated_at:          new Date().toISOString(),
  };

  await saveSuggestion(receiptId, suggestionPayload);

  console.log(`[campaign] Suggestion saved — ${suggestions.length} rule(s) matched, ${totalSuggestedPoints} pts suggested`);

  return {
    matched:              suggestions.length > 0,
    totalSuggestedPoints,
    suggestions,
    campaignsEvaluated:  campaigns.length,
  };
}


// ============================================================
// RECEIPT CONTEXT BUILDER
// ============================================================

function buildReceiptContext(parsed) {
  return {
    receipt: {
      store_name:    (parsed.store_name    || '').toLowerCase(),
      purchase_date:  parsed.purchase_date || '',
      total:          parseFloat(parsed.total_amount) || 0,
      currency:      (parsed.currency      || 'SGD').toUpperCase(),
      items:          Array.isArray(parsed.items) ? parsed.items : [],
    },
  };
}


// ============================================================
// WHEN CONDITION EVALUATOR
// ============================================================

/**
 * Supports: { all: [...] } and { any: [...] }
 * Each condition: { field, op, value }
 *
 * Supported ops:
 *   eq, neq, gt, gte, lt, lte
 *   contains, contains_any, contains_all
 */
function evaluateWhen(when, ctx) {
  if (!when) return true;
  if (when.all) return when.all.every(cond => evaluateCondition(cond, ctx));
  if (when.any) return when.any.some(cond  => evaluateCondition(cond, ctx));
  return true;
}

function evaluateCondition({ field, op, value }, ctx) {
  const actual = resolveField(field, ctx);

  switch (op) {
    case 'eq':  return String(actual).toLowerCase() === String(value).toLowerCase();
    case 'neq': return String(actual).toLowerCase() !== String(value).toLowerCase();
    case 'gt':  return parseFloat(actual) >  parseFloat(value);
    case 'gte': return parseFloat(actual) >= parseFloat(value);
    case 'lt':  return parseFloat(actual) <  parseFloat(value);
    case 'lte': return parseFloat(actual) <= parseFloat(value);

    case 'contains':
      return String(actual).toLowerCase().includes(String(value).toLowerCase());

    case 'contains_any': {
      const keywords = Array.isArray(value) ? value : [value];
      if (Array.isArray(actual)) {
        return actual.some(el => keywords.some(kw => String(el).toLowerCase().includes(kw.toLowerCase())));
      }
      return keywords.some(kw => String(actual).toLowerCase().includes(kw.toLowerCase()));
    }

    case 'contains_all': {
      const keywords = Array.isArray(value) ? value : [value];
      if (Array.isArray(actual)) {
        return keywords.every(kw => actual.some(el => String(el).toLowerCase().includes(kw.toLowerCase())));
      }
      return keywords.every(kw => String(actual).toLowerCase().includes(kw.toLowerCase()));
    }

    default:
      console.warn(`[campaign] Unknown op "${op}"`);
      return false;
  }
}

/**
 * Resolves dot-notation field paths.
 *
 * receipt.store_name
 * receipt.total
 * receipt.currency
 * receipt.purchase_date
 * receipt.items.name   → array of all item names
 * receipt.items.price  → array of all item prices
 */
function resolveField(field, ctx) {
  const parts = field.split('.');

  if (parts[0] === 'receipt' && parts[1] === 'items' && parts[2]) {
    const prop = parts[2];
    return (ctx.receipt.items || []).map(item => item[prop] ?? '');
  }

  let val = ctx;
  for (const part of parts) {
    if (val == null) return null;
    val = val[part];
  }
  return val ?? null;
}


// ============================================================
// POINTS CALCULATOR
// ============================================================

/**
 * Modes:
 *   per_dollar     — floor(total * rate * multiplier?)
 *   flat           — fixed bonus points
 *   flat_per_match — bonus × number of matching SKUs in receipt
 *   tiered         — highest qualifying spend tier
 */
function calculatePoints(actions, ctx) {
  if (!Array.isArray(actions)) return 0;

  let total = 0;

  for (const action of actions) {
    if (action.action !== 'award_points') continue;

    const mode       = action.mode       || 'per_dollar';
    const rate       = parseFloat(action.rate       ?? 1);
    const multiplier = parseFloat(action.multiplier ?? 1);
    const bonus      = parseInt(action.bonus        ?? 0, 10);
    const round      = action.round || 'floor';
    const tiers      = Array.isArray(action.tiers)  ? action.tiers : [];
    const spend      = ctx.receipt.total;

    let pts = 0;

    switch (mode) {

      case 'per_dollar':
        pts = applyRound(spend * rate * multiplier, round);
        break;

      case 'flat':
        pts = bonus || Math.round(rate);
        break;

      case 'flat_per_match': {
        // Read match_keywords directly from the then action definition.
        // This lets the campaign JSON declare exactly which keywords to count,
        // independent of the when conditions.
        // e.g. { "mode": "flat_per_match", "bonus": 20, "match_keywords": ["H/F", "HF "] }
        const matchKeywords = Array.isArray(action.match_keywords) && action.match_keywords.length
          ? action.match_keywords
          : (ctx._matchedSkuKeywords || []);

        const matchCount = matchKeywords.length
          ? ctx.receipt.items.filter(item =>
              matchKeywords.some(kw => item.name.toLowerCase().includes(kw.toLowerCase()))
            ).length
          : 1; // default to 1 if no keywords defined at all

        pts = bonus * (matchCount || 1);
        break;
      }

      case 'tiered': {
        const sorted = [...tiers].sort((a, b) => b.min_spend - a.min_spend);
        for (const tier of sorted) {
          if (spend >= parseFloat(tier.min_spend)) {
            pts = parseInt(tier.points, 10);
            break;
          }
        }
        break;
      }

      default:
        console.warn(`[campaign] Unknown points mode "${mode}"`);
    }

    total += pts;
  }

  return Math.max(0, total);
}

function applyRound(value, method) {
  switch (method) {
    case 'ceil':  return Math.ceil(value);
    case 'round': return Math.round(value);
    case 'floor':
    default:      return Math.floor(value);
  }
}


// ============================================================
// LIMITED CAMPAIGN — SLOT INFO (read-only, no consumption)
// ============================================================

async function getRedemptionSlotInfo(campaignPostId, profileId, rule) {
  try {
    const { data } = await axios.get(
      `${WP_URL}/wp-json/custom/v1/campaign/redemption-count`,
      { params: { campaign_post_id: campaignPostId }, headers: wpHeaders() }
    );

    const limit     = data.redemption_limit || rule.limit?.max || 0;
    const count     = data.redemption_count || 0;
    const remaining = limit > 0 ? Math.max(0, limit - count) : null;

    // Global limit check
    if (limit > 0 && count >= limit) {
      return { available: false, remaining: 0 };
    }

    // Per-user limit check
    const perUser    = rule.limit?.per_user ?? 1;
    const userCount  = await getUserRedemptionCount(campaignPostId, profileId);
    if (perUser > 0 && userCount >= perUser) {
      return { available: false, remaining };
    }

    return { available: true, remaining };

  } catch (err) {
    console.error(`[campaign] Slot info check failed: ${err.message}`);
    return { available: true, remaining: null }; // fail open
  }
}

async function getUserRedemptionCount(campaignPostId, profileId) {
  try {
    const { data } = await axios.get(
      `${WP_URL}/wp-json/custom/v1/campaign/ledger`,
      { params: { profile_id: profileId }, headers: wpHeaders() }
    );
    return (data.entries || []).filter(e => String(e.campaign_id) === String(campaignPostId)).length;
  } catch {
    return 0;
  }
}


// ============================================================
// WP API CALLS
// ============================================================

async function fetchActiveCampaigns() {
  try {
    const { data } = await axios.get(
      `${WP_URL}/wp-json/custom/v1/campaign/list`,
      { headers: wpHeaders() }
    );
    return data.campaigns || [];
  } catch (err) {
    console.error(`[campaign] Failed to fetch campaigns: ${err.message}`);
    return [];
  }
}

/**
 * saveSuggestion
 * Saves the campaign suggestion payload onto the WP receipt post.
 * Admin sees this during manual review.
 */
async function saveSuggestion(receiptId, suggestionPayload) {
  try {
    await axios.post(
      `${WP_URL}/wp-json/custom/v1/campaign/save-suggestion`,
      {
        receipt_id:  receiptId,
        suggestion:  suggestionPayload,
      },
      { headers: wpHeaders() }
    );
  } catch (err) {
    console.error(`[campaign] Failed to save suggestion: ${err.message}`);
    // Non-fatal — suggestion save failure should not crash receipt processing
  }
}


// ============================================================
// MODULE EXPORT
// ============================================================

module.exports = { runCampaignEngine };