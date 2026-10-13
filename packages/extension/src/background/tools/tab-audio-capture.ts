import type { TabAudioCaptureArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";

const OFFSCREEN_URL = "offscreen/tab-audio.html";

type TabAudioAction = NonNullable<TabAudioCaptureArgs["action"]>;

function getMediaStreamId(options: chrome.tabCapture.GetMediaStreamOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId(options, (streamId) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      if (!streamId) {
        reject(new Error("tab_audio_capture: Chrome returned an empty stream id"));
        return;
      }
      resolve(streamId);
    });
  });
}

async function getOffscreenDocumentUrl(): Promise<string | undefined> {
  const runtimeWithContexts = chrome.runtime as typeof chrome.runtime & {
    getContexts?: (filter: { contextTypes: string[]; documentUrls?: string[] }) => Promise<Array<{ documentUrl?: string }>>;
  };

  if (runtimeWithContexts.getContexts) {
    const contexts = await runtimeWithContexts.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    return contexts[0]?.documentUrl;
  }

  const offscreenWithHasDocument = chrome.offscreen as typeof chrome.offscreen & {
    hasDocument?: () => Promise<boolean>;
  };
  if (offscreenWithHasDocument?.hasDocument && await offscreenWithHasDocument.hasDocument()) {
    return chrome.runtime.getURL(OFFSCREEN_URL);
  }

  return undefined;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (!chrome.offscreen?.createDocument) {
    throw new Error("tab_audio_capture: chrome.offscreen is unavailable. Reload the extension with the offscreen permission.");
  }
  if (await getOffscreenDocumentUrl()) return;

  // A previous run (killed session, extension reload, crashed offscreen doc)
  // can leave an offscreen document alive with a URL we no longer match.
  // chrome.offscreen.createDocument then fails with
  // "Only a single offscreen document may be created." and the capture can
  // never start again until the extension is reloaded. Close whatever is there.
  const hasDocument = (chrome.offscreen as typeof chrome.offscreen & { hasDocument?: () => Promise<boolean> }).hasDocument;
  try {
    if (hasDocument && await hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
  } catch {
    // If it refuses to close, the createDocument below reports the real reason.
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Capture the current tab audio for an explicit WebBridge speech-to-text prototype.",
  });
}

async function closeOffscreenDocumentIfIdle(): Promise<void> {
  if (!chrome.offscreen?.closeDocument) return;
  try {
    const status = await sendOffscreenMessage({ action: "status" });
    if ((status as { status?: string }).status === "idle") await chrome.offscreen.closeDocument();
  } catch {
    // Best-effort cleanup only.
  }
}

function sendOffscreenMessage(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "WEBBRIDGE_TAB_AUDIO", ...message }, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      if (!response || typeof response !== "object") {
        reject(new Error("tab_audio_capture: offscreen recorder returned no response"));
        return;
      }
      const typed = response as Record<string, unknown>;
      if (typed.ok === false) {
        reject(new Error(typeof typed.error === "string" ? typed.error : "tab_audio_capture offscreen recorder failed"));
        return;
      }
      resolve(typed);
    });
  });
}

function toSafeError(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const activeTabHint = message.toLowerCase().includes("active") || message.toLowerCase().includes("invoked");
  return {
    ok: false,
    state: activeTabHint ? "permission_or_user_gesture_required" : "error",
    error: message,
    noStreamIdPersisted: true,
    guidance: activeTabHint
      ? "Chrome blocked tab audio capture because the extension was not user-invoked for this page. For the hackathon prototype, click the WebBridge extension action on the Meet tab, then retry start; use meet_caption_extract as the no-audio fallback."
      : "Use action=status for recorder state, action=stop to clean up, or meet_caption_extract as a caption-based STT fallback.",
  };
}

export class TabAudioCaptureTool extends BaseTool {
  readonly name = "tab_audio_capture" as const;
  readonly description = "Prepare or run a prototype Chrome tab audio capture recorder for STT handoff";

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
    const { action = "preflight", tabId: rawTabId, consumerTabId } = args as unknown as TabAudioCaptureArgs;

    const available = Boolean(chrome.tabCapture?.getMediaStreamId);
    const offscreenAvailable = Boolean(chrome.offscreen?.createDocument);
    if (!available) {
      return {
        ok: false,
        state: "tab_capture_unavailable",
        action,
        permission: "tabCapture",
        liveAudioCaptureImplemented: false,
        guidance: "chrome.tabCapture is unavailable. Ensure the extension manifest includes the tabCapture permission and reload the extension.",
      };
    }

    if (action === "status") {
      if (!await getOffscreenDocumentUrl()) {
        return { ok: true, action, state: "idle", status: "idle", chunks: 0, totalBytes: 0, offscreenDocument: false };
      }
      return { action, state: "status", offscreenDocument: true, ...(await sendOffscreenMessage({ action })) };
    }

    if (action === "stop") {
      if (!await getOffscreenDocumentUrl()) {
        return { ok: true, action, state: "idle", status: "idle", chunks: 0, totalBytes: 0, offscreenDocument: false };
      }
      const stopped = await sendOffscreenMessage({ action });
      await closeOffscreenDocumentIfIdle();
      return { action, state: "stopped", offscreenDocument: Boolean(await getOffscreenDocumentUrl()), ...stopped };
    }

    if (action === "drain") {
      if (!await getOffscreenDocumentUrl()) {
        return { ok: true, action, state: "idle", status: "idle", chunks: [], drainedChunks: 0, drainedBytes: 0, offscreenDocument: false };
      }
      const { includeBase64 = true, clear = true, maxChunks, maxBytes } = args as unknown as TabAudioCaptureArgs;
      return {
        action,
        state: "drained",
        offscreenDocument: true,
        ...(await sendOffscreenMessage({ action, includeBase64, clear, maxChunks, maxBytes })),
      };
    }

    const tabId = rawTabId === undefined ? await resolveTabId(undefined) : await resolveTabId(rawTabId);
    const tab = await chrome.tabs.get(tabId);
    const base = {
      ok: true,
      action,
      tabId,
      tabTitle: tab.title,
      tabUrl: tab.url,
      permission: "tabCapture",
      offscreenPermission: "offscreen",
      offscreenAvailable,
      liveAudioCaptureImplemented: offscreenAvailable,
      guidance: offscreenAvailable
        ? "Use action=start to begin capture. Provide audioEndpoint/eventEndpoint to forward PCM chunks to Agent Viso; use action=drain for webm/opus chunks and action=stop for cleanup."
        : "tabCapture is available but chrome.offscreen is unavailable. Reload an extension build with the offscreen permission, or use meet_caption_extract as fallback.",
    };

    if (action === "preflight") {
      return {
        ...base,
        state: offscreenAvailable ? "ready_for_start" : "offscreen_unavailable",
        streamIdIssued: false,
        noStreamIdPersisted: true,
      };
    }

    if (action === "get_stream_id") {
      const streamId = await getMediaStreamId({
        targetTabId: tabId,
        ...(consumerTabId !== undefined ? { consumerTabId } : {}),
      });
      return {
        ...base,
        state: "stream_id_issued",
        streamId,
        streamIdExposed: true,
        shortLivedCapability: true,
        guidance: "Legacy escape hatch: stream id issued for immediate same-origin consumption. Do not persist it. Prefer action=start so WebBridge consumes it internally and does not expose the id.",
      };
    }

    if (action !== "start") {
      throw new Error("tab_audio_capture: action must be preflight, get_stream_id, start, stop, status, or drain");
    }

    if (!offscreenAvailable) {
      return { ...base, ok: false, state: "offscreen_unavailable" };
    }

    try {
      await ensureOffscreenDocument();
      const streamId = await getMediaStreamId({ targetTabId: tabId });
      const { timesliceMs, mimeType, maxChunks, audioEndpoint, eventEndpoint, pcmSampleRate, pcmChunkSamples } = args as unknown as TabAudioCaptureArgs;
      const started = await sendOffscreenMessage({
        action: "start" satisfies TabAudioAction,
        streamId,
        tabId,
        tabTitle: tab.title,
        tabUrl: tab.url,
        timesliceMs,
        mimeType,
        maxChunks,
        audioEndpoint,
        eventEndpoint,
        pcmSampleRate,
        pcmChunkSamples,
      });

      return {
        ...base,
        ...started,
        state: "recording_started",
        streamIdIssued: true,
        streamIdExposed: false,
        noStreamIdPersisted: true,
        outputFormat: audioEndpoint
          ? "Forwarded PCM chunks to the provided audioEndpoint plus optional MediaRecorder drain chunks."
          : "MediaRecorder chunks, usually audio/webm;codecs=opus, drainable as base64 for STT handoff",
      };
    } catch (error) {
      await closeOffscreenDocumentIfIdle();
      return { ...base, ...toSafeError(error) };
    }
  }
}
