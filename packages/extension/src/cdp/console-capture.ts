import { cdpBridge } from "./bridge.js";

interface ConsoleEntry {
  level: string;
  message: string;
  timestamp: string;
  url?: string;
}

const MAX_ENTRIES = 200;

class ConsoleCapture {
  private buffers = new Map<number, ConsoleEntry[]>();
  private enabled = new Set<number>();

  constructor() {
    chrome.debugger.onEvent.addListener((source, method, params: any) => {
      if (method !== "Runtime.consoleAPICalled") return;
      const tabId = source.tabId;
      if (tabId === undefined) return;

      const buffer = this.buffers.get(tabId);
      if (!buffer) return;

      const level = params.type === "warning" ? "warn" : params.type;
      const message = (params.args || [])
        .map((a: any) => a.value ?? a.description ?? a.type)
        .join(" ");

      buffer.push({
        level,
        message,
        timestamp: new Date().toISOString(),
        url: params.stackTrace?.callFrames?.[0]?.url,
      });

      if (buffer.length > MAX_ENTRIES) {
        buffer.splice(0, buffer.length - MAX_ENTRIES);
      }
    });

    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId !== undefined) {
        this.enabled.delete(source.tabId);
      }
    });
  }

  async enable(tabId: number): Promise<void> {
    if (this.enabled.has(tabId)) return;
    if (!this.buffers.has(tabId)) {
      this.buffers.set(tabId, []);
    }
    await cdpBridge.send(tabId, "Runtime.enable");
    this.enabled.add(tabId);
  }

  getEntries(
    tabId: number,
    options?: { levels?: string[]; filter?: string; limit?: number }
  ): ConsoleEntry[] {
    let entries = this.buffers.get(tabId) || [];

    if (options?.levels?.length) {
      entries = entries.filter((e) => options.levels!.includes(e.level));
    }
    if (options?.filter) {
      const f = options.filter.toLowerCase();
      entries = entries.filter((e) => e.message.toLowerCase().includes(f));
    }
    if (options?.limit) {
      entries = entries.slice(-options.limit);
    }
    return entries;
  }

  clear(tabId: number): void {
    this.buffers.set(tabId, []);
  }
}

export const consoleCapture = new ConsoleCapture();
