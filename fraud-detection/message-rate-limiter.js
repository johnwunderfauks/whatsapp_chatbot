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

const { getRedis } = require('../helpers/services/redisClient');

const redis = getRedis();

const DAILY_LIMIT = Number(process.env.WHATSAPP_DAILY_MSG_LIMIT || 10);

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC
}

function countKey(profileId) {
  return `rate_limit:count:${profileId}:${todayKey()}`;
}

function warnedKey(profileId) {
  return `rate_limit:warned:${profileId}:${todayKey()}`;
}

function secondsUntilMidnight() {
  const now = new Date();
  const midnight = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1
  ));
  return Math.max(1, Math.ceil((midnight - now) / 1000));
}

// ─────────────────────────────────────────────────────────────
// getCounters
// Reads today's sent count + warned flag from Redis
// ─────────────────────────────────────────────────────────────
async function getCounters(profileId) {
  try {
    const [count, warned] = await redis.mget(countKey(profileId), warnedKey(profileId));
    return {
      count:  parseInt(count  || '0', 10),
      warned: warned === '1',
    };
  } catch (err) {
    console.error('[rate-limit] Redis read failed — failing open:', err.message);
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
// Increments today's counter by 1 using an atomic Redis pipeline.
// ─────────────────────────────────────────────────────────────
async function recordMessageSent(profileId) {
  try {
    const key = countKey(profileId);
    const ttl = secondsUntilMidnight();
    await redis.pipeline().incr(key).expire(key, ttl).exec();
  } catch (err) {
    // Non-fatal — counter missed but message was sent, not worth blocking
    console.error('[rate-limit] Redis increment failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// markWarned (internal)
// ─────────────────────────────────────────────────────────────
async function markWarned(profileId) {
  try {
    await redis.set(warnedKey(profileId), '1', 'EX', secondsUntilMidnight());
  } catch (err) {
    console.error('[rate-limit] Redis mark-warned failed:', err.message);
  }
}

module.exports = { checkRateLimit, recordMessageSent, DAILY_LIMIT };