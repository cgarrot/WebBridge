// smart_click / smart_type — confidence-gated semantic interaction (Layer 1).
//
// find_element resolves the description to a nodeId; when Jev is decisive the
// action runs in the same agent turn. Acting requires EITHER:
//   - calibrated confidence >= minConfidence, OR
//   - a decisive probability margin (top >= 0.6 and lead over #2 >= 0.25) —
//     Jev's confidence is calibration, not correctness; a large margin on the
//     probability distribution is an independent decisiveness signal.
// When neither holds the action is REFUSED and the top-3 candidates are
// returned so the calling agent can disambiguate with one explicit
// click_element/type_element call — never a blind click (TypeSafe
// "confidence-gated routing" pattern).

import type { SemanticConfig, SideToolHandler } from "../types.js";

type SmartKind = "click" | "type";

const TOOL_NAMES: Record<SmartKind, string> = {
  click: "smart_click",
  type: "smart_type",
};

const DECISIVE_MIN_PROBABILITY = 0.6;
const DECISIVE_MIN_MARGIN = 0.25;

function decisiveGate(top: unknown): { decisive: boolean; probability?: number; margin?: number } {
  if (!Array.isArray(top) || top.length === 0) return { decisive: false };
  const first = top[0] as { probability?: number };
  const second = (top[1] as { probability?: number } | undefined)?.probability ?? 0;
  const probability = typeof first.probability === "number" ? first.probability : 0;
  const margin = probability - second;
  return {
    decisive: probability >= DECISIVE_MIN_PROBABILITY && margin >= DECISIVE_MIN_MARGIN,
    probability,
    margin,
  };
}

export function createSmartInteractTool(
  kind: SmartKind,
  findElement: SideToolHandler,
  config: SemanticConfig
): SideToolHandler {
  const name = TOOL_NAMES[kind];
  return async (args, call) => {
    if (kind === "type" && typeof args.text !== "string") {
      throw new Error(`${name}: text is required`);
    }
    const tabId = typeof args.tabId === "number" ? args.tabId : undefined;
    const minConfidence =
      typeof args.minConfidence === "number"
        ? args.minConfidence
        : config.jevMinConfidence;

    const found = (await findElement(args, call)) as Record<string, unknown>;
    if (found?.ok !== true) {
      return found; // hard errors (no_visible_elements, bad args, ...)
    }
    if (found.fallback === true) {
      return { ...found, acted: false, reason: found.reason ?? "jev_unavailable" };
    }
    if (found.nodeId === null || found.nodeId === undefined) {
      return { ...found, acted: false, reason: "no_match" };
    }

    const nodeId = found.nodeId as string;
    const confidence =
      typeof found.confidence === "number" ? found.confidence : 0;
    const gate = decisiveGate(found.top);
    if (confidence < minConfidence && !gate.decisive) {
      return {
        ok: true,
        acted: false,
        reason: "low_confidence",
        nodeId,
        confidence,
        minConfidence,
        top: found.top,
        hint: "Refused to act. Disambiguate with click_element/type_element using an explicit nodeId (valid until the next get_visible_dom), or re-run with a clearer description.",
      };
    }

    const result = (kind === "click"
      ? await call("click_element", { nodeId, ...(tabId !== undefined ? { tabId } : {}) })
      : await call("type_element", {
          nodeId,
          text: args.text,
          clearFirst: true,
          ...(tabId !== undefined ? { tabId } : {}),
        })) as Record<string, unknown>;

    return {
      ok: true,
      acted: true,
      kind,
      nodeId,
      confidence,
      gate: confidence >= minConfidence ? "confidence" : "decisive",
      result,
    };
  };
}
