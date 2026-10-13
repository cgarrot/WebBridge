import { MAX_AGENT_TABS, SESSION_IDLE_TTL_MS } from "@webbridge/shared";

type TabGroupColor = chrome.tabGroups.ColorEnum;

const DELIVERABLE_GROUP_TITLE = "✅ WebBridge";
const DELIVERABLE_GROUP_COLOR: TabGroupColor = "green";
const DEFAULT_SESSION_COLOR: TabGroupColor = "blue";
const SESSION_TTL_ALARM = "webbridge-session-ttl";

interface TrackedTab {
  tabId: number;
  origin: "agent" | "claimed";
  /** Original group before claiming (undefined if none) */
  originalGroupId?: number;
  /** When the tab was first tracked (oldest = first candidate for cap eviction). */
  trackedAt: number;
}

export interface AcquireTabOptions {
  /** URL to open when creating a new tab (ignored on reuse). */
  url?: string;
  /** Caller intent to use a new tab (navigate/preload with newTab:true). */
  newTab?: boolean;
  /** Force a brand-new tab even if a reusable tracked tab exists. */
  forceNewTab?: boolean;
  /** Prefer reusing a tracked tab whose origin (hostname) matches this. */
  preferOrigin?: string;
  /** Make the tab active. Defaults to true. */
  active?: boolean;
}

export interface AcquireTabResult {
  tabId: number;
  created: boolean;
  reused: boolean;
  /** Agent tab ids closed to stay under MAX_AGENT_TABS. */
  closedDueToCap: number[];
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

class SessionManager {
  private sessionName = "";
  private sessionGroupId: number | null = null;
  private trackedTabs: TrackedTab[] = [];
  private primaryTabId: number | null = null;
  private lastActivityAt = Date.now();

  constructor() {
    // Anti-stale: drop tracked tabs that the user/devtools closed so we never
    // reuse or finalize dead ids, and so the cap count stays accurate.
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.untrack(tabId);
    });

    // Optional idle auto-finalize. Off by default (SESSION_IDLE_TTL_MS = 0) to
    // avoid surprising tab closes; enabled only when explicitly configured.
    if (SESSION_IDLE_TTL_MS > 0) {
      const periodMin = Math.max(0.5, SESSION_IDLE_TTL_MS / 60_000 / 2);
      chrome.alarms.create(SESSION_TTL_ALARM, { periodInMinutes: periodMin });
      chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name !== SESSION_TTL_ALARM) return;
        if (Date.now() - this.lastActivityAt >= SESSION_IDLE_TTL_MS && this.trackedTabs.length > 0) {
          console.log(`[WebBridge][session] idle for ${SESSION_IDLE_TTL_MS}ms, auto-finalizing ${this.trackedTabs.length} tab(s)`);
          this.finalize([]).catch(() => undefined);
        }
      });
    }
  }

  async nameSession(name: string): Promise<string> {
    this.sessionName = name;
    this.markActivity();

    if (this.sessionGroupId !== null) {
      try {
        await chrome.tabGroups.update(this.sessionGroupId, { title: name });
      } catch {
        this.sessionGroupId = null;
      }
    }

    return name;
  }

  getSessionName(): string {
    return this.sessionName;
  }

  getPrimaryTabId(): number | null {
    return this.primaryTabId;
  }

  getTrackedTabIds(): number[] {
    return this.trackedTabs.map((t) => t.tabId);
  }

  /** Mark activity (resets the idle TTL). */
  markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  setPrimary(tabId: number): void {
    this.primaryTabId = tabId;
    this.markActivity();
  }

  /**
   * Remove dead ids from trackedTabs. Called before reuse/cap decisions so the
   * in-memory state never drifts from reality (defense even if onRemoved missed).
   */
  private async pruneStale(): Promise<void> {
    if (this.trackedTabs.length === 0) return;
    const checks = await Promise.all(
      this.trackedTabs.map(async (t) => {
        try {
          await chrome.tabs.get(t.tabId);
          return t.tabId;
        } catch {
          return null;
        }
      })
    );
    const dead = new Set(checks.filter((id): id is number => id === null));
    if (dead.size > 0) {
      this.trackedTabs = this.trackedTabs.filter((t) => !dead.has(t.tabId));
      if (this.primaryTabId !== null && dead.has(this.primaryTabId)) this.primaryTabId = null;
    }
  }

  private untrack(tabId: number): void {
    const before = this.trackedTabs.length;
    this.trackedTabs = this.trackedTabs.filter((t) => t.tabId !== tabId);
    if (before !== this.trackedTabs.length) {
      console.log(`[WebBridge][tab] untracked ${tabId} (tracked=${this.trackedTabs.length})`);
    }
    if (this.primaryTabId === tabId) this.primaryTabId = null;
  }

  private countAgentTabs(): number {
    return this.trackedTabs.filter((t) => t.origin === "agent").length;
  }

  /**
   * Ensure a tab group exists for the current session.
   * Creates one from the first agent tab if needed.
   */
  private async ensureSessionGroup(windowId: number): Promise<number> {
    if (this.sessionGroupId !== null) {
      try {
        await chrome.tabGroups.get(this.sessionGroupId);
        return this.sessionGroupId;
      } catch {
        this.sessionGroupId = null;
      }
    }

    const title = this.sessionName || "WebBridge";
    const existingGroups = await chrome.tabGroups.query({ title, windowId });
    if (existingGroups.length > 0) {
      this.sessionGroupId = existingGroups[0].id;
      return this.sessionGroupId;
    }

    return -1;
  }

  /**
   * Centralized create-or-reuse. The single entry point for opening an agent tab.
   *
   * - forceNewTab, or no live tracked tab  -> create (after cap enforcement)
   * - otherwise                            -> reuse the best live tracked tab
   *
   * This is what stops "infinite windows": retries reuse instead of stacking tabs.
   */
  async acquireTab(opts: AcquireTabOptions): Promise<AcquireTabResult> {
    const active = opts.active ?? true;
    await this.pruneStale();
    this.markActivity();

    const agentTabs = this.trackedTabs.filter((t) => t.origin === "agent");

    // Try reuse unless explicitly forced to create a new tab.
    if (!opts.forceNewTab && agentTabs.length > 0) {
      let candidate: TrackedTab | undefined;

      if (opts.preferOrigin) {
        // Prefer a tracked tab already on the requested hostname.
        for (const t of agentTabs) {
          try {
            const tab = await chrome.tabs.get(t.tabId);
            if (originOf(tab.url) === opts.preferOrigin) {
              candidate = t;
              break;
            }
          } catch {
            continue;
          }
        }
      }

      if (!candidate && this.primaryTabId !== null) {
        candidate = agentTabs.find((t) => t.tabId === this.primaryTabId);
      }
      if (!candidate) candidate = agentTabs[agentTabs.length - 1];

      if (candidate) {
        try {
          if (active) await chrome.tabs.update(candidate.tabId, { active: true });
          this.primaryTabId = candidate.tabId;
          console.log(`[WebBridge][tab] reused ${candidate.tabId} (tracked=${this.trackedTabs.length})`);
          return { tabId: candidate.tabId, created: false, reused: true, closedDueToCap: [] };
        } catch {
          // Tab vanished between prune and update; fall through to create.
          this.untrack(candidate.tabId);
        }
      }
    }

    // Create path: enforce the hard cap first.
    const closedDueToCap = await this.enforceCap();

    const tab = await chrome.tabs.create({ url: opts.url ?? "about:blank", active });
    if (tab.id === undefined) throw new Error("acquireTab: failed to create new tab");

    try {
      await this.addTabToSession(tab.id, "agent");
    } catch {
      // grouping is best-effort
    }
    this.primaryTabId = tab.id;
    console.log(
      `[WebBridge][tab] created ${tab.id}` +
        (closedDueToCap.length ? ` (closedDueToCap=${closedDueToCap.join(",")})` : "") +
        ` (tracked=${this.trackedTabs.length})`
    );
    return { tabId: tab.id, created: true, reused: false, closedDueToCap };
  }

  /**
   * Close oldest non-primary agent tabs until we are below MAX_AGENT_TABS.
   * Hard guardrail: no matter how an agent misbehaves, open tabs stay bounded.
   */
  private async enforceCap(): Promise<number[]> {
    const closed: number[] = [];
    await this.pruneStale();

    while (this.countAgentTabs() >= MAX_AGENT_TABS) {
      const agentTabs = this.trackedTabs
        .filter((t) => t.origin === "agent" && t.tabId !== this.primaryTabId)
        .sort((a, b) => a.trackedAt - b.trackedAt);

      const victim = agentTabs[0];
      if (!victim) break; // only the primary is left; stop.

      try {
        await chrome.tabs.remove(victim.tabId);
      } catch {
        // already closed
      }
      this.untrack(victim.tabId);
      closed.push(victim.tabId);
      console.log(`[WebBridge][tab] cap-evicted ${victim.tabId} (MAX_AGENT_TABS=${MAX_AGENT_TABS})`);
    }
    return closed;
  }

  /**
   * Add a tab to the current session's tab group.
   * If no group exists yet, creates one.
   */
  async addTabToSession(tabId: number, origin: "agent" | "claimed" = "agent"): Promise<void> {
    const tab = await chrome.tabs.get(tabId);
    const windowId = tab.windowId;

    let originalGroupId: number | undefined;
    if (origin === "claimed" && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      originalGroupId = tab.groupId;
    }

    let groupId = await this.ensureSessionGroup(windowId);

    if (groupId === -1) {
      groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, {
        title: this.sessionName || "WebBridge",
        color: DEFAULT_SESSION_COLOR,
      });
      this.sessionGroupId = groupId;
    } else {
      await chrome.tabs.group({ tabIds: [tabId], groupId });
    }

    const trackedAt = Date.now();
    const existingIdx = this.trackedTabs.findIndex((t) => t.tabId === tabId);
    if (existingIdx >= 0) {
      this.trackedTabs[existingIdx] = { tabId, origin, originalGroupId, trackedAt };
    } else {
      this.trackedTabs.push({ tabId, origin, originalGroupId, trackedAt });
    }
    this.markActivity();
  }

  /**
   * Claim a user-owned tab: move it into the agent's session group.
   */
  async claimTab(tabId: number): Promise<chrome.tabs.Tab> {
    const tab = await chrome.tabs.get(tabId);
    await this.addTabToSession(tabId, "claimed");
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    this.primaryTabId = tabId;
    return tab;
  }

  /**
   * Finalize the session: close agent-created tabs not in `keep`,
   * release claimed tabs back to their original state,
   * move deliverable tabs to the shared "✅ WebBridge" group.
   */
  async finalize(
    keep: Array<{ tabId: number; status: "deliverable" | "handoff" }> = []
  ): Promise<{ closed: number[]; kept: number[]; released: number[] }> {
    const keepMap = new Map(keep.map((k) => [k.tabId, k.status]));
    const closed: number[] = [];
    const kept: number[] = [];
    const released: number[] = [];

    for (const tracked of this.trackedTabs) {
      const status = keepMap.get(tracked.tabId);

      if (status === "deliverable") {
        await this.moveToDeliverableGroup(tracked.tabId);
        kept.push(tracked.tabId);
      } else if (status === "handoff") {
        kept.push(tracked.tabId);
      } else if (tracked.origin === "agent") {
        try {
          await chrome.tabs.remove(tracked.tabId);
          closed.push(tracked.tabId);
        } catch {
          // tab already closed
        }
      } else {
        // claimed tab: release from agent group
        try {
          await chrome.tabs.ungroup(tracked.tabId);
          released.push(tracked.tabId);
        } catch {
          // tab closed or ungrouped already
        }
      }
    }

    if (closed.length || kept.length || released.length) {
      console.log(
        `[WebBridge][session] finalized: closed=${closed.length} kept=${kept.length} released=${released.length}`
      );
    }

    // Clean up the session group if empty
    if (this.sessionGroupId !== null) {
      try {
        const remaining = await chrome.tabs.query({ groupId: this.sessionGroupId });
        if (remaining.length === 0) {
          this.sessionGroupId = null;
        }
      } catch {
        this.sessionGroupId = null;
      }
    }

    this.trackedTabs = this.trackedTabs.filter((t) => keepMap.has(t.tabId));
    this.primaryTabId = null;
    return { closed, kept, released };
  }

  /**
   * Move a tab to the shared "✅ WebBridge" deliverable group,
   * creating it if necessary.
   */
  private async moveToDeliverableGroup(tabId: number): Promise<void> {
    const tab = await chrome.tabs.get(tabId);
    const windowId = tab.windowId;

    const existing = await chrome.tabGroups.query({
      title: DELIVERABLE_GROUP_TITLE,
      windowId,
    });

    if (existing.length > 0) {
      await chrome.tabs.group({ tabIds: [tabId], groupId: existing[0].id });
    } else {
      const groupId = await chrome.tabs.group({
        tabIds: [tabId],
        createProperties: { windowId },
      });
      await chrome.tabGroups.update(groupId, {
        title: DELIVERABLE_GROUP_TITLE,
        color: DELIVERABLE_GROUP_COLOR,
        collapsed: false,
      });
    }
  }

  isTracked(tabId: number): boolean {
    return this.trackedTabs.some((t) => t.tabId === tabId);
  }

  getTrackedTabs(): ReadonlyArray<TrackedTab> {
    return this.trackedTabs;
  }
}

export const sessionManager = new SessionManager();
