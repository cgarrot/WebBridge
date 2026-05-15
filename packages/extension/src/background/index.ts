import { registerAllTools } from "./tools/index.js";
import { TransportManager } from "./transport/manager.js";
import { MessageHandler } from "./message-handler.js";

registerAllTools();

const transport = new TransportManager({
  preferNative: true,
  ws: {},
});

const handler = new MessageHandler(transport);

transport.onMessage((msg) => handler.handle(msg));

transport.onStatusChange((status) => {
  console.log("[WebBridge] Transport status:", status);
  if (status === "connected") {
    handler.sendHello();
  }
});

async function init(): Promise<void> {
  try {
    await transport.connect();
    console.log("[WebBridge] Extension initialized");
  } catch (err) {
    console.warn("[WebBridge] Initial connection failed, will retry:", err);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_STATUS") {
    sendResponse({ status: transport.status });
    return false;
  }

  if (message.type === "RECONNECT") {
    transport.disconnect();
    transport.connect().then(
      () => sendResponse({ success: true }),
      (err) => sendResponse({ success: false, error: String(err) })
    );
    return true;
  }

  return false;
});

init();
