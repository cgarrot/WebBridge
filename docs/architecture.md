# WebBridge 架构说明

## 设计目标

1. **多 AI 工具兼容**：统一 HTTP API，Claude Code / Codex / OpenClaw 通过各自 Skill 调用
2. **双通道传输**：Native Messaging（安全、本机）+ WebSocket（灵活、远程）
3. **可扩展工具集**：Strategy 模式注册工具，新增工具无需修改核心逻辑
4. **配置化**：端口、超时、模式均通过环境变量控制

## 模块关系

```
packages/shared         ← 协议定义、工具类型、常量
    ↑           ↑
packages/daemon    packages/extension
(HTTP+WS+Native)  (CDP+Tools+Transport)
```

## packages/shared

纯类型包，无运行时依赖。定义：

- `BridgeMessage` — 所有消息类型的联合类型
- `ToolArgs` — 每个工具的参数类型映射
- 常量：端口、超时、心跳间隔

## packages/extension

### Transport 层

`ITransport` 接口抽象通信通道：

- `NativeTransport` — `chrome.runtime.connectNative`
- `WebSocketTransport` — 标准 WebSocket 客户端
- `TransportManager` — 自动选择并管理通道，带重连

### Tool Registry

`BaseTool` 抽象类 + `ToolRegistry` 注册表：

- 每个工具实现 `execute(args, ctx)` 方法
- 通过 `ctx.cdp` 访问 CDP Bridge
- `dispatch(name, args, ctx)` 统一派发

### CDP Bridge

封装 `chrome.debugger` API：

- 自动 attach/detach 管理
- 统一 `send(tabId, method, params)` 调用
- 会话跟踪避免重复 attach

### 已实现工具

| 工具 | CDP 域 | 说明 |
|------|--------|------|
| navigate | Page.navigate | 导航 + 等待加载 |
| screenshot | Page.captureScreenshot | 支持全页、裁剪、格式 |
| click | Input.dispatchMouseEvent | 鼠标点击 |
| fill | Input.dispatchKeyEvent + Runtime.evaluate | 聚焦 + 逐字输入 + 触发事件 |
| evaluate | Runtime.evaluate | 执行 JS 表达式 |
| snapshot | DOM / Accessibility | DOM HTML 或 AX 树 |
| list_tabs | chrome.tabs.query | 列出所有标签页 |
| find_tab | chrome.tabs.query + filter | 按标题/URL 搜索 |
| close_tab | chrome.tabs.remove | 关闭标签页 |
| send_keys | Input.dispatchKeyEvent | 键盘事件，含修饰键 |
| save_as_pdf | Page.printToPDF | 导出 PDF |
| upload | DOM.setFileInputFiles | 文件上传 |

## packages/daemon

### 运行模式

- **standalone**（默认）：启动 WebSocket Server + HTTP Server
- **native-host**：作为 Chrome Native Messaging Host 运行（WEBBRIDGE_NATIVE_HOST=1）

### 模块

- `native-host/stdio.ts` — 4 字节长度前缀 JSON 读写
- `native-host/host.ts` — NativeHostTransport 实现
- `transport/websocket.ts` — WebSocketDaemonTransport 实现
- `connection/manager.ts` — 管理多个扩展连接、心跳
- `router/tool-router.ts` — 请求/响应匹配、超时管理
- `server/http-server.ts` — Fastify HTTP API
- `server/ws-server.ts` — ws WebSocket Server

### 请求流程

```
HTTP POST /api/tool
  → ToolRouter.callTool(name, args)
    → ConnectionManager.getActiveTransport()
      → transport.send(tool_call)
        → 等待 tool_result（requestId 匹配）
  → HTTP Response
```

## 扩展方式

### 新增工具

1. 在 `packages/shared/src/tools.ts` 添加参数类型
2. 在 `packages/extension/src/background/tools/` 创建工具类
3. 在 `tools/index.ts` 注册
4. 更新 Skill 文档

### 新增传输通道

1. 实现 `ITransport` 接口
2. 在 `TransportManager` 中集成
3. Daemon 侧实现对应的 `IDaemonTransport`
