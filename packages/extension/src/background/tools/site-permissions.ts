import type { GrantMediaPermissionsArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";

/**
 * grant_media_permissions — set the Chrome *site* permission for microphone and
 * camera without a native prompt.
 *
 * Why: a meeting bot cannot hear anyone until Chrome is allowed to use the
 * microphone for the meeting origin, and the native permission bubble cannot be
 * clicked by an automation tool. `chrome.contentSettings` is the same store the
 * UI writes to, so the change persists for the profile.
 *
 * Security: this SILENTLY changes a browser permission. It is intentionally
 * narrow — pass the exact origin (e.g. https://meet.google.com) — and every call
 * is echoed back with the effective setting so it is visible in logs.
 */
export class GrantMediaPermissionsTool extends BaseTool {
  readonly name = "grant_media_permissions" as const;
  readonly description =
    "Read or set the Chrome site permission for microphone/camera (e.g. allow microphone for https://meet.google.com)";

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
    const {
      origin: rawOrigin,
      microphone = true,
      camera = false,
      setting = "allow",
    } = args as unknown as GrantMediaPermissionsArgs;

    if (!rawOrigin || typeof rawOrigin !== "string") {
      throw new Error("grant_media_permissions: origin is required (e.g. https://meet.google.com)");
    }
    const normalized = rawOrigin.trim().replace(/\/+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      throw new Error(`grant_media_permissions: origin is not a valid URL (${rawOrigin})`);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`grant_media_permissions: unsupported protocol ${parsed.protocol}`);
    }
    const primaryPattern = `${parsed.origin}/*`;
    if (!["allow", "block", "ask"].includes(setting)) {
      throw new Error(`grant_media_permissions: setting must be allow|block|ask (got ${setting})`);
    }

    const applied: Record<string, unknown> = {};
    if (microphone) {
      await setContentSetting(chrome.contentSettings.microphone, { primaryPattern, setting });
      applied.microphone = await getContentSetting(chrome.contentSettings.microphone, parsed.origin);
    }
    if (camera) {
      await setContentSetting(chrome.contentSettings.camera, { primaryPattern, setting });
      applied.camera = await getContentSetting(chrome.contentSettings.camera, parsed.origin);
    }

    return {
      origin: parsed.origin,
      primaryPattern,
      setting,
      applied,
      persisted: true,
      guidance:
        "Site permission updated (same store as the Chrome UI). A page that is already open keeps its previous grant until it is reloaded.",
    };
  }
}

/** @types/chrome models contentSettings with the callback API. */
function setContentSetting(
  resource: chrome.contentSettings.ContentSetting,
  details: { primaryPattern: string; setting: string }
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    resource.set({ ...details, scope: "regular" } as chrome.contentSettings.SetDetails, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function getContentSetting(
  resource: chrome.contentSettings.ContentSetting,
  primaryUrl: string
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve, reject) => {
    resource.get({ primaryUrl, incognito: false }, (details) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(details?.setting);
    });
  });
}
