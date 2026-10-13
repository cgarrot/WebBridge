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
  "resolve_observed_physical", // J1b (coordinated versioning required)
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
  "network",
  // Phase 6: Token-efficient extraction
  "extract_links",
  "extract_text",
  "extract_table",
  // Extension lifecycle
  "reload_extension",
  // CDP preload support
  "preload_script",
  "preload_navigate",
  // Virtual camera: replace real webcam with animated ASCII persona
  "virtual_camera",
  // Phase 7: Jev goal loop (indexed action space for the daemon-side goal runner)
  "action_space",
  // Google Meet audio + captions
  "meet_caption_extract",
  // Site permissions (microphone/camera) without a native prompt
  "grant_media_permissions",
  "tab_audio_capture",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

// --- Existing tool args ---

export interface NavigateArgs {
  url: string;
  tabId?: number;
  newTab?: boolean;
  /** Force a brand-new tab even if a session tab already exists. Default: reuse. */
  forceNewTab?: boolean;
  group_title?: string;
  groupTitle?: string;
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
  x?: number;
  y?: number;
  selector?: string;
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
  /** Optional response budget. Large string/JSON outputs are returned as compact previews. */
  maxChars?: number;
}

export interface SnapshotArgs {
  tabId?: number;
  type?: "dom" | "accessibility";
  mode?: "full" | "compact";
  maxNodes?: number;
  includeHidden?: boolean;
  roles?: string[];
  textIncludes?: string | string[];
  maxTextLength?: number;
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

export interface ResolveObservedPhysicalArgs { tabId?: number; selector: string } // J1b
export interface GetVisibleDomArgs {
  tabId?: number;
  /** Opt-in coherent page/form facts. Omitted: historical raw node array. */
  includeContext?: boolean;
  /** Explicit editor/semantic-owner extension. Requires includeContext:true. */
  includeSemanticContext?: boolean;
  /** Explicit bounded scroll/media facts in the same native read. */
  includeBehaviorContext?:boolean;
}

/** One native DOM read, plus the explicitly resolved tab identity. */
export interface VisibleDomContext {
  schema: 'visible-dom/2.0';
  tabId: number;
  page: { document_ref: string; url: string; title: string };
  nodes: Array<{ id: string; tag: string; label: string; dom_id: string; name: string;
    enabled: boolean; readonly: boolean; submits: boolean; form_ref?: string | null;
    value?: string; select_ref?: string; href?: string; type?: string; role?: string }>;
  forms: Array<{ id: string; tag: 'form'; label: string; dom_id: string; name: string }>;
}
export interface VisibleDomSemanticContext extends Omit<VisibleDomContext,'schema'|'nodes'> {
  schema: 'visible-dom/3.0';
  page:VisibleDomContext['page'] & {ready_state:'loading'|'interactive'|'complete'};
  nodes: Array<VisibleDomContext['nodes'][number] & { document_ref: string; owner_ref: string | null;
    editor_kind?: 'native_input' | 'native_textarea' | 'contenteditable' | 'opaque';
    read_kind?: 'value' | 'innerText' | 'none'; editor_backend_supported?: boolean;
    /** Optional coherent native facts. Missing means unobserved, never false
     * or an empty selection; consumers requiring them must refuse. */
    checked?: boolean; selected_values?: string[] }>;
  owners: Array<{ id: string; label: string; role: string; dom_id: string; source: string }>;
}

export interface ClickElementArgs {
  nodeId: string;
  tabId?: number;
  /** Explicit guarded commit dispatch. No backend success claim. */
  commitBinding?: import('./native-commit.js').NativeCommitBinding;
  deadlineAtMs?: number;
  operationRef?: string;
}

export interface TypeElementArgs {
  nodeId: string;
  text: string;
  tabId?: number;
  clearFirst?: boolean;
  /** Opt-in native identity guard; text is a complete plain-text replacement. */
  binding?: import('./native-text.js').NativeTextBinding;
  /**
   * `true` (default) focuses the field and inserts real text (keyboard-focus
   * path). `false` writes through the native value setter with NO focus at all —
   * framework-safe (React/Vue see an `input` event) and the only path that has
   * been observed to stay reliable over long multi-field runs (Chrome drops a
   * tab's debugger attachment after ~2 focus-taking operations on it).
   */
  focus?: boolean;
}

export interface HighlightArgs {
  nodeId: string;
  tabId?: number;
  clear?: boolean;
}

// --- Phase 7: Jev goal loop ---

/**
 * `action_space` — one atomic observation for the daemon-side goal loop.
 * Port of browser-use/jev-ultrafast `snapshot.js`: visible interactive controls
 * indexed with an operation-compatible action space, plus a freshness marker.
 */
export interface ActionSpaceArgs {
  tabId?: number;
  /** Cap on returned actions (scroll/wait included). Default 250. */
  maxActions?: number;
  /** Cap on the visible page text sent to the decision model. Default 6000. */
  maxTextChars?: number;
  /** Cap on the scope text kept per element guard. Default 400. */
  maxGuardChars?: number;
}

/** One actionable entry. `kind` drives which browser call executes it. */
export interface ActionSpaceAction {
  /** Stable within one observation: `a1`…, plus `scroll_down`/`scroll_up`/`wait`. */
  id: string;
  /** `data-wb-id` value of the observed node (absent for scroll/wait). */
  node?: string;
  kind: "click" | "fill" | "select" | "scroll" | "wait";
  role?: string;
  label: string;
  value?: string;
  current_value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  /** Operations this element supports: CLICK | TYPE_TEXT | SELECT. */
  operations?: string[];
  /** Native dropdown options, each an individually selectable target. */
  options?: Array<{ index: string; label: string; value: string }>;
  rect?: { x: number; y: number; w: number; h: number };
  /** Signed pixel delta for scroll pseudo-actions. */
  delta?: number;
}

export interface ActionSpaceResult {
  tabId: number;
  url: string;
  title: string;
  w: number;
  h: number;
  scroll: { y: number; height: number };
  /** Visible page text, capped. */
  text: string;
  actions: ActionSpaceAction[];
  /** Freshness key: changes whenever the observed page state changes. */
  marker: string;
  /** Per-node semantics captured with the observation (staleness/occlusion guard). */
  guards: Record<string, unknown[]>;
  omitted_actions: number;
}

// --- Google Meet audio + captions ---

/**
 * Bounded extraction of Google Meet live-caption candidates from the page DOM.
 * Everything is clamped in the page so a bad value can never blow up the result.
 */
export interface MeetCaptionExtractArgs {
  tabId?: number;
  /** Max caption rows returned (1..100, default 20). */
  maxCaptions?: number;
  /** Max candidate nodes inspected (1..200, default 40). */
  maxCandidates?: number;
  /** Max characters per caption text (20..2000, default 300). */
  maxTextLength?: number;
  /** Max characters for the whole serialized result (500..100000, default 8000). */
  maxChars?: number;
  /** Include captions that are currently hidden (default false). */
  includeHidden?: boolean;
  /** Collapse repeated consecutive rows (default true). */
  dedupe?: boolean;
  /** Optional CSS selector overriding the default caption container lookup. */
  selector?: string;
}

/**
 * Chrome *site* permission for microphone/camera. Used by meeting bots: a bot
 * cannot hear anyone until Chrome allows the microphone for the meeting origin,
 * and the native permission bubble cannot be clicked programmatically.
 */
export interface GrantMediaPermissionsArgs {
  /** Exact origin, e.g. `https://meet.google.com`. */
  origin: string;
  /** Set (default true) the microphone permission. */
  microphone?: boolean;
  /** Set the camera permission (default false: bots rarely need it). */
  camera?: boolean;
  /** Permission value to apply. Default `allow`. */
  setting?: "allow" | "block" | "ask";
}

/**
 * Tab audio capture through a `chrome.tabCapture` stream owned by the offscreen
 * document. `start` never exposes the stream id; chunks are drained by `drain`
 * or forwarded to `audioEndpoint` / `eventEndpoint`.
 */
export interface TabAudioCaptureArgs {
  /** Default `preflight`. */
  action?: "preflight" | "get_stream_id" | "start" | "status" | "drain" | "stop";
  tabId?: number;
  /** Tab the capture belongs to (used for `chrome.tabCapture.getMediaStreamId`). */
  consumerTabId?: number;
  /** MediaRecorder chunk interval in ms. */
  timesliceMs?: number;
  /** Recorder mime type (e.g. `audio/webm;codecs=opus`). */
  mimeType?: string;
  /** Stop buffering after this many chunks. */
  maxChunks?: number;
  /** Cap applied when draining buffered chunks. */
  maxBytes?: number;
  /** Include base64 chunk payloads when draining (default true). */
  includeBase64?: boolean;
  /** Clear the buffer after draining (default true). */
  clear?: boolean;
  /** Forward raw PCM to this endpoint instead of relying on the drain loop. */
  audioEndpoint?: string;
  /** Forward capture lifecycle events to this endpoint. */
  eventEndpoint?: string;
  /** PCM sample rate used when forwarding to `audioEndpoint`. */
  pcmSampleRate?: number;
  /** PCM samples per forwarded chunk. */
  pcmChunkSamples?: number;
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
  /** Defaults to "load" for ergonomic waits after navigation. */
  type?: "selector" | "navigation" | "load" | "network_idle";
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

export interface NetworkArgs {
  tabId?: number;
  cmd?: "start" | "stop" | "list" | "get" | "detail" | "clear";
  action?: "start" | "stop" | "list" | "get" | "detail" | "clear";
  filter?: string;
  requestId?: string;
  limit?: number;
}

export interface ExtractLinksArgs {
  tabId?: number;
  selector?: string;
  hrefIncludes?: string | string[];
  hrefExcludes?: string | string[];
  textIncludes?: string | string[];
  textExcludes?: string | string[];
  limit?: number;
  maxTextLength?: number;
  includeHidden?: boolean;
  includeHashLinks?: boolean;
}

export interface ExtractTextArgs {
  tabId?: number;
  selector?: string;
  selectors?: string[];
  includes?: string | string[];
  excludes?: string | string[];
  around?: number;
  maxChars?: number;
  maxMatches?: number;
  mode?: "text" | "snippets";
  separator?: string;
}

export interface ExtractTableArgs {
  tabId?: number;
  selector?: string;
  index?: number;
  maxTables?: number;
  maxRows?: number;
  maxCols?: number;
  maxCellLength?: number;
  maxChars?: number;
  includeLinks?: boolean;
}

export interface ReloadExtensionArgs {
  /** Delay before reloading, allowing the tool response to be sent first. */
  delayMs?: number;
}

export interface PreloadScriptArgs {
  tabId?: number;
  source: string;
  /** Run in an isolated world instead of the main world. Defaults false for page instrumentation compatibility. */
  isolated?: boolean;
  /** Register for future navigations. Defaults true; set false for runNow-only CDP snippets. */
  register?: boolean;
  /** Also execute the script immediately in the current document via CDP Runtime.evaluate. */
  runNow?: boolean;
  /** Optional response budget for runNow result previews. */
  maxChars?: number;
}

export interface PreloadNavigateArgs {
  url: string;
  source: string;
  tabId?: number;
  newTab?: boolean;
  /** Force a brand-new tab even if a session tab already exists. Default: reuse. */
  forceNewTab?: boolean;
  initialUrl?: string;
  active?: boolean;
  group_title?: string;
  groupTitle?: string;
  initialWaitMs?: number;
  urlWaitMs?: number;
}


export type VirtualCameraState = "idle" | "thinking" | "speaking" | "muted";

export interface VirtualCameraArgs {
  /** Target Meet tab. If omitted, WebBridge looks for a meet.google.com tab. */
  tabId?: number;
  /** Animation state of the ASCII persona. */
  state: VirtualCameraState;
  /** ASCII persona key. Defaults to "zob". */
  persona?: string;
  /** Display name shown in the persona label (e.g. the bot alias "Sam"). Falls back to persona. */
  name?: string;
  /** Mirror the camera horizontally (default true). Set false to disable the flip. */
  mirror?: boolean;
  /** Desired frame rate. Defaults to 15. */
  fps?: number;
  /** Arm the virtual camera (inject/getUserMedia patch) if not already installed. */
  arm?: boolean;
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
  resolve_observed_physical: ResolveObservedPhysicalArgs; // J1b
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
  network: NetworkArgs;
  extract_links: ExtractLinksArgs;
  extract_text: ExtractTextArgs;
  extract_table: ExtractTableArgs;
  reload_extension: ReloadExtensionArgs;
  preload_script: PreloadScriptArgs;
  preload_navigate: PreloadNavigateArgs;
  virtual_camera: VirtualCameraArgs;
  action_space: ActionSpaceArgs;
  meet_caption_extract: MeetCaptionExtractArgs;
  grant_media_permissions: GrantMediaPermissionsArgs;
  tab_audio_capture: TabAudioCaptureArgs;
};

export type VisibleDomBehaviorContext = Omit<VisibleDomSemanticContext,'schema'> & {schema:'visible-dom/4.0';scroll_scopes:import('./native-behavior.js').NativeScrollScopesResult;media:import('./native-behavior.js').NativeMediaObserveResult};
