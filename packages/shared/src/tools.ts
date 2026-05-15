export const TOOL_NAMES = [
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
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

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

export interface ListTabsArgs {
  // no required params
}

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
};
