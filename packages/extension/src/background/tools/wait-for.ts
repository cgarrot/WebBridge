import type { WaitForArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";
import { waitForLoad } from "../../cdp/load.js";

export class WaitForTool extends BaseTool {
  readonly name = "wait_for" as const;
  readonly description = "Wait for a page condition (selector, navigation, load, network idle)";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const {
      tabId: rawTabId,
      type = "load",
      value,
      timeoutMs = 10_000,
    } = args as unknown as WaitForArgs;

    const tabId = await resolveTabId(rawTabId);

    switch (type) {
      case "selector":
        return this.waitForSelector(tabId, value!, timeoutMs, ctx);
      case "navigation":
        return this.waitForEvent(tabId, "Page.frameNavigated", timeoutMs, ctx);
      case "load":
        return this.waitForTabLoad(tabId, timeoutMs);
      case "network_idle":
        return this.waitForNetworkIdle(tabId, timeoutMs);
      default:
        throw new Error(`wait_for: unknown type "${type}"`);
    }
  }

  private async waitForSelector(
    tabId: number,
    selector: string,
    timeoutMs: number,
    ctx: ToolContext
  ): Promise<unknown> {
    if (!selector) throw new Error("wait_for: value (selector) is required for type=selector");

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await ctx.cdp.send<{ result: { value: boolean } }>(
        tabId, "Runtime.evaluate",
        { expression: `!!document.querySelector(${JSON.stringify(selector)})`, returnByValue: true }
      );
      if (result.result.value) {
        return { tabId, type: "selector", selector, found: true };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`wait_for: selector "${selector}" not found within ${timeoutMs}ms`);
  }

  private async waitForTabLoad(tabId: number, timeoutMs: number): Promise<unknown> {
    const result = await waitForLoad(tabId, { kind: "load", timeoutMs });
    if (!result.loaded) {
      throw new Error(`wait_for: load not reached within ${timeoutMs}ms (${result.reason})`);
    }
    return { tabId, type: "load", complete: true };
  }

  private waitForEvent(
    tabId: number,
    eventName: string,
    timeoutMs: number,
    ctx: ToolContext
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.debugger.onEvent.removeListener(listener);
        reject(new Error(`wait_for: ${eventName} timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const listener = (source: chrome.debugger.Debuggee, method: string) => {
        if (source.tabId === tabId && method === eventName) {
          clearTimeout(timer);
          chrome.debugger.onEvent.removeListener(listener);
          resolve({ tabId, type: eventName.includes("Navigate") ? "navigation" : "load", fired: true });
        }
      };

      ctx.cdp.send(tabId, "Page.enable").then(() => {
        chrome.debugger.onEvent.addListener(listener);
      });
    });
  }

  private async waitForNetworkIdle(tabId: number, timeoutMs: number): Promise<unknown> {
    const result = await waitForLoad(tabId, { kind: "networkidle", timeoutMs });
    if (!result.loaded) {
      throw new Error(`wait_for: network not idle within ${timeoutMs}ms (${result.reason})`);
    }
    return { tabId, type: "network_idle", idle: true };
  }
}
