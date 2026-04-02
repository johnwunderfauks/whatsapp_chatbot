/**
 * Load Test — WhatsApp Chatbot
 *
 * Sends concurrent webhook requests without consuming any OpenAI or
 * Google Vision credits. Run the server with MOCK_EXTERNAL_APIS=true.
 *
 * Usage:
 *   # In one terminal — start server in mock mode:
 *   MOCK_EXTERNAL_APIS=true SKIP_TWILIO_VALIDATION=true RECEIPT_JOB_SYNC_TO_WP=false node index.js
 *
 *   # In another terminal — run the load test:
 *   node load-test/run.js
 *
 * Environment variables (all optional):
 *   LOAD_TEST_URL         Base URL of the server       (default: http://localhost:3000)
 *   LOAD_TEST_ROUTE       Webhook path                  (default: /webhook)
 *   LOAD_TEST_TOTAL       Total requests to send        (default: 3000)
 *   LOAD_TEST_CONCURRENCY Max simultaneous requests     (default: 100)
 *   LOAD_TEST_MODE        "text" | "receipt"            (default: text)
 *   LOAD_TEST_WARMUP      Warmup requests before timing (default: 50)
 */

"use strict";

const http  = require("http");
const https = require("https");
const qs    = require("querystring");

const BASE_URL   = process.env.LOAD_TEST_URL         || "http://localhost:3000";
const ROUTE      = process.env.LOAD_TEST_ROUTE       || "/webhook";
const TOTAL      = Number(process.env.LOAD_TEST_TOTAL       || 3000);
const CONCURRENCY= Number(process.env.LOAD_TEST_CONCURRENCY || 100);
const MODE       = process.env.LOAD_TEST_MODE        || "text";   // "text" | "receipt"
const WARMUP     = Number(process.env.LOAD_TEST_WARMUP       || 50);

const TARGET = `${BASE_URL}${ROUTE}`;
const USE_HTTPS = TARGET.startsWith("https");

// ── Payload builders ─────────────────────────────────────────────────────────

let _msgCounter = 0;

function uniqueSid() {
  return `SM${Date.now()}${(++_msgCounter).toString().padStart(6, "0")}`;
}

function randomSgPhone() {
  // Generates a unique +65 8XXXXXXX number
  return `+658${Math.floor(1000000 + Math.random() * 9000000)}`;
}

function textPayload(phone) {
  return qs.stringify({
    From:        `whatsapp:${phone}`,
    To:          "whatsapp:+15557969091",
    Body:        "hello",
    NumMedia:    "0",
    ProfileName: "Load Test User",
    MessageSid:  uniqueSid(),
  });
}

function receiptPayload(phone) {
  return qs.stringify({
    From:               `whatsapp:${phone}`,
    To:                 "whatsapp:+15557969091",
    Body:               "",
    NumMedia:           "1",
    MediaUrl0:          "https://mock.internal/receipt.jpg",
    MediaContentType0:  "image/jpeg",
    ProfileName:        "Load Test User",
    MessageSid:         uniqueSid(),
  });
}

const buildPayload = MODE === "receipt" ? receiptPayload : textPayload;

// ── HTTP request helper ───────────────────────────────────────────────────────

const parsedUrl = new URL(TARGET);
const agent = USE_HTTPS
  ? new https.Agent({ keepAlive: true, maxSockets: CONCURRENCY })
  : new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });

function sendRequest(payload) {
  return new Promise((resolve) => {
    const start = Date.now();
    const body  = payload;

    const options = {
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || (USE_HTTPS ? 443 : 3000),
      path:     parsedUrl.pathname,
      method:   "POST",
      agent,
      headers: {
        "Content-Type":   "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = (USE_HTTPS ? https : http).request(options, (res) => {
      res.resume(); // drain without storing body
      resolve({
        ok:      res.statusCode < 400,
        status:  res.statusCode,
        latency: Date.now() - start,
      });
    });

    req.on("error", (err) => {
      resolve({ ok: false, status: 0, latency: Date.now() - start, err: err.message });
    });

    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ ok: false, status: 0, latency: 15000, err: "timeout" });
    });

    req.write(body);
    req.end();
  });
}

// ── Concurrency pool ─────────────────────────────────────────────────────────

async function runPool(total, concurrency, label) {
  const results = [];
  let launched  = 0;
  let resolved  = 0;

  await new Promise((done) => {
    function tryLaunch() {
      while (launched - resolved < concurrency && launched < total) {
        const phone   = randomSgPhone();
        const payload = buildPayload(phone);
        launched++;

        sendRequest(payload).then((r) => {
          results.push(r);
          resolved++;

          const pct  = ((resolved / total) * 100).toFixed(0);
          const rps  = (resolved / ((Date.now() - startTime) / 1000)).toFixed(0);
          process.stdout.write(`\r  ${label}: ${resolved}/${total} (${pct}%) — ${rps} req/s  `);

          if (resolved === total) {
            done();
          } else {
            tryLaunch();
          }
        });
      }
    }

    const startTime = Date.now();
    tryLaunch();
  });

  return results;
}

// ── Stats helper ──────────────────────────────────────────────────────────────

function percentile(sorted, p) {
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function printStats(results, elapsed) {
  const ok     = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  const lats   = results.map((r) => r.latency).sort((a, b) => a - b);
  const avg    = lats.reduce((a, b) => a + b, 0) / lats.length;

  const byStatus = {};
  for (const r of results) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  }

  console.log(`\n\n${"─".repeat(46)}`);
  console.log(`  Requests    ${results.length} in ${elapsed.toFixed(1)}s`);
  console.log(`  Throughput  ${(results.length / elapsed).toFixed(0)} req/s`);
  console.log(`  Success     ${ok} (${((ok / results.length) * 100).toFixed(1)}%)`);
  console.log(`  Failed      ${failed} (${((failed / results.length) * 100).toFixed(1)}%)`);
  console.log(`${"─".repeat(46)}`);
  console.log(`  Latency avg ${Math.round(avg)}ms`);
  console.log(`  Latency p50 ${percentile(lats, 0.50)}ms`);
  console.log(`  Latency p95 ${percentile(lats, 0.95)}ms`);
  console.log(`  Latency p99 ${percentile(lats, 0.99)}ms`);
  console.log(`  Latency max ${lats[lats.length - 1]}ms`);
  console.log(`${"─".repeat(46)}`);
  console.log(`  Status codes:`);
  for (const [code, count] of Object.entries(byStatus).sort()) {
    const label = code === "0" ? "0 (error/timeout)" : code;
    console.log(`    ${label.padEnd(22)} ${count}`);
  }
  console.log(`${"─".repeat(46)}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`
╔══════════════════════════════════════════════╗
║         WhatsApp Chatbot — Load Test         ║
╚══════════════════════════════════════════════╝
  Target      : ${TARGET}
  Mode        : ${MODE} messages
  Total       : ${TOTAL} requests
  Concurrency : ${CONCURRENCY} simultaneous
  Warmup      : ${WARMUP} requests
`);

  // Quick connectivity check
  try {
    await sendRequest(buildPayload(randomSgPhone()));
  } catch {
    console.error(`✗ Cannot reach ${TARGET}. Is the server running?\n`);
    process.exit(1);
  }

  // Warmup — not included in final stats
  if (WARMUP > 0) {
    process.stdout.write(`  Warming up (${WARMUP} req)...`);
    await runPool(WARMUP, Math.min(WARMUP, CONCURRENCY), "Warmup");
    console.log("  done\n");
  }

  console.log(`  Running main test...`);
  const t0      = Date.now();
  const results = await runPool(TOTAL, CONCURRENCY, "Progress");
  const elapsed = (Date.now() - t0) / 1000;

  printStats(results, elapsed);

  // Exit non-zero if >5% failure rate
  const failRate = results.filter((r) => !r.ok).length / results.length;
  process.exit(failRate > 0.05 ? 1 : 0);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
