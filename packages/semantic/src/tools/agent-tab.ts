// Agent-tab resolution for semantic tools.
//
// SAFETY: without an explicit tabId, browser tools resolve to Chrome's ACTIVE
// tab — which is whatever the HUMAN user is looking at. Semantic tools must
// never send the user's unrelated active page to Jev: when the agent session
// owns tracked tabs, prefer the session's primary tab. Only when no session
// tab exists do we fall through to the active tab (same behavior as the
// underlying tools, for agents that operate without sessions).

import type { SideToolCall } from "../types.js";

interface TabEntry {
  id?: number;
  url?: string;
  active?: boolean;
  tracked?: boolean;
  primary?: boolean;
}

export async function resolveAgentTab(
  call: SideToolCall
): Promise<number | undefined> {
  try {
    const tabs = (await call("list_tabs", {})) as TabEntry[];
    if (!Array.isArray(tabs)) return undefined;
    // Skip blank just-created tabs (url "" — content not committed yet);
    // they accumulate with session churn and resolve to empty extractions.
    const usable = tabs.filter(
      (t) => t?.tracked && typeof t.id === "number" && typeof t.url === "string" && t.url !== ""
    );
    const primary =
      usable.find((t) => t.primary) ??
      usable.find((t) => t.active) ??
      usable[usable.length - 1]; // most recently created
    return typeof primary?.id === "number" ? primary.id : undefined;
  } catch {
    return undefined; // fall through to the underlying tool's default
  }
}
