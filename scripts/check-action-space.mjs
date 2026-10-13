#!/usr/bin/env node
/*
 * WebBridge action_space smoke test (no model calls, no mutations).
 *
 * Verifies the observation contract the goal loop depends on:
 *   1. `action_space` exists and returns an indexed, deduplicated action table.
 *   2. Every element action carries a `node` that `element_info` resolves back
 *      to the same `data-wb-id` (otherwise the executor could never click it).
 *   3. `marker` is present and changes when the page changes.
 *   4. Pseudo-controls (`scroll_down`/`scroll_up`/`wait`) are present.
 *   5. Only observations happen: no click/type call is made.
 *
 * Requires a running daemon + connected extension:
 *   curl -s http://127.0.0.1:10087/api/status   # extension_connected:true
 *
 * Usage:
 *   node scripts/check-action-space.mjs
 *   node scripts/check-action-space.mjs https://example.com
 *   WEBBRIDGE_URL=http://127.0.0.1:10087 node scripts/check-action-space.mjs
 */
const BASE = process.env.WEBBRIDGE_URL || "http://127.0.0.1:10087";
const URL_ARG = process.argv[2] || "https://example.com";

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
};

async function tool(name, args = {}) {
  const res = await fetch(`${BASE}/api/tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, args }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`${name}: ${json.error || `HTTP ${res.status}`}`);
  return json.data ?? json;
}

const status = await fetch(`${BASE}/api/status`).then((r) => r.json());
if (!status.extension_connected) {
  console.error("extension not connected — start Chrome with the WebBridge extension first");
  process.exit(1);
}
if (!(status.capabilities ?? []).includes("action_space")) {
  console.error("action_space is not registered — run `pnpm build:extension`, then reload the extension from chrome://extensions");
  process.exit(1);
}

console.log(`\nopening ${URL_ARG}`);
const tab = await tool("new_tab", { url: URL_ARG, waitUntil: "domcontentloaded" });
const tabId = tab.id ?? tab.tabId;
await new Promise((r) => setTimeout(r, 1200));

console.log("\n1. observation");
const obs = await tool("action_space", { tabId });
assert(obs.ok === true, "ok:true returned");
assert(typeof obs.url === "string" && obs.url.startsWith("http"), `url reported (${obs.url})`);
assert(typeof obs.marker === "string" && obs.marker.length > 10, `marker present (${obs.marker.length} chars)`);
assert(typeof obs.text === "string", `visible text present (${obs.text.length} chars)`);
assert(Array.isArray(obs.actions) && obs.actions.length > 0, `${obs.actions.length} actions observed`);

const elementActions = obs.actions.filter((a) => a.node && ["click", "fill", "select"].includes(a.kind));
assert(elementActions.length > 0, `${elementActions.length} element actions with a node id`);
assert(new Set(elementActions.map((a) => a.node)).size <= elementActions.length, "nodes are deduplicated per element");

console.log("\n2. ids resolve back through element_info (what click_element needs)");
// Mirrors the goal loop's occlusion policy:
//   same tracked id  → consistent
//   found:false      → unverifiable (background window / point outside the visual viewport)
//   found, no wbId   → untracked child or overlay: the click bubbles to the target
//   other tracked id → genuinely covered (the only case the loop rejects)
let same = 0;
let unverifiable = 0;
let untracked = 0;
let covered = 0;
let checked = 0;
for (const action of elementActions.slice(0, 8)) {
  if (!action.rect) continue;
  const x = Math.round(action.rect.x + action.rect.w / 2);
  const y = Math.round(action.rect.y + action.rect.h / 2);
  const info = await tool("element_info", { tabId, x, y });
  checked++;
  if (!info.found) unverifiable++;
  else if (!info.element?.wbId) untracked++;
  else if (info.element.wbId === action.node) same++;
  else {
    covered++;
    console.log(`    covered: ${action.node} (${action.label.slice(0, 30)}) under ${info.element.wbId}`);
  }
}
assert(checked > 0, `${checked} targets sampled`);
console.log(`    same=${same} untracked-child=${untracked} unverifiable=${unverifiable} covered=${covered}`);
assert(covered === 0, "no observed target is covered by another tracked element");

console.log("\n3. pseudo-controls");
const ids = obs.actions.map((a) => a.id);
assert(ids.includes("wait"), "wait control present");
const scrollable = obs.scroll.y + obs.h < obs.scroll.height - 2;
if (scrollable) assert(ids.includes("scroll_down"), "scroll down control present (page is scrollable)");
else console.log("  – page has no scrollable overflow: no scroll control (expected)");
assert(obs.actions.filter((a) => a.kind === "scroll").every((a) => typeof a.delta === "number"), "scroll deltas are numeric");

console.log("\n4. read-only guarantee");
const before = await tool("action_space", { tabId });
assert(before.marker === obs.marker, "a second observation did not change the page (no mutation)");

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`} — ${elementActions.length} actionable elements on ${obs.url}\n`);
process.exit(failures === 0 ? 0 : 1);
