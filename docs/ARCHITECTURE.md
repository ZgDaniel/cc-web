# 架构设计

> 系统拓扑、核心文件职责、Agent 适配层差异。运行时细节见 [RUNTIME.md](./RUNTIME.md)，前后端契约见 [PROTOCOL.md](./PROTOCOL.md)，配置与安全策略见 [CONFIG.md](./CONFIG.md)。

## 一句话定位

cc-web 是 Node.js 服务，通过浏览器 UI 驱动本地 Claude Code / Codex CLI 会话。文件级持久化（无 DB），Claude/Codex 以 detached 子进程运行，输出落盘后 tail 回前端。

## 系统拓扑

```
Browser (public/)
    │
    ├── HTTP ──── POST /api/attachments、DELETE /api/attachments/:id、静态文件
    │
    └── WebSocket ── 鉴权、会话生命周期、聊天流、斜杠命令、设置更新
              │
              ▼
        server.js (Node.js)
              │
              ├── sessions/<id>.json         会话持久化
              ├── sessions/<id>-run/         运行时输出 + PID
              ├── config/*.json              配置
              └── logs/process.log           plog 进程日志
              │
              ├── spawn ──→ claude (detached)
              └── spawn ──→ codex  (detached)
```

- HTTP 仅 3 个端点（附件上传、附件删除、静态文件含 SPA fallback）
- WebSocket 承载 95% 业务逻辑，客户端→服务端 31 个 type（含 auth），服务端→客户端 30 个 type（详见 [PROTOCOL.md](./PROTOCOL.md)）
- Claude/Codex detached 子进程，输出写入 `sessions/<id>-run/output.jsonl`，由 `FileTailer` 流式推送前端
- 不引入框架是刻意设计：行为主要在 `server.js`，加 `lib/` 适配层与原生 JS 前端 `public/app.js`

## 核心文件清单

| 文件 | 行数（近似，随重构漂移） | 职责 |
|---|---|---|
| `server.js` | ~4125 | 主应用：`.env` 加载、鉴权/token、IP 封禁、CSP 响应头、静态服务、附件 API、WebSocket 协议、会话持久化（原子写）、进程组 kill、进程恢复、通知、原生历史导入、远程任务引导、斜杠命令 |
| `lib/agent-runtime.js` | ~545 | Claude/Codex 适配器：构建 spawn 命令、映射权限模式、resume 语义、附件注入、流式事件归一化 |
| `lib/auth.js` | ~230 | 鉴权存储工厂：scrypt 密码哈希、token sha256 指纹、原子撤销（先空 tokens.json → 再写 hash → 签新 token） |
| `lib/client-ip.js` | ~90 | 客户端 IP 解析：默认不信任 XFF，配置可信代理后用"从右往左跳过可信代理"标准算法 |
| `lib/codex-rollouts.js` | ~242 | 解析 Codex rollout JSONL 历史，转换为 cc-web session/message 结构（含 tool_call 和 token 用量） |
| `public/app.js` | ~5226 | 整个前端：登录态、侧栏/会话态、消息渲染（marked + DOMPurify + decorateCodeBlocks）、斜杠命令 UX、附件上传、设置面板、主题切换、WebSocket 重连/resume |
| `scripts/regression.js` | ~1161 | 端到端隔离测试：7 项断言模块覆盖会话结构、WS 消息、进程 spawn、导入/删除、附件、改密失效、token 迁移、XSS、重连、健壮性、IP 解析、IP 封禁 |
| `scripts/mock-claude.js` | ~88 | mock Claude CLI 二进制（测试用） |
| `scripts/mock-codex.js` | ~109 | mock Codex CLI 二进制（测试用） |

## 安全防御层

cc-web 采用**纵深防御**（defense in depth），多层独立失效才发生 XSS/越权：

| 层 | 防御机制 | 失效时的兜底 |
|---|---|---|
| 输入层 | 客户端 IP 解析（`lib/client-ip.js`）：默认不信任 XFF | 无 XFF 信任 = 攻击者无法伪造 IP 绕过封禁 |
| 鉴权层 | scrypt 密码哈希 + token sha256 指纹 + 常量时间比较（`lib/auth.js`） | 时序侧信道被防住；token 泄漏后 7d 绝对过期兜底 |
| 改密层 | `revokeAllTokens` 原子封装：先空 tokens.json → 再写 hash → 签新 token | 任意点崩溃都不会出现"密码已改但旧 token 仍可用" |
| 越权层 | 改密同时踢掉所有其他已认证 WS 连接（`_ccwebAuthed=false` + close + close race 拦截） | 已登录的浏览器标签页不能继续操作 |
| 渲染层 | marked.parse → **DOMPurify sanitize** → decorateCodeBlocks（DOM API 注入受信任 UI） | DOMPurify 加载失败时 fail-closed（降级为 `<pre>escape</pre>`） |
| 浏览器层 | CSP 响应头（`script-src 'self' cdnjs.cloudflare.com`，禁止 `unsafe-inline`） | DOMPurify 失效时浏览器拒绝执行内联脚本 |
| 持久化层 | `atomicWriteJson`（tmp + rename，含密钥配置 0600） | 崩溃不会撕裂 JSON；密钥文件不被同机用户读 |
| 进程层 | `killProcess` 杀整个进程组（Linux `kill(-pid)`，detached child 是 pgid leader） | abort 后孙子进程不成孤儿继续烧 token |

## 前端渲染管线（XSS 防御核心）

```
LLM/用户文本
    │
    ▼
marked.parse(text)         → 标准 Markdown + 代码高亮 HTML
    │
    ▼
DOMPurify.sanitize(raw, {
  FORBID_TAGS: ['style','iframe','object','embed','base','form','input','button','svg','math'],
  FORBID_ATTR: ['style'],
})                          → 移除任何内联事件、危险标签
    │
    ▼
container.innerHTML = ...   → 注入 DOM（此时是干净的）
    │
    ▼
decorateCodeBlocks(container) → DOM API 注入受信任 UI：
                                - Copy 按钮（addEventListener，非 onclick）
                                - Preview 按钮 + iframe（sandbox="allow-scripts"）
                                闭包捕获 code 文本（不用全局 cid Map）
```

**关键不变量**：decorateCodeBlocks 注入的按钮/iframe 是**程序构造的受信任代码**，不经过 DOMPurify；用户/LLM 文本经过 sanitize，永不可能注入恶意 iframe 或 onclick。

**幂等性**：每个 `<code>` 节点用 `data-cc-decorated` 标记，流式刷新重写 innerHTML 后新节点自动 decorate，已标记节点不重复处理（保留 iframe srcdoc 状态）。

## Agent 适配层差异（Claude vs Codex）

UI 统一支持两个 Agent，底层不对称。所有差异在 `lib/agent-runtime.js` 实现。

### 持久化与 resume

| 维度 | Claude | Codex |
|---|---|---|
| resume 句柄 | `claudeSessionId` | `codexThreadId` + `codexHomeDir` + `codexRuntimeKey` |
| resume 命令 | `claude --resume <id>` | `codex exec resume <runtimeId> -` |
| runtime id 取法 | 直接 `claudeSessionId` | `getRuntimeSessionId` 取自 profile/线程 |

### 权限模式映射

| cc-web 内部值 | Claude CLI 参数 | Codex CLI 参数 |
|---|---|---|
| `default` | `--permission-mode default` | `--full-auto` |
| `plan` | `--permission-mode plan` | `-s read-only` |
| `yolo`（= Claude 的 `--dangerously-skip-permissions`） | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` |

⚠ **Codex plan 模式 + resume 顺序陷阱**：`-s read-only` 是 `codex exec` 的选项，**不是** `exec resume` 的选项。resume 场景必须把 `-s read-only` **push 到 `resume` 子命令前**，否则 Codex CLI 报 `unexpected argument '-s'`。

实现位置：`lib/agent-runtime.js:buildCodexSpawnSpec`（plan + resume 分支）；回归断言：`scripts/regression.js` 中针对 `-s read-only resume` 顺序的断言。历史反复回归（commit `7ec8771`、`29bb938`）。

### 附件注入

| Agent | 机制 |
|---|---|
| Claude | 有附件时切换 `--input-format stream-json`，附件元数据通过 stdin 注入 |
| Codex | 逐个追加 `--image <path>` 命令行参数 |

### 模型 spec 拆分

Codex 支持 `model(effort)` 语法，如 `gpt-5.4(high)`：

- 正则 `^(.*)\((medium|high|xhigh)\)\s*$` 捕获 base + effort
- 命中 → `--model <base>` + `-c model_reasoning_effort="<lvl>"`（TOML 字符串字面量）
- 未命中 → 原样 `--model <raw>`
- 支持的 effort 等级：`medium`、`high`、`xhigh`

Claude 直接 `--model <name>`，不拆分。

### 自定义 Codex profile

每个 Codex profile 创建隔离的 `CODEX_HOME` 目录，内含独立 `config.toml`（base_url / model / auth_method / API key）。环境变量级隔离，多 profile 不串扰。

### 修改时的影响域

变更下列任一行为，必须**同时**检查 `server.js`（共享 session 代码）与 `lib/agent-runtime.js`（agent 特定 spawn 逻辑），并跑 `npm run regression`：

- 模型选择
- 权限模式处理
- `/compact`
- resume 行为
- 附件注入
