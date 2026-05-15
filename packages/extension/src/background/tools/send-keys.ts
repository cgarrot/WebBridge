import type { SendKeysArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";

const SPECIAL_KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
};

const MODIFIER_FLAGS: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  meta: 4,
  shift: 8,
};

export class SendKeysTool extends BaseTool {
  readonly name = "send_keys" as const;
  readonly description = "Send keyboard key events";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { tabId: rawTabId, keys, modifiers = [] } = args as unknown as SendKeysArgs;

    if (!keys?.length) throw new Error("send_keys: keys array is required");

    const tabId = await resolveTabId(rawTabId);
    const modifierFlags = modifiers.reduce(
      (acc, m) => acc | (MODIFIER_FLAGS[m] ?? 0),
      0
    );

    for (const key of keys) {
      const special = SPECIAL_KEYS[key];
      const params = special
        ? { ...special, modifiers: modifierFlags }
        : { key, text: key, modifiers: modifierFlags };

      await ctx.cdp.send(tabId, "Input.dispatchKeyEvent", {
        type: "keyDown",
        ...params,
      });
      await ctx.cdp.send(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        ...params,
      });
    }

    return { tabId, keysSent: keys.length };
  }
}
