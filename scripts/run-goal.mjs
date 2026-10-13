#!/usr/bin/env node
/*
 * WebBridge goal-loop driver (dev script, not part of the published API).
 *
 * Runs the daemon-side GoalRunner against the LIVE daemon + Chrome, without
 * restarting the daemon: browser calls go through POST /api/tool, the loop and
 * the TypeSafe key live in this process. Useful to evaluate goals before
 * wiring them into an agent session, and for the G6 evaluation.
 *
 * Requires: built semantic package (`pnpm build`), a running daemon, a
 * connected extension, and TYPESAFE_API_KEY in .env.local or the environment.
 *
 * Usage:
 *   node scripts/run-goal.mjs dry  "<goal>" [tabId]
 *   node scripts/run-goal.mjs run  "<goal>" [tabId] [maxSteps]
 *   node scripts/run-goal.mjs open https://example.com     # helper: new tab, prints its id
 *
 * Env: WEBBRIDGE_URL (default http://127.0.0.1:10087), TRACE=1 for per-call logs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAEMON = process.env.WEBBRIDGE_URL || "http://127.0.0.1:10087";
const GOALS_DIR = process.env.WEBBRIDGE_GOAL_DIR || path.join(ROOT, ".webbridge-data", "flows", "goals", "dev");

const { JevClient } = await import(path.join(ROOT, "packages/semantic/dist/jev/client.js"));
const { GoalRunner } = await import(path.join(ROOT, "packages/semantic/dist/goal/loop.js"));

/** Read KEY from the environment, falling back to a gitignored .env.local (value never logged). */
function secret(key) {
  if (process.env[key]) return process.env[key];
  try {
    const file = path.join(ROOT, ".env.local");
    const match = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.+)$`, "m").exec(fs.readFileSync(file, "utf8"));
    return match?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  } catch {
    return "";
  }
}

const apiKey = secret("TYPESAFE_API_KEY") || secret("WEBBRIDGE_JEV_API_KEY");
if (!apiKey) {
  console.error("no TYPESAFE_API_KEY (env or .env.local)");
  process.exit(1);
}

let callCount = 0;
async function call(name, args = {}) {
  if (process.env.TRACE) callCount += 1;
  const res = await fetch(`${DAEMON}/api/tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, args }),
  });
  const json = await res.json().catch(() => ({}));
  const data = json.data ?? json;
  if (process.env.TRACE) {
    if (name === "action_space") {
      const actions = data?.actions ?? [];
      const interactive = actions.filter((a) => a.node && ["click", "fill", "select"].includes(a.kind)).length;
      console.log(`   [${callCount}] action_space → ok=${data?.ok} ${actions.length} actions (${interactive} interactifs) ${String(data?.url ?? data?.error ?? "").slice(-48)}`);
    } else if (name !== "element_info") {
      console.log(`   [${callCount}] ${name}`);
    }
  }
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return data;
}

const [mode = "run", goal, tabArg, stepsArg] = process.argv.slice(2);

const tabId = tabArg ? Number(tabArg) : undefined;

if (mode === "open") {
  if (!goal) {
    console.error("usage: node scripts/run-goal.mjs open <url>");
    process.exit(1);
  }
  const tab = await call("new_tab", { url: goal, waitUntil: "domcontentloaded" });
  console.log(JSON.stringify(tab));
  process.exit(0);
}

if (!goal) {
  console.error('usage: node scripts/run-goal.mjs [dry|run] "<goal>" [tabId] [maxSteps]');
  process.exit(1);
}

const runner = new GoalRunner({
  config: {
    jevApiKey: apiKey,
    jevModel: process.env.WEBBRIDGE_JEV_MODEL || "jev-latest",
    jevBaseUrl: process.env.WEBBRIDGE_JEV_BASE_URL || "https://api.typesafe.ai",
    jevTimeoutMs: Number(process.env.WEBBRIDGE_JEV_TIMEOUT_MS || 10_000),
    jevMinConfidence: 0.5,
    jevMaxCandidates: 60,
    textModelApiKey: secret("TEXT_MODEL_API_KEY") || secret("WEBBRIDGE_TEXT_MODEL_API_KEY"),
    textModelBaseUrl: secret("TEXT_MODEL_BASE_URL") || "https://openrouter.ai/api/v1",
    textModelId: secret("TEXT_MODEL") || "inception/mercury-2.5",
    textModelReasoning: secret("TEXT_MODEL_REASONING") || "none",
  },
  jev: new JevClient({ apiKey, model: process.env.WEBBRIDGE_JEV_MODEL || "jev-latest" }),
  goalsDir: GOALS_DIR,
  log: (line) => console.log(`   ${line}`),
  // Dev/eval hook: deterministic TYPE_TEXT values instead of a live helper.
  //   TEST_TEXT_HELPER="Ada Lovelace"                      → same value everywhere
  //   TEST_TEXT_HELPER='{"Nom":"Ada","*":"ada@x.io"}'    → per-field, "*" = fallback
  textHelper: process.env.TEST_TEXT_HELPER ? testTextHelper(process.env.TEST_TEXT_HELPER) : undefined,
});

function testTextHelper(spec) {
  let map;
  try {
    const parsed = JSON.parse(spec);
    if (parsed && typeof parsed === "object") map = parsed;
  } catch {
    /* plain string: one value for every field */
  }
  return async (context) => {
    const label = String(context?.field?.label ?? "");
    let value = spec;
    if (map) {
      const hit = Object.keys(map).find(
        (key) => key !== "*" && label.toLowerCase().includes(key.toLowerCase())
      );
      value = map[hit ?? "*"] ?? Object.values(map)[0];
    }
    return { ok: true, text: String(value), meta: { model: "test-helper", tookMs: 0 } };
  };
}

if (mode === "resume") {
  const resumed = await runner.resume(call, { runId: goal });
  console.log(`run ${resumed.runId} repris (${resumed.status})`);
  const final = await runner.wait(resumed.runId, 300_000);
  console.log(`\nstatus: ${final.status}${final.lastPause ? ` (${final.lastPause.reason})` : ""}`);
  console.log(`décisions: ${final.decisions} | étapes: ${final.steps.length}/${final.maxSteps} | usage: ${JSON.stringify(final.usage)} | ${final.elapsedMs}ms`);
  if (final.lastPause) console.log(`pause: ${JSON.stringify(final.lastPause.detail ?? {}).slice(0, 320)}`);
  const recent = final.steps.slice(-6);
  for (const step of recent) {
    const p = step.probability !== undefined ? `${Math.round(step.probability * 100)}%` : "-";
    const changed = step.pageChanged === null || step.pageChanged === undefined ? "" : step.pageChanged ? "page↻" : "inchangé";
    console.log(`  ${step.step}. ${step.operation} → ${step.choice} ${step.kind ?? ""} (${(step.action ?? "").slice(0, 44)}) p=${p} conf=${(step.confidence ?? 0).toFixed(2)} ${changed}${step.note ? ` [${step.note}]` : ""}`);
  }
  console.log(`\npage finale: ${final.lastPage?.url}`);
  process.exit(final.status === "completed" ? 0 : 2);
}

const started = await runner.start(call, {
  goal,
  tabId,
  maxSteps: stepsArg ? Number(stepsArg) : undefined,
  dryRun: mode === "dry",
});
console.log(`run ${started.runId} → ${goal}${mode === "dry" ? " (dry-run)" : ""}`);
const final = await runner.wait(started.runId, 300_000);

console.log(`\nstatus: ${final.status}${final.lastPause ? ` (${final.lastPause.reason})` : ""}`);
console.log(`décisions: ${final.decisions} | étapes: ${final.steps.length}/${final.maxSteps} | usage: ${JSON.stringify(final.usage)} | ${final.elapsedMs}ms`);
if (final.lastPause) console.log(`pause: ${JSON.stringify(final.lastPause.detail ?? {}).slice(0, 400)}`);
for (const step of final.steps) {
  const p = step.probability !== undefined ? `${Math.round(step.probability * 100)}%` : "-";
  const changed = step.pageChanged === null || step.pageChanged === undefined ? "" : step.pageChanged ? "page↻" : "inchangé";
  console.log(`  ${step.step}. ${step.operation} → ${step.choice} ${step.kind ?? ""} (${(step.action ?? "").slice(0, 44)}) p=${p} conf=${(step.confidence ?? 0).toFixed(2)} ${changed}${step.note ? ` [${step.note}]` : ""}`);
}
console.log(`\npage finale: ${final.lastPage?.url}`);
process.exit(final.status === "completed" ? 0 : 2);
