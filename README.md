# CC-Web

Claude Code 轻量级 Web 聊天界面 — 在浏览器中与 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 交互。

![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)

<p align="center">
  <img src="https://github.com/user-attachments/assets/ae974fcd-b6a7-4bdf-8553-bfcf2e7038a4" alt="截图1" width="30%" />
  <img src="https://github.com/user-attachments/assets/eb0291c1-2b38-4379-9a07-8eecc6c87d8f" alt="截图2" width="30%" />
  <img src="https://github.com/user-attachments/assets/09cec007-a949-44cf-9f2a-88c1eda60082" alt="截图3" width="30%" />
</p>


## 功能特性

- **实时对话** — WebSocket 流式传输，逐字显示 Claude 回复
- **工具调用折叠** — 自动折叠/展开 Claude 的工具调用过程，不干扰阅读
- **Markdown 渲染** — 完整的 Markdown + 代码高亮（highlight.js）
- **多会话管理** — 创建、切换、重命名、删除会话，自动保存历史
- **会话续接** — 基于 `--resume` 实现跨消息上下文保持
- **模型切换** — Opus / Sonnet / Haiku 随时切换
- **权限模式** — YOLO（全自动）/ Plan（确认后执行）/ Default（标准审批）
- **后台任务** — 关闭浏览器后 Claude 进程继续运行，完成后推送通知
- **多渠道通知** — 支持 PushPlus / Telegram / Server酱 / 飞书机器人 / QQ（Qmsg），Web UI 内可视化配置
- **进程持久化** — detached 进程 + PID 文件，服务重启不丢失运行中的任务
- **移动端适配** — 响应式布局，支持 PWA 通知
- **密码认证** — 自动生成初始密码、首次登录强制改密、Web UI 修改密码
- **斜杠指令** — `/clear` `/model` `/mode` `/cost` `/compact` `/help`

## 前提条件

- **Node.js** >= 18
- **Claude Code CLI** 已安装并配置（`claude` 命令可用）
  ```bash
  npm install -g @anthropic-ai/claude-code
  ```

## 快速开始

```bash
# 克隆项目
git clone https://github.com/your-username/cc-web.git
cd cc-web

# 安装依赖
npm install

# 创建配置文件（可选，不设密码则首次启动自动生成）
cp .env.example .env

# 启动
npm start
```

启动后访问 `http://localhost:8002`，输入密码即可使用。

## 配置

### 环境变量 (.env)

| 变量 | 必填 | 默认值 | 说明 |
|------|:---:|--------|------|
| `CC_WEB_PASSWORD` | 否 | 自动生成 | Web 登录密码（首次启动自动迁移到 `config/auth.json`） |
| `PORT` | 否 | `8002` | 服务监听端口 |
| `CLAUDE_PATH` | 否 | `claude` | Claude CLI 可执行文件路径 |
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
├── public/
│   ├── index.html          # 页面结构
│   ├── app.js              # 前端逻辑（WebSocket 通信、UI 交互）
│   ├── style.css           # 样式（和风暖色调主题）
│   └── sw.js               # Service Worker（移动端推送通知）
├── config/
│   ├── notify.json         # 通知渠道配置（运行时生成）
│   └── auth.json           # 密码配置（运行时生成）
├── sessions/               # 对话历史 JSON 文件（运行时生成）
├── logs/                   # 进程生命周期日志（运行时生成）
├── .env.example            # 环境变量模板
├── .gitignore
├── package.json
└── README.md
```

## 架构设计

### 进程模型

```
浏览器 ←WebSocket→ Node.js (server.js) ←文件I/O→ Claude CLI (detached)
```

- 每条用户消息 spawn 一个 `claude -p --output-format stream-json` 子进程
- 进程使用 `detached: true` + `proc.unref()`，独立于 Node.js 生命周期
- stdin/stdout/stderr 通过文件传递（`sessions/{id}-run/`），不使用 pipe
- PID 持久化到文件，服务重启后自动恢复（`recoverProcesses()`）
- 使用 `FileTailer` 实时监听输出文件变化，流式推送给前端

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

## 斜杠指令

在输入框中输入 `/` 可查看所有指令：

| 指令 | 说明 |
|------|------|
| `/clear` | 清除当前会话（含 Claude 上下文） |
| `/model [名称]` | 查看/切换模型（opus, sonnet, haiku） |
| `/mode [模式]` | 查看/切换权限模式（yolo, plan, default） |
| `/cost` | 查看当前会话累计费用 |
| `/compact` | 压缩上下文（重置 Claude 会话但保留聊天记录） |
| `/help` | 显示帮助 |

## 技术栈

- **后端**：Node.js + [ws](https://github.com/websockets/ws)（唯一依赖）
- **前端**：原生 HTML/CSS/JS，无构建步骤
- **CDN**：[marked.js](https://marked.js.org/)（Markdown）+ [highlight.js](https://highlightjs.org/)（代码高亮）
- **CLI**：[Claude Code](https://docs.anthropic.com/en/docs/claude-code)

## 许可证

MIT
