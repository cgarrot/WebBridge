interface StatusResponse {
  status: string;
}

interface ReconnectResponse {
  success: boolean;
  error?: string;
}

const COLORS: Record<string, string> = {
  connected: "#22c55e",
  connecting: "#f59e0b",
  disconnected: "#ef4444",
  unknown: "#6b7280",
};

async function getStatus(): Promise<string> {
  try {
    const response: StatusResponse = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    return response?.status ?? "unknown";
  } catch {
    return "unknown";
  }
}

function renderStatusDot(status: string): string {
  const color = COLORS[status] ?? COLORS.unknown;
  return `<span style="
    display:inline-block; width:10px; height:10px; border-radius:50%;
    background:${color}; margin-right:8px; vertical-align:middle;
  "></span>`;
}

async function render(): Promise<void> {
  const root = document.getElementById("root")!;
  const status = await getStatus();

  root.innerHTML = `
    <div style="padding:16px; font-family:system-ui,sans-serif; min-width:280px;">
      <div style="display:flex; align-items:center; margin-bottom:16px;">
        <h2 style="margin:0; font-size:18px; font-weight:600;">WebBridge</h2>
        <span style="margin-left:auto; font-size:12px; color:#6b7280;">v0.1.0</span>
      </div>

      <div style="background:#f9fafb; border-radius:8px; padding:12px; margin-bottom:12px;">
        <div style="display:flex; align-items:center;">
          ${renderStatusDot(status)}
          <span style="font-size:14px; font-weight:500;" id="status-text">${status}</span>
        </div>
      </div>

      <div style="display:flex; gap:8px;">
        <button id="btn-reconnect" style="
          flex:1; padding:8px 0; border:none; border-radius:6px;
          background:#3b82f6; color:white; font-size:13px;
          cursor:pointer; font-weight:500;
        ">Reconnect</button>
        <button id="btn-disconnect" style="
          flex:1; padding:8px 0; border:1px solid #d1d5db; border-radius:6px;
          background:white; color:#374151; font-size:13px;
          cursor:pointer; font-weight:500;
        ">Disconnect</button>
      </div>

      <div style="margin-top:12px; font-size:11px; color:#9ca3af; text-align:center;">
        Native Messaging + WebSocket dual transport
      </div>
    </div>
  `;

  document.getElementById("btn-reconnect")!.addEventListener("click", async () => {
    const statusText = document.getElementById("status-text")!;
    statusText.textContent = "connecting...";
    try {
      const result: ReconnectResponse = await chrome.runtime.sendMessage({ type: "RECONNECT" });
      statusText.textContent = result?.success ? "connected" : "disconnected";
    } catch {
      statusText.textContent = "error";
    }
    setTimeout(render, 1000);
  });

  document.getElementById("btn-disconnect")!.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "DISCONNECT" });
    setTimeout(render, 500);
  });
}

render();
