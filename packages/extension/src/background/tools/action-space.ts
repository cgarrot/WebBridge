import type { ActionSpaceArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";
import { actionSpaceExpression } from "./action-space-script.js";

/**
 * action_space — one atomic observation of everything actionable on the page.
 *
 * This is the extension half of the daemon-side Jev goal loop: the daemon picks
 * ONE operation and ONE target from this table (one TypeSafe request), then
 * executes it with click_element / type_element. It also assigns `data-wb-id`
 * itself, so the ids returned here stay resolvable by the executor.
 *
 * Read-only: no input is dispatched.
 */
export class ActionSpaceTool extends BaseTool {
  readonly name = "action_space" as const;
  readonly description =
    "Observe an indexed action space (visible controls + operations + page text + freshness marker) for decision-model loops";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const {
      tabId: rawTabId,
      maxActions,
      maxTextChars,
      maxGuardChars,
    } = args as unknown as ActionSpaceArgs;
    const tabId = await resolveTabId(rawTabId);

    const result = await ctx.cdp.send<{ result: { value: unknown } }>(
      tabId,
      "Runtime.evaluate",
      {
        expression: actionSpaceExpression({ maxActions, maxTextChars, maxGuardChars }),
        returnByValue: true,
        awaitPromise: false,
      }
    );

    const value = result.result.value;
    if (!value || typeof value !== "object") {
      return {
        tabId,
        ok: false,
        error: "action_space: page has no body (about:blank, crashed tab, or a chrome:// page)",
      };
    }

    return { tabId, ok: true, ...(value as Record<string, unknown>) };
  }
}
