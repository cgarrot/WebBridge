// Unit tests for rank_links / page_triage (Layer 1 discovery, PR 3).
// Handlers exercised with injected fake `call` + stubbed JevClient.
// Run: cd packages/semantic && npm test   (requires `pnpm build` first)

import test from "node:test";
import assert from "node:assert/strict";
import { createRankLinksTool } from "../dist/tools/rank-links.js";
import { createPageTriageTool } from "../dist/tools/page-triage.js";

function makeCall(responses) {
  const calls = [];
  const queues = new Map();
  const call = async (name, args = {}) => {
    calls.push({ name, args });
    let r = responses[name];
    if (Array.isArray(r)) {
      // Sequential queue: each call returns the next element.
      const idx = queues.get(name) ?? 0;
      queues.set(name, idx + 1);
      r = r[Math.min(idx, r.length - 1)];
    }
    if (typeof r === "function") return r(args, calls);
    return r;
  };
  return { calls, call };
}

function jevStub(answer) {
  let askCount = 0;
  let lastAsk = null;
  return {
    askCount: () => askCount,
    lastAsk: () => lastAsk,
    client: {
      async ask(state, questions) {
        askCount++;
        lastAsk = { state, questions };
        return typeof answer === "function" ? answer(state, questions) : answer;
      },
    },
  };
}

const LINKS = {
  url: "https://example.com/search",
  title: "Search results",
  links: [
    { text: "Sponsored result — buy now", href: "https://ad.example.com/offer" },
    { text: "Official pricing page", href: "https://example.com/pricing" },
    { text: "Company blog", href: "https://example.com/blog" },
    { text: "Careers", href: "https://example.com/jobs" },
  ],
  count: 4,
  matched: 4,
  totalCandidates: 4,
};

test("agent-tab safety: semantic tools target the session's primary tracked tab, not the user's active tab", async () => {
  const { calls, call } = makeCall({
    list_tabs: () => [
      { id: 9, active: true, tracked: false, primary: false }, // user's active tab
      { id: 99, active: false, tracked: true, primary: true, url: "" }, // blank mid-navigation tab
      { id: 7, active: false, tracked: true, primary: false, url: "https://iana.org" }, // agent session tab
    ],
    extract_links: LINKS,
  });
  const jev = jevStub(() => ({ ok: false, error: "skip", tookMs: 0 }));
  await createRankLinksTool(jev.client)({ intent: "pricing" }, call);
  const extractCall = calls.find((c) => c.name === "extract_links");
  assert.equal(extractCall.args.tabId, 7); // session tab with content, never blank/user tabs

  // No tracked tabs → fall through to the underlying tool default (no tabId).
  const { calls: calls2, call: call2 } = makeCall({
    list_tabs: () => [{ id: 9, active: true }],
    extract_links: LINKS,
  });
  await createRankLinksTool(jev.client)({ intent: "pricing" }, call2);
  assert.equal("tabId" in calls2.find((c) => c.name === "extract_links").args, false);
});

test("rank_links: ONE Jev call, 2 questions per link, sorted by p_exact, promo flagged", async () => {
  const { call } = makeCall({ extract_links: LINKS });
  const jev = jevStub((state, questions) => {
    // exact match: pricing (i=1); related: blog (i=2); irrelevant: others
    const mk = (i, p2, p1 = 0.1) => ({
      type: "score",
      score: p2 > 0.5 ? 2 : p1 > 0.5 ? 1 : 0,
      confidence: 0.8,
      probabilities: { "0": Math.max(0, 1 - p2 - p1), "1": p1, "2": p2 },
    });
    const answers = {};
    for (let i = 0; i < 4; i++) {
      answers[`rel_${i}`] = i === 1 ? mk(1, 0.85) : i === 2 ? mk(2, 0.1, 0.7) : mk(i, 0.05);
      answers[`promo_${i}`] = {
        type: "noul",
        noul: i === 0 ? 0.95 : 0.05,
      };
    }
    return { ok: true, answers, tookMs: 20, cached: false };
  });
  const rank = createRankLinksTool(jev.client);
  const result = await rank({ intent: "official pricing", limit: 3 }, call);

  assert.equal(jev.askCount(), 1); // single fan-out call
  assert.equal(Object.keys(jev.lastAsk().questions).length, 8); // 2×4 links
  assert.equal(jev.lastAsk().state.intent, "official pricing");
  assert.equal(result.ok, true);
  assert.equal(result.links[0].href, "https://example.com/pricing"); // p_exact 0.85 first
  assert.equal(result.links[0].relevance, "exact match");
  assert.equal(result.links[1].href, "https://example.com/blog"); // related second
  assert.equal(result.links.length, 3); // limit respected
  const sponsored = result.links.find((l) => l.href.includes("ad.example.com"));
  assert.ok(sponsored ? sponsored.promoted === true : true);
  // top_organic excludes the sponsored one
  assert.equal(result.top_organic.includes("https://ad.example.com/offer"), false);
});

test("rank_links: intent required, no links → ok:false, jev failure → fallback", async () => {
  const { call } = makeCall({ extract_links: LINKS });
  const ok = jevStub(() => ({ ok: true, answers: {}, tookMs: 1, cached: false }));
  const rank = createRankLinksTool(ok.client);
  await assert.rejects(() => rank({}, call), /intent is required/);

  const empty = makeCall({ extract_links: { links: [], count: 0 } });
  const r2 = await rank({ intent: "x" }, empty.call);
  assert.equal(r2.ok, false);
  assert.equal(r2.error, "no_links");

  const fail = jevStub(() => ({ ok: false, error: "timeout", tookMs: 100 }));
  const r3 = await createRankLinksTool(fail.client)({ intent: "pricing" }, call);
  assert.equal(r3.ok, true);
  assert.equal(r3.fallback, true);
  assert.ok(Array.isArray(r3.links));
});

test("page_triage: fan-out flags, blockers computed, usable logic", async () => {
  const { calls, call } = makeCall({
    extract_text: { url: "https://site.com/article", title: "Article", text: "Full article body text here.", chars: 500 },
  });
  const jev = jevStub((state, questions) => {
    assert.equal(state.page.url, "https://site.com/article");
    const answers = {};
    for (const key of Object.keys(questions)) {
      if (key === "relevance") {
        answers[key] = { type: "score", score: 2, confidence: 0.9, probabilities: { "0": 0.05, "1": 0.1, "2": 0.85 } };
      } else {
        answers[key] = { type: "noul", noul: 0.05 };
      }
    }
    // Content properly loaded
    answers.content_loaded = { type: "noul", noul: 0.95 };
    return { ok: true, answers, tookMs: 30, cached: false };
  });
  const triage = createPageTriageTool(jev.client);
  const result = await triage({ intent: "read the article" }, call);

  assert.equal(jev.askCount(), 1);
  assert.equal(Object.keys(jev.lastAsk().questions).length, 7); // 6 nouls + relevance
  assert.equal(result.usable, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.relevance.label, "directly relevant");
  assert.equal(result.flags.content_loaded, 0.95);
  // main-region call only (chars ≥ 40 → no body fallback)
  assert.equal(calls.filter((c) => c.name === "extract_text").length, 1);
});

test("page_triage: login wall detected → usable:false with blocker", async () => {
  const { call } = makeCall({
    extract_text: [
      { url: "https://app.com/dash", title: "Dashboard", text: "", chars: 0 }, // main empty first
      { url: "https://app.com/dash", title: "Dashboard", text: "Sign in to continue Password Forgot password", chars: 120 }, // body fallback
    ],
  });
  const jev = jevStub((state, questions) => {
    const answers = {};
    for (const key of Object.keys(questions)) {
      answers[key] = { type: "noul", noul: 0.05 };
    }
    answers.needs_login = { type: "noul", noul: 0.97 };
    answers.content_loaded = { type: "noul", noul: 0.8 }; // page loaded, just gated
    return { ok: true, answers, tookMs: 25, cached: false };
  });
  const triage = createPageTriageTool(jev.client);
  const result = await triage({}, call);
  assert.equal(result.usable, false);
  assert.deepEqual(result.blockers, ["needs_login"]);
  // no relevance question without intent
  const noIntent = jevStub(() => ({ ok: true, answers: {}, tookMs: 1, cached: false }));
  const mk2 = makeCall({ extract_text: { url: "u", title: "t", text: "x".repeat(100), chars: 100 } });
  await createPageTriageTool(noIntent.client)({}, mk2.call);
  assert.equal("relevance" in noIntent.lastAsk().questions, false);
});

test("page_triage: empty text → ok:false; jev failure → fallback with preview", async () => {
  const empty = makeCall({
    extract_text: [
      { url: "chrome://newtab", title: "", text: "", chars: 0 },
      { url: "chrome://newtab", title: "", text: "", chars: 0 },
    ],
  });
  const jev = jevStub(() => ({ ok: true, answers: {}, tookMs: 1, cached: false }));
  const r1 = await createPageTriageTool(jev.client)({}, empty.call);
  assert.equal(r1.ok, false);
  assert.equal(r1.error, "no_page_text");

  const fail = jevStub(() => ({ ok: false, error: "api_500: down", tookMs: 10 }));
  const { call } = makeCall({ extract_text: { url: "u", title: "t", text: "Some page content ".repeat(20), chars: 640 } });
  const r2 = await createPageTriageTool(fail.client)({}, call);
  assert.equal(r2.ok, true);
  assert.equal(r2.fallback, true);
  assert.ok(r2.text_preview.length > 0);
});
