#!/usr/bin/env node
/*
 * Real-world navigation test: reuse across different URLs + bounded waits.
 * Proves: (a) create-or-reuse keeps ONE tab across different sites,
 *         (b) calls return fast even on heavy/never-idle SPAs (no 30s hang),
 *         (c) rapid identical retries collapse (dedup/reuse).
 */
const BASE = process.env.WEBBRIDGE_URL || "http://127.0.0.1:10087";
const HANG_THRESHOLD_MS = 15_000; // any single call slower than this = regression

let failures = 0;
const assert = (cond, msg) => {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};

async function tool(name, args) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, args }),
  });
  const json = await res.json();
  const elapsed = Date.now() - t0;
  if (!res.ok) throw new Error(`${name} failed (${elapsed}ms): ${JSON.stringify(json)}`);
  return { data: json.data, elapsed };
}

async function trackedTabs() {
  const { data } = await tool("list_tabs", {});
  return data.filter((t) => t.tracked);
}

async function main() {
  console.log(`Real navigation test → ${BASE}\n`);
  const status = await fetch(`${BASE}/api/status`).then((r) => r.json()).catch(() => null);
  if (!status?.extension_connected) {
    console.error("Extension not connected."); process.exit(2);
  }

  await tool("name_session", { name: "real-nav-test" });

  // --- 1) Reuse across DIFFERENT origins (one tab repurposed) ---
  console.log("1) Reuse across different sites (expect same tabId, created once)");
  const sites = [
    "https://github.com",
    "https://news.ycombinator.com",
    "https://example.com",
    "https://github.com", // back to first origin
  ];
  let firstTab = null;
  for (const url of sites) {
    const { data, elapsed } = await tool("navigate", { url, newTab: true, waitUntil: "load" });
    if (firstTab === null) firstTab = data.tabId;
    console.log(
      `   ${url.padEnd(34)} tabId=${data.tabId} created=${data.created} reused=${data.reused} ` +
      `loaded=${data.loaded} (${data.loadReason}) ${elapsed}ms`
    );
    assert(elapsed < HANG_THRESHOLD_MS, `${url} returned in ${elapsed}ms (< ${HANG_THRESHOLD_MS}ms, no hang)`);
  }
  const tracked = await trackedTabs();
  assert(tracked.length === 1, `only 1 tracked tab across 4 sites (got ${tracked.length})`);
  assert(tracked[0]?.id === firstTab, `reused the same tabId ${firstTab}`);

  // --- 2) Heavy never-idle SPA with networkidle (must NOT hang) ---
  console.log("\n2) Never-idle SPA (youtube) with waitUntil:networkidle (bounded, no hang)");
  const { data: yt, elapsed: ytMs } = await tool("navigate", {
    url: "https://www.youtube.com",
    newTab: true,
    waitUntil: "networkidle",
  });
  console.log(
    `   youtube.com  tabId=${yt.tabId} reused=${yt.reused} loaded=${yt.loaded} ` +
    `(${yt.loadReason}) ${ytMs}ms`
  );
  assert(ytMs < 12_500, `networkidle bounded within ~10s budget (got ${ytMs}ms)`);
  assert(yt.tabId === firstTab, `still reusing the same tab (got ${yt.tabId})`);

  // --- 3) Rapid identical retries (dedup / reuse, no duplicate tab) ---
  console.log("\n3) Rapid identical retries x3 (dedup/reuse, no new tab)");
  const before = (await trackedTabs()).length;
  const rapid = await Promise.all([
    tool("navigate", { url: "https://example.com", newTab: true, waitUntil: "load" }),
    tool("navigate", { url: "https://example.com", newTab: true, waitUntil: "load" }),
    tool("navigate", { url: "https://example.com", newTab: true, waitUntil: "load" }),
  ]);
  rapid.forEach((r, i) =>
    console.log(`   retry ${i + 1}: tabId=${r.data.tabId} reused=${r.data.reused} loaded=${r.data.loaded} ${r.elapsed}ms`)
  );
  const after = (await trackedTabs()).length;
  assert(after === before, `no new tab created by retries (before=${before}, after=${after})`);
  assert(new Set(rapid.map((r) => r.data.tabId)).size === 1, "all retries used the same tabId");

  // --- cleanup ---
  console.log("\n4) finalize");
  const fin = await tool("finalize_tabs", { keep: [] });
  console.log(`   closed=${fin.data.closed?.length ?? 0}`);
  assert((await trackedTabs()).length === 0, "0 tracked after finalize");

  console.log(`\n${failures === 0 ? "PASS ✅" : `FAIL ❌ (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("errored:", e); process.exit(1); });
