#!/usr/bin/env node
/*
 * WebBridge tab-lifecycle smoke test.
 *
 * Validates the fixes that stop "infinite windows":
 *   1. Repeated `navigate {newTab:true}` reuses one tab (create-or-reuse).
 *   2. `new_tab` (force create) is bounded by MAX_AGENT_TABS.
 *   3. `finalize_tabs` cleans everything up.
 *
 * Requires a running daemon + connected extension:
 *   curl -s http://127.0.0.1:10087/api/status   # extension_connected:true
 *
 * Usage:
 *   node scripts/test-tab-lifecycle.mjs
 *   WEBBRIDGE_URL=http://127.0.0.1:10087 node scripts/test-tab-lifecycle.mjs
 */
const BASE = process.env.WEBBRIDGE_URL || "http://127.0.0.1:10087";
const MAX_AGENT_TABS = 8;

let failures = 0;
const assert = (cond, msg) => {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
};

async function tool(name, args) {
  const res = await fetch(`${BASE}/api/tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, args }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${name} failed: ${JSON.stringify(json)}`);
  return json.data;
}

const trackedCount = async () => {
  const tabs = await tool("list_tabs", {});
  return Array.isArray(tabs) ? tabs.filter((t) => t.tracked).length : 0;
};

async function main() {
  console.log(`WebBridge tab-lifecycle smoke test → ${BASE}\n`);

  const status = await fetch(`${BASE}/api/status`).then((r) => r.json()).catch(() => null);
  if (!status?.extension_connected) {
    console.error("Extension not connected. Start daemon + load extension first.");
    process.exit(2);
  }

  await tool("name_session", { name: "smoke-tab-lifecycle" });

  // 1) Repeated navigate with newTab:true must REUSE one tab.
  console.log("1) navigate newTab:true x6 → expect 1 reused tab");
  for (let i = 0; i < 6; i++) {
    const r = await tool("navigate", { url: "https://example.com", newTab: true, waitUntil: "load" });
    console.log(`   call ${i + 1}: tabId=${r.tabId} created=${r.created} reused=${r.reused} loaded=${r.loaded}`);
  }
  const afterNav = await trackedCount();
  assert(afterNav === 1, `only 1 tracked tab after 6 navigations (got ${afterNav})`);

  // 2) new_tab force-creates but must stay <= MAX_AGENT_TABS.
  console.log(`\n2) new_tab x12 → expect <= ${MAX_AGENT_TABS} tracked (cap enforced)`);
  for (let i = 0; i < 12; i++) {
    await tool("new_tab", { url: "https://example.com" });
  }
  const afterNew = await trackedCount();
  assert(afterNew <= MAX_AGENT_TABS, `tracked tabs <= ${MAX_AGENT_TABS} (got ${afterNew})`);

  // 3) finalize_tabs closes all agent tabs.
  console.log("\n3) finalize_tabs {keep:[]} → expect 0 tracked");
  const fin = await tool("finalize_tabs", { keep: [] });
  console.log(`   closed=${fin.closed?.length ?? 0} kept=${fin.kept?.length ?? 0} released=${fin.released?.length ?? 0}`);
  const afterFin = await trackedCount();
  assert(afterFin === 0, `0 tracked tabs after finalize (got ${afterFin})`);

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures} assertion(s))`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test errored:", err);
  process.exit(1);
});
