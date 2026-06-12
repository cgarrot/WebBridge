export interface NormalizedCommand {
  name: string;
  args: Record<string, unknown>;
  sessionName?: string;
}

interface CommandBody {
  name?: unknown;
  action?: unknown;
  toolName?: unknown;
  args?: unknown;
  session?: unknown;
  sessionId?: unknown;
}

const BROWSER_TOOL_ALIASES: Record<string, string> = {
  browser_list_tabs: "list_tabs",
  browser_new_tab: "new_tab",
  browser_select_tab: "switch_tab",
  browser_navigate: "navigate",
  browser_snapshot: "snapshot",
  browser_click: "click",
  browser_mouse_click: "click",
  browser_fill: "fill",
  browser_type: "send_keys",
  browser_key_type: "send_keys",
  browser_send_keys: "send_keys",
  browser_screenshot: "screenshot",
  browser_evaluate: "evaluate",
  browser_close_tab: "close_tab",
  browser_close_session: "finalize_tabs",
  browser_find_tab: "find_tab",
  browser_upload: "upload",
  browser_save_as_pdf: "save_as_pdf",
  browser_get_tab_info: "get_tab_info",
  browser_console_logs: "console_logs",
  browser_wait_for: "wait_for",
  browser_history: "browser_history",
  browser_network: "network",
  browser_extract_links: "extract_links",
  browser_extract_text: "extract_text",
  browser_extract_table: "extract_table",
  browser_reload_extension: "reload_extension",
};

const TOOL_ALIASES: Record<string, string> = {
  close_session: "finalize_tabs",
  mouse_click: "click",
  key_type: "send_keys",
  type: "send_keys",
  select_tab: "switch_tab",
  get_tab: "get_tab_info",
  pdf: "save_as_pdf",
  links: "extract_links",
  extract: "extract_text",
  table: "extract_table",
  extension_reload: "reload_extension",
};

export function normalizeCommandBody(body: unknown): NormalizedCommand {
  const input = isRecord(body) ? (body as CommandBody) : {};
  const rawName = firstString(input.name, input.action, input.toolName);

  if (!rawName) {
    throw new Error("Missing command name: expected name, action, or toolName");
  }

  const name = normalizeToolName(rawName);
  const args = isRecord(input.args) ? { ...(input.args as Record<string, unknown>) } : {};
  normalizeArgs(name, args);

  const sessionName = firstString(
    input.session,
    input.sessionId,
    args.session,
    args.sessionId,
    args.group_title,
    args.groupTitle,
  );

  delete args.session;

  return { name, args, sessionName };
}

export function normalizeToolName(rawName: string): string {
  const name = rawName.trim();
  return BROWSER_TOOL_ALIASES[name] ?? TOOL_ALIASES[name] ?? name;
}

function normalizeArgs(name: string, args: Record<string, unknown>): void {
  if (name === "evaluate" && typeof args.code === "string" && typeof args.expression !== "string") {
    args.expression = args.code;
  }
  delete args.code;

  if (name === "upload") {
    if (Array.isArray(args.files) && !Array.isArray(args.filePaths)) {
      args.filePaths = args.files;
    }
    if (Array.isArray(args.paths) && !Array.isArray(args.filePaths)) {
      args.filePaths = args.paths;
    }
    delete args.files;
    delete args.paths;
  }

  if (name === "send_keys") {
    const text = typeof args.text === "string" ? args.text : undefined;
    if (!Array.isArray(args.keys) && text !== undefined) {
      args.keys = [...text];
    } else if (typeof args.keys === "string") {
      args.keys = [args.keys];
    }
    delete args.text;
  }

  if (name === "find_tab") {
    if (typeof args.urlContains === "string" && typeof args.query !== "string") {
      args.query = args.urlContains;
    }
    if (typeof args.titleContains === "string" && typeof args.query !== "string") {
      args.query = args.titleContains;
    }
  }

  if (name === "network" && typeof args.cmd === "string" && typeof args.action !== "string") {
    args.action = args.cmd;
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
