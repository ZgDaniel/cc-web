# 更新记录

## v1.4.0

### 安全加固（5 大目标）

- **鉴权系统现代化**：密码改 scrypt 哈希（`N=16384 r=8 p=1`）+ 16 字节随机 salt；token 改 sha256 指纹存储（绝不落盘原始值），新增 24h 滑动续期 + 7 天绝对过期；改密走 `revokeAllTokens` 原子封装（先空 `tokens.json` → 再写 hash → 签新 token），任意点崩溃都不会出现「密码已改但旧 token 仍可用」
- **改密踢下线**：A 标签页改密后，B 标签页等所有其他已认证 WS 连接立即被关闭（前置 `_ccwebAuthed=false` 防 close race），旧 token 失效，旧 WS 重连时被踢回登录页
- **聊天内容 XSS 纵深防御**：marked 解析 → **DOMPurify sanitize**（fail-closed：未加载时降级 `<pre>escape</pre>`）→ decorateCodeBlocks 用 DOM API 注入 Copy/Preview 受信任 UI；兜底为统一 CSP 响应头（禁止 `unsafe-inline`、`object-src 'none'`、仅允许 cdnjs CDN）
- **客户端 IP 解析加固**：默认**完全不信任** `X-Forwarded-For`（防 XFF 伪造绕过 IP 封禁）；新增 `CC_WEB_TRUSTED_PROXIES` 环境变量，配置后启用「XFF 链 + socket，从右往左跳过可信代理」标准算法；非法 IP token 污染整条 XFF 链时整体丢弃回退 socket
- **HTTP `/api/*` 前置封禁**：被封 IP 调用 API 直接返回 403，不消耗 token 验证算力
- **长期健壮性**：所有 session / config 落盘改走 `atomicWriteJson`（tmp + rename），含密钥的 `dev.json` / `codex.json` / `notify.json` / `auth.json` / `tokens.json` 强制 `0600`；中断按钮改用 `kill(-pid)` 杀**整个进程组**，避免孙子进程变孤儿继续烧 token

### 体验改进

- **WS 重连不打断阅读**：前端 `hasInitialAuthCompleted` 区分「首次鉴权成功」与「重连鉴权成功」，重连不再触发会话列表/历史重载，保留用户当前滚动位置与正在浏览的旧消息

### 文档

- 新增 `docs/ARCHITECTURE.md` 「安全防御层」（8 层纵深防御表 + 兜底）与「前端渲染管线」（marked → DOMPurify → decorateCodeBlocks 流程图）
- 新增 `docs/RUNTIME.md` 「原子写」「中断进程组」「WebSocket 重连与改密踢下线」三节
- 新增 `docs/PROTOCOL.md` 「HTTP 响应头」「/api/* 前置封禁」「客户端 IP 解析」「鉴权握手细节」四节
- 新增 `docs/CONFIG.md` 「客户端 IP 解析（防 X-Forwarded-For 伪造）」整节
- 更新 `README.md` / `README.en.md`：Nginx 反代示例补 `X-Forwarded-For $remote_addr` 清洗行 + `CC_WEB_TRUSTED_PROXIES` 配置说明

### 测试

- `scripts/regression.js` 新增 7 项独立断言模块：改密原子失效集成、token 迁移单元、CSP + DOMPurify + 无内联 onclick、WS 重连不重渲染、原子写 + 进程组 kill + 旧 token 拒绝、XFF 纯函数 8 case、IP 封禁 trusted_proxies 场景

## v1.3.1

### 新增

- Codex 模型配置：支持通过配置动态管理可选模型
- 浏览器标签页：新增站点 favicon

### 修复

- 修复长时间运行服务中的内存泄漏风险
- 修复新建会话时本地目录输入与选择状态不同步的问题
- 修复 Claude 认证 token 处理异常的问题

## v1.3.0

### 新增

- 开发者配置：新增 SSH 主机管理（支持密钥/密码认证），新增 /ssh 命令便捷连接远程主机
- 开发者配置：新增 GitHub Token 与仓库管理，新增 /github 命令快速提交仓库
- 设置面板：统一 Claude 与 Codex API 配置到同一面板
- 设置面板：新增"本地配置"模板化机制，支持读取/快照/恢复本地 API 配置
- 新建会话：新增"本地任务/远程任务"选择，支持固定目录和 SSH 远程主机

## v1.2.12

### 修复

- 修复 Claude opus/sonnet 会话在切换自定义 API 模板后因模型名 `[1m]` 后缀不匹配导致 403 报错的问题
- 修复编辑模板模型名或删除模板后，已有会话的模型名无法正确重映射的问题

## v1.2.11

### 改进

- Claude 默认设置为 1M 上下文（opus / sonnet 自动使用 `[1m]` 模型，haiku 保持不变）

## v1.2.10

### 改进

- 实现与原生 claude code / codex cli 一致的 `/init` 功能

## v1.2.9

### 新功能

- **通知 AI 摘要** — 任务完成时调用 Claude API 生成摘要内容推送，支持正常完成/异常/上下文压缩等多种情况分类，摘要 API 凭证可独立配置或复用活跃 Claude 模板/Codex Profile，各渠道按字符限制自动截断，摘要失败时降级为原始信息
- **通知配置收进二级菜单** — Claude 和 Codex 设置面板中的通知区域改为 nav-card 入口，点击进入独立子页，与主题设置风格统一

## v1.2.8

### 新功能

- **Codex 双 Agent** — 新建会话时可选 Claude 或 Codex，共享后端内核，侧边栏按 Agent 隔离
- **图片上传** — 拖拽 / 粘贴 / 附件按钮上传图片，客户端自动压缩，单条消息最多 4 张
- **主题系统** — 新增 CoolVibe Light 等多套主题，设置中一键切换
- **Codex 本地历史导入** — 导入 `~/.codex/sessions/` 下的会话历史
- **隔离式回归脚本** — `npm run regression` 使用 mock CLI 在临时目录中校验主路径

### 改进

- 会话加载增加遮罩与热缓存，减少切换卡顿
- 移动端侧栏支持右滑唤起 / 左滑关闭
- 后端 spawn 与事件解析拆分为独立模块

### 修复

- 切后台再切回时运行中内容短暂消失
- 移动端附件按钮、新会话按钮比例失调

## v1.2.7

- 导入本地 CLI 会话（`~/.claude/projects/`），可续接历史对话
- 新建会话时指定工作目录
- 设置面板新增「检查更新」

## v1.2.6

- 工具调用超过 5 个时自动折叠
- 模板编辑弹窗支持拉取上游模型列表
- AskUserQuestion 选项预览区
- 自定义滚动条，会话历史分批渲染
- 修复配置文件写入竞争导致的随机 401
- 修复流式输出与工具调用 UI 共存时的覆盖问题
- 删除会话时同步清除本地 CLI 历史

## v1.2.3

- 模型配置系统：local / custom 两种模式，支持多 API 模板切换

## v1.2.2

- `/compact` 对齐 Claude Code 原生压缩策略
- 上下文超限时自动压缩并重放失败请求

## v1.2.1

- 修复 AskUserQuestion 交互选项不显示的问题
- 点击选项快捷填充到输入框

## v1.2

- 修复长代码块导致页面横向溢出
- 移动端回车改为换行，发送改为按钮触发

## v1.1

- Windows 环境兼容支持
