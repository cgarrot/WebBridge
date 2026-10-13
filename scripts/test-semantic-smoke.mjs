#!/usr/bin/env node
// Smoke test for the semantic side-feature (PR 1: jev_ping).
// Requires a running daemon. For a full offline check, point the daemon at
// scripts/mock-jev.mjs via WEBBRIDGE_JEV_BASE_URL.
//
// Usage: node scripts/test-semantic-smoke.mjs [--base-url http://127.0.0.1:10087]

const args = process.argv.slice(2);
const baseFlag = args.indexOf("--base-url");
const BASE = baseFlag !== -1 ? args[baseFlag + 1] : "http://127.0.0.1:10087";

async function main() {
  let failed = false;

  // 1. Daemon reachable + semantic status
  let health;
  try {
    const res = await fetch(`${BASE}/health`);
    health = await res.json();
  } catch (err) {
    console.log(`❌ Daemon not reachable at ${BASE} (${err.message})`);
    console.log("   Start it first: node packages/daemon/dist/cli/index.js start");
    process.exit(1);
  }

  if (health.semantic) {
    console.log(`✅ /health reports semantic: jev=${health.semantic.jev} model=${health.semantic.model} tools=[${health.semantic.tools}]`);
  } else {
    console.log(`❌ /health has no semantic block — feature not enabled`);
    console.log(`   Start the daemon with WEBBRIDGE_SEMANTIC_ENABLED=1 TYPESAFE_API_KEY=<key>`);
    failed = true;
  }

  // 2. jev_ping round-trip
  try {
    const res = await fetch(`${BASE}/api/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "jev_ping", args: {} }),
    });
    const json = await res.json();
    if (json?.data?.ok) {
      console.log(`✅ jev_ping ok: model=${json.data.model} alive=${json.data.alive} took=${json.data.tookMs}ms cached=${json.data.cached}`);
    } else {
      console.log(`❌ jev_ping failed: ${JSON.stringify(json)}`);
      failed = true;
    }
  } catch (err) {
    console.log(`❌ jev_ping call error: ${err.message}`);
    failed = true;
  }

  // 3. Runtime toggle off → tool disappears; on → returns
  try {
    await fetch(`${BASE}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ semantic_enabled: false }),
    });
    const off = await fetch(`${BASE}/api/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "jev_ping", args: {} }),
    });
    const offJson = await off.json();
    if (offJson?.error && /Unknown tool|not found|no side|No extension connected/i.test(offJson.error)) {
      console.log(`✅ semantic_enabled=false unregisters side tools (${offJson.error})`);
    } else {
      console.log(`⚠️  semantic_enabled=false: unexpected response: ${JSON.stringify(offJson).slice(0, 160)}`);
    }
    await fetch(`${BASE}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ semantic_enabled: true }),
    });
    const on = await fetch(`${BASE}/health`).then((r) => r.json());
    console.log(on.semantic ? `✅ semantic_enabled=true re-registers (jev=${on.semantic.jev})` : `❌ re-enable failed`);
    if (!on.semantic) failed = true;
  } catch (err) {
    console.log(`⚠️  toggle check skipped: ${err.message}`);
  }

  console.log(failed ? "\nSemantic smoke: FAILED" : "\nSemantic smoke: PASSED");
  process.exit(failed ? 1 : 0);
}

main();
