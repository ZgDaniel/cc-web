# CC-Web

浏览器端驱动本地 Claude Code / Codex CLI 会话的 Node.js 网关。文件级持久化（无 DB），detached 子进程 + JSONL tail 推回前端。

- **线上**：`cc-web-jp2.service`（systemd 托管，:8002，绑定 127.0.0.1）
- **入口**：`npm start` 启动 `server.js`
- **面向终端用户的部署/截图文档**：见 [README.md](./README.md)
- **版本历史**：见 [CHANGELOG.md](./CHANGELOG.md)

## 核心命令

```bash
npm install                  # 装依赖（仅 ws@8）
npm start                    # 启动 = node server.js
npm run regression           # 唯一自动化测试（端到端隔离）
node --check server.js       # 后端语法检查
node --check public/app.js   # 前端语法检查
```

## 测试契约（红线）

- **无构建 / 无 lint / 无 Jest / Vitest / Playwright**
- 唯一自动化验证 = `npm run regression`（隔离实例 + mock CLI + WebSocket 抓包）
- 无单测命令；聚焦测试需手动窄化 `scripts/regression.js`
- 无前端构建步骤；`server.js` 直接静态托管 `public/`

## 安全红线（顶级必读）

- 密码存 `config/auth.json`（scrypt 哈希 + 随机 salt，**绝不落盘明文**），无配置时生成随机 12 字符 + `mustChange: true`
- 启动时检测旧 schema（含明文 `password` 字段）自动迁移为 scrypt 哈希
- 活跃 token 落盘 `config/tokens.json`（**只存 sha256 指纹**），服务重启不踢用户；滑动 24h 续期 + 7 天绝对过期
- 改密**立即失效所有活跃会话**（`revokeAllTokens` 严格顺序：先写空 tokens.json 再换 hash，崩溃安全）+ **踢掉所有其他已认证 WS 连接**（前置 `_ccwebAuthed=false` 防 close race）
- 暴力破解防护：5 分钟内 3 次失败 → IP 封禁 7 天
- **永不封禁**：Tailscale IP（100.x.x.x）、loopback、`CC_WEB_IP_WHITELIST`
- **客户端 IP 解析**：默认**完全不信任** `X-Forwarded-For`（直接用 socket 远端地址），需配置 `CC_WEB_TRUSTED_PROXIES` 才启用「XFF 链 + socket，从右往左跳过可信代理」标准算法（防 XFF 伪造绕过封禁）
- **XSS 纵深防御**：marked 解析 → **DOMPurify sanitize**（fail-closed：未加载降级 `<pre>escape</pre>`）→ decorateCodeBlocks 用 DOM API 注入受信任 UI；兜底为 CSP 响应头（禁止 `unsafe-inline`、`object-src 'none'`、仅允许 cdnjs CDN）
- **HTTP `/api/*` 前置封禁**：被封 IP 调用 API 直接返回 403，不消耗 token 验证算力
- **原子写**：`atomicWriteJson`（tmp + rename）覆盖所有 session/config 落盘；含密钥配置强制 0600
- **进程组 kill**：detached child 是 pgid leader，abort 时 `kill(-pid)` 杀整组防孙子进程成孤儿
- 详细策略见 [docs/CONFIG.md "鉴权与安全"](./docs/CONFIG.md#鉴权与安全) + [docs/ARCHITECTURE.md "安全防御层"](./docs/ARCHITECTURE.md#安全防御层)

## 前后端契约红线（无 schema 驱动）

- WebSocket 消息契约：客户端→服务端 31 个 type（含 auth）、服务端→客户端 30 个 type，与 server.js / public/app.js 双向 switch 完整对称
- Session JSON 结构持久化在 `sessions/*.json`，字段默认值在 `normalizeSession()`（**新增字段必须设默认值**）
- 附件 API：`POST /api/attachments` + `DELETE /api/attachments/:id`（HTTP 仅此 2 个非静态端点）
- 斜杠命令：`/clear` `/mode` `/model` `/cost` `/compact` `/init` `/github` `/ssh` `/help` 走 `handleSlashCommand`；**`/goal` 走 `handleMessage` 独立路径**（绕过分发器）
- 完整契约见 [docs/PROTOCOL.md](./docs/PROTOCOL.md)

## 敏感目录（本地运行时状态，非源码真相源）

- `config/` — 鉴权 / 通知 / 模板 / Codex profile / Dev 配置 / 封禁 IP
- `sessions/` — 会话 JSON + `*-run/` 运行时输出
- `sessions/_attachments/` — 上传的图片（原始字节 + 元数据 JSON，TTL 清理）
- `logs/` — `process.log` 进程日志（2MB 轮转）
- `.env` — 环境变量

## 详细文档索引

| 文档 | 作用 |
|---|---|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 系统拓扑 + 核心文件职责 + **Claude vs Codex 适配层差异**（权限映射 / resume / 附件注入 / 模型 spec 拆分）+ **安全防御层**（8 层纵深防御）+ **前端渲染管线**（marked → DOMPurify → decorateCodeBlocks） |
| [docs/RUNTIME.md](./docs/RUNTIME.md) | 会话持久化（normalizeSession + 字段表 + 原子写）+ detached 进程生命周期（含 killProcess 进程组中断）+ FileTailer + 自动 compact 重试 + /goal 多轮 + 懒加载 + plog + **WS 重连与改密踢下线** |
| [docs/PROTOCOL.md](./docs/PROTOCOL.md) | WebSocket 31+30 type 清单（C→S 含 auth）+ HTTP 路由（含响应头 + 前置封禁 + 客户端 IP 解析）+ 附件流程 + 原生会话导入 + 斜杠命令表 |
| [docs/CONFIG.md](./docs/CONFIG.md) | config/ 文件 schema + 环境变量 + 环境假设 + 鉴权策略（含 XFF 不信任）+ 通知 5 通道 + AI 摘要 |

## 关键代码文件索引

| 文件 | 行数 | 职责 | 入口锚点（行号会随重构漂移，按函数名定位最稳） |
|---|---|---|---|
| `server.js` | ~3965 | 主应用 | `normalizeSession` / `FileTailer` / `handleProcessComplete` / `recoverProcesses` / WS switch / `handleSlashCommand` / `handleMessage`（均按函数名定位最稳） |
| `public/app.js` | ~5175 | 整个前端 | `handleServerMessage` / `flushRender` / `renderMarkdown` / `sendMessage` |
| `lib/agent-runtime.js` | ~545 | Claude/Codex 适配器 | `buildClaudeSpawnSpec` / `buildCodexSpawnSpec` / `processClaudeEvent` / `processCodexEvent` / `processRuntimeEvent` |
| `lib/auth.js` | ~230 | 鉴权存储工厂（scrypt 哈希 + token 指纹 + 原子撤销） | `createAuthStore` / `hashPassword` / `verifyPassword` / `issueToken` / `loadTokens` / `revokeAllTokens` |
| `lib/client-ip.js` | ~90 | 客户端 IP 解析（防 XFF 伪造，从右往左跳过可信代理） | `createClientIpResolver` / `resolveClientIP` / `isTrustedProxy` |
| `lib/codex-rollouts.js` | ~242 | Codex 历史 JSONL 解析 | `parseCodexRolloutLines` / `getCodexRolloutFiles` / `parseCodexRolloutFile` |
| `scripts/regression.js` | ~880 | 端到端隔离测试 | 顶部模块头含完整覆盖矩阵；新增 `testAuthStoreTokenMigration` / `testXssHardening` / `testWsReconnectPreservesState` / `testRobustnessHardening` / `testClientIpResolution` / `testIpBanEnforcement` |
| `scripts/mock-claude.js` | ~88 | mock Claude CLI | — |
| `scripts/mock-codex.js` | ~109 | mock Codex CLI | — |

## 修改时的高风险区域

变更以下行为必须**同时**检查 `server.js` + `lib/agent-runtime.js`，并跑 `npm run regression`：

- 模型选择 / 权限模式 / `/compact` / resume / 附件注入
- 进程 spawn / 输出解析 / `*-run/` 目录结构
- WebSocket 消息类型 / 负载 shape（前后端双向）

⚠ **Codex `-s read-only resume` 顺序陷阱**：resume 场景下 `-s read-only` 必须 push 到 `resume` 子命令前，否则 Codex CLI 报错。历史反复回归。

## 关联文档

- [README.md](./README.md) — 终端用户文档（部署、截图、systemd/Nginx 配置）
- [README.en.md](./README.en.md) — 英文版
- [CHANGELOG.md](./CHANGELOG.md) — 版本历史
