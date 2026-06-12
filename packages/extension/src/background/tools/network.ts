import type { NetworkArgs } from "@webbridge/shared";
import { BaseTool, type ToolContext } from "./base.js";
import { resolveTabId } from "../../cdp/session.js";

interface NetworkRecord {
  requestId: string;
  url?: string;
  method?: string;
  type?: string;
  status?: number;
  mimeType?: string;
  startTime: number;
  endTime?: number;
  errorText?: string;
  requestHeaders?: Record<string, unknown>;
  responseHeaders?: Record<string, unknown>;
}

const MAX_RECORDS = 500;
const buffers = new Map<number, Map<string, NetworkRecord>>();
const listeners = new Map<number, (source: chrome.debugger.Debuggee, method: string, params?: any) => void>();

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
]);

export class NetworkTool extends BaseTool {
  readonly name = "network" as const;
  readonly description = "Capture and inspect network requests for the active tab";

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const { tabId: rawTabId, filter, requestId, limit = 100 } = args as unknown as NetworkArgs;
    const cmd = ((args as unknown as NetworkArgs).cmd ?? (args as unknown as NetworkArgs).action ?? "list");
    const tabId = await resolveTabId(rawTabId);

    if (cmd === "start") {
      return this.start(tabId, ctx);
    }
    if (cmd === "stop") {
      return this.stop(tabId, ctx);
    }
    if (cmd === "clear") {
      buffers.set(tabId, new Map());
      return { tabId, status: "cleared" };
    }
    if (cmd === "detail") {
      if (!requestId) throw new Error("network: requestId is required for detail");
      return this.detail(tabId, requestId, ctx);
    }
    if (cmd === "list" || cmd === "get") {
      return this.list(tabId, filter, limit);
    }

    throw new Error(`network: unknown command ${cmd}`);
  }

  private async start(tabId: number, ctx: ToolContext): Promise<unknown> {
    if (listeners.has(tabId)) {
      return { tabId, status: "already_started" };
    }

    await ctx.cdp.send(tabId, "Network.enable");
    ensureBuffer(tabId);

    const listener = (source: chrome.debugger.Debuggee, method: string, params?: any) => {
      if (source.tabId !== tabId || !params) return;
      const records = ensureBuffer(tabId);

      if (method === "Network.requestWillBeSent") {
        const id = String(params.requestId);
        records.set(id, {
          requestId: id,
          url: params.request?.url,
          method: params.request?.method,
          type: params.type,
          startTime: Date.now(),
          requestHeaders: redactHeaders(params.request?.headers),
        });
        trimRecords(records);
      } else if (method === "Network.responseReceived") {
        const id = String(params.requestId);
        const existing = records.get(id) ?? { requestId: id, startTime: Date.now() };
        records.set(id, {
          ...existing,
          url: params.response?.url ?? existing.url,
          status: params.response?.status,
          mimeType: params.response?.mimeType,
          type: params.type ?? existing.type,
          responseHeaders: redactHeaders(params.response?.headers),
        });
        trimRecords(records);
      } else if (method === "Network.loadingFinished") {
        const id = String(params.requestId);
        const existing = records.get(id);
        if (existing) records.set(id, { ...existing, endTime: Date.now() });
      } else if (method === "Network.loadingFailed") {
        const id = String(params.requestId);
        const existing = records.get(id) ?? { requestId: id, startTime: Date.now() };
        records.set(id, { ...existing, errorText: params.errorText, endTime: Date.now() });
        trimRecords(records);
      }
    };

    chrome.debugger.onEvent.addListener(listener);
    listeners.set(tabId, listener);
    return { tabId, status: "started" };
  }

  private async stop(tabId: number, ctx: ToolContext): Promise<unknown> {
    const listener = listeners.get(tabId);
    if (listener) {
      chrome.debugger.onEvent.removeListener(listener);
      listeners.delete(tabId);
    }
    try {
      await ctx.cdp.send(tabId, "Network.disable");
    } catch {
      // Non-fatal: debugger may already be detached.
    }
    return { tabId, status: "stopped" };
  }

  private list(tabId: number, filter: string | undefined, limit: number): unknown {
    const records = [...(buffers.get(tabId)?.values() ?? [])]
      .filter((record) => !filter || record.url?.toLowerCase().includes(filter.toLowerCase()))
      .slice(-Math.min(Math.max(limit, 1), MAX_RECORDS))
      .map((record) => ({
        requestId: record.requestId,
        method: record.method,
        url: record.url,
        status: record.status,
        type: record.type,
        mimeType: record.mimeType,
        durationMs: record.endTime ? record.endTime - record.startTime : undefined,
        errorText: record.errorText,
      }));

    return { tabId, requests: records, count: records.length };
  }

  private async detail(tabId: number, requestId: string, ctx: ToolContext): Promise<unknown> {
    const record = buffers.get(tabId)?.get(requestId);
    if (!record) throw new Error(`network: request not found: ${requestId}`);

    let bodyPreview: string | undefined;
    let bodyTruncated = false;
    try {
      const body = await ctx.cdp.send<{ body: string; base64Encoded: boolean }>(
        tabId,
        "Network.getResponseBody",
        { requestId },
      );
      const decoded = body.base64Encoded ? atob(body.body) : body.body;
      bodyPreview = decoded.slice(0, 8_000);
      bodyTruncated = decoded.length > bodyPreview.length;
    } catch {
      // Body is not always available (cached, preflight, opaque, or still loading).
    }

    return {
      tabId,
      request: {
        requestId: record.requestId,
        method: record.method,
        url: record.url,
        headers: record.requestHeaders,
      },
      response: {
        status: record.status,
        mimeType: record.mimeType,
        headers: record.responseHeaders,
      },
      durationMs: record.endTime ? record.endTime - record.startTime : undefined,
      errorText: record.errorText,
      bodyPreview,
      bodyTruncated,
    };
  }
}

function ensureBuffer(tabId: number): Map<string, NetworkRecord> {
  let records = buffers.get(tabId);
  if (!records) {
    records = new Map();
    buffers.set(tabId, records);
  }
  return records;
}

function trimRecords(records: Map<string, NetworkRecord>): void {
  while (records.size > MAX_RECORDS) {
    const first = records.keys().next().value;
    if (!first) return;
    records.delete(first);
  }
}

function redactHeaders(headers: unknown): Record<string, unknown> | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    output[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? "[REDACTED]" : value;
  }
  return output;
}

chrome.debugger.onDetach.addListener((source) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  const listener = listeners.get(tabId);
  if (listener) chrome.debugger.onEvent.removeListener(listener);
  listeners.delete(tabId);
});
