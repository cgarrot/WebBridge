// Unit tests for the flow runner (Layer 2, PR 4).
// Fixture-driven: fake `call` (browser tools) + stubbed JevClient + temp dirs.
// Run: cd packages/semantic && npm test   (requires `pnpm build` first)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateRecipe, resolveRef } from "../dist/flow/dsl.js";
import { FlowRunner } from "../dist/flow/runner.js";
import { loadRunState } from "../dist/flow/evidence.js";

const CONFIG = {
  jevApiKey: "test", jevModel: "jev-latest", jevBaseUrl: "http://127.0.0.1:1",
  jevTimeoutMs: 100, jevMinConfidence: 0.5, jevMaxCandidates: 60,
};

function tmpFlowsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wb-flows-"));
}

// --- fake browser ------------------------------------------------------------

function makeFakeCall(overrides = {}) {
  const calls = [];
  const defaultHandlers = {
    navigate: async (args) => ({ tabId: 42, url: args.url, loaded: true }),
    evaluate: async (args) => {
      // fill_native / centers / etc: echo a plausible outcome (wrapped in {value})
      if (args.expression.includes("setter")) return { value: { found: true } };
      if (args.expression.includes("scrollIntoView")) return { value: { x: 10, y: 10, w: 40, h: 20 } };
      if (args.expression.includes(".click()")) return { value: { found: true } };
      return { value: null, type: "object" };
    },
    click: async (args) => ({ clicked: true, x: args.x, y: args.y }),
    extract_text: async () => ({ url: "https://x.test/page", title: "Page", text: "Example Domain body text with content", chars: 500 }),
    screenshot: async () => ({ data: Buffer.from("fake-png").toString("base64") }),
    get_tab_info: async () => ({ url: "https://x.test/page", title: "Page" }),
    find_element: async (args) => ({ ok: true, nodeId: "n3", confidence: 0.9, matched: { tag: "a", text: args.description } }),
    upload: async () => ({ uploaded: true }),
  };
  const handlers = { ...defaultHandlers, ...overrides };
  const call = async (name, args = {}) => {
    calls.push({ name, args });
    const h = handlers[name];
    if (!h) throw new Error(`no fake handler for ${name}`);
    return h(args, calls);
  };
  return { calls, call };
}

function jevVerifyPass() {
  return {
    async ask(state, questions) {
      const answers = {};
      for (const key of Object.keys(questions)) {
        answers[key] = { type: "noul", noul: 0.95, confidence: 0.9 };
      }
      return { ok: true, answers, tookMs: 20, cached: false };
    },
  };
}

function jevVerifyNoul(value, confidence = 0.9) {
  return {
    async ask(_state, questions) {
      const answers = {};
      for (const key of Object.keys(questions)) {
        answers[key] = { type: "noul", noul: value, confidence };
      }
      return { ok: true, answers, tookMs: 20, cached: false };
    },
  };
}

const RECIPE = {
  id: "t-basic",
  steps: [
    { do: "navigate", url: "https://example.com" },
    { do: "verify", expect: { loaded: { type: "noul", instructions: "page loaded" } } },
    { do: "fill_native", selector: "#data-title", value: "$meta.title" },
    { do: "screenshot", label: "filled" },
    { do: "gate", id: "final", requireApproval: true },
  ],
};

async function runToCompletion(runner, call, extra = {}) {
  const started = await runner.start(call, { flow: "t-basic", params: { meta: { title: "Mon Livre" } }, ...extra });
  const done = await runner.wait(started.runId, 5000);
  return done;
}

// --- tests -------------------------------------------------------------------

test("dsl: validation catches bad recipes", () => {
  assert.equal(validateRecipe({ id: "x", steps: [{ do: "nope" }] }).ok, false);
  assert.equal(validateRecipe({ id: "x", steps: [] }).ok, false);
  assert.equal(validateRecipe({ id: "x", steps: [{ do: "gate" }] }).ok, false);
  assert.equal(validateRecipe({ id: "x", steps: [{ do: "verify", expect: {} }] }).ok, false);
  assert.equal(validateRecipe({ steps: [{ do: "navigate", url: "u" }] }).ok, false);
  const ok = validateRecipe({ id: "x", steps: [{ do: "navigate", url: "u" }] });
  assert.equal(ok.ok, true);
});

test("dsl: value refs resolve from params and vars", () => {
  const vars = { kdp_id: "APOOVVWQ3PIZH" };
  assert.equal(resolveRef("$meta.title", { meta: { title: "T" } }, vars), "T");
  assert.equal(resolveRef("$var.kdp_id", {}, vars), "APOOVVWQ3PIZH");
  assert.equal(resolveRef("plain string", {}, {}), "plain string");
  assert.throws(() => resolveRef("$meta.nope", { meta: {} }, {}));
});

test("runner: pauses at gate; approval resumes; state.json persisted per step; evidence written", async () => {
  const dir = tmpFlowsDir();
  const { call, calls } = makeFakeCall();
  const runner = new FlowRunner({ config: CONFIG, jev: jevVerifyPass(), flowsDir: dir });
  // Inject the test recipe as a user recipe.
  fs.writeFileSync(path.join(dir, "..", `recipe-t-basic.json`), JSON.stringify(RECIPE)); // not loaded; use runner API directly instead
  // Simpler: register via start on a custom recipe by monkey-wiring getRecipe
  runner.getRecipe = (id) => (id === "t-basic" ? validateRecipe(RECIPE).recipe : undefined);

  const started = await runner.start(call, { flow: "t-basic", params: { meta: { title: "Mon Livre" } } });
  assert.equal(started.status, "running");
  const paused = await runner.wait(started.runId, 5000);
  assert.equal(paused.status, "paused_at_gate");
  assert.equal(paused.lastPause.reason, "approval_required");
  assert.match(paused.lastPause.resumeHint, /approve:\["final"\]/);
  assert.equal(paused.stepsDone, 4);

  // state.json persisted + evidence exists
  const persisted = loadRunState(dir, started.runId);
  assert.equal(persisted.status, "paused_at_gate");
  assert.ok(fs.existsSync(path.join(dir, started.runId, "step-003-filled.png")));

  // fill_native resolved the value ref
  const fillEval = calls.find((c) => c.name === "evaluate" && c.args.expression.includes("setter"));
  assert.ok(fillEval.args.expression.includes("Mon Livre"));

  // resume WITHOUT approve → refuses (gate still pending → pauses again)
  const r1 = await runner.resume(call, { runId: started.runId });
  const p1 = await runner.wait(started.runId, 5000);
  assert.equal(p1.status, "paused_at_gate");

  // resume WITH approve → completes
  const r2 = await runner.resume(call, { runId: started.runId, approve: ["final"] });
  const done = await runner.wait(started.runId, 5000);
  assert.equal(done.status, "completed");
  assert.equal(done.stepsDone, 5);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runner: verify failure retries once then pauses with verify_failed; resume continues", async () => {
  const dir = tmpFlowsDir();
  const { call } = makeFakeCall();
  let askCount = 0;
  const jev = {
    async ask(state, questions) {
      askCount++;
      const fail = askCount <= 2; // first attempt + retry both fail, third (after resume) passes
      const answers = {};
      for (const key of Object.keys(questions)) {
        answers[key] = { type: "noul", noul: fail ? 0.1 : 0.95, confidence: 0.9 };
      }
      return { ok: true, answers, tookMs: 5, cached: false };
    },
  };
  const runner = new FlowRunner({ config: CONFIG, jev, flowsDir: dir });
  runner.getRecipe = (id) => (id === "t-basic" ? validateRecipe(RECIPE).recipe : undefined);
  const started = await runner.start(call, { flow: "t-basic", params: { meta: { title: "T" } } });
  const paused = await runner.wait(started.runId, 8000);
  assert.equal(paused.status, "paused");
  assert.equal(paused.lastPause.reason, "verify_failed");
  assert.equal(askCount, 2); // exactly one retry

  await runner.resume(call, { runId: started.runId });
  const done = await runner.wait(started.runId, 5000);
  assert.equal(done.status, "paused_at_gate", `run failed instead: ${done.error}`); // continued past verify to the gate
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runner: low-confidence verify pauses as low_confidence (no blind retry)", async () => {
  const dir = tmpFlowsDir();
  const { call } = makeFakeCall();
  const runner = new FlowRunner({ config: CONFIG, jev: jevVerifyNoul(0.95, 0.2), flowsDir: dir });
  runner.getRecipe = (id) => (id === "t-basic" ? validateRecipe(RECIPE).recipe : undefined);
  const started = await runner.start(call, { flow: "t-basic", params: {} });
  const paused = await runner.wait(started.runId, 8000);
  assert.equal(paused.status, "paused");
  assert.equal(paused.lastPause.reason, "low_confidence");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runner: dry-run stops before the gate; dangerous selectors skipped", async () => {
  const dir = tmpFlowsDir();
  const { call, calls } = makeFakeCall();
  const recipe = {
    id: "t-dry",
    dangerous: ["#publish"],
    steps: [
      { do: "navigate", url: "https://example.com" },
      { do: "real_click", selector: "#publish-button" },
      { do: "gate", id: "go", requireApproval: true },
    ],
  };
  const runner = new FlowRunner({ config: CONFIG, jev: jevVerifyPass(), flowsDir: dir });
  runner.getRecipe = (id) => (id === "t-dry" ? validateRecipe(recipe).recipe : undefined);
  const started = await runner.start(call, { flow: "t-dry", dryRun: true });
  const paused = await runner.wait(started.runId, 5000);
  assert.equal(paused.status, "paused_at_gate");
  assert.equal(paused.lastPause.reason, "dry_run_stop");
  const clickCall = calls.find((c) => c.name === "click");
  assert.equal(clickCall, undefined); // dangerous click skipped, nothing clicked
  const skipNote = paused.log.find((l) => l.note?.includes("DRY-RUN"));
  assert.ok(skipNote, "dry-run skip note present");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runner: gate requiresParams enforced", async () => {
  const dir = tmpFlowsDir();
  const { call } = makeFakeCall();
  const recipe = {
    id: "t-param",
    steps: [
      { do: "navigate", url: "https://example.com" },
      { do: "gate", id: "publish", requireApproval: true, requiresParams: ["allowPublish"] },
    ],
  };
  const runner = new FlowRunner({ config: CONFIG, jev: jevVerifyPass(), flowsDir: dir });
  runner.getRecipe = (id) => (id === "t-param" ? validateRecipe(recipe).recipe : undefined);

  const started = await runner.start(call, { flow: "t-param" });
  let state = await runner.wait(started.runId, 5000);
  assert.equal(state.lastPause.reason, "missing_param");

  // approve alone is not enough
  await runner.resume(call, { runId: started.runId, approve: ["publish"] });
  state = await runner.wait(started.runId, 5000);
  assert.equal(state.lastPause.reason, "missing_param");

  // param + approval → completes
  await runner.resume(call, { runId: started.runId, params: { allowPublish: true } });
  state = await runner.wait(started.runId, 5000);
  assert.equal(state.status, "completed");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runner: stop at step boundary; persistence survives a 'restart' (new runner instance)", async () => {
  const dir = tmpFlowsDir();
  const { call } = makeFakeCall();
  const slowNavigate = {
    navigate: async (args) => {
      await new Promise((r) => setTimeout(r, 150));
      return { tabId: 42, url: args.url, loaded: true };
    },
  };
  const recipe = {
    id: "t-stop",
    steps: Array.from({ length: 6 }, (_, i) => ({ do: "navigate", url: `https://example.com/${i}` })),
  };
  const r1 = new FlowRunner({ config: CONFIG, jev: jevVerifyPass(), flowsDir: dir });
  r1.getRecipe = (id) => (id === "t-stop" ? validateRecipe(recipe).recipe : undefined);
  const started = await r1.start(makeFakeCall(slowNavigate).call, { flow: "t-stop" });
  r1.stop(started.runId);
  const stopped = await r1.wait(started.runId, 8000);
  assert.equal(stopped.status, "stopped");

  // "restart": new FlowRunner over the same dir sees persisted state
  const r2 = new FlowRunner({ config: CONFIG, jev: jevVerifyPass(), flowsDir: dir });
  const recovered = r2.status(started.runId);
  assert.equal(recovered.status, "stopped");
  assert.equal(recovered.stepsTotal, 6);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runner: fail-fast when recipe needs evaluate but it is disabled", async () => {
  const dir = tmpFlowsDir();
  const { call } = makeFakeCall({
    evaluate: async () => { throw new Error('evaluate is disabled. Enable it with POST /config {"evaluate_enabled":true} before use.'); },
  });
  const runner = new FlowRunner({ config: CONFIG, jev: jevVerifyPass(), flowsDir: dir });
  runner.getRecipe = (id) => (id === "t-basic" ? validateRecipe(RECIPE).recipe : undefined);
  await assert.rejects(
    () => runner.start(call, { flow: "t-basic", params: {} }),
    /evaluate is disabled/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runner: wait_text timeout pauses with actionable hint", async () => {
  const dir = tmpFlowsDir();
  const { call } = makeFakeCall({
    extract_text: async () => ({ url: "u", title: "t", text: "nothing relevant", chars: 100, snippets: [], totalMatches: 0 }),
  });
  const recipe = {
    id: "t-wait",
    steps: [
      { do: "navigate", url: "https://example.com" },
      { do: "wait_text", includes: "uploaded successfully", timeoutMs: 1200 },
    ],
  };
  const runner = new FlowRunner({ config: CONFIG, jev: jevVerifyPass(), flowsDir: dir });
  runner.getRecipe = (id) => (id === "t-wait" ? validateRecipe(recipe).recipe : undefined);
  const started = await runner.start(call, { flow: "t-wait" });
  const paused = await runner.wait(started.runId, 8000);
  assert.equal(paused.status, "paused");
  assert.equal(paused.lastPause.reason, "wait_text_timeout");
  fs.rmSync(dir, { recursive: true, force: true });
});
