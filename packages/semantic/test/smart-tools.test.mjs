// Unit tests for find_element / smart_click / smart_type (Layer 1, PR 2).
// Handlers are exercised directly with an injected fake `call` (browser tools)
// and a stubbed JevClient — no network, no browser.
// Run: cd packages/semantic && npm test   (requires `pnpm build` first)

import test from "node:test";
import assert from "node:assert/strict";
import { createFindElementTool, NONE_OPTION } from "../dist/tools/find-element.js";
import { createSmartInteractTool } from "../dist/tools/smart-interact.js";

const CONFIG = {
  jevApiKey: "test",
  jevModel: "jev-latest",
  jevBaseUrl: "http://127.0.0.1:1",
  jevTimeoutMs: 100,
  jevMinConfidence: 0.5,
  jevMaxCandidates: 60,
};

const DOM = [
  { id: "n1", tag: "a", text: "Docs", href: "/docs" },
  { id: "n2", tag: "button", text: "Sign in", ariaLabel: "Sign in to your account" },
  { id: "n3", tag: "input", placeholder: "Search…" },
  { id: "n4", tag: "a", text: "More information…", href: "https://iana.org" },
  { id: "n5", tag: "div", role: "button", text: "Open menu" },
];

function makeCalls({ dom = DOM } = {}) {
  const calls = [];
  const call = async (name, args = {}) => {
    calls.push({ name, args });
    if (name === "get_visible_dom") return dom;
    if (name === "click_element") return { tabId: 1, nodeId: args.nodeId, tag: "button", text: "Sign in", x: 10, y: 10 };
    if (name === "type_element") return { tabId: 1, nodeId: args.nodeId, typed: args.text?.length ?? 0, tag: "input" };
    throw new Error(`unexpected tool call: ${name}`);
  };
  return { calls, call };
}

function jevStub(answer) {
  let lastAsk = null;
  return {
    lastAsk: () => lastAsk,
    client: {
      async ask(state, questions) {
        lastAsk = { state, questions };
        return typeof answer === "function" ? answer(state, questions) : answer;
      },
    },
  };
}

const okPick = (nodeId, confidence = 0.9, probabilities = { [nodeId]: 0.9 }) => ({
  ok: true,
  tookMs: 12,
  cached: false,
  answers: { pick: { type: "choice", choice: nodeId, confidence, probabilities } },
});

test("find_element: happy path returns nodeId, confidence, top, matched", async () => {
  const { call } = makeCalls();
  const jev = jevStub(() => okPick("n2", 0.88, { n2: 0.88, n4: 0.07, n1: 0.03, [NONE_OPTION]: 0.02 }));
  const find = createFindElementTool(jev.client, CONFIG);
  const result = await find({ description: "the sign in button" }, call);
  assert.equal(result.ok, true);
  assert.equal(result.nodeId, "n2");
  assert.equal(result.confidence, 0.88);
  assert.equal(result.matched.tag, "button");
  assert.deepEqual(
    result.top.map((t) => t.nodeId),
    ["n2", "n4", "n1"]
  );
});

test("find_element: state carries the intent; criteria carries compact summaries + __none__", async () => {
  const { call } = makeCalls();
  const jev = jevStub(() => okPick("n1"));
  const find = createFindElementTool(jev.client, CONFIG);
  await find({ description: "the docs link" }, call);
  const { state, questions } = jev.lastAsk();
  assert.equal(state.intent, "the docs link");
  const criteria = questions.pick.criteria;
  assert.equal(criteria.n1, '<a> text="Docs" href="/docs"');
  assert.ok(criteria[NONE_OPTION]);
  // No raw rects leak into the Jev state.
  assert.equal(JSON.stringify(state).includes("rect"), false);
});

test("find_element: __none__ → ok with nodeId null + no_match reason", async () => {
  const { call } = makeCalls();
  const jev = jevStub(() => okPick(NONE_OPTION, 0.8, { [NONE_OPTION]: 0.8, n3: 0.1 }));
  const find = createFindElementTool(jev.client, CONFIG);
  const result = await find({ description: "a dinosaur" }, call);
  assert.equal(result.ok, true);
  assert.equal(result.nodeId, null);
  assert.equal(result.reason, "no_match");
});

test("find_element: Jev failure → fallback with candidates, ok:true", async () => {
  const { call } = makeCalls();
  const jev = jevStub(() => ({ ok: false, error: "timeout", tookMs: 100 }));
  const find = createFindElementTool(jev.client, CONFIG);
  const result = await find({ description: "anything" }, call);
  assert.equal(result.ok, true);
  assert.equal(result.fallback, true);
  assert.equal(result.candidates.length, 5);
  assert.equal(result.candidates[0].nodeId, "n1");
});

test("find_element: caps candidates to jevMaxCandidates", async () => {
  const bigDom = Array.from({ length: 100 }, (_, i) => ({ id: `n${i + 1}`, tag: "a", text: `link ${i + 1}` }));
  const { call } = makeCalls({ dom: bigDom });
  const jev = jevStub((state, questions) => {
    const keys = Object.keys(questions.pick.criteria);
    assert.equal(keys.length, CONFIG.jevMaxCandidates + 1); // + __none__
    return okPick("n1");
  });
  const find = createFindElementTool(jev.client, CONFIG);
  const result = await find({ description: "link 1" }, call);
  assert.equal(result.totalCandidates, 60);
});

test("find_element: empty description throws; no visible elements → ok:false", async () => {
  const { call } = makeCalls();
  const jev = jevStub(() => okPick("n1"));
  const find = createFindElementTool(jev.client, CONFIG);
  await assert.rejects(() => find({ description: "  " }, call), /description is required/);
  const empty = makeCalls({ dom: [] });
  const result = await find({ description: "x" }, empty.call);
  assert.equal(result.ok, false);
  assert.equal(result.error, "no_visible_elements");
});

test("smart_click: acts when confidence ≥ threshold, passes nodeId to click_element", async () => {
  const { calls, call } = makeCalls();
  const jev = jevStub(() => okPick("n2", 0.9));
  const find = createFindElementTool(jev.client, CONFIG);
  const click = createSmartInteractTool("click", find, CONFIG);
  const result = await click({ description: "sign in" }, call);
  assert.equal(result.acted, true);
  assert.equal(result.nodeId, "n2");
  const clickCall = calls.find((c) => c.name === "click_element");
  assert.equal(clickCall.args.nodeId, "n2");
});

test("smart_click: refuses below minConfidence without decisive margin, no click call", async () => {
  const { calls, call } = makeCalls();
  // Low confidence AND flat distribution → both gates closed.
  const jev = jevStub(() => okPick("n2", 0.3, { n2: 0.4, n1: 0.3, n4: 0.2 }));
  const find = createFindElementTool(jev.client, CONFIG);
  const click = createSmartInteractTool("click", find, CONFIG);
  const result = await click({ description: "sign in" }, call);
  assert.equal(result.acted, false);
  assert.equal(result.reason, "low_confidence");
  assert.ok(result.hint.includes("click_element"));
  assert.equal(calls.find((c) => c.name === "click_element"), undefined);
});

test("smart_click: acts on decisive probability margin despite low confidence", async () => {
  const { calls, call } = makeCalls();
  // Confidence 0.28 (< 0.5) but n1 dominates: 0.64 vs 0.05 → decisive gate opens.
  const jev = jevStub(() => okPick("n1", 0.28, { n1: 0.64, n4: 0.05, n3: 0.02 }));
  const find = createFindElementTool(jev.client, CONFIG);
  const click = createSmartInteractTool("click", find, CONFIG);
  const result = await click({ description: "docs" }, call);
  assert.equal(result.acted, true);
  assert.equal(result.gate, "decisive");
  assert.equal(calls.find((c) => c.name === "click_element").args.nodeId, "n1");
});

test("smart_click: decisive gate stays closed when the runner-up is close", async () => {
  const { call } = makeCalls();
  // top 0.7 but #2 at 0.6 → margin 0.1 < 0.25 → refuse.
  const jev = jevStub(() => okPick("n2", 0.3, { n2: 0.7, n1: 0.6 }));
  const find = createFindElementTool(jev.client, CONFIG);
  const click = createSmartInteractTool("click", find, CONFIG);
  const result = await click({ description: "sign in" }, call);
  assert.equal(result.acted, false);
  assert.equal(result.reason, "low_confidence");
});

test("smart_click: refuses on Jev fallback and on no_match", async () => {
  const { call } = makeCalls();
  const fallback = jevStub(() => ({ ok: false, error: "api_500: boom", tookMs: 5 }));
  const click = createSmartInteractTool(
    "click",
    createFindElementTool(fallback.client, CONFIG),
    CONFIG
  );
  const r1 = await click({ description: "x" }, call);
  assert.equal(r1.acted, false);
  assert.equal(r1.fallback, true);

  const none = jevStub(() => okPick(NONE_OPTION, 0.9));
  const click2 = createSmartInteractTool(
    "click",
    createFindElementTool(none.client, CONFIG),
    CONFIG
  );
  const r2 = await click2({ description: "dinosaur" }, call);
  assert.equal(r2.acted, false);
  assert.equal(r2.reason, "no_match");
});

test("smart_type: types text via type_element with clearFirst", async () => {
  const { calls, call } = makeCalls();
  const jev = jevStub(() => okPick("n3", 0.85));
  const find = createFindElementTool(jev.client, CONFIG);
  const type = createSmartInteractTool("type", find, CONFIG);
  const result = await type({ description: "the search box", text: "hello world" }, call);
  assert.equal(result.acted, true);
  const typeCall = calls.find((c) => c.name === "type_element");
  assert.equal(typeCall.args.text, "hello world");
  assert.equal(typeCall.args.clearFirst, true);
});

test("smart_type: text is required", async () => {
  const { call } = makeCalls();
  const jev = jevStub(() => okPick("n3"));
  const type = createSmartInteractTool(
    "type",
    createFindElementTool(jev.client, CONFIG),
    CONFIG
  );
  await assert.rejects(() => type({ description: "search" }, call), /text is required/);
});
