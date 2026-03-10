# CC-Web

Claude Code Web Chat UI - 轻量级 Web 聊天界面，通过 WebSocket 与 Claude Code CLI 交互。

## 目录与发布约定

- 开发与运行目录固定为：`/home/cc-dan/cc/cc-web`
- 当前提交 GitHub 的脱敏目录为：`/home/cc-dan/cc/cc-web_v1.2.2`
- 脱敏目录命名规则：`/home/cc-dan/cc/cc-web_v<主版本>.<次版本>.<修订版本>`
- 版本发布时，必须保持以下信息一致：
  1. 脱敏目录实际名称（如 `cc-web_v1.2.2`）
  2. 本文件中的“当前提交 GitHub 的脱敏目录”路径
  3. `/home/cc-dan/cc/项目清单.md` 中 CC-Web 的发布副本路径
  4. 脱敏目录 `README.md` 的“更新记录”版本号与说明
- 标准发布流程：
  1. 先在开发目录完成修改并验证
  2. 将变更同步到脱敏目录并完成脱敏处理
  3. 如版本升级，先重命名脱敏目录，再同步更新上述 4 处版本信息
  4. 在脱敏目录提交并上传 GitHub
- GitHub 鉴权使用用户提供的临时 token（有效期 30 天）；出于安全考虑，不在仓库文件中保存明文 token

## 架构

- `server.js`: Node.js 后端 (HTTP 静态文件 + WebSocket + Claude 进程管理)
- `public/`: 前端 (原生 HTML/CSS/JS，无构建步骤)
- `sessions/`: JSON 格式对话历史 + 运行时 `-run` 目录
- `logs/process.log`: 进程生命周期日志

## 关键设计

- 每条消息 spawn `claude -p --output-format stream-json --verbose --dangerously-skip-permissions`
- 使用 `--resume SESSION_ID` 实现会话续接
- 用户输入通过 stdin 传入（防注入）
- spawn 时删除 CLAUDECODE 环境变量（避免嵌套检测）
- 密码认证 + token 会话
- **Detached 进程**: `detached: true` + `proc.unref()`，Claude 进程独立于 Node.js
- **文件 I/O**: stdin/stdout/stderr 走文件（`sessions/{id}-run/`），不走 pipe
- **PID 持久化**: PID 写入 `sessions/{id}-run/pid`，服务重启后通过 `recoverProcesses()` 恢复
- **systemd KillMode=process**: 服务重启只杀 Node.js，不杀 Claude 子进程

## 进程生命周期日志

日志文件: `logs/process.log`（JSONL 格式，自动轮转 2MB）

记录事件:
| 事件 | 说明 |
|------|------|
| `server_start` | 服务启动 |
| `ws_connect` / `ws_disconnect` | WebSocket 连接/断开，含影响的活跃进程列表 |
| `process_spawn` | 进程创建（PID、模式、模型、参数） |
| `process_exit_event` | 进程退出（exitCode、signal） |
| `process_complete` | 进程完成处理（含 wsConnected、wsDisconnectTime、disconnectToDeathGap、stderr 摘要） |
| `pid_monitor_detected_exit` | PID 监控发现进程已退出（服务重启后场景） |
| `user_abort` | 用户主动停止 |
| `process_spawn_fail` | 进程启动失败 |
| `recovery_start/alive/dead` | 启动时恢复进程 |
| `ws_resume_attach` | 客户端重连并挂载到运行中的进程 |
| `heartbeat` | 每 60 秒活跃进程状态快照 |

关键诊断字段（`process_complete` 事件）:
- `wsDisconnectTime`: WS 断开时间
- `disconnectToDeathGap`: WS 断开到进程结束的时间差
- `exitCode` / `signal`: 退出码和信号（0=正常，非0/SIGTERM/SIGKILL=异常）
- `stderr`: 错误日志末尾 500 字符

查看日志: `cat logs/process.log | jq .` 或 `tail -f logs/process.log | jq .`

## 端口

- 本地监听: 127.0.0.1:8002
- 外部访问: https://cc.02370237.xyz (Nginx 反向代理)

## 模型配置系统

配置文件: `config/model.json`

支持两种模式（通过设置面板切换）：

| 模式 | 说明 |
|------|------|
| `local` | 读取 `~/.claude.json` 中的 `env` 字段覆盖 MODEL_MAP（ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL） |
| `custom` | 使用命名模板，每个模板含 apiKey、apiBase、defaultModel、opusModel、sonnetModel、haikuModel |

关键实现：
- `MODEL_MAP` 改为 `let`，启动时调用 `applyModelConfig()` 应用配置
- `handleSaveModelConfig()` 保存后立即重新应用 MODEL_MAP
- API Key 脱敏：前4后4，中间 `****`
- 保存时若 API Key 含 `****` 则保留旧值（防止脱敏值覆盖真实密钥）
- WS 消息：`get_model_config` → `model_config`；`save_model_config` → `model_config` + `system_message`

## /compact 修复记录

`pendingCompactRetries` 新增 `reason` 字段（`'normal'` | `'auto'`），区分用户手动 `/compact` 与自动触发，避免补发重复提示消息。
