# 配置与安全

> `config/` 文件 schema、环境变量、鉴权与封禁策略、通知通道。架构见 [ARCHITECTURE.md](./ARCHITECTURE.md)，运行时见 [RUNTIME.md](./RUNTIME.md)，契约见 [PROTOCOL.md](./PROTOCOL.md)。

## config/ 文件清单

`config/` 是**本地可变状态**，不是源码真相源：

| 文件 | 用途 |
|---|---|
| `auth.json` | 密码哈希（scrypt + salt）、`mustChange` 标志、schema 版本 |
| `tokens.json` | 活跃 token 指纹（**只存 sha256 digest**），服务重启后保留登录 |
| `notify.json` | 推送通道配置 + AI 摘要设置 |
| `model.json` | Claude 模型模板 + 当前活动模板 |
| `codex.json` | Codex profiles（API key、模型、自定义 CODEX_HOME） |
| `dev.json` | GitHub token/repos + SSH hosts（供 `/github`、`/ssh` 使用） |
| `banned_ips.json` | 被封 IP + 过期时间戳 |

## 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `PORT` | `8002` | 监听端口 |
| `CLAUDE_PATH` | `claude` | Claude CLI 路径 |
| `CODEX_PATH` | `codex` | Codex CLI 路径 |
| `CC_WEB_CONFIG_DIR` | `./config` | 配置目录覆盖（隔离测试用） |
| `CC_WEB_SESSIONS_DIR` | `./sessions` | 会话目录覆盖 |
| `CC_WEB_PUBLIC_DIR` | `./public` | 静态目录覆盖 |
| `CC_WEB_LOGS_DIR` | `./logs` | 日志目录覆盖 |
| `CC_WEB_IP_WHITELIST` | — | 暴力破解豁免 IP 列表 |
| `CC_WEB_TRUSTED_PROXIES` | — | 可信反向代理 CIDR/IP 列表（仅这些来源的 X-Forwarded-For 才被信任），默认空 = 最严格 |
| `PUSHPLUS_TOKEN` | — | 遗留：首次运行迁移到 `config/notify.json` |
| `CC_WEB_PASSWORD` | — | 遗留：首次运行迁移到 `config/auth.json` |

## 环境假设

- 服务绑定 `127.0.0.1`；外部访问**必须**通过反向代理、隧道或 LAN 暴露
- 原生 Claude 导入读 `~/.claude/projects`
- 原生 Codex 导入/删除读 `~/.codex/sessions` 与 `~/.codex/` 下 SQLite；依赖宿主机 `sqlite3` 命令
- `npm run regression` 也依赖 `sqlite3`

## 鉴权与安全

### 密码策略

- 密码哈希存 `config/auth.json`（scrypt，`N=16384 r=8 p=1 keylen=64` + 16 字节随机 salt），首次运行从 `CC_WEB_PASSWORD` 迁移
- **绝不落盘明文密码**；启动时检测旧 schema（含 `password` 字段）自动派生为 scrypt 哈希
- `auth.json` schema：`{ alg:'scrypt', salt:<hex>, hash:<hex>, params:{N,r,p,keylen}, mustChange, version:2 }`
- 无密码配置时：生成随机 12 字符密码，打印到控制台，置 `mustChange: true`
- 密码要求：≥8 字符，至少包含 (大写 / 小写 / 数字 / 特殊) 中**两类**
- 密码比较用 `crypto.timingSafeEqual`（常量时间，防时序侧信道）
- 改密**立即失效所有活跃会话**：`revokeAllTokens` 原子封装，严格顺序：先写空 `tokens.json`（旧 token 立即失效）→ 再写新 hash → 签新 token 跟随 `tokens.json` 落盘。任意点崩溃都不会出现"密码已改但旧 token 仍可用"

### Token 与会话持久化

- 活跃 token 落盘 `config/tokens.json`，**只存 sha256 指纹**（`digest`），不存原始 token
- `tokens.json` schema：`{ tokens:[{ digest:<sha256 hex>, issuedAt:<iso>, expiresAt:<iso>, absoluteExpiresAt:<iso> }] }`
  - `expiresAt` 滑动过期：每次活跃续期 24h（活跃用户不被踢）
  - `absoluteExpiresAt` 绝对过期：签发后 7 天硬上限（防止被盗 token 无限续期）
- 验证流程：内存命中优先（digest 比对 + expiresAt 滑动续期），否则算请求 token 的 sha256 比对磁盘（服务重启后兜底）
- token 有效期 24 小时滑动 + 7 天绝对过期；过期项在加载与定时清理时移除
- 文件权限 `0600`；写入用 tmp + fsync + rename 原子操作

### 登录失败原因（auth_result.reason）

服务端 `auth_result` 失败时返回三种对外收敛的 reason：

| reason | 含义 |
|---|---|
| `invalid_password` | 密码登录失败（触发暴力破解计数） |
| `session_expired` | token 失效（过期 / 改密 / 服务重启清空，统一不细分；不触发暴力破解计数） |
| `auth_failed` | 兜底（兼容旧版前端） |

### 暴力破解防护

- 5 分钟内 3 次失败 → IP 封禁 7 天（存 `config/banned_ips.json`）
- **永不封禁**：
  - Tailscale IP（`100.x.x.x`）
  - loopback
  - `CC_WEB_IP_WHITELIST` 中的 IP

### 客户端 IP 解析（防 X-Forwarded-For 伪造）

服务默认**完全不信任** `X-Forwarded-For` 头，直接使用 socket 真实远端地址。这可防止攻击者伪造 XFF 让封禁记到受害者头上（定向 DoS）或分散到不同 IP（爆破绕过）。

- 配置可信反向代理 CIDR/IP 列表：`CC_WEB_TRUSTED_PROXIES="127.0.0.1,10.0.0.0/8,::1,2001:db8::/32"`
- 配置后，仅当 socket 远端地址在可信列表内时，才取 XFF 链中"从右往左第一个不可信 IP"作为真实客户端
- **反向代理必须主动清洗客户端伪造的 XFF**，否则即使 server 信任代理，攻击者仍可向 XFF 链注入伪造项
  - Nginx：`proxy_set_header X-Forwarded-For $remote_addr;`
  - Caddy：`header_up X-Forwarded-For {remote_host}`
- 任何非法 IP token（如 `NOT_AN_IP`）会污染整个 XFF 链，server 直接丢弃 XFF 回退到 socket 地址
- HTTP `/api/*` 路径前置 `isBanned` 检查：被封 IP 调用任何 API 直接返回 403

实现与单测见 `lib/client-ip.js`。

## 通知通道

5 个推送通道，配置在 `config/notify.json`：

| 通道 | 配置键 | 内容长度上限 |
|---|---|---|
| PushPlus | `pushplus.token` | 18000 字符 |
| Telegram | `telegram.botToken` + `telegram.chatId` | 3800 字符 |
| Server酱 | `serverchan.sendKey` | 30000 字符 |
| 飞书 | `feishu.webhook` | 18000 字符 |
| QQ（Qmsg） | `qqbot.qmsgKey` + `qqbot.qqList` | 3800 字符 |

### AI 摘要

可选生成完成摘要（用 Claude / Codex / 自定义 API）。配置：

```json
{
  "summary": {
    "enabled": true,
    "trigger": "background",
    "apiSource": "claude",
    "apiBase": "...",
    "apiKey": "...",
    "model": "..."
  }
}
```

- `trigger`: `'background'`（仅后台完成触发）或 `'always'`
- `apiSource`: `'claude'` / `'codex'` / `'custom'`

### PUSHPLUS_TOKEN 迁移

`PUSHPLUS_TOKEN` 环境变量是遗留迁移路径——首次运行时自动移入 `config/notify.json`。

## 敏感目录声明

下列目录为**本地运行时状态**，不是源码真相源：

- `config/`
- `sessions/`（含会话 JSON、`*-run/` 运行时输出、`_attachments/` 附件存储）
- `logs/`
- `.env`

不要依赖仓内示例内容；这些文件在本地创建并被反复改写。

注意：附件实际落盘到 `sessions/_attachments/`（数据文件 + 元数据 JSON），不是项目根的 `attachments/`。`.gitignore` 中的 `attachments/` 条目保留是为兼容历史路径，实际运行时不写入该目录。
