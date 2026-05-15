export const TOOL_NAMES = [
  // Existing
  "navigate",
  "screenshot",
  "click",
  "fill",
  "evaluate",
  "snapshot",
  "list_tabs",
  "close_tab",
  "find_tab",
  "send_keys",
  "save_as_pdf",
  "upload",
  // Phase 1: CUA
  "move",
  "double_click",
  "hover",
  "scroll",
  "drag",
  // Phase 2: Tab management
  "new_tab",
  "switch_tab",
  "get_tab_info",
  "back",
  "forward",
  "reload",
  // Phase 3: DOM CUA
  "get_visible_dom",
  "click_element",
  "type_element",
  "highlight",
  // Phase 4: Advanced
  "clipboard",
  "console_logs",
  "wait_for",
  "element_info",
  // Phase 5: Session & Tab Group UX
  "name_session",
  "finalize_tabs",
  "claim_tab",
  "browser_history",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

// --- Existing tool args ---

export interface NavigateArgs {
  url: string;
  tabId?: number;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
}

export interface ScreenshotArgs {
  tabId?: number;
  fullPage?: boolean;
  format?: "png" | "jpeg" | "webp";
  quality?: number;
  clip?: { x: number; y: number; width: number; height: number };
}

export interface ClickArgs {
  tabId?: number;
  x: number;
  y: number;
  button?: "left" | "right" | "middle";
  clickCount?: number;
}

export interface FillArgs {
  tabId?: number;
  selector: string;
  value: string;
}

export interface EvaluateArgs {
  tabId?: number;
  expression: string;
  returnByValue?: boolean;
}

export interface SnapshotArgs {
  tabId?: number;
  type?: "dom" | "accessibility";
}

export interface ListTabsArgs {}

export interface CloseTabArgs {
  tabId: number;
}

export interface FindTabArgs {
  query?: string;
  url?: string;
}

export interface SendKeysArgs {
  tabId?: number;
  keys: string[];
  modifiers?: Array<"ctrl" | "alt" | "shift" | "meta">;
}

export interface SaveAsPdfArgs {
  tabId?: number;
  landscape?: boolean;
  printBackground?: boolean;
}

export interface UploadArgs {
  tabId?: number;
  selector: string;
  filePaths: string[];
}

// --- Phase 1: CUA tool args ---

export interface MoveArgs {
  x: number;
  y: number;
  tabId?: number;
}

export interface DoubleClickArgs {
  x: number;
  y: number;
  button?: "left" | "right" | "middle";
  tabId?: number;
}

export interface HoverArgs {
  x: number;
  y: number;
  duration?: number;
  tabId?: number;
}

export interface ScrollArgs {
  x: number;
  y: number;
  deltaX?: number;
  deltaY?: number;
  tabId?: number;
}

export interface DragArgs {
  path: Array<{ x: number; y: number }>;
  tabId?: number;
}

// --- Phase 2: Tab management args ---

export interface NewTabArgs {
  url?: string;
  active?: boolean;
}

export interface SwitchTabArgs {
  tabId: number;
}

export interface GetTabInfoArgs {
  tabId?: number;
}

export interface BackArgs {
  tabId?: number;
}

export interface ForwardArgs {
  tabId?: number;
}

export interface ReloadArgs {
  tabId?: number;
  ignoreCache?: boolean;
}

// --- Phase 3: DOM CUA args ---

export interface GetVisibleDomArgs {
  tabId?: number;
}

export interface ClickElementArgs {
  nodeId: string;
  tabId?: number;
}

export interface TypeElementArgs {
  nodeId: string;
  text: string;
  tabId?: number;
  clearFirst?: boolean;
}

export interface HighlightArgs {
  nodeId: string;
  tabId?: number;
  clear?: boolean;
}

// --- Phase 4: Advanced args ---

export interface ClipboardArgs {
  action: "read" | "write";
  text?: string;
  tabId?: number;
}

export interface ConsoleLogsArgs {
  tabId?: number;
  levels?: Array<"debug" | "info" | "log" | "warn" | "error">;
  filter?: string;
  limit?: number;
}

export interface WaitForArgs {
  tabId?: number;
  type: "selector" | "navigation" | "load" | "network_idle";
  value?: string;
  timeoutMs?: number;
}

export interface ElementInfoArgs {
  x: number;
  y: number;
  tabId?: number;
}

// --- Phase 5: Session & Tab Group UX ---

export interface NameSessionArgs {
  name: string;
}

export interface FinalizeTabsArgs {
  keep?: Array<{
    tabId: number;
    status: "deliverable" | "handoff";
  }>;
}

export interface ClaimTabArgs {
  tabId: number;
}

export interface BrowserHistoryArgs {
  query?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export type ToolArgs = {
  navigate: NavigateArgs;
  screenshot: ScreenshotArgs;
  click: ClickArgs;
  fill: FillArgs;
  evaluate: EvaluateArgs;
  snapshot: SnapshotArgs;
  list_tabs: ListTabsArgs;
  close_tab: CloseTabArgs;
  find_tab: FindTabArgs;
  send_keys: SendKeysArgs;
  save_as_pdf: SaveAsPdfArgs;
  upload: UploadArgs;
  move: MoveArgs;
  double_click: DoubleClickArgs;
  hover: HoverArgs;
  scroll: ScrollArgs;
  drag: DragArgs;
  new_tab: NewTabArgs;
  switch_tab: SwitchTabArgs;
  get_tab_info: GetTabInfoArgs;
  back: BackArgs;
  forward: ForwardArgs;
  reload: ReloadArgs;
  get_visible_dom: GetVisibleDomArgs;
  click_element: ClickElementArgs;
  type_element: TypeElementArgs;
  highlight: HighlightArgs;
  clipboard: ClipboardArgs;
  console_logs: ConsoleLogsArgs;
  wait_for: WaitForArgs;
  element_info: ElementInfoArgs;
  name_session: NameSessionArgs;
  finalize_tabs: FinalizeTabsArgs;
  claim_tab: ClaimTabArgs;
  browser_history: BrowserHistoryArgs;
};
