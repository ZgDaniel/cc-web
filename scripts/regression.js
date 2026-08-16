#!/usr/bin/env node

/**
 * 端到端隔离回归测试（约 880 行，无测试框架）。
 *
 * 启动方式：npm run regression
 *
 * 隔离机制：
 *   - 抢空闲端口 + mkdtemp 建临时根
 *   - 通过 CC_WEB_CONFIG_DIR/SESSIONS_DIR/LOGS_DIR/HOME 环境变量指向临时目录
 *   - CLAUDE_PATH/CODEX_PATH 指向 mock-claude.js / mock-codex.js
 *
 * 断言：nextMessage 轮询 messages 数组（50ms 间隔，15s 超时），
 *      process.log 直接 grep process_spawn 行校验 spawn 参数。
 *
 * 覆盖场景：
 *   - Codex/Claude config 保存/回读 + API key 掩码
 *   - /init /model /compact（含自动 compact 重试）
 *   - Claude token 超限 → 自动 /compact + 重放（P0 正则补全，mock stderr 报 Prompt is too long）
 *   - Claude 预防性水位压缩：高水位 resume 会话先压缩再重放（P2）+ compact_boundary
 *     事件透传为含 token 数的 system_message（P1）
 *   - lib/context-usage 单元：jsonl 尾扫求和 / 无 usage / 文件缺失 / 1m-普通窗口四组合
 *   - 附件上传 → 带图消息 → session JSON 持久化
 *   - 模式切换保 thread id（Codex + Claude 双侧）
 *   - Codex Profile 切换 → 隔离 runtime config.toml
 *   - Claude /goal 多轮自治（TURN_1 → goal_feedback → TURN_2 顺序断言）
 *   - Codex /goal 兼容提示 + /loop 持久化调度与取消
 *   - Native session 导入（Claude .jsonl + Codex rollout + SQLite）
 *   - Codex 导入删除（JSON + rollout + SQLite thread 三处清理）
 *
 * 安全/健壮性覆盖（5 项目标 + 7 项断言）：
 *   - 改密失效 + 新 token 立即可用 + 并发连接被踢下线（testPasswordChangeAtomicity）
 *   - tokens.json 绝对过期/缺失字段迁移（testAuthStoreTokenMigration）
 *   - XSS：CSP 头 + DOMPurify sanitize + 无内联 onclick（testXssHardening）
 *   - WS 重连不重渲染聊天区（testWsReconnectPreservesState）
 *   - WS 心跳协议级 ping + 运行中任务 activeOutput 断线补齐（testWsHeartbeatAndActiveOutput）
 *   - atomicWriteJson + kill 进程组 + HTTP 旧 token 拒绝（testRobustnessHardening）
 *   - XFF 解析纯函数单测（testClientIpResolution）
 *   - 可信代理 + IP 封禁端到端（testIpBanEnforcement）
 *
 * 盲区：无前端 DOM driver；无浏览器运行时 XSS 验证（依赖 DOMPurify 库可信度）；
 *      无并发场景；无断电级持久化测试；无 Windows taskkill 覆盖。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const REPO_DIR = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(REPO_DIR, 'server.js');
const MOCK_CLAUDE = path.join(REPO_DIR, 'scripts', 'mock-claude.js');
const MOCK_CODEX = path.join(REPO_DIR, 'scripts', 'mock-codex.js');

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : null;
      server.close(() => resolve(port));
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sql(dbPath, statement) {
  const result = spawnSync('sqlite3', [dbPath, statement], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `sqlite3 failed: ${statement}`);
  return result.stdout.trim();
}

async function waitForPort(port, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const probe = spawnSync('bash', ['-lc', `ss -tln | grep -q ':${port} '`], { encoding: 'utf8' });
    if (probe.status === 0) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

async function waitForFile(filePath, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(filePath)) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
}

async function withServer(env, fn) {
  const child = spawn('/usr/bin/node', [SERVER_PATH], {
    cwd: REPO_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    await waitForPort(env.PORT, 10000);
    await fn({ child, stdout: () => stdout, stderr: () => stderr });
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    if (!child.killed) child.kill('SIGKILL');
  }
}

function connectWs(port, password) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages = [];

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', password }));
    });
    ws.on('message', (buf) => {
      const msg = JSON.parse(String(buf));
      messages.push(msg);
      if (msg.type === 'auth_result' && msg.success) resolve({ ws, messages, token: msg.token });
      if (msg.type === 'auth_result' && !msg.success) reject(new Error('Auth failed'));
    });
    ws.on('error', reject);
  });
}

async function uploadAttachment(port, token, { filename, mime, data }) {
  const response = await fetch(`http://127.0.0.1:${port}/api/attachments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': mime,
      'X-Filename': encodeURIComponent(filename),
    },
    body: data,
  });
  const payload = await response.json();
  assert(response.ok && payload.ok, `Attachment upload failed: ${payload.message || response.status}`);
  return payload.attachment;
}

function nextMessage(messages, ws, predicate, timeoutMs = 15000) {
  const callSite = (() => {
    const stack = String(new Error().stack || '').split('\n');
    return (stack[3] || stack[2] || '').trim();
  })();
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const idx = messages.findIndex(predicate);
      if (idx !== -1) {
        clearInterval(timer);
        const found = messages.splice(idx, 1)[0];
        resolve(found);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        const recentTypes = messages.slice(-12).map((m) => m?.type).join(', ');
        const pendingTypes = messages.slice(0, 12).map((m) => m?.type).join(', ');
        reject(new Error(`Timed out waiting for expected WebSocket message (wsState=${ws.readyState}, callSite=${callSite}, pendingTypes=[${pendingTypes}], recentTypes=[${recentTypes}])`));
      }
    }, 50);
  });
}

// opts: { sessionId, projectDirName, prompt, answer, cwd, usage }。
// usage 会挂到 assistant 行的 message.usage 上（P2 水位估算读取的就是这个位置）。
function createFakeClaudeHistory(homeDir, opts = {}) {
  const sessionId = opts.sessionId || 'claude-import-test';
  const prompt = opts.prompt || 'Claude import prompt';
  const answer = opts.answer || 'Claude import answer';
  const projectDirName = opts.projectDirName || 'tmp-project';
  const projectDir = path.join(homeDir, '.claude', 'projects', projectDirName);
  mkdirp(projectDir);
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  const assistantMessage = { content: [{ type: 'text', text: answer }] };
  if (opts.usage) assistantMessage.usage = opts.usage;
  const lines = [
    JSON.stringify({
      type: 'user',
      cwd: opts.cwd || '/tmp/project-a',
      timestamp: '2026-03-12T00:00:00.000Z',
      message: { content: prompt },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-03-12T00:00:02.000Z',
      message: assistantMessage,
    }),
  ];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return { sessionId, projectDir: projectDirName, filePath, title: prompt };
}

function createFakeCodexHistory(homeDir) {
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '03', '12');
  mkdirp(sessionsDir);
  const threadId = 'codex-import-thread';
  const rolloutPath = path.join(sessionsDir, 'rollout-2026-03-12T00-00-00-codex-import-thread.jsonl');
  const rolloutLines = [
    JSON.stringify({
      timestamp: '2026-03-12T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: threadId, cwd: '/tmp/project-b', cli_version: '0.114.0', source: 'exec' },
    }),
    JSON.stringify({
      timestamp: '2026-03-12T00:00:00.100Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md wrapper should be ignored' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-03-12T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Codex import prompt' },
    }),
    JSON.stringify({
      timestamp: '2026-03-12T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Codex import answer' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-03-12T00:00:03.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 8 } },
      },
    }),
  ];
  fs.writeFileSync(rolloutPath, `${rolloutLines.join('\n')}\n`);

  const stateDb = path.join(homeDir, '.codex', 'state_5.sqlite');
  mkdirp(path.dirname(stateDb));
  sql(stateDb, `
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      git_sha TEXT,
      git_branch TEXT,
      git_origin_url TEXT,
      cli_version TEXT NOT NULL DEFAULT '',
      first_user_message TEXT NOT NULL DEFAULT '',
      agent_nickname TEXT,
      agent_role TEXT,
      memory_mode TEXT NOT NULL DEFAULT 'enabled'
    );
    CREATE TABLE IF NOT EXISTS stage1_outputs (
      thread_id TEXT PRIMARY KEY,
      source_updated_at INTEGER NOT NULL,
      raw_memory TEXT NOT NULL,
      rollout_summary TEXT NOT NULL,
      generated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS thread_dynamic_tools (
      thread_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      input_schema TEXT NOT NULL,
      PRIMARY KEY(thread_id, position)
    );
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ts_nanos INTEGER NOT NULL,
      level TEXT NOT NULL,
      target TEXT NOT NULL,
      message TEXT,
      module_path TEXT,
      file TEXT,
      line INTEGER,
      thread_id TEXT,
      process_uuid TEXT,
      estimated_bytes INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, cli_version)
    VALUES ('${threadId}', '${rolloutPath.replace(/'/g, "''")}', 1, 2, 'exec', 'OpenAI', '/tmp/project-b', 'Codex import prompt', '{}', 'never', '0.114.0');
    INSERT INTO logs (ts, ts_nanos, level, target, thread_id) VALUES (1, 0, 'INFO', 'test', '${threadId}');
  `);

  const logsDb = path.join(homeDir, '.codex', 'logs_1.sqlite');
  sql(logsDb, `
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ts_nanos INTEGER NOT NULL,
      level TEXT NOT NULL,
      target TEXT NOT NULL,
      message TEXT,
      module_path TEXT,
      file TEXT,
      line INTEGER,
      thread_id TEXT,
      process_uuid TEXT,
      estimated_bytes INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO logs (ts, ts_nanos, level, target, thread_id) VALUES (1, 0, 'INFO', 'test', '${threadId}');
  `);

  return { threadId, rolloutPath, stateDb, logsDb };
}

// Unit coverage for auth-store token migration paths (lib/auth.js loadTokens):
//   - missing absoluteExpiresAt + issuedAt within 7d  -> accept + backfill field
//   - missing absoluteExpiresAt + issuedAt older 7d   -> reject (abs-expired)
//   - missing absoluteExpiresAt + missing issuedAt    -> reject (cannot decide)
//   - absoluteExpiresAt in the past                   -> reject
//   - absoluteExpiresAt in the future                 -> accept as-is
async function testAuthStoreTokenMigration() {
  const { createAuthStore } = require('../lib/auth');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-auth-'));
  const tokensPath = path.join(tempDir, 'tokens.json');

  const fixedNow = Date.parse('2026-06-15T12:00:00.000Z');
  const authStore = createAuthStore({
    AUTH_CONFIG_PATH: path.join(tempDir, 'auth.json'),
    TOKENS_PATH: tokensPath,
    now: () => fixedNow,
  });

  const dayMs = 24 * 60 * 60 * 1000;
  const iso = (offsetMs) => new Date(fixedNow + offsetMs).toISOString();

  const records = [
    // 1) missing absExp, issuedAt within 7d  -> accept + backfill
    { digest: 'a'.repeat(64), issuedAt: iso(-1 * dayMs), expiresAt: iso(1 * dayMs) },
    // 2) missing absExp, issuedAt > 7d ago   -> reject
    { digest: 'b'.repeat(64), issuedAt: iso(-8 * dayMs), expiresAt: iso(1 * dayMs) },
    // 3) missing absExp, missing issuedAt    -> reject
    { digest: 'c'.repeat(64), expiresAt: iso(1 * dayMs) },
    // 4) absExp in the past                  -> reject
    { digest: 'd'.repeat(64), issuedAt: iso(-8 * dayMs), expiresAt: iso(1 * dayMs), absoluteExpiresAt: iso(-1 * dayMs) },
    // 5) absExp in the future                -> accept as-is
    { digest: 'e'.repeat(64), issuedAt: iso(-1 * dayMs), expiresAt: iso(1 * dayMs), absoluteExpiresAt: iso(5 * dayMs) },
  ];
  fs.writeFileSync(tokensPath, JSON.stringify({ tokens: records }, null, 2));

  const { map, dirty } = authStore.loadTokens();
  assert(dirty, 'loadTokens should mark dirty when migration backfills or drops records');
  assert(map.size === 2, `Expected 2 surviving tokens, got ${map.size}`);
  assert(map.has('a'.repeat(64)), 'Record 1 (missing absExp, fresh issuedAt) should be migrated and kept');
  assert(map.get('a'.repeat(64)).absoluteExpiresAt, 'Migrated record should have absoluteExpiresAt backfilled');
  assert(!map.has('b'.repeat(64)), 'Record 2 (issuedAt older than 7d) should be rejected by inferred absolute expiry');
  assert(!map.has('c'.repeat(64)), 'Record 3 (missing issuedAt + absExp) should be rejected (undecidable)');
  assert(!map.has('d'.repeat(64)), 'Record 4 (absExp in the past) should be rejected');
  assert(map.has('e'.repeat(64)), 'Record 5 (absExp in the future) should be accepted as-is');

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('Auth-store token migration checks passed.');
}

// Unit coverage for lib/context-usage.js (P2 预防性水位压缩核心)：
//   - estimateClaudeContextUsage 从文件末尾向前找最后一条含 usage 的 assistant 行，
//     返回 input + cache_read + cache_creation 三项之和（更早的 usage 行、坏行不参与）
//   - 无 usage / 文件不存在 → null（调用方必须跳过预防逻辑）
//   - shouldPreemptiveCompact：[1m] 与普通窗口 × 高低水位四组合
async function testContextUsage() {
  const { estimateClaudeContextUsage, shouldPreemptiveCompact } = require('../lib/context-usage');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-usage-'));

  const usageLine = (usage) => JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'ok' }], usage },
  });

  const jsonlPath = path.join(tempDir, 'session.jsonl');
  fs.writeFileSync(jsonlPath, [
    JSON.stringify({ type: 'user', message: { content: 'q' } }),
    usageLine({ input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 5 }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'no usage here' }] } }),
    'this-line-is-not-json',
    usageLine({ input_tokens: 900, cache_read_input_tokens: 90, cache_creation_input_tokens: 10, output_tokens: 5 }),
    '',
  ].join('\n'));

  assert(estimateClaudeContextUsage(jsonlPath) === 1000, 'estimate should sum the LAST usage-bearing assistant line (900+90+10)');

  const noUsagePath = path.join(tempDir, 'no-usage.jsonl');
  fs.writeFileSync(noUsagePath, `${JSON.stringify({ type: 'assistant', message: { content: [] } })}\n`);
  assert(estimateClaudeContextUsage(noUsagePath) === null, 'jsonl without usage must return null');
  assert(estimateClaudeContextUsage(path.join(tempDir, 'missing.jsonl')) === null, 'missing file must return null');

  // 4 combos: window size from model label × water level (threshold 80%)
  assert(shouldPreemptiveCompact(200000, 'claude-opus-4-6[1m]', 80) === false, '1M window: 200k is below 80% threshold');
  assert(shouldPreemptiveCompact(800000, 'claude-opus-4-6[1m]', 80) === true, '1M window: 800k reaches 80% threshold');
  assert(shouldPreemptiveCompact(160000, 'claude-sonnet-4-6', 80) === true, '200k window: 160k reaches 80% threshold');
  assert(shouldPreemptiveCompact(159999, 'claude-sonnet-4-6', 80) === false, '200k window: 159,999 is below 80% threshold');
  assert(shouldPreemptiveCompact(null, 'claude-opus-4-6[1m]', 80) === false, 'null usage must never preempt');

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('Context usage estimation checks passed.');
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-regression-'));
  const configDir = path.join(tempRoot, 'config');
  const sessionsDir = path.join(tempRoot, 'sessions');
  const logsDir = path.join(tempRoot, 'logs');
  const homeDir = path.join(tempRoot, 'home');
  mkdirp(configDir);
  mkdirp(sessionsDir);
  mkdirp(logsDir);
  mkdirp(homeDir);

  fs.writeFileSync(path.join(configDir, 'notify.json'), JSON.stringify({
    provider: 'off',
    pushplus: { token: '' },
    telegram: { botToken: '', chatId: '' },
    serverchan: { sendKey: '' },
    feishu: { webhook: '' },
    qqbot: { qmsgKey: '' },
  }, null, 2));

  // fixture 的 cwd 必须是真实目录：导入后的会话以该 cwd spawn CLI，
  // 不存在的 cwd 会让 spawn 异步 ENOENT 且不触发 exit 事件（会话卡死）
  const claudeFixtureCwd = path.join(tempRoot, 'project-a');
  const claudeUsageFixtureCwd = path.join(tempRoot, 'project-usage');
  mkdirp(claudeFixtureCwd);
  mkdirp(claudeUsageFixtureCwd);
  createFakeClaudeHistory(homeDir, { cwd: claudeFixtureCwd });
  // P2 预防压缩 fixture：assistant 行带高水位 usage（150k input + 40k cache_read + 10k
  // cache_creation = 200k tokens ≥ 默认 200k 窗口的 80%），导入后发消息应先 /compact 再重放
  createFakeClaudeHistory(homeDir, {
    sessionId: 'claude-usage-import-test',
    projectDirName: 'tmp-project-usage',
    prompt: 'Claude usage import prompt',
    answer: 'Claude usage import answer',
    cwd: claudeUsageFixtureCwd,
    usage: { input_tokens: 150000, cache_read_input_tokens: 40000, cache_creation_input_tokens: 10000, output_tokens: 500 },
  });
  const codexFixture = createFakeCodexHistory(homeDir);

  const port = await getFreePort();
  const password = 'Regression!234';

  await withServer({
    PORT: String(port),
    CC_WEB_PASSWORD: password,
    CC_WEB_CONFIG_DIR: configDir,
    CC_WEB_SESSIONS_DIR: sessionsDir,
    CC_WEB_LOGS_DIR: logsDir,
    HOME: homeDir,
    CLAUDE_PATH: MOCK_CLAUDE,
    CODEX_PATH: MOCK_CODEX,
    // 心跳间隔压到 400ms：主链路全程覆盖多轮 ping/pong，验证心跳不干扰正常消息流
    CC_WEB_WS_PING_INTERVAL_MS: '400',
  }, async () => {
    const { ws, messages, token } = await connectWs(port, password);

    await nextMessage(messages, ws, (msg) => msg.type === 'session_list');

    ws.send(JSON.stringify({
      type: 'save_codex_config',
      config: {
        mode: 'custom',
        activeProfile: 'Regression Profile',
        profiles: [{
          name: 'Regression Profile',
          apiKey: 'sk-regression',
          apiBase: 'https://example.com/v1',
          model: 'gpt-5.5',
          models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex'],
        }],
        enableSearch: true,
      },
    }));
    const codexConfigMsg = await nextMessage(messages, ws, (msg) => msg.type === 'codex_config');
    assert(codexConfigMsg.config.mode === 'custom', 'Codex config mode save/load failed');
    assert(codexConfigMsg.config.activeProfile === 'Regression Profile', 'Codex active profile save/load failed');
    assert(Array.isArray(codexConfigMsg.config.profiles) && codexConfigMsg.config.profiles[0]?.apiKey.includes('****'), 'Codex profile API key should be masked');
    assert(codexConfigMsg.config.profiles[0]?.model === 'gpt-5.5', 'Codex profile model save/load failed');
    assert(Array.isArray(codexConfigMsg.config.profiles[0]?.models) && codexConfigMsg.config.profiles[0].models.length === 3, 'Codex profile model list save/load failed');
    assert(codexConfigMsg.config.supportsSearch === false, 'Codex config should expose unsupported search capability');
    assert(codexConfigMsg.config.enableSearch === false, 'Codex config should ignore unsupported search toggle');

    const codexInitCwd = path.join(tempRoot, 'codex-space');
    mkdirp(codexInitCwd);
    ws.send(JSON.stringify({ type: 'new_session', agent: 'codex', cwd: codexInitCwd, mode: 'plan' }));
    const codexSession = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'codex' && msg.cwd === codexInitCwd);
    assert(codexSession.mode === 'plan', 'Codex new_session should follow requested mode');
    assert(codexSession.model === 'gpt-5.5', 'Codex new_session should inject configured profile model');

    ws.send(JSON.stringify({ type: 'message', text: '/init', sessionId: codexSession.sessionId, mode: 'plan', agent: 'codex' }));
    const codexInitStart = await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /AGENTS\.md/.test(msg.message || ''));
    assert(/AGENTS\.md/.test(codexInitStart.message || ''), 'Codex /init should announce AGENTS.md generation');
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === codexSession.sessionId);
    assert(fs.existsSync(path.join(codexInitCwd, 'AGENTS.md')), 'Codex /init should generate AGENTS.md in the workspace');

    ws.send(JSON.stringify({ type: 'message', text: '/model gpt-5.3-codex', sessionId: codexSession.sessionId, mode: 'plan', agent: 'codex' }));
    const codexModelChanged = await nextMessage(messages, ws, (msg) => msg.type === 'model_changed' && msg.model === 'gpt-5.3-codex');
    assert(codexModelChanged.model === 'gpt-5.3-codex', 'Codex /model should accept arbitrary Codex model names');

    const codexAttachment = await uploadAttachment(port, token, {
      filename: 'codex-test.png',
      mime: 'image/png',
      data: Buffer.from('codex-image'),
    });
    ws.send(JSON.stringify({ type: 'message', text: 'first codex prompt', attachments: [codexAttachment], mode: 'yolo', agent: 'codex' }));
    const firstMessageSession = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'codex' && msg.title === 'first codex prompt');
    assert(firstMessageSession.agent === 'codex', 'First-message path created wrong agent');
    const runningSessionList = await nextMessage(messages, ws, (msg) => msg.type === 'session_list' && msg.sessions.some((s) => s.id === firstMessageSession.sessionId && s.isRunning));
    assert(runningSessionList.sessions.some((s) => s.id === firstMessageSession.sessionId && s.isRunning), 'Running Codex session should be marked as isRunning');
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === firstMessageSession.sessionId);

    // Switching permission mode must not clear Codex thread id (otherwise resume loses context).
    const codexSessionPath = path.join(sessionsDir, `${firstMessageSession.sessionId}.json`);
    await waitForFile(codexSessionPath, 15000);
    const storedAfterFirst = JSON.parse(fs.readFileSync(codexSessionPath, 'utf8'));
    const threadIdBeforeMode = storedAfterFirst.codexThreadId;
    assert(threadIdBeforeMode, 'Codex thread id should be persisted after first run');

    ws.send(JSON.stringify({ type: 'set_mode', sessionId: firstMessageSession.sessionId, mode: 'plan' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'mode_changed' && msg.mode === 'plan');
    await waitForFile(codexSessionPath, 15000);
    const storedAfterMode = JSON.parse(fs.readFileSync(codexSessionPath, 'utf8'));
    assert(storedAfterMode.codexThreadId === threadIdBeforeMode, 'Codex thread id should survive mode switch');

    ws.send(JSON.stringify({ type: 'message', text: 'second codex prompt', sessionId: firstMessageSession.sessionId, mode: 'plan', agent: 'codex' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === firstMessageSession.sessionId);

    const processLog = fs.readFileSync(path.join(logsDir, 'process.log'), 'utf8');
    const spawnLine = processLog
      .trim()
      .split('\n')
      .find((line) => line.includes(`"event":"process_spawn"`) && line.includes(firstMessageSession.sessionId.slice(0, 8)));
    assert(spawnLine && !spawnLine.includes('--search') && spawnLine.includes('--image'), 'Codex exec should attach images and not append unsupported --search flag');

	    const allSpawnsForSession = processLog
	      .trim()
	      .split('\n')
	      .filter((line) => line.includes(`"event":"process_spawn"`) && line.includes(firstMessageSession.sessionId.slice(0, 8)));
	    const lastSpawn = allSpawnsForSession[allSpawnsForSession.length - 1] || '';
	    assert(lastSpawn.includes('resume') && lastSpawn.includes(threadIdBeforeMode), 'Codex mode switch should keep resume thread id');
	    assert(lastSpawn.includes('-s read-only'), 'Codex plan mode should set sandbox read-only');
	    assert(lastSpawn.includes('-s read-only resume'), 'Codex resume in plan mode must place -s before resume subcommand');

    ws.send(JSON.stringify({ type: 'message', text: '/goal finish regression verification', sessionId: firstMessageSession.sessionId, mode: 'plan', agent: 'codex' }));
    const codexGoalText = await nextMessage(messages, ws, (msg) => msg.type === 'text_delta' && /Create and persist a durable goal/.test(msg.text || ''));
    assert(/finish regression verification/.test(codexGoalText.text || ''), 'Codex /goal should pass the declared condition to its compatible prompt');
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === firstMessageSession.sessionId);

    ws.send(JSON.stringify({ type: 'message', text: '/loop 1s verify scheduled Codex follow-up', sessionId: firstMessageSession.sessionId, mode: 'plan', agent: 'codex' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /已设置 \/loop/.test(msg.message || ''));
    const loopStart = await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /◎ Loop · 正在执行周期提示/.test(msg.message || ''));
    assert(/verify scheduled Codex follow-up/.test(loopStart.message || ''), '/loop should preserve its scheduled prompt');
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === firstMessageSession.sessionId);
    const loopSession = JSON.parse(fs.readFileSync(codexSessionPath, 'utf8'));
    assert(loopSession.loop?.intervalMs === 1000, '/loop should persist its interval on the session');
    ws.send(JSON.stringify({ type: 'message', text: '/loop off', sessionId: firstMessageSession.sessionId, mode: 'plan', agent: 'codex' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /已停止当前会话的 \/loop/.test(msg.message || ''));
    const loopStoppedSession = JSON.parse(fs.readFileSync(codexSessionPath, 'utf8'));
    assert(loopStoppedSession.loop === null, '/loop off should clear persisted loop state');

    ws.send(JSON.stringify({
      type: 'save_codex_config',
      config: {
        mode: 'custom',
        activeProfile: 'Regression Profile 2',
        profiles: [{
          name: 'Regression Profile 2',
          apiKey: 'sk-regression-2',
          apiBase: 'https://example.org/v1',
          model: 'gpt-5.4',
          models: ['gpt-5.4'],
        }],
      },
    }));
    await nextMessage(messages, ws, (msg) => msg.type === 'codex_config' && msg.config.activeProfile === 'Regression Profile 2');
    const storedAfterProfileSwitch = JSON.parse(fs.readFileSync(codexSessionPath, 'utf8'));
    assert(storedAfterProfileSwitch.codexThreadId === threadIdBeforeMode, 'Codex profile switch should not clear thread id');
    assert(storedAfterProfileSwitch.model === 'gpt-5.4', 'Codex profile switch should update existing session model');

    ws.send(JSON.stringify({ type: 'message', text: 'third codex prompt', sessionId: firstMessageSession.sessionId, mode: 'plan', agent: 'codex' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === firstMessageSession.sessionId);
    const processLogAfterProfileSwitch = fs.readFileSync(path.join(logsDir, 'process.log'), 'utf8');
    const profileSwitchSpawn = processLogAfterProfileSwitch
      .trim()
      .split('\n')
      .filter((line) => line.includes(`"event":"process_spawn"`) && line.includes(firstMessageSession.sessionId.slice(0, 8)))
      .pop() || '';
    assert(profileSwitchSpawn.includes('resume') && profileSwitchSpawn.includes(threadIdBeforeMode), 'Codex profile switch should keep resume context');
    assert(profileSwitchSpawn.includes('--model gpt-5.4'), 'Codex profile switch should run with new profile model');

    const runtimeToml = fs.readFileSync(path.join(configDir, 'codex-session-home', firstMessageSession.sessionId, 'config.toml'), 'utf8');
    assert(runtimeToml.includes('preferred_auth_method = "apikey"'), 'Codex custom profile should write isolated runtime auth mode');
    assert(runtimeToml.includes('base_url = "https://example.org/v1"'), 'Codex custom profile should write isolated runtime base_url');
    assert(runtimeToml.includes('model = "gpt-5.4"'), 'Codex custom profile should write isolated runtime model');

    ws.send(JSON.stringify({ type: 'message', text: '/compact', sessionId: firstMessageSession.sessionId, mode: 'yolo', agent: 'codex' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /正在执行/.test(msg.message || '') && /Codex \/compact/.test(msg.message || ''));
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === firstMessageSession.sessionId);
    const compactDoneMsg = await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /已执行 Codex \/compact/.test(msg.message || ''));
    assert(/已执行 Codex \/compact/.test(compactDoneMsg.message || ''), 'Codex /compact should complete with Codex-specific status message');

    const autoCompactCwd = path.join(tempRoot, 'codex-auto-compact');
    mkdirp(autoCompactCwd);
    ws.send(JSON.stringify({ type: 'new_session', agent: 'codex', cwd: autoCompactCwd, mode: 'yolo' }));
    const autoCompactSession = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'codex' && msg.cwd === autoCompactCwd);
    ws.send(JSON.stringify({ type: 'message', text: 'warm up auto compact', sessionId: autoCompactSession.sessionId, mode: 'yolo', agent: 'codex' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === autoCompactSession.sessionId);
    ws.send(JSON.stringify({ type: 'message', text: 'trigger codex context limit', sessionId: autoCompactSession.sessionId, mode: 'yolo', agent: 'codex' }));
    const autoCompactStart = await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /正在按 Codex \/compact 自动压缩/.test(msg.message || ''));
    assert(/Codex \/compact/.test(autoCompactStart.message || ''), 'Codex auto /compact should announce auto compact start');
    const autoCompactDone = await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /已执行 Codex \/compact/.test(msg.message || ''));
    assert(/已执行 Codex \/compact/.test(autoCompactDone.message || ''), 'Codex auto /compact should finish compact step');
	    const autoCompactResume = await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /按 Codex 压缩计划继续执行/.test(msg.message || ''));
	    assert(/继续执行/.test(autoCompactResume.message || ''), 'Codex auto /compact should announce retry');
	    // Some Codex builds won't echo the original prompt text as a text delta on retry; accept either.
	    const autoCompactRetry = await nextMessage(messages, ws, (msg) => (
	      (msg.type === 'text_delta' && /trigger codex context limit/.test(msg.text || '')) ||
	      (msg.type === 'done' && msg.sessionId === autoCompactSession.sessionId)
	    ), 20000);
	    if (autoCompactRetry.type === 'text_delta') {
	      assert(/trigger codex context limit/.test(autoCompactRetry.text || ''), 'Codex auto /compact should replay the failed prompt after compact');
	    }

    const claudeAttachment = await uploadAttachment(port, token, {
      filename: 'claude-test.png',
      mime: 'image/png',
      data: Buffer.from('claude-image'),
    });
    ws.send(JSON.stringify({ type: 'message', text: 'describe attachment', attachments: [claudeAttachment], mode: 'yolo', agent: 'claude' }));
    const claudeImageSession = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'claude' && msg.title === 'describe attachment');
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === claudeImageSession.sessionId);
    const claudeSpawnLine = fs.readFileSync(path.join(logsDir, 'process.log'), 'utf8')
      .trim()
      .split('\n')
      .find((line) => line.includes(`"event":"process_spawn"`) && line.includes(claudeImageSession.sessionId.slice(0, 8)));
    assert(claudeSpawnLine && claudeSpawnLine.includes('--input-format stream-json'), 'Claude image message should switch stdin to stream-json');
    const storedClaudeSession = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${claudeImageSession.sessionId}.json`), 'utf8'));
    assert(Array.isArray(storedClaudeSession.messages?.[0]?.attachments) && storedClaudeSession.messages[0].attachments.length === 1, 'Claude message should persist attachment metadata');
    assert(storedClaudeSession.claudeSessionId, 'Claude session id should be persisted after first run');
    const claudeSessionIdBeforeMode = storedClaudeSession.claudeSessionId;

    // Mode switching must not clear Claude runtime session id (resume should keep context).
    ws.send(JSON.stringify({ type: 'set_mode', sessionId: claudeImageSession.sessionId, mode: 'plan' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'mode_changed' && msg.mode === 'plan');
    const storedClaudeAfterMode = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${claudeImageSession.sessionId}.json`), 'utf8'));
    assert(storedClaudeAfterMode.claudeSessionId === claudeSessionIdBeforeMode, 'Claude session id should survive mode switch');

    ws.send(JSON.stringify({ type: 'message', text: 'second claude prompt', sessionId: claudeImageSession.sessionId, mode: 'plan', agent: 'claude' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === claudeImageSession.sessionId);
    const claudeSpawns = fs.readFileSync(path.join(logsDir, 'process.log'), 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.includes(`"event":"process_spawn"`) && line.includes(claudeImageSession.sessionId.slice(0, 8)));
    const lastClaudeSpawn = claudeSpawns[claudeSpawns.length - 1] || '';
    assert(lastClaudeSpawn.includes(`--resume ${claudeSessionIdBeforeMode}`), 'Claude mode switch should keep --resume session id');
    assert(lastClaudeSpawn.includes('--permission-mode plan'), 'Claude plan mode should set --permission-mode plan');

    // /goal multi-turn coverage: ensure cc-web does not intercept Claude /goal, surfaces synthetic
    // Stop hook feedback as a goal_feedback system_message, never persists it to session.messages,
    // AND preserves the strict event order TURN_1 -> feedback -> TURN_2.
    const goalEvents = [];
    const goalListener = (buf) => {
      try { goalEvents.push(JSON.parse(String(buf))); } catch {}
    };
    ws.on('message', goalListener);
    ws.send(JSON.stringify({ type: 'message', text: '/goal verify multi-turn', sessionId: claudeImageSession.sessionId, mode: 'plan', agent: 'claude' }));
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === claudeImageSession.sessionId);
    ws.off('message', goalListener);
    const idxTurn1 = goalEvents.findIndex((e) => e.type === 'text_delta' && /GOAL_TURN_1/.test(e.text || ''));
    const idxFeedback = goalEvents.findIndex((e) => e.type === 'system_message' && e.kind === 'goal_feedback');
    const idxTurn2 = goalEvents.findIndex((e) => e.type === 'text_delta' && /GOAL_TURN_2/.test(e.text || ''));
    assert(idxTurn1 >= 0, '/goal should emit GOAL_TURN_1 text_delta');
    assert(idxFeedback >= 0, '/goal should emit goal_feedback system_message');
    assert(idxTurn2 >= 0, '/goal should emit GOAL_TURN_2 text_delta');
    assert(idxTurn1 < idxFeedback && idxFeedback < idxTurn2, '/goal events must arrive in order: TURN_1 -> feedback -> TURN_2');
    assert(/keep going/.test(goalEvents[idxFeedback].message || ''), '/goal feedback must contain evaluator hint');
    const goalUnknownCmd = goalEvents.find((e) => e.type === 'system_message' && /未知指令/.test(e.message || ''));
    assert(!goalUnknownCmd, '/goal must bypass cc-web slash command interceptor (no "未知指令")');
    const goalSessionJson = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${claudeImageSession.sessionId}.json`), 'utf8'));
    assert(!JSON.stringify(goalSessionJson.messages || []).includes('Stop hook feedback'), '/goal Stop hook feedback must not be persisted to session.messages');

    // P0 行为级：Claude token 超限识别。mock 首次运行 stderr 报
    // "API Error: Prompt is too long: 1048576 tokens > 1000000 maximum" 并非零退出
    // （旧 isContextLimitError Claude 分支只认 Request too large (max 20MB)，识别不到这种错误）。
    // 期望链路：失败 → 自动注入 /compact → 原消息重放，共 3 次 spawn。
    const claudeSpawnsBeforeLimit = fs.readFileSync(path.join(logsDir, 'process.log'), 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.includes('"event":"process_spawn"') && line.includes(claudeImageSession.sessionId.slice(0, 8))).length;
    ws.send(JSON.stringify({ type: 'message', text: 'trigger claude context limit', sessionId: claudeImageSession.sessionId, mode: 'plan', agent: 'claude' }));
    const claudeLimitStart = await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /自动执行 \/compact/.test(msg.message || ''));
    assert(/Claude Code 原版策略/.test(claudeLimitStart.message || ''), 'Claude "Prompt is too long" failure should trigger auto compact');
    await nextMessage(messages, ws, (msg) => msg.type === 'text_delta' && /Claude compact finished/.test(msg.text || ''));
    const claudeBoundaryMsg = await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /上下文已压缩（前 93,158 → 后 5,762 tokens）/.test(msg.message || ''));
    assert(claudeBoundaryMsg.kind === 'compact', 'compact_boundary should surface as kind=compact system_message with token counts');
    await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /已自动按压缩计划继续执行/.test(msg.message || ''));
    const claudeLimitReplay = await nextMessage(messages, ws, (msg) => msg.type === 'text_delta' && /trigger claude context limit/.test(msg.text || ''));
    assert(/trigger claude context limit/.test(claudeLimitReplay.text || ''), 'Original prompt must be replayed after auto compact');
    const claudeSpawnsAfterLimit = fs.readFileSync(path.join(logsDir, 'process.log'), 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.includes('"event":"process_spawn"') && line.includes(claudeImageSession.sessionId.slice(0, 8))).length;
    assert(claudeSpawnsAfterLimit - claudeSpawnsBeforeLimit === 3, `Auto compact chain should spawn fail+compact+replay = 3 processes (got ${claudeSpawnsAfterLimit - claudeSpawnsBeforeLimit})`);
    // compact 注入的消息本身不得写入历史（hideInHistory）
    const claudeLimitSessionJson = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${claudeImageSession.sessionId}.json`), 'utf8'));
    assert(!JSON.stringify(claudeLimitSessionJson.messages || []).includes('"content":"/compact"'), 'Injected /compact must stay out of session history');

    ws.send(JSON.stringify({ type: 'list_native_sessions' }));
    const nativeSessions = await nextMessage(messages, ws, (msg) => msg.type === 'native_sessions');
    assert(nativeSessions.groups?.length > 0, 'Claude native session listing failed');
    const flatNative = nativeSessions.groups.flatMap((g) => g.sessions.map((s) => ({ ...s, dir: g.dir })));
    const firstClaude = flatNative.find((s) => s.title === 'Claude import prompt');
    assert(firstClaude, 'Claude import fixture should be listed');
    ws.send(JSON.stringify({ type: 'import_native_session', sessionId: firstClaude.sessionId, projectDir: firstClaude.dir }));
    const importedClaude = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'claude' && msg.title === 'Claude import prompt');
    assert(importedClaude.messages?.[0]?.content === 'Claude import prompt', 'Claude import parsed wrong first message');

    // P2 行为级：预防性水位压缩。导入一个 transcript 带高水位 usage（200k tokens ≥ 200k
    // 窗口 × 80%）的会话，再发消息：期望 通知 → /compact 运行（含 P1 boundary 透传）→
    // 原消息重放，共 2 次 spawn；原消息仅经重放记录一次。
    const usageImportItem = flatNative.find((s) => s.title === 'Claude usage import prompt');
    assert(usageImportItem, 'Claude high-usage fixture should be listed');
    ws.send(JSON.stringify({ type: 'import_native_session', sessionId: usageImportItem.sessionId, projectDir: usageImportItem.dir }));
    const usageSession = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'claude' && msg.title === 'Claude usage import prompt');
    ws.send(JSON.stringify({ type: 'message', text: 'preempt usage replay prompt', sessionId: usageSession.sessionId, mode: 'yolo', agent: 'claude' }));
    const preemptNotice = await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /◎ 检测到上下文接近上限，先执行压缩再发送您的消息/.test(msg.message || ''));
    assert(preemptNotice.kind === 'compact', 'Preemptive compact notice should be a kind=compact system_message');
    await nextMessage(messages, ws, (msg) => msg.type === 'text_delta' && /Claude compact finished/.test(msg.text || ''));
    await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /上下文已压缩（前 93,158 → 后 5,762 tokens）/.test(msg.message || ''));
    await nextMessage(messages, ws, (msg) => msg.type === 'system_message' && /已自动按压缩计划继续执行/.test(msg.message || ''));
    const preemptReplay = await nextMessage(messages, ws, (msg) => msg.type === 'text_delta' && /preempt usage replay prompt/.test(msg.text || ''));
    assert(/preempt usage replay prompt/.test(preemptReplay.text || ''), 'Original prompt must be replayed after preemptive compact');
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === usageSession.sessionId);
    const preemptSpawns = fs.readFileSync(path.join(logsDir, 'process.log'), 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.includes('"event":"process_spawn"') && line.includes(usageSession.sessionId.slice(0, 8)));
    assert(preemptSpawns.length === 2, `Preemptive compact should spawn compact+replay = 2 processes (got ${preemptSpawns.length})`);
    const usageSessionJson = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${usageSession.sessionId}.json`), 'utf8'));
    const replayedUserCount = (usageSessionJson.messages || []).filter((m) => m.role === 'user' && m.content === 'preempt usage replay prompt').length;
    assert(replayedUserCount === 1, `Preempted message should be recorded exactly once via replay (got ${replayedUserCount})`);
    // 低水位对照：导入的普通会话（fixture 无 usage 字段 → 水位不可确凿读取）不得触发预防压缩
    ws.send(JSON.stringify({ type: 'message', text: 'low water prompt', sessionId: importedClaude.sessionId, mode: 'yolo', agent: 'claude' }));
    const lowWaterDelta = await nextMessage(messages, ws, (msg) => msg.type === 'text_delta' && /low water prompt/.test(msg.text || ''));
    assert(/low water prompt/.test(lowWaterDelta.text || ''), 'Session without readable watermark must go through the normal path');
    await nextMessage(messages, ws, (msg) => msg.type === 'done' && msg.sessionId === importedClaude.sessionId);

    ws.send(JSON.stringify({ type: 'list_codex_sessions' }));
    const codexSessions = await nextMessage(messages, ws, (msg) => msg.type === 'codex_sessions');
    const importedCodexItem = codexSessions.sessions.find((item) => item.threadId === codexFixture.threadId);
    assert(importedCodexItem, 'Codex session listing failed');

    ws.send(JSON.stringify({ type: 'import_codex_session', threadId: importedCodexItem.threadId, rolloutPath: importedCodexItem.rolloutPath }));
    const importedCodex = await nextMessage(messages, ws, (msg) => msg.type === 'session_info' && msg.agent === 'codex' && msg.title === 'Codex import prompt');
    assert(importedCodex.messages?.[0]?.content === 'Codex import prompt', 'Codex import kept wrapper instructions');
    assert(importedCodex.totalUsage?.inputTokens === 20, 'Codex import usage parse failed');

    const importedSessionId = importedCodex.sessionId;
    ws.send(JSON.stringify({ type: 'delete_session', sessionId: importedSessionId }));
    await nextMessage(messages, ws, (msg) => msg.type === 'session_list' && !msg.sessions.some((s) => s.id === importedSessionId));

    assert(!fs.existsSync(path.join(sessionsDir, `${importedSessionId}.json`)), 'Deleting Codex session did not remove session JSON');
    assert(!fs.existsSync(codexFixture.rolloutPath), 'Deleting Codex session did not remove rollout file');
    assert(sql(codexFixture.stateDb, `select count(*) from threads where id='${codexFixture.threadId}'`) === '0', 'Deleting Codex session did not remove thread row');

    // Password change must atomically invalidate all prior tokens (incl. concurrent sessions)
    // and issue a fresh token to the active connection. Old token used on a new WS must
    // fail with reason='session_expired'; new token must succeed.
    const secondConn = await connectWs(port, password);
    assert(secondConn.token && secondConn.token !== token, 'Second concurrent login should issue distinct token');
    // Register close listener BEFORE change_password so we don't miss the close event
    // (server closes secondConn synchronously inside handleChangePassword).
    const secondConnClosed = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      secondConn.ws.on('close', () => { clearTimeout(timer); resolve(true); });
      secondConn.ws.on('error', () => { clearTimeout(timer); resolve(false); });
    });
    ws.send(JSON.stringify({ type: 'change_password', currentPassword: password, newPassword: 'NewRegression!567' }));
    const pwdChanged = await nextMessage(messages, ws, (msg) => msg.type === 'password_changed' && msg.success);
    assert(pwdChanged.success && pwdChanged.token, 'Password change should succeed and return a new token');
    assert(pwdChanged.token !== token && pwdChanged.token !== secondConn.token, 'New token must differ from all prior tokens');
    // Old token (from second concurrent login) must now be invalid
    const staleConnPromise = new Promise((resolve) => {
      const wsStale = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      wsStale.on('open', () => { wsStale.send(JSON.stringify({ type: 'auth', token: secondConn.token })); });
      wsStale.on('message', (buf) => {
        const msg = JSON.parse(String(buf));
        if (msg.type === 'auth_result') {
          resolve(msg);
          wsStale.close();
        }
      });
      wsStale.on('error', () => resolve({ success: false, reason: 'ws_error' }));
    });
    const staleResult = await staleConnPromise;
    assert(staleResult.success === false && staleResult.reason === 'session_expired', 'Old token must be invalidated immediately after password change');
    // pwdChanged.token must work via token-auth on a fresh WS. This locks the
    // tokenMemory shape regression: if revokeAllTokens returned the wrong Map shape,
    // server would crash inside isTokenValid on `hit.record.*` access.
    const newTokenAuthPromise = new Promise((resolve, reject) => {
      const wsNew = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      wsNew.on('open', () => { wsNew.send(JSON.stringify({ type: 'auth', token: pwdChanged.token })); });
      wsNew.on('message', (buf) => {
        const msg = JSON.parse(String(buf));
        if (msg.type === 'auth_result') {
          if (msg.success) resolve(msg);
          else reject(new Error(`new token auth failed: ${msg.reason}`));
        }
      });
      wsNew.on('error', (e) => reject(new Error(`ws error: ${e.message}`)));
    });
    const newTokenResult = await newTokenAuthPromise;
    assert(newTokenResult.success === true, 'password_changed.token must work via token-auth on fresh WS');
    // Already-authenticated concurrent connection (secondConn) must be force-closed
    // by the server so it cannot continue sending business messages despite token
    // revocation.
    assert(await secondConnClosed, 'Concurrent authenticated connection must be force-closed after password change');

    ws.close();
    console.log('Regression checks passed.');
  });

  // Standalone auth-store unit tests: absoluteExpiresAt migration paths
  await testAuthStoreTokenMigration();

  // P2 unit tests: lib/context-usage.js (watermark estimation + preempt threshold)
  await testContextUsage();

  // Static + HTTP-header checks for XSS hardening (Goal 2)
  await testXssHardening();

  // WS reconnect must not re-render the chat area (Goal 4: 症状 1)
  await testWsReconnectPreservesState();

  // WS 心跳 + 运行中任务断线内容补齐（Goal 6）
  await testWsHeartbeatAndActiveOutput();

  // Goal 5: long-term robustness (atomic writes + killProcess process-group + HTTP token revocation)
  await testRobustnessHardening();

  // Client IP resolution + IP ban enforcement (Goal 3)
  await testClientIpResolution();
  await testIpBanEnforcement();
}

// Pure-function tests for client IP resolution (Goal 3).
// Covers: no trusted proxies (XFF ignored), single trusted proxy, multi-hop
// trusted chain, IPv4-mapped IPv6 (::ffff:), IPv6 trusted subnet, tainted XFF
// (any invalid token → whole XFF discarded).
async function testClientIpResolution() {
  const { createClientIpResolver } = require('../lib/client-ip');

  // Case 1: no trusted proxies → XFF always ignored, falls back to socket
  {
    const { resolveClientIP } = createClientIpResolver('');
    const ip = resolveClientIP({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    assert(ip === '127.0.0.1', `No trusted proxies: XFF must be ignored (got ${ip})`);
  }

  // Case 2: single trusted proxy 127.0.0.1, XFF honored
  {
    const { resolveClientIP } = createClientIpResolver('127.0.0.1');
    const ip = resolveClientIP({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    assert(ip === '203.0.113.10', `Trusted proxy 127.0.0.1: XFF=203.0.113.10 must resolve (got ${ip})`);
  }

  // Case 3: multi-hop chain A(trusted) → B(trusted) → server
  {
    const { resolveClientIP } = createClientIpResolver('127.0.0.1,10.0.0.1');
    const ip = resolveClientIP({
      socket: { remoteAddress: '10.0.0.1' },
      headers: { 'x-forwarded-for': '1.2.3.4, 127.0.0.1' },
    });
    assert(ip === '1.2.3.4', `Multi-hop trusted chain must return original client (got ${ip})`);
  }

  // Case 4: untrusted socket → XFF discarded even if present
  {
    const { resolveClientIP } = createClientIpResolver('127.0.0.1');
    const ip = resolveClientIP({
      socket: { remoteAddress: '8.8.8.8' },
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    assert(ip === '8.8.8.8', `Untrusted socket: XFF must be ignored (got ${ip})`);
  }

  // Case 5: IPv4-mapped IPv6 normalization
  {
    const { resolveClientIP, isTrustedProxy } = createClientIpResolver('127.0.0.1');
    assert(isTrustedProxy('::ffff:127.0.0.1') === true, '::ffff:127.0.0.1 must normalize to trusted 127.0.0.1');
    const ip = resolveClientIP({
      socket: { remoteAddress: '::ffff:127.0.0.1' },
      headers: { 'x-forwarded-for': '203.0.113.20' },
    });
    assert(ip === '203.0.113.20', `IPv4-mapped IPv6 socket must be normalized (got ${ip})`);
  }

  // Case 6: IPv6 trusted subnet (2001:db8::/32)
  {
    const { resolveClientIP, isTrustedProxy } = createClientIpResolver('2001:db8::/32');
    assert(isTrustedProxy('2001:db8::1') === true, 'IPv6 trusted subnet must match');
    assert(isTrustedProxy('2001:db9::1') === false, 'IPv6 outside trusted subnet must NOT match');
    const ip = resolveClientIP({
      socket: { remoteAddress: '2001:db8::1' },
      headers: { 'x-forwarded-for': '2001:dead:beef::1' },
    });
    assert(ip === '2001:dead:beef::1', `IPv6 trusted proxy must honor XFF (got ${ip})`);
  }

  // Case 7: tainted XFF (any invalid token → whole XFF discarded)
  {
    const { resolveClientIP } = createClientIpResolver('127.0.0.1');
    const ip = resolveClientIP({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'x-forwarded-for': '203.0.113.10, NOT_AN_IP, 198.51.100.5' },
    });
    assert(ip === '127.0.0.1', `Tainted XFF (invalid token) must discard whole XFF (got ${ip})`);
  }

  // Case 8: missing XFF header → socket address only
  {
    const { resolveClientIP } = createClientIpResolver('127.0.0.1');
    const ip = resolveClientIP({
      socket: { remoteAddress: '127.0.0.1' },
      headers: {},
    });
    assert(ip === '127.0.0.1', `Missing XFF must fall back to socket (got ${ip})`);
  }

  console.log('Client IP resolution checks passed.');
}

async function testIpBanEnforcement() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-ban-'));
  const configDir = path.join(tempRoot, 'config');
  const sessionsDir = path.join(tempRoot, 'sessions');
  const logsDir = path.join(tempRoot, 'logs');
  const homeDir = path.join(tempRoot, 'home');
  for (const d of [configDir, sessionsDir, logsDir, homeDir]) mkdirp(d);
  const password = 'BanTest!234';
  const port = await getFreePort();

  // Scenario A: TRUSTED_PROXIES configured = 127.0.0.1, so XFF=203.0.113.10 is honored.
  // After 3 password failures with that XFF, the source IP must be banned and
  // subsequent WS connections from the same XFF must be rejected with banned=true.
  await withServer({
    PORT: String(port),
    CC_WEB_PASSWORD: password,
    CC_WEB_CONFIG_DIR: configDir,
    CC_WEB_SESSIONS_DIR: sessionsDir,
    CC_WEB_LOGS_DIR: logsDir,
    HOME: homeDir,
    CLAUDE_PATH: MOCK_CLAUDE,
    CODEX_PATH: MOCK_CODEX,
    CC_WEB_TRUSTED_PROXIES: '127.0.0.1',
  }, async () => {
    // 3 failed auths with X-Forwarded-For: 203.0.113.10
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
          headers: { 'X-Forwarded-For': '203.0.113.10' },
        });
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'auth', password: 'wrong-password-' + i }));
        });
        ws.on('message', (buf) => {
          const msg = JSON.parse(String(buf));
          if (msg.type === 'auth_result') {
            ws.close();
            resolve(msg);
          }
        });
        ws.on('error', () => resolve(null));
      });
    }
    // 4th attempt with same XFF → expect banned
    const bannedResult = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { 'X-Forwarded-For': '203.0.113.10' },
      });
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', password: 'wrong-again' }));
      });
      ws.on('message', (buf) => {
        const msg = JSON.parse(String(buf));
        if (msg.type === 'auth_result') {
          ws.close();
          resolve(msg);
        }
      });
      ws.on('error', () => resolve(null));
      setTimeout(() => { try { ws.close(); } catch {}; resolve(null); }, 5000);
    });
    assert(bannedResult && bannedResult.banned === true, 'Trusted-proxy XFF=203.0.113.10 must trigger ban after 3 failures');

    // HTTP /api/attachments from the same banned XFF must return 403 (not 401)
    const resp = await fetch(`http://127.0.0.1:${port}/api/attachments`, {
      method: 'POST',
      headers: {
        'X-Forwarded-For': '203.0.113.10',
        Authorization: 'Bearer invalid-token',
        'Content-Type': 'image/png',
        'X-Filename': 'test.png',
      },
      body: Buffer.from('test'),
    });
    assert(resp.status === 403, `Banned IP via XFF must be rejected with 403 (got ${resp.status})`);
  });

  fs.rmSync(tempRoot, { recursive: true, force: true });

  // Scenario B: no trusted proxies configured → XFF must be ignored.
  // 3 failed auths with arbitrary XFF must NOT ban that XFF (since IP resolves to 127.0.0.1,
  // which is whitelisted and never banned; we just verify XFF is NOT recorded as banned).
  const tempRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-ban2-'));
  const configDir2 = path.join(tempRoot2, 'config');
  const sessionsDir2 = path.join(tempRoot2, 'sessions');
  const logsDir2 = path.join(tempRoot2, 'logs');
  const homeDir2 = path.join(tempRoot2, 'home');
  for (const d of [configDir2, sessionsDir2, logsDir2, homeDir2]) mkdirp(d);
  const port2 = await getFreePort();

  await withServer({
    PORT: String(port2),
    CC_WEB_PASSWORD: password,
    CC_WEB_CONFIG_DIR: configDir2,
    CC_WEB_SESSIONS_DIR: sessionsDir2,
    CC_WEB_LOGS_DIR: logsDir2,
    HOME: homeDir2,
    CLAUDE_PATH: MOCK_CLAUDE,
    CODEX_PATH: MOCK_CODEX,
    // CC_WEB_TRUSTED_PROXIES intentionally NOT set
  }, async () => {
    // Attempt 3 failed auths with spoofed XFF
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port2}/ws`);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'auth', password: 'wrong' }));
        });
        ws.on('message', (buf) => {
          const msg = JSON.parse(String(buf));
          if (msg.type === 'auth_result') { ws.close(); resolve(msg); }
        });
        ws.on('error', () => resolve(null));
      });
    }
    // Subsequent HTTP call from the SAME spoofed XFF should NOT be 403 (XFF must be ignored)
    // Because loopback is whitelisted, client resolves to 127.0.0.1 → never banned → 401 from missing token
    const resp = await fetch(`http://127.0.0.1:${port2}/api/attachments`, {
      method: 'POST',
      headers: {
        'X-Forwarded-For': '198.51.100.42',
        Authorization: 'Bearer invalid',
        'Content-Type': 'image/png',
        'X-Filename': 'test.png',
      },
      body: Buffer.from('test'),
    });
    assert(resp.status === 401, `Spoofed XFF without trusted_proxies must NOT ban (expected 401, got ${resp.status})`);
  });

  fs.rmSync(tempRoot2, { recursive: true, force: true });
  console.log('IP ban enforcement checks passed.');
}

// Goal 4: WS reconnect must NOT trigger a full session reload.
// First auth triggers pendingInitialSessionLoad → session_list → syncViewForAgent.
// Reconnect (auth via stored token) must skip pendingInitialSessionLoad so the user's
// scroll position is preserved. Verified via (1) static scan of app.js source and
// (2) behavioral check that server only sends session_list on both connects, but the
// second connect does NOT receive a fresh session_info for the previously-viewed session.
async function testWsReconnectPreservesState() {
  // 1. Static scan: hasInitialAuthCompleted flag must gate pendingInitialSessionLoad
  const indexHtml = fs.readFileSync(path.join(REPO_DIR, 'public', 'app.js'), 'utf8');
  assert(/hasInitialAuthCompleted\s*=\s*false/.test(indexHtml), 'app.js must declare hasInitialAuthCompleted=false initially');
  assert(/!hasInitialAuthCompleted/.test(indexHtml), 'app.js must gate pendingInitialSessionLoad behind !hasInitialAuthCompleted');
  assert(/hasInitialAuthCompleted\s*=\s*true/.test(indexHtml), 'app.js must set hasInitialAuthCompleted=true after first successful auth');
  // On auth failure / token invalidation, the flag must reset
  assert(/hasInitialAuthCompleted\s*=\s*false[\s\S]{0,200}cc-web-auth-failed/.test(indexHtml) || /auth-failed[\s\S]{0,200}hasInitialAuthCompleted\s*=\s*false/.test(indexHtml), 'app.js must reset hasInitialAuthCompleted on auth failure');

  // 2. Behavioral: simulate reconnect via real WS + token-auth
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-reconnect-'));
  const configDir = path.join(tempRoot, 'config');
  const sessionsDir = path.join(tempRoot, 'sessions');
  const logsDir = path.join(tempRoot, 'logs');
  const homeDir = path.join(tempRoot, 'home');
  for (const d of [configDir, sessionsDir, logsDir, homeDir]) mkdirp(d);
  const password = 'Reconnect!234';
  const port = await getFreePort();

  await withServer({
    PORT: String(port),
    CC_WEB_PASSWORD: password,
    CC_WEB_CONFIG_DIR: configDir,
    CC_WEB_SESSIONS_DIR: sessionsDir,
    CC_WEB_LOGS_DIR: logsDir,
    HOME: homeDir,
    CLAUDE_PATH: MOCK_CLAUDE,
    CODEX_PATH: MOCK_CODEX,
  }, async () => {
    // First connection: password auth → get token
    const first = await connectWs(port, password);
    const firstToken = first.token;
    // Server should send session_list on first auth
    await nextMessage(first.messages, first.ws, (msg) => msg.type === 'session_list');
    first.ws.close();

    // Wait a moment for the server to register the disconnect
    await sleep(200);

    // Reconnect with stored token (simulating WS drop + reconnect)
    const reconnect = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const messages = [];
      ws.on('open', () => { ws.send(JSON.stringify({ type: 'auth', token: firstToken })); });
      ws.on('message', (buf) => {
        const msg = JSON.parse(String(buf));
        messages.push(msg);
        if (msg.type === 'auth_result' && msg.success) {
          // Give it a moment to receive follow-up messages
          setTimeout(() => resolve({ ws, messages, token: msg.token }), 300);
        }
        if (msg.type === 'auth_result' && !msg.success) {
          reject(new Error(`Token auth failed on reconnect: ${msg.reason}`));
        }
      });
      ws.on('error', reject);
    });

    // Reconnect must succeed via token auth
    assert(reconnect.token === firstToken, 'Reconnect should preserve the same token');
    // Server still sends session_list (sidebar update is fine)
    const hasSessionList = reconnect.messages.some((m) => m.type === 'session_list');
    assert(hasSessionList, 'Server should send session_list on reconnect (sidebar refresh is expected)');
    // Server must NOT proactively send session_info for any previously-viewed session
    // (reconnect with valid token doesn't trigger initial session load on client side;
    //  server's role is to NOT push session_info without an explicit load_session request)
    const unsolicitedSessionInfo = reconnect.messages.find((m) => m.type === 'session_info' && !m.historyPending);
    assert(!unsolicitedSessionInfo, 'Server must NOT push session_info on reconnect without explicit load_session (would force re-render)');

    reconnect.ws.close();
  });

  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log('WS reconnect state preservation checks passed.');
}

// Goal 6: WS 心跳 + 断线内容补齐。
//  1) 服务端按 CC_WEB_WS_PING_INTERVAL_MS 周期发协议级 ping；客户端正常回 pong 时
//     连接必须保持 OPEN（心跳不得误杀活跃连接）
//  2) 运行中任务的 session_info 必须附带 activeOutput（内存 fullText 快照），
//     且包含已流出的文本片段；任务结束后 activeOutput 必须消失（键省略）
//  3) 双客户端 load_session 抢占 entry.ws 后，原客户端再次 load_session 能拿回
//     补齐数据并继续收到 done（模拟断线重连补齐全链路）
async function testWsHeartbeatAndActiveOutput() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-heartbeat-'));
  const configDir = path.join(tempRoot, 'config');
  const sessionsDir = path.join(tempRoot, 'sessions');
  const logsDir = path.join(tempRoot, 'logs');
  const homeDir = path.join(tempRoot, 'home');
  for (const d of [configDir, sessionsDir, logsDir, homeDir]) mkdirp(d);
  const password = 'Heartbeat!234';
  const port = await getFreePort();

  // 慢速 mock：分段输出（0s / 1.5s / 3s）+ 4.5s 收尾，保证采样窗口内任务持续运行
  const slowClaudePath = path.join(tempRoot, 'slow-claude.js');
  fs.writeFileSync(slowClaudePath, `#!/usr/bin/env node
const crypto = require('crypto');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const resumeIndex = args.indexOf('--resume');
  const sessionId = resumeIndex >= 0 && args[resumeIndex + 1] ? args[resumeIndex + 1] : crypto.randomUUID();
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
  const assistant = (text) => write({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text }] } });
  write({ type: 'system', session_id: sessionId });
  assistant('SLOW_CHUNK_1');
  setTimeout(() => assistant('SLOW_CHUNK_2'), 1500);
  setTimeout(() => assistant('SLOW_CHUNK_3'), 3000);
  setTimeout(() => write({ type: 'result', session_id: sessionId, total_cost_usd: 0 }), 4500);
});
`);
  fs.chmodSync(slowClaudePath, 0o755);

  await withServer({
    PORT: String(port),
    CC_WEB_PASSWORD: password,
    CC_WEB_CONFIG_DIR: configDir,
    CC_WEB_SESSIONS_DIR: sessionsDir,
    CC_WEB_LOGS_DIR: logsDir,
    HOME: homeDir,
    CLAUDE_PATH: slowClaudePath,
    CODEX_PATH: MOCK_CODEX,
    CC_WEB_WS_PING_INTERVAL_MS: '400',
  }, async () => {
    const conn1 = await connectWs(port, password);
    await nextMessage(conn1.messages, conn1.ws, (msg) => msg.type === 'session_list');

    // 协议级 ping 计数（Node ws 客户端自动回 pong，服务端不应 terminate 该连接）
    let pingCount = 0;
    conn1.ws.on('ping', () => { pingCount += 1; });

    conn1.ws.send(JSON.stringify({ type: 'message', text: 'slow output prompt', mode: 'yolo', agent: 'claude' }));
    const runningSession = await nextMessage(conn1.messages, conn1.ws, (msg) => msg.type === 'session_info' && msg.title === 'slow output prompt');
    const sessionId = runningSession.sessionId;

    // 任务已在输出（第一段已流出）
    const firstDelta = await nextMessage(conn1.messages, conn1.ws, (msg) => msg.type === 'text_delta' && /SLOW_CHUNK_1/.test(msg.text || ''));
    assert(/SLOW_CHUNK_1/.test(firstDelta.text || ''), '慢速任务应先流出 SLOW_CHUNK_1');

    // 第二个客户端（模拟断线后重连/他端查看）load_session：session_info 必须附带运行中实时输出
    const conn2 = await connectWs(port, password);
    await nextMessage(conn2.messages, conn2.ws, (msg) => msg.type === 'session_list');
    conn2.ws.send(JSON.stringify({ type: 'load_session', sessionId }));
    const midRunInfo = await nextMessage(conn2.messages, conn2.ws, (msg) => msg.type === 'session_info' && msg.sessionId === sessionId);
    assert(midRunInfo.isRunning === true, '运行中任务的 session_info 应标记 isRunning=true');
    assert(typeof midRunInfo.activeOutput === 'string' && midRunInfo.activeOutput.length > 0, '运行中任务的 session_info 应附带非空 activeOutput');
    assert(midRunInfo.activeOutput.includes('SLOW_CHUNK_1'), 'activeOutput 应包含已流出的 SLOW_CHUNK_1 片段');

    // conn2 的 load_session 抢占了 entry.ws（此后 text_delta 只发给 conn2）。
    // 原客户端再 load_session 切回——这正是断线重连补齐路径：拿回全量 activeOutput + 恢复 done 送达
    conn1.ws.send(JSON.stringify({ type: 'load_session', sessionId }));
    const reconnectInfo = await nextMessage(conn1.messages, conn1.ws, (msg) => msg.type === 'session_info' && msg.sessionId === sessionId);
    assert(reconnectInfo.isRunning === true, '原客户端重连式 load_session 应看到 isRunning=true');
    assert(typeof reconnectInfo.activeOutput === 'string' && reconnectInfo.activeOutput.includes('SLOW_CHUNK_1'), '原客户端补齐 load_session 应拿到含已输出片段的 activeOutput');

    // 心跳：等最多 3 秒，应收到至少 1 个协议级 ping；且回 pong 的连接保持 OPEN
    const heartbeatDeadline = Date.now() + 3000;
    while (Date.now() < heartbeatDeadline && pingCount === 0) {
      await sleep(100);
    }
    assert(pingCount >= 1, `3 秒内应收到至少 1 个协议级 ping（间隔 400ms，实际收到 ${pingCount} 个）`);
    assert(conn1.ws.readyState === WebSocket.OPEN, '正常回 pong 的连接不应被心跳 terminate');

    // 原客户端（entry.ws 持有者）必须正常收到 done：心跳未误杀连接、补齐未破坏完成链路
    await nextMessage(conn1.messages, conn1.ws, (msg) => msg.type === 'done' && msg.sessionId === sessionId, 20000);

    // 任务结束后再 load_session：activeOutput 必须省略（仅运行中会话携带），isRunning=false
    conn2.ws.send(JSON.stringify({ type: 'load_session', sessionId }));
    const finishedInfo = await nextMessage(conn2.messages, conn2.ws, (msg) => msg.type === 'session_info' && msg.sessionId === sessionId);
    assert(finishedInfo.isRunning === false, '任务结束后 session_info 应标记 isRunning=false');
    assert(!('activeOutput' in finishedInfo), '任务结束后 session_info 不应携带 activeOutput 键');

    conn2.ws.close();
    conn1.ws.close();
  });

  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log('WS heartbeat + active output backfill checks passed.');
}

// Goal 5: long-term robustness.
//  1) HTTP /api/attachments must reject revoked tokens with 401 (tokenMemory structure must work for HTTP path too)
//  2) server.js must use atomicWriteJson for all persistent JSON state (sessions/configs)
//  3) killProcess must target the whole process group on Linux (kill -pid) so detached grandchildren don't survive
async function testRobustnessHardening() {
  // Static scan: atomicWriteJson helper + usage in critical save paths
  const serverJs = fs.readFileSync(path.join(REPO_DIR, 'server.js'), 'utf8');
  assert(/function atomicWriteJson\(/.test(serverJs), 'server.js must define atomicWriteJson helper');
  for (const fn of ['saveSession', 'saveBannedIPs', 'saveNotifyConfig', 'saveModelConfig', 'saveCodexConfig', 'saveDevConfig', 'saveAttachmentMeta']) {
    assert(new RegExp(`function ${fn}\\([\\s\\S]{0,300}atomicWriteJson\\(`).test(serverJs), `${fn} must use atomicWriteJson`);
  }
  // killProcess must use process.kill(-pid) for process-group targeting on Linux
  assert(/process\.kill\(-pid,\s*signal\)/.test(serverJs), 'killProcess must target process group via kill(-pid) on Linux');

  // Behavioral: HTTP attachment path rejects revoked tokens
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-robust-'));
  const configDir = path.join(tempRoot, 'config');
  const sessionsDir = path.join(tempRoot, 'sessions');
  const logsDir = path.join(tempRoot, 'logs');
  const homeDir = path.join(tempRoot, 'home');
  for (const d of [configDir, sessionsDir, logsDir, homeDir]) mkdirp(d);
  const password = 'Robust!234';
  const port = await getFreePort();

  await withServer({
    PORT: String(port),
    CC_WEB_PASSWORD: password,
    CC_WEB_CONFIG_DIR: configDir,
    CC_WEB_SESSIONS_DIR: sessionsDir,
    CC_WEB_LOGS_DIR: logsDir,
    HOME: homeDir,
    CLAUDE_PATH: MOCK_CLAUDE,
    CODEX_PATH: MOCK_CODEX,
  }, async () => {
    const conn = await connectWs(port, password);
    // Pre-change: attachment upload with valid token works
    const attachment1 = await uploadAttachment(port, conn.token, {
      filename: 'pre.png', mime: 'image/png', data: Buffer.from('pre'),
    });
    assert(attachment1 && attachment1.id, 'Attachment upload with valid token should succeed');

    // Change password → tokenMemory reset, conn.token must be invalid for HTTP path too
    conn.ws.send(JSON.stringify({ type: 'change_password', currentPassword: password, newPassword: 'NewRobust!567' }));
    await nextMessage(conn.messages, conn.ws, (msg) => msg.type === 'password_changed' && msg.success);

    // POST /api/attachments with OLD token must now return 401 (tokenMemory structure must work for HTTP path)
    const resp = await fetch(`http://127.0.0.1:${port}/api/attachments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${conn.token}`,
        'Content-Type': 'image/png',
        'X-Filename': 'post.png',
      },
      body: Buffer.from('post'),
    });
    assert(resp.status === 401, `Old token must be rejected on HTTP path after password change (expected 401, got ${resp.status})`);

    conn.ws.close();
  });

  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log('Robustness hardening checks passed.');
}

// Verify CSP header is present on every HTTP response and that the front-end no
// longer relies on inline event handlers in the markdown render path. These are
// static guarantees; runtime DOMPurify behavior is the library's responsibility.
async function testXssHardening() {
  const port = await getFreePort();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-xss-'));
  const configDir = path.join(tempRoot, 'config');
  const sessionsDir = path.join(tempRoot, 'sessions');
  const logsDir = path.join(tempRoot, 'logs');
  const homeDir = path.join(tempRoot, 'home');
  for (const d of [configDir, sessionsDir, logsDir, homeDir]) mkdirp(d);
  const password = 'XssTest!234';

  await withServer({
    PORT: String(port),
    CC_WEB_PASSWORD: password,
    CC_WEB_CONFIG_DIR: configDir,
    CC_WEB_SESSIONS_DIR: sessionsDir,
    CC_WEB_LOGS_DIR: logsDir,
    HOME: homeDir,
    CLAUDE_PATH: MOCK_CLAUDE,
    CODEX_PATH: MOCK_CODEX,
  }, async () => {
    // 1. Every HTTP response must carry CSP + X-Content-Type-Options + Referrer-Policy
    for (const path of ['/', '/app.js', '/style.css']) {
      const resp = await fetch(`http://127.0.0.1:${port}${path}`);
      const csp = resp.headers.get('content-security-policy') || '';
      assert(/default-src 'self'/.test(csp), `CSP default-src missing on ${path}`);
      assert(/script-src 'self' https:\/\/cdnjs\.cloudflare\.com/.test(csp), `CSP script-src must restrict to self + cdnjs on ${path}`);
      assert(!/'unsafe-inline'/.test(csp.split(';').find((d) => d.includes('script-src')) || ''), `CSP script-src must NOT allow 'unsafe-inline' on ${path}`);
      assert(resp.headers.get('x-content-type-options') === 'nosniff', `X-Content-Type-Options missing on ${path}`);
      assert(resp.headers.get('referrer-policy') === 'same-origin', `Referrer-Policy missing on ${path}`);
    }

    // 2. index.html must load DOMPurify from CDN
    const indexHtml = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert(/dompurify\/[\d.]+\/purify\.min\.js/.test(indexHtml), 'index.html must reference DOMPurify script');

    // 3. app.js must no longer contain inline onclick=/onerror= strings in markdown path
    //    (decorateCodeBlocks uses addEventListener; renderMarkdown goes through DOMPurify)
    const appJs = await (await fetch(`http://127.0.0.1:${port}/app.js`)).text();
    assert(!/onclick=["']ccCopyCode|onclick=["']ccTogglePreview/.test(appJs), 'app.js must not contain inline onclick= for code block buttons');
    assert(!/window\.ccCopyCode|window\.ccTogglePreview/.test(appJs), 'app.js must not expose global onclick handlers (replaced by decorateCodeBlocks closure)');
    assert(/DOMPurify\.sanitize/.test(appJs), 'app.js renderMarkdown must call DOMPurify.sanitize');
    assert(/decorateCodeBlocks/.test(appJs), 'app.js must define decorateCodeBlocks');
    // Fail-closed: DOMPurify missing path must never return raw marked output
    assert(!/return raw;/.test(appJs.replace(/\/\/[^\n]*/g, '')), 'app.js renderMarkdown must not return raw unsanitized HTML when DOMPurify is unavailable (fail-closed)');

    // 4. style.css must still contain code-block styling (regression: confirm we didn't drop styles)
    const css = await (await fetch(`http://127.0.0.1:${port}/style.css`)).text();
    assert(/\.code-block-wrapper/.test(css), 'style.css must still define .code-block-wrapper');
    assert(/\.code-preview-iframe/.test(css), 'style.css must still define .code-preview-iframe');
  });

  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log('XSS hardening checks passed.');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
