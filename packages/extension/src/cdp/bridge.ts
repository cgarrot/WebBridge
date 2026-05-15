import { CDP_PROTOCOL_VERSION } from "@webbridge/shared";

interface CDPTarget {
  tabId: number;
  attached: boolean;
}

export class CDPBridge {
  private targets = new Map<number, CDPTarget>();

  async attach(tabId: number): Promise<void> {
    if (this.targets.get(tabId)?.attached) return;

    await chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION);
    this.targets.set(tabId, { tabId, attached: true });
  }

  async detach(tabId: number): Promise<void> {
    const target = this.targets.get(tabId);
    if (!target?.attached) return;

    await chrome.debugger.detach({ tabId });
    target.attached = false;
    this.targets.delete(tabId);
  }

  async send<T = unknown>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    await this.attach(tabId);
    const result = await chrome.debugger.sendCommand({ tabId }, method, params);
    return result as T;
  }

  async detachAll(): Promise<void> {
    const tabIds = [...this.targets.keys()];
    await Promise.allSettled(tabIds.map((id) => this.detach(id)));
  }

  isAttached(tabId: number): boolean {
    return this.targets.get(tabId)?.attached ?? false;
  }
}

export const cdpBridge = new CDPBridge();
