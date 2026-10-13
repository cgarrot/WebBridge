import type { VirtualCameraArgs, VirtualCameraState } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "../base.js";

const VIRTUAL_CAMERA_GLOBAL = "__webbridgeVirtualCamera";

async function findMeetTabId(): Promise<number | null> {
  const tabs = await chrome.tabs.query({ url: "https://meet.google.com/*" });
  if (tabs.length === 0) return null;
  const active = tabs.find((t) => t.active);
  const candidate = active ?? tabs[0];
  return candidate.id ?? null;
}

async function evaluateOnTab(
  tabId: number,
  expression: string,
  ctx: ToolContext
): Promise<unknown> {
  await ctx.cdp.send(tabId, "Runtime.enable");
  const evaluated = await ctx.cdp.send<{
    result: { type: string; value?: unknown; description?: string };
    exceptionDetails?: { text: string };
  }>(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (evaluated.exceptionDetails) {
    throw new Error(`virtual_camera evaluate failed: ${evaluated.exceptionDetails.text}`);
  }
  return evaluated.result.value ?? evaluated.result.description;
}

export class VirtualCameraTool extends BaseTool {
  readonly name = "virtual_camera" as const;
  readonly description =
    "Replace the user's real webcam in Google Meet with an animated ASCII-art persona.";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const typed = args as unknown as Partial<VirtualCameraArgs>;
    const state: VirtualCameraState = (typed.state as VirtualCameraState) ?? "idle";
    const allowedStates: VirtualCameraState[] = ["idle", "thinking", "speaking", "muted"];
    if (!allowedStates.includes(state)) {
      throw new Error(
        `virtual_camera: invalid state "${state}". Allowed: ${allowedStates.join(", ")}`
      );
    }

    const tabId = typed.tabId ?? (await findMeetTabId());
    if (!tabId) {
      return {
        ok: false,
        armed: false,
        state,
        error: "No meet.google.com tab found and no tabId provided.",
        guidance:
          "Open a Google Meet meeting first, or pass an explicit tabId of the Meet tab.",
      };
    }

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !tab.url?.startsWith("https://meet.google.com/")) {
      return {
        ok: false,
        armed: false,
        state,
        tabId,
        error: `Tab ${tabId} is not a Google Meet tab (${tab?.url ?? "unknown"}).`,
        guidance: "Target a Meet tab, or omit tabId to auto-detect one.",
      };
    }

    // The content script is injected via manifest at document_start on Meet.
    // Verify it is present; if not, the user needs to reload the Meet tab.
    const apiCheckExpression = `typeof ${VIRTUAL_CAMERA_GLOBAL} !== 'undefined' ? 'ready' : 'missing'`;
    const ready = await evaluateOnTab(tabId, apiCheckExpression, ctx);
    if (ready !== "ready") {
      return {
        ok: false,
        armed: false,
        state,
        tabId,
        ready,
        error: "Virtual camera API is not available in the Meet tab.",
        guidance:
          "Reload the Meet tab so the WebBridge virtual_camera content script is injected.",
      };
    }

    const armOptions: Record<string, unknown> = {
      persona: typed.persona ?? "zob",
      fps: typed.fps ?? 15,
    };
    if (typed.name) armOptions.name = typed.name;
    if (typed.mirror !== undefined) armOptions.mirror = typed.mirror;

    const armResult = await evaluateOnTab(
      tabId,
      `${VIRTUAL_CAMERA_GLOBAL}.arm(${JSON.stringify(armOptions)})`,
      ctx
    );

    if (armResult !== true) {
      return {
        ok: false,
        armed: false,
        state,
        tabId,
        error: "Failed to install virtual camera patch in Meet tab.",
        guidance:
          "Reload the Meet tab and try again; if the problem persists, check that the WebBridge extension content scripts have permission on meet.google.com.",
      };
    }

    await evaluateOnTab(tabId, `${VIRTUAL_CAMERA_GLOBAL}.setState(${JSON.stringify(state)})`, ctx);

    return {
      ok: true,
      armed: true,
      state,
      tabId,
      persona: typed.persona ?? "zob",
      name: typed.name ?? typed.persona ?? "zob",
      mirror: typed.mirror ?? true,
      fps: typed.fps ?? 15,
      guidance:
        "Virtual ASCII camera is active. In Google Meet, select 'Viso ASCII Cam' from the camera dropdown. Use state 'thinking'/'speaking'/'idle' to animate the persona.",
    };
  }
}
