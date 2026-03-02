/**
 * message-rate-limiter.js
 *
 * Rate limits outbound WhatsApp replies to user-initiated messages.
 * Admin-triggered notifications (approval/rejection) bypass this entirely.
 *
 * Limit is configurable via env var WHATSAPP_DAILY_MSG_LIMIT (default: 10).
 *
 * Per-user counters are stored in WordPress post meta on the whatsapp_user
 * profile post, keyed by date. No extra infrastructure needed.
 *
 * Meta keys written:
 *   msg_rate_limit_{YYYY-MM-DD}         → count of messages sent today
 *   msg_rate_limit_warned_{YYYY-MM-DD}  → whether warning was sent today
 *
 * Usage:
 *   const { checkRateLimit, recordMessageSent } = require('./message-rate-limiter');
 *
 *   const { allowed, warning } = await checkRateLimit(profileId, phone);
 *   if (!allowed) return;                    // silently drop
 *   if (warning) await sendWarningMessage(phone, warning);
 *
 *   await sendYourMessage(phone, text);      // your existing send call
 *   await recordMessageSent(profileId);      // increment counter
 */

const axios = require('axios');
require('dotenv').config();

const WP_URL          = process.env.WP_URL;
const WP_USER         = process.env.WP_USER;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;
const DAILY_LIMIT = 10; // max outbound replies per user per day

function wpHeaders() {
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');
  return {
    Authorization:  `Basic ${auth}`,
    'Content-Type': 'application/json',
  };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC
}

// ─────────────────────────────────────────────────────────────
// getCounters
// Fetches today's sent count + warned flag from WP meta
// ─────────────────────────────────────────────────────────────
async function getCounters(profileId) {
  const date = todayKey();

  try {
    const res = await axios.get(
      `${WP_URL}/wp-json/custom/v1/rate-limit/${profileId}?date=${date}`,
      { headers: wpHeaders() }
    );
    return {
      count:   parseInt(res.data.count   ?? 0, 10),
      warned:  res.data.warned === true || res.data.warned === 'true',
    };
  } catch (err) {
    // If endpoint fails, fail open — don't block messages
    console.error('[rate-limit] Failed to fetch counters:', err.message);
    return { count: 0, warned: false };
  }
}

// ─────────────────────────────────────────────────────────────
// checkRateLimit
//
// Call this BEFORE sending a user-initiated reply.
//
// Returns:
//   { allowed: true }                      — send normally
//   { allowed: false, warning: null }      — limit hit, already warned today, drop silently
//   { allowed: false, warning: string }    — limit hit, send this warning message first
// ─────────────────────────────────────────────────────────────
async function checkRateLimit(profileId) {
  const { count, warned } = await getCounters(profileId);

  // Under limit — allow
  if (count < DAILY_LIMIT) {
    return { allowed: true, warning: null };
  }

  // Over limit, already warned today — silent drop
  if (warned) {
    console.log(`[rate-limit] Profile ${profileId} over limit (${count}/${DAILY_LIMIT}), already warned — dropping`);
    return { allowed: false, warning: null };
  }

  // Over limit, not yet warned — send warning once then drop
  console.log(`[rate-limit] Profile ${profileId} hit limit (${count}/${DAILY_LIMIT}) — sending warning`);

  // Mark warned so we don't send it again today
  await markWarned(profileId);

  return {
    allowed: false,
    warning: `You've reached your daily message limit of ${DAILY_LIMIT} messages. Please try again tomorrow. 🙏`,
  };
}

// ─────────────────────────────────────────────────────────────
// recordMessageSent
//
// Call this AFTER successfully sending a user-initiated reply.
// Increments today's counter by 1.
// ─────────────────────────────────────────────────────────────
async function recordMessageSent(profileId) {
  const date = todayKey();

  try {
    await axios.post(
      `${WP_URL}/wp-json/custom/v1/rate-limit/${profileId}/increment`,
      { date },
      { headers: wpHeaders() }
    );
  } catch (err) {
    // Non-fatal — counter missed but message was sent, not worth blocking
    console.error('[rate-limit] Failed to increment counter:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// markWarned (internal)
// ─────────────────────────────────────────────────────────────
async function markWarned(profileId) {
  const date = todayKey();

  try {
    await axios.post(
      `${WP_URL}/wp-json/custom/v1/rate-limit/${profileId}/mark-warned`,
      { date },
      { headers: wpHeaders() }
    );
  } catch (err) {
    console.error('[rate-limit] Failed to mark warned:', err.message);
  }
}

module.exports = { checkRateLimit, recordMessageSent, DAILY_LIMIT };