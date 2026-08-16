# 前后端契约

> WebSocket 消息契约、HTTP 路由、Session JSON 结构、附件流程、斜杠命令。契约**无 schema 驱动**，前后端耦合隐式 — 改动需双向检查。

## WebSocket 协议

### 客户端 → 服务端

`server.js` 客户端消息入口：`auth` 单独分支 + switch 共 30 个 case = **31 个 type**（按符号名 `ws.on('message')` 与 switch 定位最稳）。

| 类型 | 用途 |
|---|---|
| `auth` | 鉴权握手（独立分支，在 WS `message` 事件回调顶部，switch 之前）。负载可选 `password` 或 `token`，两者其一即可 |
| `message` | 用户消息（含文本/图片/斜杠命令） |
| `abort` | 中断当前生成（**服务端 kill 整个进程组**，详见 [RUNTIME.md](./RUNTIME.md)） |
| `new_session` | 新建会话（local/remote） |
| `load_session` | 加载会话 |
| `delete_session` | 删除会话 |
| `rename_session` | 重命名会话 |
| `set_mode` | 切换 permissionMode |
| `list_sessions` | 拉取会话列表 |
| `detach_view` | 关闭查看模式 |
| `get_notify_config` / `save_notify_config` / `test_notify` | 通知配置 |
| `change_password` | 改密 |
| `get_model_config` / `save_model_config` | Claude 模型模板 |
| `get_codex_config` / `save_codex_config` | Codex profile |
| `fetch_models` | 拉取可用模型列表 |
| `check_update` | 检查版本更新 |
| `read_claude_local_config` / `read_codex_local_config` | 读本地 CLI 配置 |
| `save_local_snapshot` / `restore_claude_local_snapshot` | 本地配置快照 |
| `get_dev_config` / `save_dev_config` | Dev 配置（GitHub/SSH） |
| `list_native_sessions` / `import_native_session` | Claude 原生会话 |
| `list_codex_sessions` / `import_codex_session` | Codex 原生会话 |
| `list_cwd_suggestions` | cwd 建议列表 |

### 服务端 → 客户端

`public/app.js` 中 `handleServerMessage` 函数，共 **30 个 case**：

| 类型 | 用途 |
|---|---|
| `auth_result` | 鉴权结果。失败时含 `reason`（`invalid_password` / `session_expired` / `auth_failed`，3 类收敛值）+ 可选 `banned: true` |
| `error` | 错误 |
| `system_message` | 系统消息（含 `kind: 'goal_feedback'` / `'compact'` 等，未知 kind 走默认渲染，见下方示例） |
| `session_list` | 会话列表 |
| `session_info` | 会话元信息。运行中会话额外附带 `activeOutput`（string，内存实时全量输出，用于断线补齐，见 [RUNTIME.md](./RUNTIME.md#ws-心跳与断线内容补齐)）；任务结束后该键省略 |
| `session_history_chunk` | 历史分块（懒加载，详见 [RUNTIME.md](./RUNTIME.md#懒加载历史)） |
| `resume_generating` | 恢复生成态 |
| `session_renamed` | 重命名通知 |
| `mode_changed` / `model_changed` | 模式/模型切换通知 |
| `text_delta` | 文本流增量（**经 DOMPurify sanitize 后注入 DOM**，详见 [ARCHITECTURE.md](./ARCHITECTURE.md)） |
| `tool_start` / `tool_end` | 工具调用起止 |
| `cost` / `usage` | 成本/用量更新 |
| `done` | 生成完成 |
| `background_done` | 后台完成（推送通知触发） |
| `notify_config` / `notify_test_result` | 通知配置回执 |
| `password_changed` | 改密通知。成功时返回新 `token`，前端必须用新 token 替换旧 token；改密副作用：**踢掉所有其他已认证 WS 连接**（详见 [CONFIG.md](./CONFIG.md#鉴权与安全)） |
| `model_config` / `codex_config` / `dev_config` | 配置回执 |
| `claude_local_config` / `codex_local_config` | 本地配置回执 |
| `fetch_models_result` | 模型列表回执 |
| `update_info` | 版本更新信息 |
| `native_sessions` / `codex_sessions` | 原生会话列表 |
| `cwd_suggestions` | cwd 建议回执 |

### 鉴权握手细节

`auth` 消息支持两种凭据：

| 凭据 | 行为 |
|---|---|
| `password` 明文 | 服务端 `verifyPassword`（scrypt + 常量时间比较）验证；失败触发 IP 暴力破解计数（5min/3次 → 封禁 7d） |
| `token` 持久 token | 内存命中优先（digest 比对 + 24h 滑动续期 + 7d 绝对过期）；磁盘兜底（服务重启后内存空，token 在有效期内仍可用） |

失败 `reason` 收敛为 3 类，前端按文案显示：

| reason | 触发条件 | 是否触发封禁计数 |
|---|---|---|
| `invalid_password` | 密码登录失败 | 是 |
| `session_expired` | token 失效（过期 / 改密 / 服务重启清空） | 否 |
| `auth_failed` | 兜底（兼容旧版前端） | 否 |

成功时 `auth_result` 含 `token` + `mustChangePassword`（强制改密标志）。

### 关键事件流（流式生成）

```
client: message
   ↓
server: text_delta × N         (流式)
server: tool_start × N
server: tool_end × N
server: cost / usage
server: done | background_done
```

事件归一化在 `lib/agent-runtime.js`（`processClaudeEvent` / `processCodexEvent`），统一为上表 6 类。

### `system_message` 压缩提示示例

compact 相关提示（`kind: 'compact'`，走已有 system_message 默认渲染，前端无需新 case）：

```json
{ "type": "system_message", "kind": "compact", "message": "◎ 检测到上下文接近上限，先执行压缩再发送您的消息" }
{ "type": "system_message", "kind": "compact", "message": "◎ 上下文已压缩（前 93,158 → 后 5,762 tokens）" }
```

第一条在预防性水位压缩触发时（发送前）下发；第二条由 CLI 的 compact 边界事件透传（token 数取不到时为 `◎ 上下文已压缩`）。详见 [RUNTIME.md "自动 compact 重试"](./RUNTIME.md#自动-compact-重试)。

### WS 心跳

服务端每 `CC_WEB_WS_PING_INTERVAL_MS`（默认 25s）向所有客户端发协议级 ping；连续两轮未收到 pong 即 `terminate` 死连接。客户端无需处理（浏览器自动回 pong）。详见 [RUNTIME.md](./RUNTIME.md#ws-心跳与断线内容补齐)。

## HTTP 路由（仅 3 个）

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/api/attachments` | 图片上传（10MB 上限） |
| `DELETE` | `/api/attachments/:id` | 删除附件 |
| `GET` | `*` | 静态文件（`public/`，含 SPA fallback，路径校验 `startsWith(PUBLIC_DIR)`） |

### HTTP 响应头（所有响应统一）

服务端在 `http.createServer` 顶部为所有响应设置：

| 头 | 值 | 用途 |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self';` | XSS 纵深防御（DOMPurify 主防御失效时兜底） |
| `X-Content-Type-Options` | `nosniff` | 防 MIME 嗅探 |
| `Referrer-Policy` | `same-origin` | 不泄漏 referrer 到外部 |

### `/api/*` 前置封禁检查

所有 `/api/*` 路径在 token 检查**之前**先做 `isBanned(ip)`：

- IP 已被封禁 → 直接返回 `403 { ok:false, banned:true }`（不消耗 token 验证算力）
- 未封禁 → 继续走正常 token 校验流程（401 失败不触发 IP 计数，因为 token 失效属于 session_expired 不计入爆破）

### 客户端 IP 解析

服务端不再无脑信任 `X-Forwarded-For` 第一项。默认 clientIP = socket 真实远端地址；只有配置 `CC_WEB_TRUSTED_PROXIES` 后才使用标准算法（XFF 链 + socket，从右往左跳过可信代理，第一个非可信 IP）。详见 [CONFIG.md "客户端 IP 解析"](./CONFIG.md#客户端-ip-解析防-x-forwarded-for-伪造)。

## Session JSON 结构

详见 [RUNTIME.md "Session 对象关键字段"](./RUNTIME.md#session-对象关键字段)。文件路径：`sessions/<sessionId>.json`。

## 附件上传/删除流程

**上传协议**（非 multipart）：

- `POST /api/attachments`
- Header：`Authorization: Bearer <token>` + `Content-Type: image/png|jpeg|webp|gif` + `X-Filename: <原始文件名>`
- Body：**原始图片字节流**（直接 `req.on('data')` 流式收集，10MB 上限）
- 落盘：`sessions/_attachments/<uuid>.<ext>`（数据文件）+ `sessions/_attachments/<uuid>.json`（元数据）
- 返回：`{ ok, id, kind, filename, ... }`

**删除**：`DELETE /api/attachments/:id` → 移除数据文件 + 元数据文件。

**TTL 清理**：定时器扫 `sessions/_attachments/` 元数据，过期删除（`server.js` 顶部常量）。

## 原生会话导入

| 来源 | 路径 | 实现 |
|---|---|---|
| Claude 原生 | `~/.claude/projects` 下的 `.jsonl` | `list_native_sessions` / `import_native_session` |
| Codex 原生 | `~/.codex/sessions/` 下 rollout + SQLite（`state_5.sqlite` / `logs_1.sqlite`） | `list_codex_sessions` / `import_codex_session` |

⚠ Codex 导入/删除依赖宿主机 `sqlite3` 命令；`scripts/regression.js` 也依赖。

## 斜杠命令

服务端 `handleSlashCommand` switch 入口（`server.js`，按函数名定位最稳）：

| 命令 | 行为 |
|---|---|
| `/clear` | 清空当前会话消息 |
| `/mode` | 切换 permissionMode |
| `/model` | 查看/切换 Claude 模型 |
| `/cost` | 显示累计成本 |
| `/compact` | 执行原生上下文压缩 |
| `/init` | 分析项目并生成/更新 Agent 指南文件 |
| `/loop <间隔> <提示>` | 定期执行提示；支持 `s`、`m`、`h`（1 秒–24 小时） |
| `/github` | 注入 GitHub repos 上下文（来自 dev.json） |
| `/ssh` | 注入 SSH hosts 上下文（来自 dev.json） |
| `/help` | 显示帮助 |

### `/goal`（特殊路径，不在 switch 中）

`/goal` **绕过 slash 分发器**：

- 在 `handleMessage` 独立处理
- Claude 原样接收原生命令；Codex `exec` 会被转换为“创建、持久化并推进目标”的兼容提示，`/goal`（无条件）则请求清除目标
- 双重正则排除 `/^\/goal(?:\s|$)/i`（WS switch 前一处、`handleMessage` 内一处）防误走 switch
- 详见 [RUNTIME.md "/goal 多轮自治"](./RUNTIME.md#goal-多轮自治)

### `/loop <间隔> <提示>`

- 由 cc-web 调度，不依赖 Claude 或 Codex 的 TUI；每个会话只能保留一个循环
- 任务仍在运行时跳过本轮，不并发启动第二个 agent
- 配置持久化在 session 的 `loop` 字段，服务重启后恢复；`/loop off` 或 `/clear` 会停止并清除配置
