# CC-Web

Claude Code / Codex 轻量级 Web 远程工具 — 在浏览器中与本机 CLI Agent 交互。

![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)

[English README](./README.en.md) | [更新日志](./CHANGELOG.md)

Vibe产物，readme比较絮叨，建议直接丢给CC，拷打一番就好。

## 一键部署：claude
```
https://github.com/ZgDaniel/cc-web 给我装！
```


<p align="center">
  <img src="https://github.com/user-attachments/assets/ae974fcd-b6a7-4bdf-8553-bfcf2e7038a4" alt="截图1" width="30%" />
  <img src="https://github.com/user-attachments/assets/eb0291c1-2b38-4379-9a07-8eecc6c87d8f" alt="截图2" width="30%" />
  <img src="https://github.com/user-attachments/assets/09cec007-a949-44cf-9f2a-88c1eda60082" alt="截图3" width="30%" />
</p>


## 功能特性

- **超轻量** — 后端性能占用少，前端通过 web 访问
- **多会话管理** — 创建、切换、重命名、删除会话，删除时同步清除本地 Claude 历史记录
- **本地历史导入** — Claude 可导入 `~/.claude/projects/` 会话；Codex 可导入 `~/.codex/sessions/` rollout 历史
- **后台任务** — 关闭浏览器后 Claude 进程继续运行，完成后推送通知，支持 PushPlus / Telegram / Server酱 / 飞书机器人 / QQ（Qmsg）
- **多 API 切换** — 可配置多个 API 方案，一键切换，即时生效
- **开发者配置** — 可保存主机SSH信息、github token，实现快速管理远程主机、管理github仓库

## 前提条件

- **Node.js** >= 18
- **Claude Code CLI** 或 **Codex CLI** 已安装并配置
  ```bash
  npm install -g @anthropic-ai/claude-code
  npm install -g @openai/codex
  ```

## 快速开始

### Linux / macOS

```bash
git clone https://github.com/ZgDaniel/cc-web.git
cd cc-web
npm install
cp .env.example .env    # 可选，不设密码则首次启动自动生成
npm start
```

### Windows

```cmd
git clone https://github.com/ZgDaniel/cc-web.git
cd cc-web
npm install
copy .env.example .env  & REM 可选
```
然后双击 `start.bat`，或在终端运行 `node server.js`。

---

启动后访问 `http://localhost:8002`，输入密码即可使用。

## 配置

### 环境变量 (.env)

| 变量 | 必填 | 默认值 | 说明 |
|------|:---:|--------|------|
| `CC_WEB_PASSWORD` | 否 | 自动生成 | Web 登录密码（首次启动自动迁移到 `config/auth.json`） |
| `PORT` | 否 | `8002` | 服务监听端口 |
| `CLAUDE_PATH` | 否 | `claude` | Claude CLI 可执行文件路径 |
| `CODEX_PATH` | 否 | `codex` | Codex CLI 可执行文件路径 |
| `CC_WEB_CONFIG_DIR` | 否 | `./config` | 配置目录覆写（主要供隔离测试使用） |
| `CC_WEB_SESSIONS_DIR` | 否 | `./sessions` | 会话目录覆写（主要供隔离测试使用） |
| `CC_WEB_LOGS_DIR` | 否 | `./logs` | 日志目录覆写（主要供隔离测试使用） |
| `PUSHPLUS_TOKEN` | 否 | - | PushPlus Token（首次启动自动迁移到通知配置） |

### 通知配置

点击侧边栏底部的 **⚙ 设置按钮**，在 Web UI 中可视化配置推送通知：

| 通知方式 | 所需配置 | 获取方式 |
|---------|---------|---------|
| **PushPlus**（微信推送） | Token | [pushplus.plus](https://www.pushplus.plus/) 注册获取 |
| **Telegram** | Bot Token + Chat ID | [@BotFather](https://t.me/BotFather) 创建机器人 |
| **Server酱** | SendKey | [sct.ftqq.com](https://sct.ftqq.com/) 注册获取 |
| **飞书机器人** | Webhook URL | 飞书群 → 设置 → 群机器人 → 添加自定义机器人 |
| **QQ（Qmsg）** | Qmsg Key | [qmsg.zendee.cn](https://qmsg.zendee.cn/) 登录后获取，需添加接收 QQ 号 |

配置保存在 `config/notify.json`，Token 在 UI 中脱敏显示（仅显示前4后4位）。

### 密码管理

密码存储在 `config/auth.json`，支持自动生成与 Web UI 修改：

- **首次启动**（无 `.env` 密码、无 `auth.json`）：自动生成 12 位随机密码，打印到控制台，首次登录强制修改
- **从 `.env` 迁移**：如已在 `.env` 设置 `CC_WEB_PASSWORD`，启动时自动迁移到 `auth.json`，无需改密
- **Web UI 修改**：设置面板 → 修改密码（需输入当前密码）
- **密码要求**：≥ 8 位，包含大写/小写/数字/特殊字符中的至少 2 种
- **改密后**：所有已登录会话失效，需重新认证

## 项目结构

```
cc-web/
├── server.js              # Node.js 后端（HTTP + WebSocket + 进程管理 + 通知）
├── lib/
│   ├── agent-runtime.js    # Claude / Codex 运行时适配层
│   └── codex-rollouts.js   # Codex rollout 历史解析
├── public/
│   ├── index.html          # 页面结构
│   ├── app.js              # 前端逻辑（WebSocket 通信、UI 交互）
│   ├── style.css           # 样式（和风暖色调主题）
│   └── sw.js               # Service Worker（移动端推送通知）
├── config/
│   ├── codex.json          # Codex 独立配置（运行时生成）
│   ├── notify.json         # 通知渠道配置（运行时生成）
│   └── auth.json           # 密码配置（运行时生成）
├── sessions/               # 对话历史 JSON 文件（运行时生成）
├── logs/                   # 进程生命周期日志（运行时生成）
├── scripts/
│   ├── regression.js       # 隔离式回归脚本
│   ├── mock-claude.js      # 回归用 mock Claude CLI
│   └── mock-codex.js       # 回归用 mock Codex CLI
├── .env.example            # 环境变量模板
├── start.bat               # Windows 一键启动脚本
├── .gitignore
├── package.json
└── README.md
```

## 架构设计

### 进程模型

```
浏览器 ←WebSocket→ Node.js (server.js) ←文件I/O→ Claude / Codex CLI (detached)
```

- 每条用户消息会根据当前会话 Agent，spawn Claude 或 Codex 子进程
- 进程使用 `detached: true` + `proc.unref()`，独立于 Node.js 生命周期
- stdin/stdout/stderr 通过文件传递（`sessions/{id}-run/`），不使用 pipe
- PID 持久化到文件，服务重启后自动恢复（`recoverProcesses()`）
- 使用 `FileTailer` 实时监听输出文件变化，流式推送给前端
- Claude / Codex 的 spawn spec 与事件解析分别由 `lib/agent-runtime.js` 管理

### 后台任务流程

1. 用户发送消息 → spawn Claude 进程
2. 用户关闭浏览器 → 进程继续运行（detached）
3. 进程完成 → PID 监控检测到退出
4. 发送推送通知（PushPlus/Telegram/...）
5. 用户重新打开 → 自动同步完成的回复

### 进程日志

日志文件 `logs/process.log`（JSONL 格式，自动轮转 2MB），记录完整的进程生命周期：

| 事件 | 说明 |
|------|------|
| `process_spawn` | 进程创建（PID、模式、模型） |
| `process_complete` | 进程完成（退出码、耗时、费用） |
| `ws_connect` / `ws_disconnect` | 客户端连接/断开 |
| `ws_resume_attach` | 客户端重连并挂载到运行中的进程 |
| `recovery_alive` / `recovery_dead` | 服务重启时恢复进程 |
| `heartbeat` | 每 60 秒活跃进程状态快照 |

查看日志：
```bash
tail -f logs/process.log | jq .
```

## 生产部署

### systemd 服务

创建 `/etc/systemd/system/cc-web.service`：

```ini
[Unit]
Description=CC-Web - Claude Code Web Chat UI
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/cc-web
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
# 重要：只杀 Node.js 进程，不杀 Claude 子进程
KillMode=process

[Install]
WantedBy=multi-user.target
```

> **`KillMode=process` 非常重要**：确保 systemd 重启服务时只杀 Node.js 进程，Claude 子进程继续运行，服务恢复后自动重新挂载。

```bash
sudo systemctl enable cc-web
sudo systemctl start cc-web
```

### Nginx 反向代理

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8002;
        proxy_http_version 1.1;

        # WebSocket 支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # 长连接超时（Claude 任务可能运行较久）
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

### Windows 部署

适用于在个人电脑上运行 CC-Web，通过手机远程控制 Claude Code。

**启动方式**：双击 `start.bat`，或在终端运行：
```cmd
cd cc-web
npm install
node server.js
```

**局域网访问**（手机和电脑在同一 WiFi）：
- 直接访问 `http://电脑局域网IP:8002`

**远程访问**（外出时用手机控制家里电脑）：
- 推荐使用 [Tailscale](https://tailscale.com/) — 电脑和手机各安装一个，自动组网，免费够用
- 或使用 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)（需域名）


## 更新记录

查看 [CHANGELOG.md](./CHANGELOG.md)

## 致谢

- 本项目得到 [@carroxaitech](https://github.com/carroxaitech)、[@YoungHong1992](https://github.com/YoungHong1992)的悉心指导，得到[@123aliez](https://github.com/123aliez)的算力支持，[@lytxsy](https://github.com/lytxsy)的深度测试，受益良多
- 项目亦得到[linux.do](https://linux.do)启发
