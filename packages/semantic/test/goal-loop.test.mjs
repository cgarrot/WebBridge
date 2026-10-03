// Unit tests for the goal loop (Layer 3): action space, answer validation,
// single-request fan-out, and the code-owned execution loop.
//
// Fixture-driven: fake `call` (browser tools) + stubbed JevClient + temp dirs.
// Run: cd packages/semantic && npm test   (requires `pnpm build` first)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { actionSpace, validateChoice } from "../dist/goal/action-space.js";
import { choose } from "../dist/goal/choose.js";
import { GoalRunner } from "../dist/goal/loop.js";

// --- helpers ---------------------------------------------------------------

const CONFIG = {
  jevApiKey: "test-key",
  jevModel: "jev-test",
  jevBaseUrl: "http://localhost",
  jevTimeoutMs: 1000,
  jevMinConfidence: 0.5,
  jevMaxCandidates: 60,
  textModelApiKey: "",
};

function tmpGoalsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wb-goal-"));
}

/** Builds a TypeSafe-valid Choice answer from the questions actually sent. */
function answerChoice(questions, id, choiceId, { confidence = 0.9 } = {}) {
  const keys = Object.keys(questions[id].criteria);
  assert.ok(keys.includes(choiceId), `answerChoice: "${choiceId}" not offered by ${id}: ${keys.join(",")}`);
  const others = keys.filter((k) => k !== choiceId);
  const probabilities = {};
  for (const key of keys) probabilities[key] = key === choiceId ? (others.length ? 0.9 : 1) : others.length ? 0.1 / others.length : 0;
  return { type: "choice", choice: choiceId, probabilities, confidence };
}

/** Scripted Jev: each entry is {questions-based} answer builder, consumed in order. */
function jevStub(script) {
  const calls = [];
  return {
    calls,
    client: {
      disabled: false,
      model: "jev-test",
      async ask(state, questions) {
        calls.push({ state, questions });
        const step = script.shift();
        if (!step) throw new Error("jevStub: script exhausted");
        if (step.error) return { ok: false, error: step.error, tookMs: 1 };
        const answers = {};
        for (const [id, choiceId] of Object.entries(step.pick ?? {})) {
          answers[id] = answerChoice(questions, id, choiceId);
        }
        return {
          ok: true,
          answers,
          model: "jev-test",
          tookMs: 12,
          cached: false,
          usage: { input_tokens: 100, output_tokens: 0 },
        };
      },
    },
  };
}

function makeCall(handler) {
  const calls = [];
  const call = async (name, args = {}) => {
    calls.push({ name, args });
    return handler(name, args, calls);
  };
  return { calls, call };
}

const queueShift = (value) => value;

function observation(overrides = {}) {
  return {
    ok: true,
    url: "https://example.com/search",
    title: "Search",
    text: "Where from? Where to? Departure",
    w: 1280,
    h: 800,
    scroll: { y: 0, height: 2000 },
    marker: "m1",
    actions: [
      { id: "a1", node: "a1", kind: "click", role: "button", label: "Submit search", rect: { x: 10, y: 10, w: 100, h: 30 } },
      { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 },
      { id: "wait", kind: "wait", label: "Wait for the page to update" },
    ],
    guards: {},
    omitted_actions: 0,
    ...overrides,
  };
}

// --- action space ----------------------------------------------------------

test("actionSpace: dedupes by node and lists every compatible operation", () => {
  const space = actionSpace([
    { id: "a1", node: "a1", kind: "fill", role: "combobox", label: "Where from?", value: "" },
    { id: "a1:open", node: "a1", kind: "click", role: "combobox", label: "Open Where from?" },
    { id: "a2", node: "a2", kind: "click", role: "button", label: "Search" },
    { id: "scroll_down", kind: "scroll", label: "Scroll down" },
    { id: "wait", kind: "wait", label: "Wait" },
  ]);
  assert.equal(space.elements.length, 2);
  assert.deepEqual(space.elements[0].operations.sort(), ["CLICK", "TYPE_TEXT"]);
  assert.deepEqual(space.elements[1].operations, ["CLICK"]);
  assert.deepEqual(Object.keys(space.targets).sort(), ["CLICK", "TYPE_TEXT"]);
  assert.deepEqual(Object.keys(space.targets.CLICK).sort(), ["1", "2"]);
  assert.deepEqual(Object.keys(space.targets.TYPE_TEXT), ["1"]);
  assert.deepEqual(Object.keys(space.controls).sort(), ["SCROLL_DOWN", "WAIT"]);
});

test("actionSpace: native dropdown options become individual targets", () => {
  const space = actionSpace([
    { id: "a1", node: "a1", kind: "fill", role: "combobox", label: "Cabin", value: "" },
    { id: "a1:1", node: "a1", kind: "select", label: "Cabin → Economy", value: "ECO", current_value: "Business" },
    { id: "a1:2", node: "a1", kind: "select", label: "Cabin → First", value: "FIRST", current_value: "Business" },
  ]);
  assert.equal(space.elements.length, 1);
  assert.deepEqual(space.elements[0].operations.sort(), ["SELECT", "TYPE_TEXT"]);
  assert.deepEqual(Object.keys(space.targets.SELECT).sort(), ["1:1", "1:2"]);
  assert.equal(space.elements[0].options.length, 2);
  assert.equal(space.targets.SELECT["1:2"].value, "FIRST");
});

test("actionSpace: excludeOperations drops an operation and its head", () => {
  const space = actionSpace(
    [{ id: "a1:1", node: "a1", kind: "select", label: "Cabin → Economy", value: "ECO" }],
    { excludeOperations: ["SELECT"] }
  );
  assert.equal(space.elements.length, 0);
  assert.deepEqual(Object.keys(space.targets), []);
});

// --- validation ------------------------------------------------------------

test("validateChoice: accepts a well-formed answer", () => {
  const result = validateChoice(
    { type: "choice", choice: "b", probabilities: { a: 0.2, b: 0.8 }, confidence: 0.7 },
    ["a", "b"]
  );
  assert.equal(result.ok, true);
  assert.equal(result.answer.choice, "b");
});

test("validateChoice: rejects unoffered choice, bad distribution, non-argmax", () => {
  assert.equal(validateChoice({ choice: "z", probabilities: { a: 0.5, z: 0.5 }, confidence: 0.5 }, ["a", "z"]).ok, true);
  assert.equal(validateChoice({ choice: "z", probabilities: { a: 1 }, confidence: 0.5 }, ["a"]).ok, false);
  assert.equal(validateChoice({ choice: "a", probabilities: { a: 0.5, b: 0.6 }, confidence: 0.5 }, ["a", "b"]).ok, false);
  assert.equal(validateChoice({ choice: "a", probabilities: { a: 0.5, b: 0.2 }, confidence: 0.5 }, ["a", "b"]).ok, false);
  assert.equal(validateChoice({ choice: "a", probabilities: { a: 1, b: 0 }, confidence: Number.NaN }, ["a", "b"]).ok, false);
  assert.equal(validateChoice(null, ["a"]).ok, false);
});

// --- one request per cycle -------------------------------------------------

test("choose: one request, only the selected head is validated, ids map back", async () => {
  const jev = jevStub([{ pick: { operation: "CLICK", click_target: "1" } }]);
  const result = await choose(jev.client, {
    goal: "Submit the search",
    page: { url: "https://example.com", title: "T", text: "..." },
    actions: [
      { id: "a1", node: "a1", kind: "click", label: "Submit" },
      { id: "a2", node: "a2", kind: "click", label: "Cancel" },
      { id: "wait", kind: "wait", label: "Wait" },
    ],
    history: [],
    evaluateAvailable: true,
  });
  assert.equal(result.ok, true);
  assert.equal(jev.calls.length, 1, "exactly one TypeSafe request per cycle");
  const questions = jev.calls[0].questions;
  assert.deepEqual(Object.keys(questions).sort(), ["click_target", "operation"]);
  assert.deepEqual(Object.keys(questions.click_target.criteria).sort(), ["1", "2"]);
  assert.equal(result.decision.operation, "CLICK");
  assert.equal(result.decision.choice, "a1");
  assert.equal(result.decision.probabilities.a1, 0.9);
  assert.equal(result.decision.confidence, 0.9);
});

test("choose: an unused malformed head cannot block a safe action", async () => {
  const jev = jevStub([{ pick: { operation: "CLICK", click_target: "1" } }]);
  const result = await choose(jev.client, {
    goal: "x",
    page: {},
    actions: [
      { id: "a1", node: "a1", kind: "click", label: "Ok" },
      { id: "a2", node: "a2", kind: "fill", label: "Name" },
    ],
    history: [],
    evaluateAvailable: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision.choice, "a1");
});

test("choose: refuses to act when the answer is malformed", async () => {
  const jev = {
    calls: [],
    client: {
      disabled: false,
      model: "jev-test",
      async ask(_state, questions) {
        this.calls = questions;
        return {
          ok: true,
          answers: { operation: { type: "choice", choice: "NOPE", probabilities: { CLICK: 0.5 }, confidence: 0.5 } },
          model: "jev-test",
          tookMs: 5,
          cached: false,
        };
      },
    },
  };
  const result = await choose(jev.client, {
    goal: "x",
    page: {},
    actions: [{ id: "a1", node: "a1", kind: "click", label: "Ok" }],
    history: [],
    evaluateAvailable: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /invalid_operation_answer/);
});

test("choose: pseudo-controls are selectable without a target head", async () => {
  const jev = jevStub([{ pick: { operation: "SCROLL_DOWN" } }]);
  const result = await choose(jev.client, {
    goal: "load more results",
    page: {},
    actions: [
      { id: "a1", node: "a1", kind: "click", label: "Next" },
      { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 },
    ],
    history: [],
    evaluateAvailable: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision.choice, "scroll_down");
  assert.deepEqual(Object.keys(jev.calls[0].questions).sort(), ["click_target", "operation"]);
});

// --- the loop --------------------------------------------------------------

test("goal loop: click → page change → DONE completes (with freshness check)", async () => {
  const goalsDir = tmpGoalsDir();
  const first = observation();
  const second = observation({ marker: "m2", url: "https://example.com/results" });
  const queue = [first, second, second];
  const jev = jevStub([{ pick: { operation: "CLICK", click_target: "1" } }, { pick: { operation: "DONE" } }]);
  const { calls, call } = makeCall(async (name) => {
    if (name === "action_space") return queue.shift();
    if (name === "evaluate") return { result: 1 };
    if (name === "element_info") return { found: true, element: { wbId: "a1" } };
    return { ok: true };
  });
  const runner = new GoalRunner({ config: CONFIG, jev: jev.client, goalsDir, sleep: async () => {} });
  const started = await runner.start(call, { goal: "Submit the search" });
  const final = await runner.wait(started.runId, 5000);

  assert.equal(final.status, "completed");
  assert.equal(final.steps.length, 2);
  assert.equal(final.steps[0].kind, "click");
  assert.equal(final.steps[0].pageChanged, true);
  assert.equal(final.steps[1].choice, "DONE");
  assert.match(final.steps[1].note, /verify the outcome independently/);
  assert.ok(final.steps[0].probability > 0.5, "the chosen action keeps its probability");
  assert.equal(final.usage.inputTokens, 200);
  assert.equal(calls.filter((c) => c.name === "click_element").length, 1);
  // nothing executed for the DONE step
  assert.equal(calls.filter((c) => c.name === "element_info").length, 1);
});

test("goal loop: a covered target is skipped, never clicked", async () => {
  const goalsDir = tmpGoalsDir();
  const obs = observation();
  const queue = [obs, obs, obs];
  const jev = jevStub([{ pick: { operation: "CLICK", click_target: "1" } }, { pick: { operation: "DONE" } }]);
  const { calls, call } = makeCall(async (name) => {
    if (name === "action_space") return queue.shift();
    if (name === "evaluate") return { result: 1 };
    // Another tracked element sits on top of the target.
    if (name === "element_info") return { found: true, element: { wbId: "some-other-node" } };
    return { ok: true };
  });
  const runner = new GoalRunner({ config: CONFIG, jev: jev.client, goalsDir, sleep: async () => {} });
  const started = await runner.start(call, { goal: "Submit" });
  const final = await runner.wait(started.runId, 5000);

  assert.equal(final.status, "completed");
  assert.equal(calls.filter((c) => c.name === "click_element").length, 0);
  assert.match(final.steps[0].note, /skipped: target moved/);
});

test("goal loop: an unverifiable point (background window) still executes", async () => {
  const goalsDir = tmpGoalsDir();
  const first = observation();
  const second = observation({ marker: "m2" });
  const queue = [first, second, second];
  const jev = jevStub([{ pick: { operation: "CLICK", click_target: "1" } }, { pick: { operation: "DONE" } }]);
  const { calls, call } = makeCall(async (name) => {
    if (name === "action_space") return queue.shift();
    if (name === "evaluate") return { result: 1 };
    // Chrome background window: elementFromPoint resolves nothing at that point.
    if (name === "element_info") return { found: false };
    return { ok: true };
  });
  const runner = new GoalRunner({ config: CONFIG, jev: jev.client, goalsDir, sleep: async () => {} });
  const started = await runner.start(call, { goal: "Submit" });
  const final = await runner.wait(started.runId, 5000);

  assert.equal(final.status, "completed");
  assert.equal(calls.filter((c) => c.name === "click_element").length, 1);
});

test("goal loop: three steps without a page change stop the run", async () => {
  const goalsDir = tmpGoalsDir();
  const obs = observation();
  const queue = [obs, obs, obs, obs];
  const jev = jest => jest;
  const stub = jevStub([
    { pick: { operation: "CLICK", click_target: "1" } },
    { pick: { operation: "CLICK", click_target: "1" } },
    { pick: { operation: "CLICK", click_target: "1" } },
  ]);
  const { calls, call } = makeCall(async (name) => {
    if (name === "action_space") return queue.shift();
    if (name === "evaluate") return { result: 1 };
    if (name === "element_info") return { found: true, element: { wbId: "a1" } };
    return { ok: true };
  });
  const runner = new GoalRunner({ config: CONFIG, jev: stub.client, goalsDir, sleep: async () => {} });
  const started = await runner.start(call, { goal: "Click something" });
  const final = await runner.wait(started.runId, 5000);

  // B2/P11 : `no_page_change` est une HÉSITATION reprenable, pas un échec
  // terminal. Avant, ce test attendait `blocked` alors que le run fournissait un
  // `resumeHint` — un conseil impossible à suivre, puisque `resume` n'accepte que
  // les runs `paused`.
  assert.equal(final.status, "paused");
  assert.equal(final.lastPause.reason, "no_page_change");
  assert.equal(final.steps.length, 3);
  assert.equal(calls.filter((c) => c.name === "click_element").length, 3);

  // La reprise est réellement possible (avec un nouveau contexte, cf. P09).
  const resumed = await runner.resume(call, { runId: started.runId, hint: "la cible a changé, réessaie" });
  assert.match(resumed.goal, /\[Hint\]/);
});

test("L3: identical resume hint is refused", async () => {
  const goalsDir = tmpGoalsDir();
  const obs = observation();
  const stub = jevStub([
    { pick: { operation: "CLICK", click_target: "1" } },
    { pick: { operation: "CLICK", click_target: "1" } },
    { pick: { operation: "CLICK", click_target: "1" } },
    { pick: { operation: "CLICK", click_target: "1" } },
    { pick: { operation: "CLICK", click_target: "1" } },
    { pick: { operation: "CLICK", click_target: "1" } },
  ]);
  const { call } = makeCall(async (name) => {
    if (name === "action_space") return obs;
    if (name === "evaluate") return { result: 1 };
    if (name === "element_info") return { found: true, element: { wbId: "a1" } };
    return { ok: true };
  });
  const runner = new GoalRunner({ config: CONFIG, jev: stub.client, goalsDir, sleep: async () => {} });
  const started = await runner.start(call, { goal: "Click something" });
  const first = await runner.wait(started.runId, 5000);
  assert.equal(first.status, "paused");
  await runner.resume(call, { runId: started.runId, hint: "essaie encore" });
  await runner.wait(started.runId, 5000);
  await assert.rejects(
    () => runner.resume(call, { runId: started.runId, hint: "essaie encore" }),
    /resume_hint_not_new/,
  );
});

test("goal loop: step budget is enforced", async () => {
  const goalsDir = tmpGoalsDir();
  const queue = ["m1", "m2", "m3"].map((marker) => observation({ marker }));
  const stub = jevStub([
    { pick: { operation: "CLICK", click_target: "1" } },
    { pick: { operation: "CLICK", click_target: "1" } },
  ]);
  const { calls, call } = makeCall(async (name) => {
    if (name === "action_space") return queue.shift();
    if (name === "evaluate") return { result: 1 };
    if (name === "element_info") return { found: true, element: { wbId: "a1" } };
    return { ok: true };
  });
  const runner = new GoalRunner({ config: CONFIG, jev: stub.client, goalsDir, sleep: async () => {} });
  const started = await runner.start(call, { goal: "Click twice", maxSteps: 2 });
  const final = await runner.wait(started.runId, 5000);

  assert.equal(final.status, "blocked");
  assert.equal(final.lastPause.reason, "step_budget");
  assert.equal(calls.filter((c) => c.name === "click_element").length, 2);
});

test("goal loop: TYPE_TEXT without a helper key pauses before typing", async () => {
  const goalsDir = tmpGoalsDir();
  const obs = observation({
    actions: [
      { id: "a1", node: "a1", kind: "fill", role: "combobox", label: "Where from?", value: "", rect: { x: 10, y: 10, w: 100, h: 30 } },
      { id: "wait", kind: "wait", label: "Wait" },
    ],
  });
  const queue = [obs];
  const stub = jevStub([{ pick: { operation: "TYPE_TEXT", type_text_target: "1" } }]);
  const { calls, call } = makeCall(async (name) => {
    if (name === "action_space") return queue.shift();
    if (name === "evaluate") return { result: 1 };
    if (name === "element_info") return { found: true, element: { wbId: "a1" } };
    return { ok: true };
  });
  const runner = new GoalRunner({ config: CONFIG, jev: stub.client, goalsDir, sleep: async () => {} });
  const started = await runner.start(call, { goal: "Search flights from Zurich" });
  const final = await runner.wait(started.runId, 5000);

  assert.equal(final.status, "paused");
  assert.equal(final.lastPause.reason, "text_helper_unavailable");
  assert.equal(calls.filter((c) => c.name === "type_element").length, 0);
});

test("goal loop: dry run plans one step and executes nothing", async () => {
  const goalsDir = tmpGoalsDir();
  const queue = [observation()];
  const stub = jevStub([{ pick: { operation: "CLICK", click_target: "1" } }]);
  const { calls, call } = makeCall(async (name) => {
    if (name === "action_space") return queue.shift();
    if (name === "evaluate") return { result: 1 };
    if (name === "element_info") return { found: true, element: { wbId: "a1" } };
    return { ok: true };
  });
  const runner = new GoalRunner({ config: CONFIG, jev: stub.client, goalsDir, sleep: async () => {} });
  const started = await runner.start(call, { goal: "Submit", dryRun: true });
  const final = await runner.wait(started.runId, 5000);

  assert.equal(final.status, "paused");
  assert.equal(final.lastPause.reason, "dry_run");
  assert.equal(final.lastPause.detail.planned.operation, "CLICK");
  assert.equal(final.lastPause.detail.planned.action, "Submit search");
  assert.equal(calls.filter((c) => c.name === "click_element").length, 0);
  assert.equal(calls.filter((c) => c.name === "element_info").length, 0);
});

test("goal loop: a mutation error pauses and is never retried", async () => {
  const goalsDir = tmpGoalsDir();
  const queue = [observation()];
  const stub = jevStub([{ pick: { operation: "CLICK", click_target: "1" } }]);
  const { calls, call } = makeCall(async (name) => {
    if (name === "action_space") return queue.shift();
    if (name === "evaluate") return { result: 1 };
    if (name === "element_info") return { found: true, element: { wbId: "a1" } };
    if (name === "click_element") throw new Error("dispatch failed");
    return { ok: true };
  });
  const runner = new GoalRunner({ config: CONFIG, jev: stub.client, goalsDir, sleep: async () => {} });
  const started = await runner.start(call, { goal: "Submit" });
  const final = await runner.wait(started.runId, 5000);

  assert.equal(final.status, "paused");
  assert.equal(final.lastPause.reason, "execution_error");
  assert.equal(calls.filter((c) => c.name === "click_element").length, 1, "no automatic retry");
});

test("goal loop: navigates through a transient unobservable page", async () => {
  const goalsDir = tmpGoalsDir();
  const first = observation();
  const second = observation({ marker: "m2", url: "https://example.com/results" });
  // After the click the document has no body for an instant: {ok:false} then recovery.
  const queue = [first, { ok: false, error: "page has no body" }, second, second];
  const jev = jevStub([{ pick: { operation: "CLICK", click_target: "1" } }, { pick: { operation: "DONE" } }]);
  const { calls, call } = makeCall(async (name) => {
    if (name === "action_space") return queue.shift() ?? second;
    if (name === "evaluate") return { result: 1 };
    if (name === "element_info") return { found: false };
    return { ok: true };
  });
  const runner = new GoalRunner({ config: CONFIG, jev: jev.client, goalsDir, sleep: async () => {} });
  const started = await runner.start(call, { goal: "Open the result" });
  const final = await runner.wait(started.runId, 5000);

  assert.equal(final.status, "completed");
  assert.equal(final.steps.length, 2);
  assert.equal(final.steps[0].pageChanged, true);
  assert.equal(calls.filter((c) => c.name === "action_space").length, 4);
});

test("goal loop: run state is persisted and recoverable by runId", async () => {
  const goalsDir = tmpGoalsDir();
  const queue = [observation()];
  const stub = jevStub([{ pick: { operation: "CLICK", click_target: "1" } }]);
  const { call } = makeCall(async (name) => {
    if (name === "action_space") return queue.shift();
    if (name === "evaluate") return { result: 1 };
    if (name === "element_info") return { found: true, element: { wbId: "a1" } };
    return { ok: true };
  });
  const runner = new GoalRunner({ config: CONFIG, jev: stub.client, goalsDir, sleep: async () => {} });
  const started = await runner.start(call, { goal: "Submit", dryRun: true });
  await runner.wait(started.runId, 5000);

  const file = path.join(goalsDir, started.runId, "state.json");
  assert.ok(fs.existsSync(file), "state.json written after every step");
  const fresh = new GoalRunner({ config: CONFIG, jev: stub.client, goalsDir, sleep: async () => {} });
  const reloaded = fresh.status(started.runId);
  assert.equal(reloaded.goal, "Submit");
  assert.equal(reloaded.status, "paused");
  assert.equal(fresh.listRuns()[0].runId, started.runId);
});

test("goal loop: resume continues a paused run", async () => {
  const goalsDir = tmpGoalsDir();
  const obs = observation();
  const queue = [obs, obs, obs];
  const stub = jevStub([{ pick: { operation: "CLICK", click_target: "1" } }, { pick: { operation: "DONE" } }]);
  let failNextClick = true;
  const { calls, call } = makeCall(async (name) => {
    if (name === "action_space") return queue.shift();
    if (name === "evaluate") return { result: 1 };
    if (name === "element_info") return { found: true, element: { wbId: "a1" } };
    if (name === "click_element" && failNextClick) {
      failNextClick = false;
      throw new Error("transient dispatch failure");
    }
    return { ok: true };
  });
  const runner = new GoalRunner({ config: CONFIG, jev: stub.client, goalsDir, sleep: async () => {} });
  const started = await runner.start(call, { goal: "Submit" });
  const paused = await runner.wait(started.runId, 5000);
  assert.equal(paused.status, "paused");

  // B2/P09 : la reprise exige un NOUVEAU contexte (hint). Ce test vérifie la
  // mécanique de reprise, on lui fournit donc le contexte qu'un appelant réel
  // doit désormais fournir.
  const resumed = await runner.resume(call, { runId: started.runId, hint: "the transient dispatch failure is gone; retry the click" });
  assert.equal(resumed.status, "running");
  const final = await runner.wait(started.runId, 5000);
  assert.equal(final.status, "completed");
});

// --- execution expressions --------------------------------------------------

test("fill expression: never focuses (focus() drops the tab's CDP attachment)", async () => {
  const { FILL_EXPRESSION, SELECT_EXPRESSION } = await import("../dist/goal/loop.js");
  const fill = FILL_EXPRESSION("a2", "ada@example.com");
  assert.ok(fill.includes('[data-wb-id="a2"]'), "targets the observed node");
  assert.ok(fill.includes("ada@example.com"), "carries the value");
  assert.ok(fill.includes("new Event('input'") && fill.includes("new Event('change'"), "emits framework-visible events");
  assert.ok(!/\.focus\(/.test(fill), "regression guard: focus() poisons chrome.debugger for the tab");
  const select = SELECT_EXPRESSION("a3", "lyon");
  assert.ok(select.includes("HTMLSelectElement.prototype"), "uses the native select setter");
  assert.ok(!/\.focus\(/.test(select), "select must not focus either");
});

test("choose: a control-less page is not an error (DONE/BLOCKED still offered)", async () => {
  const jev = jevStub([{ pick: { operation: "DONE" } }]);
  const result = await choose(jev.client, {
    goal: "Submit the form",
    page: { url: "https://httpbin.org/post", title: "JSON", text: '{"ok": true}' },
    actions: [{ id: "wait", kind: "wait", label: "Wait for the page to update" }],
    history: [],
    evaluateAvailable: true,
  });
  assert.equal(result.ok, true);
  assert.match(result.warning, /no_interactive_elements/);
  assert.deepEqual(Object.keys(jev.calls[0].questions.operation.criteria).sort(), ["BLOCKED", "DONE", "WAIT"]);
  assert.equal(result.decision.choice, "DONE");
});

test("goal loop: a submitted form landing on a controlless page completes", async () => {
  const goalsDir = tmpGoalsDir();
  const form = observation();
  const submitted = {
    ok: true,
    url: "https://httpbin.org/post",
    title: "httpbin.org/post",
    text: '{"form": {"custname": "Ada Lovelace"}}',
    w: 1280,
    h: 800,
    scroll: { y: 0, height: 500 },
    marker: "submitted",
    actions: [{ id: "wait", kind: "wait", label: "Wait for the page to update" }],
    guards: {},
    omitted_actions: 0,
  };
  const queue = [form, submitted];
  const jev = jevStub([{ pick: { operation: "CLICK", click_target: "1" } }, { pick: { operation: "DONE" } }]);
  const { calls, call } = makeCall(async (name) => {
    // A control-less page is re-read while the loop waits for it to settle.
    if (name === "action_space") return queue.shift() ?? submitted;
    if (name === "evaluate") return { result: 1 };
    if (name === "element_info") return { found: false };
    return { ok: true };
  });
  const runner = new GoalRunner({ config: CONFIG, jev: jev.client, goalsDir, sleep: async () => {} });
  const started = await runner.start(call, { goal: "Submit the pizza order" });
  const final = await runner.wait(started.runId, 5000);

  assert.equal(final.status, "completed");
  assert.equal(final.lastPause.reason, "done");
  assert.equal(final.lastPause.detail.interactive_elements, 0);
  assert.equal(calls.filter((c) => c.name === "click_element").length, 1);
});

// --- wall guard -------------------------------------------------------------

test("goal loop: a login wall pauses before spending the budget", async () => {
  const goalsDir = tmpGoalsDir();
  const wall = observation({
    url: "https://example.com/article",
    title: "Contenu réservé aux membres",
    text: "Connectez-vous pour lire cet article. Il vous reste 0 article gratuit.",
    actions: [
      { id: "a1", node: "a1", kind: "click", role: "button", label: "Se connecter", rect: { x: 10, y: 10, w: 90, h: 30 } },
      { id: "wait", kind: "wait", label: "Wait" },
    ],
  });
  const jev = jevStub([{ pick: { operation: "CLICK", click_target: "1" } }]);
  const { calls, call } = makeCall(async (name) => {
    if (name === "action_space") return queueShift(wall);
    if (name === "page_triage") return { ok: true, usable: false, blockers: ["needs_login"], annoyances: ["cookie_banner"] };
    if (name === "evaluate") return { result: 1 };
    return { ok: true };
  });
  const runner = new GoalRunner({ config: CONFIG, jev: jev.client, goalsDir, sleep: async () => {} });
  const started = await runner.start(call, { goal: "Résume l'article sur les volants de badminton" });
  const final = await runner.wait(started.runId, 5000);

  assert.equal(final.status, "paused");
  assert.equal(final.lastPause.reason, "page_blocked");
  assert.deepEqual(final.lastPause.detail.blockers, ["needs_login"]);
  assert.equal(final.steps.length, 0, "nothing executed on a wall");
  assert.equal(jev.calls.length, 0, "the wall is detected BEFORE paying for a decision");
  assert.equal(calls.filter((c) => c.name === "click_element").length, 0);
});

test("goal loop: a usable low-control page keeps going", async () => {
  const goalsDir = tmpGoalsDir();
  const small = observation({ marker: "s1" });
  const after = observation({ marker: "s2" });
  const jev = jevStub([{ pick: { operation: "CLICK", click_target: "1" } }, { pick: { operation: "DONE" } }]);
  const { calls, call } = makeCall(async (name) => {
    if (name === "action_space") return small;
    if (name === "page_triage") return { ok: true, usable: true, blockers: [] };
    if (name === "evaluate") return { result: 1 };
    if (name === "element_info") return { found: false };
    if (name === "click_element") return { ok: true, clicked: true };
    return { ok: true };
  });
  const runner = new GoalRunner({ config: CONFIG, jev: jev.client, goalsDir, sleep: async () => {} });
  const started = await runner.start(call, { goal: "Avance d'une étape" });
  // After the click the loop re-observes; keep serving an informative page.
  const final = await runner.wait(started.runId, 5000);
  assert.ok(["completed", "blocked", "paused"].includes(final.status));
  assert.equal(calls.filter((c) => c.name === "page_triage").length, 1, "triage runs once per run");
  assert.equal(calls.filter((c) => c.name === "click_element").length, 1);
});

test("goal loop: wall guard can be disabled", async () => {
  const goalsDir = tmpGoalsDir();
  const wall = observation({
    actions: [{ id: "a1", node: "a1", kind: "click", label: "Se connecter", rect: { x: 1, y: 1, w: 10, h: 10 } }, { id: "wait", kind: "wait", label: "Wait" }],
  });
  const jev = jevStub([{ pick: { operation: "CLICK", click_target: "1" } }]);
  const { calls, call } = makeCall(async (name) => {
    if (name === "action_space") return wall;
    if (name === "page_triage") throw new Error("page_triage must not be called");
    if (name === "evaluate") return { result: 1 };
    if (name === "element_info") return { found: false };
    return { ok: true };
  });
  const runner = new GoalRunner({
    config: { ...CONFIG, goalTriageMinElements: 0 },
    jev: jev.client,
    goalsDir,
    sleep: async () => {},
  });
  const started = await runner.start(call, { goal: "Avance" });
  await runner.wait(started.runId, 5000);
  assert.equal(calls.filter((c) => c.name === "page_triage").length, 0);
  assert.equal(jev.calls.length >= 1, true, "the decision path still runs");
});

test("goal loop: TYPE_TEXT without the evaluate gate uses the focus-free setter", async () => {
  const goalsDir = tmpGoalsDir();
  const obs = observation({
    actions: [
      { id: "a1", node: "a1", kind: "fill", role: "textbox", label: "Nom", value: "", rect: { x: 10, y: 10, w: 100, h: 30 } },
      { id: "wait", kind: "wait", label: "Wait" },
    ],
  });
  const after = observation({ marker: "m9" });
  const queue = [obs, after, after];
  const jev = jevStub([{ pick: { operation: "TYPE_TEXT", type_text_target: "1" } }, { pick: { operation: "DONE" } }]);
  const { calls, call } = makeCall(async (name) => {
    if (name === "action_space") return queue.shift() ?? after;
    if (name === "evaluate") throw new Error("evaluate is disabled"); // policy gate closed
    if (name === "element_info") return { found: false };
    return { ok: true };
  });
  const config = { ...CONFIG, textModelApiKey: "test" };
  const runner = new GoalRunner({
    config,
    jev: jev.client,
    goalsDir,
    sleep: async () => {},
    // deterministic helper so no network call is made
    textHelper: async () => ({ ok: true, text: "Ada", meta: { model: "test-helper", tookMs: 0 } }),
  });
  const started = await runner.start(call, { goal: "Remplis le nom" });
  const final = await runner.wait(started.runId, 5000);

  assert.equal(final.evaluateAvailable, false);
  const typed = calls.find((c) => c.name === "type_element");
  assert.ok(typed, "type_element is used when evaluate is unavailable");
  assert.equal(typed.args.focus, false, "and it must not focus the field");
  assert.equal(calls.filter((c) => c.name === "evaluate").length >= 1, true, "evaluate was probed then avoided");
  assert.equal(final.status, "completed");
});

// --- confidence gate + stale targets ----------------------------------------

test("goal loop: below the confidence floor nothing executes (alternatives surfaced)", async () => {
  const goalsDir = tmpGoalsDir();
  const queue = [observation()];
  // 0.43 confidence: uncertain enough that acting would be a guess.
  const asks = [];
  const jev = {
    client: {
      disabled: false,
      model: "jev-test",
      async ask(_state, questions) {
        asks.push(questions);
        const keys = Object.keys(questions.operation.criteria);
        const others = (1 - 0.53) / (keys.length - 1);
        return {
          ok: true,
          answers: {
            operation: {
              type: "choice",
              choice: "CLICK",
              probabilities: Object.fromEntries(keys.map((k) => [k, k === "CLICK" ? 0.53 : others])),
              confidence: 0.43,
            },
            click_target: { type: "choice", choice: "1", probabilities: { 1: 1 }, confidence: 0.9 },
          },
          model: "jev-test",
          tookMs: 20,
          cached: false,
        };
      },
    },
  };
  const { calls, call } = makeCall(async (name) => {
    if (name === "action_space") return queue.shift() ?? observation();
    if (name === "evaluate") return { result: 1 };
    if (name === "element_info") return { found: true, element: { wbId: "a1" } };
    return { ok: true };
  });
  const runner = new GoalRunner({ config: CONFIG, jev: jev.client, goalsDir, sleep: async () => {} });
  const started = await runner.start(call, { goal: "Fais un truc ambigu" });
  const final = await runner.wait(started.runId, 5000);

  assert.equal(final.status, "paused");
  assert.equal(final.lastPause.reason, "low_confidence");
  assert.equal(final.lastPause.detail.threshold, 0.5);
  assert.equal(final.lastPause.detail.proposed.choice, "a1");
  assert.ok(final.lastPause.detail.alternatives.length > 0, "alternatives are surfaced");
  assert.equal(calls.filter((c) => c.name === "click_element").length, 0, "nothing executed");
  assert.equal(calls.filter((c) => c.name === "element_info").length, 0, "no pre-flight either");
});

test("goal loop: a target that vanishes before dispatch is re-observed, not a pause", async () => {
  const goalsDir = tmpGoalsDir();
  const first = observation();
  const second = observation({ marker: "m2" });
  const queue = [first, second, second];
  const jev = jevStub([{ pick: { operation: "CLICK", click_target: "1" } }, { pick: { operation: "DONE" } }]);
  let attempts = 0;
  const { calls, call } = makeCall(async (name) => {
    if (name === "action_space") return queue.shift() ?? second;
    if (name === "evaluate") return { result: 1 };
    if (name === "element_info") return { found: false }; // background window: unverifiable
    if (name === "click_element") {
      attempts += 1;
      if (attempts === 1) throw new Error('click_element: node "a1" not found. Run get_visible_dom first.');
      return { ok: true };
    }
    return { ok: true };
  });
  const runner = new GoalRunner({ config: CONFIG, jev: jev.client, goalsDir, sleep: async () => {} });
  const started = await runner.start(call, { goal: "Ouvre le résultat" });
  const final = await runner.wait(started.runId, 5000);

  assert.equal(final.status, "completed");
  assert.equal(final.staleRetries, 1);
  assert.match(final.steps[0].note, /stale target/);
  assert.equal(attempts, 1, "the same click is not repeated");
  assert.equal(final.decisions, 2, "the loop re-observes and decides again");
});

test("goal loop: stale retries are bounded", async () => {
  const goalsDir = tmpGoalsDir();
  const obs = observation();
  const jev = jevStub(Array.from({ length: 8 }, () => ({ pick: { operation: "CLICK", click_target: "1" } })));
  const { calls, call } = makeCall(async (name) => {
    if (name === "action_space") return obs;
    if (name === "evaluate") return { result: 1 };
    if (name === "element_info") return { found: false };
    if (name === "click_element") throw new Error(`click_element: node "a1" not found.`);
    return { ok: true };
  });
  const runner = new GoalRunner({ config: CONFIG, jev: jev.client, goalsDir, sleep: async () => {} });
  const started = await runner.start(call, { goal: "Clique un truc qui bouge" });
  const final = await runner.wait(started.runId, 5000);

  assert.equal(final.status, "paused");
  assert.equal(final.lastPause.reason, "stale_target");
  assert.equal(final.staleRetries, 3);
  assert.equal(calls.filter((c) => c.name === "click_element").length, 4, "1 try + 3 bounded retries");
});

test("goal loop: a terminal decision below the ACTION floor still ends the run", async () => {
  const goalsDir = tmpGoalsDir();
  const obs = observation();
  const queue = [obs, obs];
  // DONE at 0.40: under the 0.5 action floor, above the 0.35 terminal floor.
  const jev = {
    client: {
      disabled: false,
      model: "jev-test",
      async ask(_s, questions) {
        const keys = Object.keys(questions.operation.criteria);
        const others = (1 - 0.4) / (keys.length - 1);
        return {
          ok: true,
          answers: {
            operation: {
              type: "choice",
              choice: "DONE",
              probabilities: Object.fromEntries(keys.map((k) => [k, k === "DONE" ? 0.4 : others])),
              confidence: 0.4,
            },
          },
          model: "jev-test",
          tookMs: 10,
          cached: false,
        };
      },
    },
  };
  const { call } = makeCall(async (name) => {
    if (name === "action_space") return queue.shift() ?? obs;
    if (name === "evaluate") return { result: 1 };
    if (name === "page_triage") return { ok: true, usable: true, blockers: [] };
    return { ok: true };
  });
  const runner = new GoalRunner({ config: CONFIG, jev: jev.client, goalsDir, sleep: async () => {} });
  const started = await runner.start(call, { goal: "Termine" });
  const final = await runner.wait(started.runId, 5000);

  assert.equal(final.status, "completed", "a low-confidence DONE is accepted, then verified");
  assert.match(final.steps[0].note, /below the action floor/);
});

test("L3: does not regenerate when the field already has the generated value (reuse ≠ page marker)", async () => {
  const goalsDir = tmpGoalsDir();
  const empty = observation({
    marker: "m-empty",
    actions: [
      { id: "a1", node: "a1", kind: "fill", role: "textbox", label: "Search", value: "", rect: { x: 10, y: 10, w: 100, h: 30 } },
      { id: "wait", kind: "wait", label: "Wait" },
    ],
  });
  const filled = observation({
    marker: "m-filled-unrelated-href-change",
    actions: [
      { id: "a1", node: "a1", kind: "fill", role: "textbox", label: "Search", value: "Ada", rect: { x: 10, y: 10, w: 100, h: 30 } },
      { id: "wait", kind: "wait", label: "Wait" },
    ],
  });
  const queue = [empty, filled, filled, filled];
  const stub = jevStub([
    { pick: { operation: "TYPE_TEXT", type_text_target: "1" } },
    { pick: { operation: "TYPE_TEXT", type_text_target: "1" } },
    { pick: { operation: "TYPE_TEXT", type_text_target: "1" } },
  ]);
  let helperCalls = 0;
  const { calls, call } = makeCall(async (name) => {
    if (name === "action_space") return queue.shift() ?? filled;
    if (name === "evaluate") return { found: true, value: "Ada", result: 1 };
    if (name === "element_info") return { found: false };
    return { ok: true };
  });
  const runner = new GoalRunner({
    config: { ...CONFIG, textModelApiKey: "test", goalTriageMinElements: 0 },
    jev: stub.client,
    goalsDir,
    sleep: async () => {},
    textHelper: async () => {
      helperCalls += 1;
      return { ok: true, text: "Ada", meta: { model: "test-helper", tookMs: 0 } };
    },
  });
  const started = await runner.start(call, { goal: "Search Ada" });
  const final = await runner.wait(started.runId, 5000);
  assert.equal(helperCalls, 1, "the helper must not run again when the field already holds Ada");
  assert.equal(final.status, "paused");
  assert.equal(final.lastPause.reason, "field_already_has_value");
  assert.equal(final.noopFills, 2);
  assert.ok(final.steps.some((step) => /already has generated value/.test(String(step.note || ""))));
});
