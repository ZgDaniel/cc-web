# CC-Web

A lightweight web interface for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI, so you can run and monitor workflows directly from a browser.

![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)

## Screenshots

<p align="center">
  <img src="https://github.com/user-attachments/assets/ae974fcd-b6a7-4bdf-8553-bfcf2e7038a4" alt="Screenshot 1" width="30%" />
  <img src="https://github.com/user-attachments/assets/eb0291c1-2b38-4379-9a07-8eecc6c87d8f" alt="Screenshot 2" width="30%" />
  <img src="https://github.com/user-attachments/assets/09cec007-a949-44cf-9f2a-88c1eda60082" alt="Screenshot 3" width="30%" />
</p>

## Features

- **Lightweight runtime**: low backend overhead, browser-based control panel.
- **Multi-session management**: create, switch, rename, and delete sessions with automatic history persistence.
- **Session resume**: context continuity via `--resume`; you can also reattach via SSH + tmux when needed.
- **Background task support**: Claude processes continue after browser disconnect and notify you on completion.
- **Multi-channel notifications**: PushPlus / Telegram / ServerChan / Feishu bot / QQ (Qmsg), configurable in Web UI.
- **Process persistence**: detached subprocess + PID files; running tasks survive service restarts.
- **Mobile friendly**: responsive layout with PWA notifications.
- **Password-based auth**: initial password generation, forced first-login reset, and password change in Web UI.

## Requirements

- **Node.js** >= 18
- **Claude Code CLI** installed and configured (`claude` command available)

```bash
npm install -g @anthropic-ai/claude-code
```

## Quick Start

### Linux / macOS

```bash
git clone https://github.com/ZgDaniel/cc-web.git
cd cc-web
npm install
cp .env.example .env    # optional; if omitted, an initial password is auto-generated
npm start
```

### Windows

```cmd
git clone https://github.com/ZgDaniel/cc-web.git
cd cc-web
npm install
copy .env.example .env  & REM optional
```

Then run `start.bat`, or start manually with `node server.js`.

After startup, open `http://localhost:8002` and sign in with your password.

## Configuration

### Environment Variables (.env)

| Variable | Required | Default | Description |
|------|:---:|--------|------|
| `CC_WEB_PASSWORD` | No | Auto-generated | Web login password (migrated into `config/auth.json` on first start) |
| `PORT` | No | `8002` | Service port |
| `CLAUDE_PATH` | No | `claude` | Executable path to Claude CLI |
| `PUSHPLUS_TOKEN` | No | - | PushPlus token (migrated into notification config on first start) |

### Notification Configuration

Open the **Settings (⚙)** button in the sidebar to configure notifications in Web UI.

| Channel | Required Fields | How to Get |
|---------|---------|---------|
| **PushPlus** | Token | Register at [pushplus.plus](https://www.pushplus.plus/) |
| **Telegram** | Bot Token + Chat ID | Create bot via [@BotFather](https://t.me/BotFather) |
| **ServerChan** | SendKey | Register at [sct.ftqq.com](https://sct.ftqq.com/) |
| **Feishu Bot** | Webhook URL | Feishu group → Settings → Group Bot |
| **QQ (Qmsg)** | Qmsg Key | Obtain from [qmsg.zendee.cn](https://qmsg.zendee.cn/) |

Settings are stored in `config/notify.json`. Tokens are masked in UI display.

### Password Management

Passwords are stored in `config/auth.json` and support generation + UI updates:

- **First startup** (no password in `.env` and no `auth.json`): auto-generates a random 12-character password, prints it to console, and requires password reset on first login.
- **Migration from `.env`**: if `CC_WEB_PASSWORD` is already set, it is migrated to `auth.json` automatically at startup.
- **Change password in UI**: Settings panel → Change Password (requires current password).
- **Password policy**: at least 8 characters, with at least 2 of these categories: uppercase, lowercase, number, special character.
- **After password change**: all existing logged-in sessions are invalidated.

## Project Structure

```text
cc-web/
├── server.js              # Node.js backend (HTTP + WebSocket + process management + notifications)
├── public/
│   ├── index.html          # UI structure
│   ├── app.js              # Frontend logic (WebSocket, UI interactions)
│   ├── style.css           # Styles
│   └── sw.js               # Service Worker (mobile notifications)
├── config/
│   ├── notify.json         # Notification channel config (generated at runtime)
│   └── auth.json           # Auth config (generated at runtime)
├── sessions/               # Chat history JSON files (generated at runtime)
├── logs/                   # Process lifecycle logs (generated at runtime)
├── .env.example            # Environment variable template
├── start.bat               # Windows startup script
├── .gitignore
├── package.json
└── README.md
```

## Architecture

### Process Model

```text
Browser ←WebSocket→ Node.js (server.js) ←file I/O→ Claude CLI (detached)
```

- Each user message spawns a `claude -p --output-format stream-json` subprocess.
- Subprocesses use `detached: true` + `proc.unref()` and run independently from Node.js lifecycle.
- stdin/stdout/stderr are bridged via files in `sessions/{id}-run/`.
- PID is persisted to disk and recovered after service restart (`recoverProcesses()`).
- `FileTailer` streams file updates to frontend in real time.

### Background Task Flow

1. User sends a message → spawn Claude subprocess.
2. User closes browser → subprocess keeps running.
3. Process completes → PID monitor detects exit.
4. Completion notification is sent.
5. User reconnects → completed response is synced.

### Process Logs

`logs/process.log` uses JSONL format with automatic 2MB rotation.

| Event | Description |
|------|------|
| `process_spawn` | Process created (PID, mode, model) |
| `process_complete` | Process finished (exit code, duration, cost) |
| `ws_connect` / `ws_disconnect` | Client connected/disconnected |
| `ws_resume_attach` | Client reconnected to running process |
| `recovery_alive` / `recovery_dead` | Process recovery during service restart |
| `heartbeat` | Active process snapshot every 60 seconds |

View logs:

```bash
tail -f logs/process.log | jq .
```

## Production Deployment

### systemd Service

Create `/etc/systemd/system/cc-web.service`:

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
# Important: only stop Node.js process, not Claude child processes
KillMode=process

[Install]
WantedBy=multi-user.target
```

`KillMode=process` is important. It ensures systemd restart only stops Node.js, while Claude subprocesses continue and are reattached after recovery.

```bash
sudo systemctl enable cc-web
sudo systemctl start cc-web
```

### Nginx Reverse Proxy

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8002;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # Long-running tasks may take time
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

### Windows Deployment

Use this mode when running CC-Web on a personal PC and controlling Claude Code from mobile.

Start with `start.bat`, or run manually:

```cmd
cd cc-web
npm install
node server.js
```

**LAN access** (same Wi-Fi):
- Open `http://<your-lan-ip>:8002`

**Remote access**:
- Recommended: [Tailscale](https://tailscale.com/) for secure private networking.
- Alternative: [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (requires domain setup).

## Release Notes

- **v1.2.2**
  - Aligned context compression with Claude Code native behavior: `/compact` is now actually sent to CLI instead of doing a local pseudo-reset.
  - Added automatic overflow recovery: when `Request too large (max 20MB)` occurs, CC-Web runs `/compact` and replays the failed prompt automatically.
  - Added retry guard: if context is still too large after compacting, CC-Web stops auto-retry and asks for a narrower prompt range.
- **v1.2.1**
  - Fixed missing `AskUserQuestion` options in Web UI by preserving structured tool input in backend and rendering question/option cards on frontend.
  - Added option-to-input shortcut: click an option to append it into the input box for quick confirmation.
- **v1.2**
  - Fixed layout overflow caused by long code blocks in messages. The page no longer stretches horizontally; code blocks scroll within the block.
  - Improved mobile input behavior: Enter inserts newline by default, and sending is done via the send button.
- **v1.1**
  - Added compatibility improvements for Claude Code CLI on Windows.

## Notes

- This project currently targets Claude Code only.