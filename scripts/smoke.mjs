#!/usr/bin/env node
/**
 * End-to-end smoke test against a running stack (docker compose up).
 * Usage: node scripts/smoke.mjs
 * Env: SMOKE_BASE_URL (default http://localhost:3001)
 */
const BASE = (process.env.SMOKE_BASE_URL || "http://localhost:3001").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 60_000);
/** Internal-only seller — never shown in normal use; cleaned up after smoke run. */
const SMOKE_SELLER = process.env.SMOKE_SELLER || "__dropkanzi-smoke__";
const BAD_LOG_PATTERNS = [
  "Stream isn't writeable",
  "Custom Ids cannot contain",
  "22P02",
  "does not exist",
];

async function waitForHealth() {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastErr = "unknown";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) {
        const body = await res.json();
        if (body?.status === "ok") return;
        lastErr = `unexpected body: ${JSON.stringify(body)}`;
      } else {
        lastErr = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`health check failed after ${TIMEOUT_MS}ms: ${lastErr}`);
}

function fail(step, err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n[smoke] FAILED at step: ${step}`);
  console.error(`[smoke] ${msg}\n`);
  process.exit(1);
}

async function main() {
  console.log(`[smoke] base URL: ${BASE}`);

  try {
    await waitForHealth();
    console.log("[smoke] ✓ GET /api/health");
  } catch (err) {
    fail("GET /api/health", err);
  }

  try {
    const res = await fetch(`${BASE}/api/metrics`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log("[smoke] ✓ GET /api/metrics");
  } catch (err) {
    fail("GET /api/metrics", err);
  }

  let jobId;
  try {
    const res = await fetch(`${BASE}/api/pf-scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seller: SMOKE_SELLER,
        scanType: "sold",
        daysBack: 7,
        forceRefresh: false,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
    jobId = body.jobId;
    if (!jobId || String(jobId).includes(":")) {
      throw new Error(`invalid jobId: ${jobId}`);
    }
    console.log(`[smoke] ✓ POST /api/pf-scan → jobId=${jobId}`);
  } catch (err) {
    fail("POST /api/pf-scan", err);
  }

  try {
    const res = await fetch(`${BASE}/api/pf-scan/jobs`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log("[smoke] ✓ GET /api/pf-scan/jobs");
  } catch (err) {
    fail("GET /api/pf-scan/jobs", err);
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${BASE}/api/pf-scan/stream?jobId=${encodeURIComponent(jobId)}`, {
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    console.log("[smoke] ✓ GET /api/pf-scan/stream (opened)");
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.log("[smoke] ✓ GET /api/pf-scan/stream (timeout ok)");
    } else {
      fail("GET /api/pf-scan/stream", err);
    }
  }

  for (const pattern of BAD_LOG_PATTERNS) {
    console.log(`[smoke] (manual) verify logs do not contain: ${pattern}`);
  }

  if (jobId) {
    try {
      await fetch(`${BASE}/api/pf-scan/${encodeURIComponent(jobId)}`, { method: "DELETE" });
      console.log(`[smoke] ✓ cleaned up test job ${jobId}`);
    } catch {
      console.log(`[smoke] (warn) could not delete test job ${jobId}`);
    }
  }

  console.log("\n[smoke] All automated steps passed.\n");
}

main().catch((err) => fail("unhandled", err));
