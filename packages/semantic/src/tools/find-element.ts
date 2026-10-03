// find_element — Layer 1 semantic element resolution.
//
// Replaces the "get_visible_dom → agent reads a 100-500 element dump → agent
// picks a nodeId → click_element" loop (2 LLM turns + thousands of tokens)
// with ONE daemon-side call: get_visible_dom (local) + one Jev Choice (~700ms).
//
// Safety: the Choice always includes a `__none__` escape option, so Jev never
// gets coerced into picking a wrong element when nothing matches. NodeIds stay
// valid until the next get_visible_dom call (data-wb-id attributes persist in
// the DOM), so low-confidence results can still be resolved manually by the
// agent via click_element/type_element.

import type { JevClient } from "../jev/client.js";
import type { SemanticConfig, SideToolHandler } from "../types.js";
import { resolveAgentTab } from "./agent-tab.js";

export const NONE_OPTION = "__none__";

export interface DomCandidate {
  id: string;
  tag?: string;
  text?: string;
  role?: string;
  href?: string;
  type?: string;
  placeholder?: string;
  ariaLabel?: string;
  value?: string;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface CompactCandidate {
  nodeId: string;
  tag?: string;
  text?: string;
  ariaLabel?: string;
  href?: string;
  placeholder?: string;
}

const truncate = (s: string, max: number): string =>
  s.length > max ? s.slice(0, max) : s;

function candidateSummary(c: DomCandidate): string {
  const parts: string[] = [`<${c.tag ?? c.role ?? "?"}>`];
  if (c.ariaLabel) parts.push(`aria="${c.ariaLabel}"`);
  if (c.text) parts.push(`text="${c.text}"`);
  if (c.placeholder) parts.push(`placeholder="${c.placeholder}"`);
  if (c.value) parts.push(`value="${c.value}"`);
  if (c.href) parts.push(`href="${c.href}"`);
  return truncate(parts.join(" "), 140);
}

function compact(c: DomCandidate): CompactCandidate {
  const out: CompactCandidate = { nodeId: c.id };
  if (c.tag) out.tag = c.tag;
  if (c.text) out.text = truncate(c.text, 80);
  if (c.ariaLabel) out.ariaLabel = truncate(c.ariaLabel, 80);
  if (c.href) out.href = truncate(c.href, 120);
  if (c.placeholder) out.placeholder = truncate(c.placeholder, 80);
  return out;
}

export function createFindElementTool(
  jev: JevClient,
  config: SemanticConfig
): SideToolHandler {
  return async (args, call) => {
    const description =
      typeof args.description === "string" ? args.description.trim() : "";
    if (!description) {
      throw new Error("find_element: description is required (e.g. \"the login button\")");
    }
    const tabId =
      typeof args.tabId === "number" ? args.tabId : await resolveAgentTab(call);

    const dom = (await call(
      "get_visible_dom",
      tabId !== undefined ? { tabId } : {}
    )) as DomCandidate[];
    if (!Array.isArray(dom) || dom.length === 0) {
      return {
        ok: false,
        error: "no_visible_elements",
        hint: "get_visible_dom returned no interactable elements; the page may still be loading — wait_for then retry.",
      };
    }

    const candidates = dom.slice(0, config.jevMaxCandidates);
    const criteria: Record<string, string> = {};
    for (const c of candidates) {
      criteria[c.id] = candidateSummary(c);
    }
    criteria[NONE_OPTION] = "No candidate element matches the intent";

    const result = await jev.ask(
      { intent: description },
      {
        pick: {
          type: "choice",
          instructions: {
            question: `Which candidate element does the intent \`${description}\` refer to?`,
            focus:
              "Pick the exact interactable element (button, link, input, ...) a person would use for this intent — not a container or a static label. Candidates are in visible order.",
            none: `Use \`${NONE_OPTION}\` only when no candidate plausibly matches the intent.`,
          },
          criteria,
        },
      }
    );

    const fallbackCandidates = candidates.slice(0, 15).map(compact);

    if (!result.ok) {
      return {
        ok: true,
        fallback: true,
        reason: "jev_unavailable",
        error: result.error,
        candidates: fallbackCandidates,
        hint: "Jev unavailable — pick a nodeId manually and call click_element/type_element (ids stay valid until the next get_visible_dom).",
      };
    }

    const pick = result.answers.pick;
    const probabilities = pick?.probabilities ?? {};
    const top = Object.entries(probabilities)
      .filter(([id]) => id !== NONE_OPTION)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([nodeId, probability]) => ({ nodeId, probability }));

    const nodeId = pick?.choice;
    if (nodeId === NONE_OPTION) {
      return {
        ok: true,
        nodeId: null,
        reason: "no_match",
        confidence: pick?.confidence ?? null,
        top,
        totalCandidates: candidates.length,
        hint: "Jev found no matching element. Widen the description, scroll (new elements need a fresh find_element), or inspect candidates via get_visible_dom.",
      };
    }
    if (!nodeId || !(nodeId in criteria)) {
      return {
        ok: true,
        fallback: true,
        reason: "invalid_choice",
        error: `Jev returned unknown option "${String(nodeId)}"`,
        candidates: fallbackCandidates,
        hint: "Resolve manually via click_element/type_element.",
      };
    }

    const matched = candidates.find((c) => c.id === nodeId);
    return {
      ok: true,
      nodeId,
      confidence: pick?.confidence ?? null,
      top,
      matched: matched ? compact(matched) : undefined,
      totalCandidates: candidates.length,
      tookMs: result.tookMs,
      cached: result.cached,
    };
  };
}
