# WebBridge 通信协议

## 概述

WebBridge 使用 JSON 消息协议在 Chrome 扩展和 Daemon 之间通信。协议支持两种传输通道，消息格式完全一致。

## 传输通道

### Native Messaging

- Chrome 通过 `chrome.runtime.connectNative("com.webbridge.host")` 启动 Daemon
- 使用 stdin/stdout 双向通信
- 消息格式：4 字节 uint32 LE 长度前缀 + UTF-8 JSON 正文
- 仅支持本机，安全性最高

### WebSocket

- 扩展主动连接 `ws://{host}:{port}/ws`
- 使用标准 WebSocket 文本帧传 JSON
- 支持远程连接

## 消息类型

### hello（扩展 → Daemon）

扩展连接后发送，报告版本和能力：

```json
{
  "type": "hello",
  "payload": {
    "extensionVersion": "0.1.0",
    "capabilities": ["navigate", "screenshot", "click", ...]
  }
}
```

### hello_ack（Daemon → 扩展）

```json
{
  "type": "hello_ack",
  "payload": {
    "daemonVersion": "0.1.0"
  }
}
```

### ping / pong（心跳）

Daemon 定期发 ping，扩展回 pong：

```json
{ "type": "ping", "timestamp": 1715738400000 }
{ "type": "pong", "timestamp": 1715738400000 }
```

### tool_call（Daemon → 扩展）

```json
{
  "type": "tool_call",
  "requestId": "uuid-v4",
  "payload": {
    "name": "navigate",
    "args": { "url": "https://example.com" }
  }
}
```

### tool_result（扩展 → Daemon）

成功：

```json
{
  "type": "tool_result",
  "responseToRequestId": "uuid-v4",
  "payload": {
    "data": { "tabId": 1, "url": "https://example.com" }
  }
}
```

失败：

```json
{
  "type": "tool_result",
  "responseToRequestId": "uuid-v4",
  "payload": {
    "error": "Element not found: #missing"
  }
}
```

## HTTP API

Daemon 同时暴露 HTTP 接口供 AI 工具调用：

### GET /api/status

```json
{ "status": "ok", "connections": 1, "version": "0.1.0" }
```

### POST /api/tool

请求：

```json
{ "name": "navigate", "args": { "url": "https://example.com" } }
```

响应（成功）：

```json
{ "data": { "tabId": 1, "url": "https://example.com" } }
```

响应（失败）：

```json
{ "error": "No extension connected" }
```

## 连接生命周期

1. 扩展启动 → 尝试 Native Messaging → 不可用则降级 WebSocket
2. 连接建立 → 扩展发 hello → Daemon 回 hello_ack
3. 定期心跳 → Daemon 发 ping → 扩展回 pong
4. 断线 → 扩展自动重连（指数退避，最多 10 次）

## 超时

- 心跳间隔：30 秒
- 心跳超时：10 秒
- 工具调用超时：60 秒
- 重连延迟：3 秒 × 重试次数（最大 15 秒）
