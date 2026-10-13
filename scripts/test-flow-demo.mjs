#!/usr/bin/env node
// Flow runner smoke test (PR 4): runs the built-in demo-example recipe
// end-to-end against a live daemon + connected extension + (optionally) real Jev.
// Requires evaluate_enabled (the recipe's find_click uses coordinate clicks).
//
// Usage: node scripts/test-flow-demo.mjs [--base-url http://127.0.0.1:10087]

const args = process.argv.slice(2);
const baseFlag = args.indexOf("--base-url");
const BASE = baseFlag !== -1 ? args[baseFlag + 1] : "http://127.0.0.1:10087";

const tool = (name, toolArgs = {}) =>
  fetch(`${BASE}/api/tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, args: toolArgs }),
  })
    .then((r) => r.json())
    .then((j) => ("data" in j ? j.data : Promise.reject(new Error(j.error ?? JSON.stringify(j)))));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let failed = false;

  // Warm-up: one plain navigate settles the reused session tab (avoids the
  // stale-page race on the very first flow navigation).
  try {
    await tool("navigate", { url: "https://example.com", waitUntil: "load", newTab: true });
  } catch (err) {
    console.log(`⚠️  warm-up navigate failed (will continue): ${err.message}`);
  }

  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  if (!health.semantic) {
    console.log("❌ semantic feature not enabled — start daemon with WEBBRIDGE_SEMANTIC_ENABLED=1 + key");
    process.exit(1);
  }
  if (!health.extension_connected) {
    console.log("❌ extension not connected");
    process.exit(1);
  }
  console.log(`✅ daemon ok | ext connected | tools: ${health.semantic.tools.length}`);

  // The demo recipe needs evaluate for coordinate clicks.
  await fetch(`${BASE}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ evaluate_enabled: true }),
  });
  console.log("✅ evaluate enabled (required by find_click)");

  // After a daemon restart the still-loaded extension SW may run stale code
  // (older builds contain a concurrent-navigation guard that rejects flow
  // navigations). Reload it from disk to guarantee current code.
  try {
    await tool("reload_extension", { delayMs: 200 });
    await wait(5000);
    const h2 = await fetch(`${BASE}/health`).then((r) => r.json());
    if (!h2.extension_connected) {
      await wait(4000);
    }
    console.log("✅ extension reloaded from disk");
  } catch (err) {
    console.log(`⚠️  reload_extension unavailable: ${err.message}`);
  }

  await tool("name_session", { name: "flow-demo-smoke" });

  const flows = await tool("flow_list");
  const demo = flows.flows.find((f) => f.id === "demo-example");
  if (!demo) {
    console.log("❌ demo-example recipe missing");
    process.exit(1);
  }
  console.log(`✅ flow_list: ${flows.flows.length} flow(s), demo-example = ${demo.steps} steps`);

  // 1) Dry-run: must stop at the gate with dry_run_stop.
  const dry = await tool("run_flow", { flow: "demo-example", dryRun: true });
  const dryDone = await tool("flow_wait", { runId: dry.runId, timeoutMs: 90000 });
  if (dryDone.status === "paused_at_gate" && dryDone.lastPause?.reason === "dry_run_stop") {
    console.log(`✅ dry-run stopped at gate as designed (${dryDone.stepsDone}/${dryDone.stepsTotal} steps)`);
  } else {
    console.log(`❌ dry-run unexpected: ${dryDone.status} ${dryDone.lastPause?.reason ?? ""} ${dryDone.error ?? ""}`);
    failed = true;
  }

  // 2) Live run: pause at gate → approve → completed.
  const run = await tool("run_flow", { flow: "demo-example" });
  const paused = await tool("flow_wait", { runId: run.runId, timeoutMs: 90000 });
  if (paused.status !== "paused_at_gate") {
    console.log(`❌ live run did not reach the gate: ${paused.status} — ${paused.lastPause?.reason ?? paused.error ?? ""}`);
    failed = true;
  } else {
    console.log(`✅ live run paused at gate (${paused.stepsDone}/${paused.stepsTotal} steps, ${paused.elapsedMs}ms)`);
    await tool("run_flow", { resume: run.runId, approve: ["demo-done"] });
    const done = await tool("flow_wait", { runId: run.runId, timeoutMs: 30000 });
    if (done.status === "completed") {
      console.log(`✅ approved → completed ${done.stepsDone}/${done.stepsTotal} | evidence: ${done.evidence.join(", ")}`);
    } else {
      console.log(`❌ resume did not complete: ${done.status} ${done.error ?? ""}`);
      failed = true;
    }
  }

  await tool("finalize_tabs", { keep: [] });
  console.log(failed ? "\nFlow smoke: FAILED" : "\nFlow smoke: PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
