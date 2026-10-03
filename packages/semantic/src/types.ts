// @webbridge/semantic — optional side-feature types.
//
// The daemon core never imports this package statically. It discovers it via
// dynamic import (guarded by WEBBRIDGE_SEMANTIC_ENABLED) and talks to it through
// the structural types below. The daemon keeps its own structurally-compatible
// SideToolHandler declaration (see daemon/src/router/tool-router.ts).

// --- Jev (TypeSafe) client -------------------------------------------------

export interface JevQuestion {
  type: "choice" | "score" | "noul";
  /** Plain question, or structured object (TypeSafe "advanced: structure"). */
  instructions: string | Record<string, unknown>;
  /** Choice options / Score legend / Noul criteria. */
  criteria?: unknown;
}

export interface JevAnswer {
  type: "choice" | "score" | "noul";
  choice?: string;
  score?: number;
  noul?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface JevUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export type JevState = string | Record<string, unknown>;

export type JevAskResult =
  | {
      ok: true;
      answers: Record<string, JevAnswer>;
      model?: string;
      tookMs: number;
      cached: boolean;
      usage?: JevUsage;
    }
  | {
      ok: false;
      error: string;
      tookMs: number;
    };

// --- Side tools (daemon-registered) -----------------------------------------

/**
 * Policy-aware tool call handed to side-tool handlers. It applies the same
 * daemon policies (paused / evaluate_enabled) as direct HTTP callers, then
 * routes through the normal ToolRouter (dedup, timeouts, extension dispatch).
 */
export type SideToolCall = (
  name: string,
  args?: Record<string, unknown>
) => Promise<unknown>;

export type SideToolHandler = (
  args: Record<string, unknown>,
  call: SideToolCall
) => Promise<unknown>;

export interface SemanticFeatureStatus {
  enabled: true;
  jev: "ok" | "no_api_key" | "error" | "untested";
  model: string;
  tools: string[];
  last_call: {
    ok: boolean;
    tookMs: number;
    at: string;
    questions: number;
    cached: boolean;
    error?: string;
  } | null;
}

export interface SemanticFeature {
  /** Tool name → handler. Registered on the daemon ToolRouter. */
  sideTools: Map<string, SideToolHandler>;
  /** Side-tool names that remain available while the daemon is paused. */
  readOnlyToolNames: string[];
  status(): SemanticFeatureStatus;
}

// --- Configuration (mirrors the daemon's additive config block) --------------

export interface SemanticConfig {
  jevApiKey: string;
  jevModel: string;
  jevBaseUrl: string;
  jevTimeoutMs: number;
  jevMinConfidence: number;
  jevMaxCandidates: number;
  // --- goal loop (run_goal): the ONLY generative call in the loop ----------
  /** OpenAI-compatible key used when the chosen operation is TYPE_TEXT. */
  textModelApiKey?: string;
  textModelBaseUrl?: string;
  textModelId?: string;
  /** "none" disables provider-side reasoning (fastest). */
  textModelReasoning?: string;
  /**
   * Wall guard: when the FIRST observation of a run has fewer compatible
   * controls than this, the loop asks `page_triage` once and pauses if the page
   * is not usable (login wall, paywall, CAPTCHA, error page) instead of burning
   * the step budget on it. `0` disables the guard. Default 10.
   */
  goalTriageMinElements?: number;
}

export type Logger = (line: string) => void;

export interface CreateSemanticFeatureOptions {
  config: SemanticConfig;
  log?: Logger;
  /** Injectable for tests. */
  jev?: import("./jev/client.js").JevClient;
}
