// Shared runtime policy for tool invocation.
//
// Single source of truth for `paused` and `evaluate_enabled`, used by BOTH the
// HTTP layer (direct /api/tool + /command callers) and daemon-side side-feature
// tools (semantic layer) through ToolRouter.policyCall — so opt-in side features
// can never bypass daemon policies.

const READ_ONLY_TOOLS = new Set([
  "list_tabs",
  "find_tab",
  "snapshot",
  "screenshot",
  "get_tab_info",
  "console_logs",
  "element_info",
]);

export class PolicyState {
  paused = false;
  evaluateEnabled = false;
  private readOnlySideTools = new Set<string>();

  /** Returns an error message when the tool must be refused, else undefined. */
  check(name: string): string | undefined {
    if (name === "evaluate" && !this.evaluateEnabled) {
      return 'evaluate is disabled. Enable it with POST /config {"evaluate_enabled":true} before use.';
    }
    if (
      this.paused &&
      !READ_ONLY_TOOLS.has(name) &&
      !this.readOnlySideTools.has(name)
    ) {
      return "WebBridge browser control is paused. Read-only tools remain available.";
    }
    return undefined;
  }

  /** Names of registered side-feature tools that stay available while paused. */
  setReadOnlySideTools(names: string[]): void {
    this.readOnlySideTools = new Set(names);
  }
}
