# 运行时模型

> 会话持久化、detached 进程生命周期、关键运行时模式。架构见 [ARCHITECTURE.md](./ARCHITECTURE.md)，契约见 [PROTOCOL.md](./PROTOCOL.md)，配置见 [CONFIG.md](./CONFIG.md)。

## 会话持久化

### 文件布局

- `sessions/<sessionId>.json` — 会话对象（消息历史 + 元数据）
- `sessions/<sessionId>-run/` — 活跃运行目录
  - `pid` — 子进程 PID
  - `output.jsonl` — 流式输出，`FileTailer` tail 此文件

### normalizeSession

`server.js` 中 `normalizeSession()` 在加载时统一字段默认值。**新增字段必须在 `normalizeSession` 设默认值**，保证前向兼容。

当前在该函数设默认值的字段：`agent` / `claudeSessionId` / `codexThreadId` / `codexHomeDir` / `codexRuntimeKey` / `totalCost` / `totalUsage` / `taskMode` / `sshHostId` / `remoteCwd` / `messages`。

**不在该函数设默认值**（由创建/业务路径显式赋值）：
- `permissionMode` — 由 `handleNewSession` / `handleMessage` 创建时赋值，默认 `'yolo'`
- `hasUnread` — 由消息处理路径动态置位
- `updated` — 由各业务路径写入

### 原子写（atomicWriteJson）

`server.js` 中 `atomicWriteJson(path, value, options)` 是统一落盘入口，避免大型 session JSON 在写入中途崩溃导致文件撕裂：

- 写 `tmp` 文件 → `fs.writeFileSync` 拿到字节 → `fs.renameSync` 替换目标（POSIX 原子）
- 可选 `options.mode`：`saveDevConfig` / `saveCodexConfig` / `saveNotifyConfig` 等含密钥的配置强制 `0o600`，防止同机其他用户读
- 所有 7 个 save 函数（`saveSession` / `saveBannedIPs` / `saveNotifyConfig` / `saveModelConfig` / `saveCodexConfig` / `saveDevConfig` / `saveAttachmentMeta`）以及 `lib/auth.js` 的 token/auth 写入都走原子写

**关键不变量**：任何崩溃都不会让目标文件停留在半写状态——要么是旧内容，要么是新内容，绝不撕裂。

### Session 对象关键字段

除 `id` / `title` / `messages` 之外：

| 字段 | 含义 |
|---|---|
| `agent` | `'claude'` 或 `'codex'` |
| `claudeSessionId` | Claude resume 句柄 |
| `codexThreadId` | Codex resume 线程 id |
| `codexHomeDir` | Codex 隔离 profile 目录（CODEX_HOME） |
| `codexRuntimeKey` | Codex runtime 认证 key |
| `permissionMode` | cc-web 内部值：`'default'` / `'plan'` / `'yolo'`（= `dangerously_skip_permissions`）。默认 `'yolo'`。Claude/Codex 各自 CLI 参数映射见 [ARCHITECTURE.md](./ARCHITECTURE.md#权限模式映射) |
| `model` | 当前会话使用的模型（Codex 创建时设默认，Claude 从模板解析） |
| `cwd` | 工作目录 |
| `taskMode` | `'local'` 或 `'remote'`（remote 携带 `sshHostId` + `remoteCwd`） |
| `totalCost` | 累计美元成本 |
| `totalUsage` | 累计 token 用量（`inputTokens` / `cachedInputTokens` / `outputTokens`） |
| `hasUnread` | 是否有未读消息（侧栏高亮） |
| `updated` | 最后更新时间戳（ISO） |

## Detached 进程生命周期

### 三态流转

```
用户发送消息
    │
    ▼
spawn claude/codex (detached)         ← lib/agent-runtime.js 构建命令
    │
    ├─→ 写 PID 到 sessions/<id>-run/pid
    └─→ 流式输出到 sessions/<id>-run/output.jsonl
              │
              ▼
        FileTailer (server.js)         ← fs.watch + 500ms 轮询双保险
              │
              ├─→ 按字节偏移只读新内容
              ├─→ 缓冲半截 JSON 行
              └─→ 推送 text_delta / tool_start / tool_end 到前端
    │
    ▼
进程退出
    │
    ▼
handleProcessComplete                  ← server.js
    │
    ├─→ 累计 cost / usage 到 session
    ├─→ 检测 context limit → 自动 compact 重试
    ├─→ 驱动 /goal 多轮自治
    └─→ 触发 background_done 通知
```

### recoverProcesses（启动时恢复）

服务重启时 `recoverProcesses()` 扫描所有残留的 `*-run/` 目录：

- 子进程仍存活 → 重新 attach（继续 tail）
- 子进程已退出 → 把输出 finalize 进 session JSON

**关键含义**：服务重启**不会**终止进行中的 Claude/Codex 工作。

### 中断进程（killProcess）

用户点停止按钮 / 发 abort 时，`killProcess(pid)` 杀**整个进程组**而不是单进程：

- spawn 时 detached child 自动成为 pgid leader（同 pid）
- Linux 用 `process.kill(-pid, signal)`，负数 pid 表示进程组
- **关键含义**：claude/codex 子进程如果再 spawn 了孙子进程（如 bash 执行工具调用），中断时这些孙子进程会随组一起死，不会变孤儿继续烧 token

### 修改时必须验证

变更进程 spawn / 输出解析 / run 目录结构时，必须同时检查：

- `server.js`（FileTailer / recoverProcesses / handleProcessComplete）
- `lib/agent-runtime.js`（spawn 命令构建）

并跑 `npm run regression`。

## 关键运行时模式

### 自动 compact 重试

会话中检测到 context limit 错误（`isContextLimitError`）时，服务端自动：

1. 注入 `/compact` 命令
2. 重放原 prompt

状态机：

- `pendingCompactRetries: Map<sessionId, ...>` — 跟踪重试状态
- `pendingSlashCommands: Map<sessionId, ...>` — 排队的 slash 命令
- `reason: 'auto'`（自动触发）vs `'normal'`（用户主动）

核心位置：`server.js` 中 `handleProcessComplete` 函数（按函数名定位最稳）。

### `/goal` 多轮自治

`/goal` 是绕过 slash 分发器的特殊路径：

- 在 `handleMessage`（`server.js`）独立处理
- 双重正则排除 `/^\/goal(?:\s|$)/i`（一处 WS switch 前、一处 `handleMessage` 内）防止走 `handleSlashCommand` switch
- 把"继续追问条件"塞入 `pendingCompactRetries`，靠 `handleProcessComplete` 循环驱动下一轮
- 前端 per-session LRU（cap 100）+ 三态分类 + optimistic flag 抗竞态

### 懒加载历史

会话历史**不**一次性发送。规则：

- 首条 `INITIAL_HISTORY_COUNT = 12` 条消息立即发送
- 旧消息按 `HISTORY_CHUNK_SIZE = 24` 分块，通过 `session_history_chunk` WebSocket 消息增量推送

常量位置：`server.js` 中 `INITIAL_HISTORY_COUNT` 与 `HISTORY_CHUNK_SIZE`（按符号名定位）。

### FileTailer

`server.js` 中的 `FileTailer` 类（按类名定位最稳），tail `output.jsonl` 实现流式推送：

- `fs.watch()` + 500ms 备份轮询双保险
- 按字节偏移只读新内容
- 缓冲半截 JSON 行直到 newline

### 进程日志 plog

`logs/process.log`，JSONL 格式，2MB 自动轮转。事件类型：

- `process_spawn` / `process_complete`
- `ws_connect` / `ws_disconnect`
- `recovery_alive` / `recovery_dead`
- `heartbeat`（活跃进程每 60s）

实现位置：`server.js` 顶部 `plog` 工厂。

### WebSocket 重连与改密踢下线

WS 连接掉线（网络抖动 / 临时断开）时前端自动重连，体验关键：**重连不打断用户当前的阅读**。

- 前端用 `hasInitialAuthCompleted` 区分「首次鉴权成功」和「重连后鉴权成功」
- 首次成功 → 加载会话列表 + 当前会话历史（`pendingInitialSessionLoad = true`）
- 重连成功 → **不**触发会话/历史重载，保留当前滚动位置、保留正在浏览的旧消息
- 服务端鉴权内存命中（digest 比对 + 24h 滑动续期），重连基本无感

**改密踢下线**：用户在 A 标签页改密后，B 标签页必须立即失效，否则旧密码登录态会留下后门。实现严格顺序：

1. `revokeAllTokens` 原子封装（先空 `tokens.json` → 再写新 hash → 再签新 token）
2. 遍历 `wss.clients`，对**其他**已认证 WS（`_ccwebAuthed === true`）：先置 `_ccwebAuthed = false`（防 close race 中再发消息），再 `close()`
3. 旧 WS 收到 close 后重连，但 token 已失效，被踢回登录页

**关键不变量**：改密完成的瞬间，没有任何旧 token 能继续操作 WS，也没有任何旧 WS 连接能继续 send。
