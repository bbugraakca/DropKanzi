#!/usr/bin/env node
/** Remove leftover smoke-test scan jobs from the queue UI. */
const BASE = (process.env.SMOKE_BASE_URL || "http://localhost:3001").replace(/\/$/, "");

const SMOKE_PATTERNS = [/smoke-test/i, /^__dropkanzi-smoke__$/i];

function isSmokeJob(job) {
  const seller = String(job.seller ?? "");
  const id = String(job.id ?? "");
  return SMOKE_PATTERNS.some((re) => re.test(seller) || re.test(id));
}

async function main() {
  const res = await fetch(`${BASE}/api/pf-scan/jobs`);
  if (!res.ok) throw new Error(`list jobs failed: HTTP ${res.status}`);
  const { jobs = [] } = await res.json();
  const targets = jobs.filter(isSmokeJob);
  if (targets.length === 0) {
    console.log("[cleanup] No smoke-test jobs found.");
    return;
  }
  for (const job of targets) {
    const del = await fetch(`${BASE}/api/pf-scan/${encodeURIComponent(job.id)}`, {
      method: "DELETE",
    });
    if (del.ok) {
      console.log(`[cleanup] removed ${job.id} (${job.seller}, ${job.status})`);
    } else {
      const body = await del.text();
      console.warn(`[cleanup] failed ${job.id}: HTTP ${del.status} ${body}`);
    }
  }
  console.log(`[cleanup] Done — removed ${targets.length} job(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
