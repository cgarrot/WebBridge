type TabGroupColor = chrome.tabGroups.ColorEnum;

const DELIVERABLE_GROUP_TITLE = "✅ WebBridge";
const DELIVERABLE_GROUP_COLOR: TabGroupColor = "green";
const DEFAULT_SESSION_COLOR: TabGroupColor = "blue";

interface TrackedTab {
  tabId: number;
  origin: "agent" | "claimed";
  /** Original group before claiming (undefined if none) */
  originalGroupId?: number;
}

class SessionManager {
  private sessionName = "";
  private sessionGroupId: number | null = null;
  private trackedTabs: TrackedTab[] = [];

  async nameSession(name: string): Promise<string> {
    this.sessionName = name;

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

    const existingIdx = this.trackedTabs.findIndex((t) => t.tabId === tabId);
    if (existingIdx >= 0) {
      this.trackedTabs[existingIdx] = { tabId, origin, originalGroupId };
    } else {
      this.trackedTabs.push({ tabId, origin, originalGroupId });
    }
  }

  /**
   * Claim a user-owned tab: move it into the agent's session group.
   */
  async claimTab(tabId: number): Promise<chrome.tabs.Tab> {
    const tab = await chrome.tabs.get(tabId);
    await this.addTabToSession(tabId, "claimed");
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
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
