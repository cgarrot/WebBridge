export interface HelloMessage {
  type: "hello";
  payload: {
    extensionVersion: string;
    capabilities?: string[];
  };
}

export interface HelloAckMessage {
  type: "hello_ack";
  payload: {
    daemonVersion: string;
  };
}

export interface PingMessage {
  type: "ping";
  timestamp: number;
}

export interface PongMessage {
  type: "pong";
  timestamp: number;
}

export interface ToolCallMessage {
  type: "tool_call";
  requestId: string;
  payload: {
    name: string;
    args: Record<string, unknown>;
  };
}

export interface ToolResultMessage {
  type: "tool_result";
  responseToRequestId: string;
  payload: {
    data?: unknown;
    error?: string;
  };
}

export type BridgeMessage =
  | HelloMessage
  | HelloAckMessage
  | PingMessage
  | PongMessage
  | ToolCallMessage
  | ToolResultMessage;

export type BridgeMessageType = BridgeMessage["type"];

export function createToolCall(
  requestId: string,
  name: string,
  args: Record<string, unknown>
): ToolCallMessage {
  return { type: "tool_call", requestId, payload: { name, args } };
}

export function createToolResult(
  responseToRequestId: string,
  data?: unknown,
  error?: string
): ToolResultMessage {
  return { type: "tool_result", responseToRequestId, payload: { data, error } };
}
