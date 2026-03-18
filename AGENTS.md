# AGENTS.md

## Purpose

CC-Web is a minimal Node.js web shell for running local Claude Code and Codex CLI sessions from a browser. The backend serves static files, exposes a small attachment API, manages detached agent subprocesses, persists session state on disk, and streams runtime events over WebSocket.

## Key Entry Points

- `server.js`: main server, auth, WebSocket protocol, attachment API, session persistence, process recovery, notifications.
- `lib/agent-runtime.js`: Claude/Codex spawn specs and runtime event parsing.
- `lib/codex-rollouts.js`: imports local Codex rollout history into cc-web sessions.
- `public/index.html`: UI shell.
- `public/app.js`: frontend behavior and WebSocket client.
- `public/style.css`: UI themes/styles.
- `scripts/regression.js`: isolated end-to-end regression harness using mock Claude/Codex CLIs.
- `scripts/mock-claude.js`, `scripts/mock-codex.js`: fake CLIs used only by regression tests.

## Run And Check

```bash
npm start                    # starts node server.js
node server.js              # direct start, default 127.0.0.1:8002
npm run regression          # isolated regression test with mock CLIs
node --check server.js
node --check public/app.js
```

Notes:

- `package.json` only defines `start` and `regression`.
- There is no frontend build step.
- In this workspace, `.env.example` and `.gitignore` are not present even though README mentions them.

## Runtime Files And Config

- `.env`: optional local overrides; parsed manually by `server.js`.
- `config/`: runtime config such as `auth.json`, `notify.json`, `model.json`, `codex.json`, `banned_ips.json`, plus Codex runtime-home data.
- `sessions/*.json`: persisted chat sessions.
- `sessions/*-run/`: active run directories with pid/output files; these may survive server restarts.
- `sessions/_attachments/`: uploaded image attachments, cleaned by TTL.
- `logs/process.log`: JSONL lifecycle log with simple rotation.

Useful env vars from code:

- `PORT`
- `CLAUDE_PATH`
- `CODEX_PATH`
- `CC_WEB_CONFIG_DIR`
- `CC_WEB_SESSIONS_DIR`
- `CC_WEB_PUBLIC_DIR`
- `CC_WEB_LOGS_DIR`
- `CC_WEB_IP_WHITELIST`

## Important Workflows

- Startup binds only to `127.0.0.1`. Reverse proxy/Tailscale exposure is external to this repo.
- Auth is password-or-token over WebSocket. Failed auth bans non-whitelisted IPs after 3 attempts in 5 minutes.
- New messages spawn detached Claude or Codex subprocesses. Output is written to `sessions/<id>-run/output.jsonl` and tailed back to the UI.
- `recoverProcesses()` reattaches to still-running detached processes on server restart and finalizes completed runs from leftover run directories.
- Claude sessions resume via stored `claudeSessionId`; Codex resumes via stored runtime/thread state.
- Attachments are uploaded over `POST /api/attachments`; only PNG/JPEG/WEBP/GIF are accepted, max 10 MB each, max 4 per message.
- Native history import exists for both Claude and Codex. Codex import/delete paths depend on local Codex rollout files and sqlite state.

## Repo-Specific Safety Constraints

- Treat `config/`, `sessions/`, `logs/`, `.env`, and any tokens/passwords as sensitive local state. Do not commit secrets or runtime artifacts.
- Be careful with detached child processes. Avoid deleting `sessions/*-run/`, PID files, or killing agent processes unless the task explicitly requires it.
- Prefer facts from code over README. The README is broader and partially out of sync with the checked-out workspace.
- When changing WebSocket message types or session JSON shape, verify both `server.js` and `public/app.js`.
- When changing Claude/Codex spawn behavior, verify `lib/agent-runtime.js` and run `npm run regression`.
- Codex cleanup/import code assumes local `sqlite3` is available in some flows; do not add features that silently require more tooling without documenting it.
