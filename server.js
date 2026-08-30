/**
 * cc-web 服务端主应用（约 3965 行）。
 *
 * 浏览器 UI → 本地 Claude Code / Codex CLI 会话的网关。文件级持久化（无 DB），
 * Claude/Codex detached 子进程 + JSONL tail 推回前端。
 *
 * 顶层组织（按行号近似）：
 *   1-44      模块导入 + 路径常量
 *   46-373    plog 工厂 + 通知系统（pushplus/telegram/serverchan/feishu/qqbot + AI 摘要）
 *   375-539   鉴权 + IP 封禁 + 白名单
 *   540-552   运行时 Map：pendingSlashCommands / pendingCompactRetries /
 *             activeProcesses / wsSessionMap
 *   553-1046  模型模板 / Codex runtime / Dev 配置 / Claude settings 同步
 *   1062-1196 附件系统 + TTL 清理 + wsSend
 *   1198-1311 normalizeSession / loadSession / saveSession
 *   1313-1799 进程生命周期：FileTailer / handleProcessComplete / recoverProcesses
 *   1801-1911 HTTP（仅 3 个端点：附件上传/删除/静态）
 *   1914-2076 WS 握手 + 客户端消息 switch（30 个 type）
 *   2078-3760 WS handler 函数群（handleSlashCommand 2444 / handleMessage 3024 等）
 *   3762-3854 shutdown / killPortOccupant / listen
 *
 * 详细架构、运行时模型、契约、配置见 docs/。
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { WebSocketServer } = require('ws');
const { createAgentRuntime } = require('./lib/agent-runtime');
const { estimateClaudeContextUsage, shouldPreemptiveCompact } = require('./lib/context-usage');
const { createAuthStore } = require('./lib/auth');
const { createCodexRolloutStore } = require('./lib/codex-rollouts');
const { createClientIpResolver } = require('./lib/client-ip');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  }
}

const PORT = parseInt(process.env.PORT) || 8002;
const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';
const CODEX_PATH = process.env.CODEX_PATH || 'codex';
const CONFIG_DIR = process.env.CC_WEB_CONFIG_DIR || path.join(__dirname, 'config');
const SESSIONS_DIR = process.env.CC_WEB_SESSIONS_DIR || path.join(__dirname, 'sessions');
const PUBLIC_DIR = process.env.CC_WEB_PUBLIC_DIR || path.join(__dirname, 'public');
const LOGS_DIR = process.env.CC_WEB_LOGS_DIR || path.join(__dirname, 'logs');
const ATTACHMENTS_DIR = path.join(SESSIONS_DIR, '_attachments');
const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENTS = 4;
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const NOTIFY_CONFIG_PATH = path.join(CONFIG_DIR, 'notify.json');
const AUTH_CONFIG_PATH = path.join(CONFIG_DIR, 'auth.json');
const TOKENS_PATH = path.join(CONFIG_DIR, 'tokens.json');
const MODEL_CONFIG_PATH = path.join(CONFIG_DIR, 'model.json');
const CODEX_CONFIG_PATH = path.join(CONFIG_DIR, 'codex.json');
const BANNED_IPS_PATH = path.join(CONFIG_DIR, 'banned_ips.json');
const GROUPS_CONFIG_PATH = path.join(CONFIG_DIR, 'groups.json');
// WS 心跳间隔（毫秒）：每轮 ping 全部客户端，连续两轮无 pong 判定死连接 terminate
const WS_PING_INTERVAL_MS = parseInt(process.env.CC_WEB_WS_PING_INTERVAL_MS, 10) || 25000;

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

// === Process Lifecycle Logger ===
const LOG_FILE = path.join(LOGS_DIR, 'process.log');
const LOG_MAX_SIZE = 2 * 1024 * 1024; // 2MB per file

/**
 * 进程生命周期日志写入器。JSONL 格式，自动轮转（>2MB 重命名为 .old.log）。
 *
 * 事件类型：process_spawn / process_complete / ws_connect / ws_disconnect /
 * recovery_alive / recovery_dead / heartbeat（活跃进程每 60s 一次）。
 *
 * @param {'INFO'|'WARN'|'ERROR'} level
 * @param {string} event - 事件名（如 'process_spawn'）
 * @param {object} [data={}] - 事件数据
 */
function plog(level, event, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  const line = JSON.stringify(entry) + '\n';
  try {
    // Simple rotation: if file > 2MB, rename to .old and start fresh
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > LOG_MAX_SIZE) {
        const oldFile = LOG_FILE.replace('.log', '.old.log');
        try { fs.unlinkSync(oldFile); } catch {}
        fs.renameSync(LOG_FILE, oldFile);
      }
    } catch {}
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

// === Notification System ===
const DEFAULT_SUMMARY_CONFIG = {
  enabled: false,
  trigger: 'background', // 'background' | 'always'
  apiSource: 'claude',   // 'claude' | 'codex' | 'custom'
  apiBase: '',
  apiKey: '',
  model: '',
};

function loadNotifyConfig() {
  try {
    if (fs.existsSync(NOTIFY_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(NOTIFY_CONFIG_PATH, 'utf8'));
      // Ensure summary field exists for older configs
      if (!raw.summary) raw.summary = { ...DEFAULT_SUMMARY_CONFIG };
      return raw;
    }
  } catch {}
  // First run: migrate from .env PUSHPLUS_TOKEN
  const token = process.env.PUSHPLUS_TOKEN || '';
  const config = {
    provider: token ? 'pushplus' : 'off',
    pushplus: { token },
    telegram: { botToken: '', chatId: '' },
    serverchan: { sendKey: '' },
    feishu: { webhook: '' },
    qqbot: { qmsgKey: '' },
    summary: { ...DEFAULT_SUMMARY_CONFIG },
  };
  saveNotifyConfig(config);
  return config;
}

function saveNotifyConfig(config) {
  // notify.json 可能含推送通道 token（pushplus/telegram/serverchan/feishu/qq），强制 0600
  atomicWriteJson(NOTIFY_CONFIG_PATH, JSON.stringify(config, null, 2), 0o600);
}

function maskToken(str) {
  if (!str || str.length <= 8) return str ? '****' : '';
  return str.slice(0, 4) + '****' + str.slice(-4);
}

function getNotifyConfigMasked() {
  const config = loadNotifyConfig();
  const s = config.summary || {};
  return {
    provider: config.provider,
    pushplus: { token: maskToken(config.pushplus?.token) },
    telegram: { botToken: maskToken(config.telegram?.botToken), chatId: config.telegram?.chatId || '' },
    serverchan: { sendKey: maskToken(config.serverchan?.sendKey) },
    feishu: { webhook: maskToken(config.feishu?.webhook) },
    qqbot: { qmsgKey: maskToken(config.qqbot?.qmsgKey) },
    summary: {
      enabled: !!s.enabled,
      trigger: s.trigger || 'background',
      apiSource: s.apiSource || 'claude',
      apiBase: s.apiBase || '',
      apiKey: maskToken(s.apiKey),
      model: s.model || '',
    },
  };
}

// === Notification Summary ===

// Per-channel content length limits (chars)
const NOTIFY_CONTENT_LIMITS = {
  telegram: 3800,
  qqbot: 3800,
  serverchan: 30000,
  pushplus: 18000,
  feishu: 18000,
};

function truncateForChannel(text, provider) {
  const limit = NOTIFY_CONTENT_LIMITS[provider] || 18000;
  if (text.length <= limit) return text;
  return text.slice(0, limit - 20) + '\n\n[内容已截断]';
}

function getSummaryApiCredentials(summaryConfig) {
  // Returns { apiBase, apiKey, model } or null
  const src = summaryConfig.apiSource || 'claude';
  if (src === 'claude') {
    const modelCfg = loadModelConfig();
    if (modelCfg.mode === 'custom' && modelCfg.activeTemplate) {
      const tpl = (modelCfg.templates || []).find(t => t.name === modelCfg.activeTemplate);
      if (tpl && tpl.apiKey && tpl.apiBase) {
        return { apiBase: tpl.apiBase, apiKey: tpl.apiKey, model: tpl.defaultModel || tpl.opusModel || '' };
      }
    }
    return null; // local mode — no API credentials available
  }
  if (src === 'codex') {
    const codexCfg = loadCodexConfig();
    if (codexCfg.mode === 'custom' && codexCfg.activeProfile) {
      const profile = (codexCfg.profiles || []).find(p => p.name === codexCfg.activeProfile);
      if (profile && profile.apiKey && profile.apiBase) {
        const resolvedModel = splitCodexModelSpec(summaryConfig.model || profile.model || DEFAULT_CODEX_MODEL).base || DEFAULT_CODEX_MODEL;
        return { apiBase: profile.apiBase, apiKey: profile.apiKey, model: resolvedModel };
      }
    }
    return null;
  }
  if (src === 'custom') {
    if (summaryConfig.apiBase && summaryConfig.apiKey) {
      return { apiBase: summaryConfig.apiBase, apiKey: summaryConfig.apiKey, model: summaryConfig.model || '' };
    }
    return null;
  }
  return null;
}

function callSummaryApi(creds, prompt) {
  return new Promise((resolve) => {
    try {
      const base = creds.apiBase.replace(/\/+$/, '');
      const url = new URL(base + '/v1/chat/completions');
      const mod = url.protocol === 'https:' ? require('https') : require('http');
      const model = creds.model || 'claude-opus-4-6';
      const body = JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });
      const req = mod.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${creds.apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 20000,
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const text = json.choices?.[0]?.message?.content || json.content?.[0]?.text || '';
            resolve({ ok: !!text, text: text.trim() });
          } catch {
            resolve({ ok: false, text: '' });
          }
        });
      });
      req.on('error', () => resolve({ ok: false, text: '' }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, text: '' }); });
      req.write(body);
      req.end();
    } catch {
      resolve({ ok: false, text: '' });
    }
  });
}

function buildSummaryPrompt(sessionTitle, lastUserMsg, fullText, isError, errorDesc) {
  const userSnip = (lastUserMsg || '').slice(0, 300);
  const outputSnip = (fullText || '').slice(0, 15000);
  const base = `会话：${sessionTitle}\n用户请求：${userSnip}\n\n以下是助手的输出内容：\n${outputSnip}`;
  if (isError) {
    return base + `\n\n错误信息：${(errorDesc || '').slice(0, 300)}\n\n` +
      `请用纯文本简要说明本次任务做了什么、遇到了什么问题。` +
      `要求：1. 不超过 200 字  2. 可以有序号和适当分段  3. 不要罗列具体代码、函数名、文件路径等细节  4. 不使用 markdown 格式（无星号、井号、横线等符号）`;
  }
  return base + `\n\n请用纯文本简要说明本次任务做了什么、结论是否成功。` +
    `要求：1. 不超过 200 字  2. 可以有序号和适当分段  3. 不要罗列具体代码、函数名、文件路径等细节  4. 不使用 markdown 格式（无星号、井号、横线等符号）`;
}

async function buildNotifyContent(entry, session, completionError, contextLimitExceeded) {
  const title = session?.title || 'Untitled';
  const agent = entry.agent || 'claude';
  const agentLabel = agent === 'codex' ? 'Codex' : 'Claude';
  const hasTools = (entry.toolCalls || []).length > 0;

  // Determine notify title
  let notifyTitle;
  if (contextLimitExceeded) {
    notifyTitle = `⚠ ${title} 上下文已压缩`;
  } else if (completionError) {
    notifyTitle = `✗ ${title} 任务异常`;
  } else if (hasTools) {
    notifyTitle = `✓ ${title} 任务完成`;
  } else {
    notifyTitle = `✓ ${title} 回复就绪`;
  }

  // Context limit: fixed message, no AI
  if (contextLimitExceeded) {
    return { title: notifyTitle, content: `${agentLabel} 会话上下文已达上限，已自动触发压缩。\n会话: ${title}` };
  }

  // Check if summary is enabled and applicable
  const notifyCfg = loadNotifyConfig();
  const summaryCfg = notifyCfg.summary || {};
  const summaryEnabled = !!summaryCfg.enabled;

  if (!summaryEnabled) {
    // Fallback: simple content
    const lines = [`会话: ${title}`];
    if (completionError) lines.push(`错误: ${completionError.slice(0, 200)}`);
    return { title: notifyTitle, content: lines.join('\n') };
  }

  const creds = getSummaryApiCredentials(summaryCfg);
  if (!creds) {
    // No credentials — fallback
    const lines = [`会话: ${title}`];
    if (completionError) lines.push(`错误: ${completionError.slice(0, 200)}`);
    return { title: notifyTitle, content: lines.join('\n') };
  }

  // Get last user message from session
  const messages = session?.messages || [];
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const lastUserMsg = typeof lastUser?.content === 'string' ? lastUser.content : '';

  const prompt = buildSummaryPrompt(title, lastUserMsg, entry.fullText || '', !!completionError, completionError || '');
  const result = await callSummaryApi(creds, prompt);

  let bodyText;
  if (result.ok && result.text) {
    bodyText = result.text;
  } else {
    // Fallback on API failure
    const lines = [`会话: ${title}`];
    if (completionError) lines.push(`错误: ${completionError.slice(0, 200)}`);
    if (!result.ok) lines.push('（摘要生成失败，以上为原始信息）');
    bodyText = lines.join('\n');
  }

  return { title: notifyTitle, content: bodyText };
}

function sendNotification(title, content) {
  const config = loadNotifyConfig();
  if (!config.provider || config.provider === 'off') return Promise.resolve({ ok: true, skipped: true });
  const https = require('https');
  const truncated = truncateForChannel(content, config.provider);

  return new Promise((resolve) => {
    let url, data;
    let isFormData = false;
    switch (config.provider) {
      case 'pushplus': {
        if (!config.pushplus?.token) return resolve({ ok: false, error: 'PushPlus token 未配置' });
        url = 'https://www.pushplus.plus/send';
        data = JSON.stringify({ token: config.pushplus.token, title, content: truncated, template: 'txt' });
        break;
      }
      case 'telegram': {
        if (!config.telegram?.botToken || !config.telegram?.chatId) return resolve({ ok: false, error: 'Telegram botToken 或 chatId 未配置' });
        url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;
        data = JSON.stringify({ chat_id: config.telegram.chatId, text: `${title}\n\n${truncated}` });
        break;
      }
      case 'serverchan': {
        if (!config.serverchan?.sendKey) return resolve({ ok: false, error: 'Server酱 sendKey 未配置' });
        url = `https://sctapi.ftqq.com/${config.serverchan.sendKey}.send`;
        data = JSON.stringify({ title, desp: truncated });
        break;
      }
      case 'feishu': {
        if (!config.feishu?.webhook) return resolve({ ok: false, error: '飞书 Webhook 未配置' });
        url = config.feishu.webhook;
        data = JSON.stringify({ msg_type: 'text', content: { text: `${title}\n\n${truncated}` } });
        break;
      }
      case 'qqbot': {
        if (!config.qqbot?.qmsgKey) return resolve({ ok: false, error: 'Qmsg Key 未配置' });
        url = `https://qmsg.zendee.cn/send/${config.qqbot.qmsgKey}`;
        data = `msg=${encodeURIComponent(`${title}\n\n${truncated}`)}`;
        isFormData = true;
        break;
      }
      default:
        return resolve({ ok: false, error: `未知通知方式: ${config.provider}` });
    }

    const parsed = new URL(url);
    const contentType = isFormData ? 'application/x-www-form-urlencoded' : 'application/json';
    const reqOptions = {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(parsed, reqOptions, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        plog('INFO', 'notify_response', { provider: config.provider, status: res.statusCode, body: body.slice(0, 200) });
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: body.slice(0, 200) });
      });
    });
    req.on('error', (e) => {
      plog('WARN', 'notify_error', { provider: config.provider, error: e.message });
      resolve({ ok: false, error: e.message });
    });
    req.write(data);
    req.end();
  });
}

// Load config on startup (ensures migration)
loadNotifyConfig();

// === Auth Config ===
function generateRandomPassword(length = 12) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

const authStore = createAuthStore({ AUTH_CONFIG_PATH, TOKENS_PATH });

function saveAuthConfigAtomic(config) {
  // 原子写 auth.json（tmp + fsync + rename, 0600）
  const tmp = AUTH_CONFIG_PATH + '.tmp.' + process.pid + '.' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    const fd = fs.openSync(tmp, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {}
  fs.renameSync(tmp, AUTH_CONFIG_PATH);
  try { fs.chmodSync(AUTH_CONFIG_PATH, 0o600); } catch {}
}

function loadAuthConfig() {
  // Priority 1: config/auth.json exists
  try {
    if (fs.existsSync(AUTH_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(AUTH_CONFIG_PATH, 'utf8'));
      // 新 schema（alg=scrypt）：直接用
      if (raw && raw.alg === 'scrypt' && raw.hash) return raw;
      // 旧 schema（含明文 password）：自动迁移为哈希
      const migrated = authStore.migrateFromPlaintext(raw);
      if (migrated) {
        migrated.mustChange = !!raw.mustChange;
        saveAuthConfigAtomic(migrated);
        plog('INFO', 'auth_migrated', { from: 'plaintext', to: 'scrypt' });
        return migrated;
      }
    }
  } catch (e) {
    plog('WARN', 'auth_load_failed', { error: String(e && e.message) });
  }

  // Priority 2: .env has CC_WEB_PASSWORD → migrate
  const envPw = process.env.CC_WEB_PASSWORD;
  if (envPw && envPw !== 'changeme') {
    const config = { ...authStore.hashPassword(envPw), mustChange: false, version: 2 };
    saveAuthConfigAtomic(config);
    return config;
  }

  // Priority 3: Generate random password
  const pw = generateRandomPassword(12);
  const config = { ...authStore.hashPassword(pw), mustChange: true, version: 2 };
  saveAuthConfigAtomic(config);
  console.log('========================================');
  console.log('  自动生成初始密码: ' + pw);
  console.log('  首次登录后将要求修改密码');
  console.log('========================================');
  return config;
}

function validatePasswordStrength(pw) {
  if (!pw || pw.length < 8) {
    return { valid: false, message: '密码长度至少 8 位' };
  }
  let types = 0;
  if (/[a-z]/.test(pw)) types++;
  if (/[A-Z]/.test(pw)) types++;
  if (/[0-9]/.test(pw)) types++;
  if (/[^a-zA-Z0-9]/.test(pw)) types++;
  if (types < 2) {
    return { valid: false, message: '密码需包含至少 2 种字符类型（大写/小写/数字/特殊字符）' };
  }
  return { valid: true, message: '' };
}

let authConfig = null;

function ensureAuthLoaded() {
  if (!authConfig) {
    authConfig = loadAuthConfig();
    // 启动时加载持久化 token（清过期）
    const { map, dirty } = authStore.loadTokens();
    // 转换为统一内存结构：digest -> { record, lastActive }
    tokenMemory = new Map();
    for (const [digest, rec] of map) {
      tokenMemory.set(digest, { record: rec, lastActive: Date.now() });
    }
    if (dirty) persistTokens();
  }
  return authConfig;
}

// 活跃 token：digest（sha256）-> { record, lastActive }
// record 含 issuedAt/expiresAt，lastActive 用于内存活跃续期
let tokenMemory = new Map();
const TOKEN_TTL = authStore.TOKEN_TTL_MS;

function persistTokens() {
  const records = Array.from(tokenMemory.values()).map((entry) => entry.record);
  authStore.saveTokens(records);
}

// 校验 token：内存命中优先（续期 lastActive + expiresAt），否则算 digest 比对磁盘
function isTokenValid(token) {
  if (!token || typeof token !== 'string') return false;
  const digest = authStore.digestOf(token);
  const now = Date.now();
  const hit = tokenMemory.get(digest);
  if (hit) {
    // 绝对过期（7d）：拒绝，不滚动续期
    const absExp = Date.parse(hit.record.absoluteExpiresAt || '');
    if (Number.isFinite(absExp) && absExp < now) {
      tokenMemory.delete(digest);
      persistTokens();
      return false;
    }
    const exp = Date.parse(hit.record.expiresAt || '');
    if (Number.isFinite(exp) && exp < now) {
      tokenMemory.delete(digest);
      persistTokens();
      return false;
    }
    // 续期：滚动 24h 活跃窗口（不动 absoluteExpiresAt）
    hit.lastActive = now;
    hit.record.expiresAt = new Date(now + TOKEN_TTL).toISOString();
    return true;
  }
  // 磁盘兜底（服务重启后内存空，但 token 仍可能在有效期内）
  const { map, dirty } = authStore.loadTokens();
  if (dirty) {
    // 重新写一次清理后的磁盘
    const cleaned = Array.from(map.values());
    authStore.saveTokens(cleaned);
  }
  const rec = map.get(digest);
  if (!rec) return false;
  const absExp = Date.parse(rec.absoluteExpiresAt || '');
  if (Number.isFinite(absExp) && absExp < now) return false;
  const exp = Date.parse(rec.expiresAt || '');
  if (Number.isFinite(exp) && exp < now) return false;
  tokenMemory.set(digest, { record: rec, lastActive: now });
  return true;
}

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [digest, entry] of tokenMemory) {
    const exp = Date.parse(entry.record.expiresAt || '');
    if (Number.isFinite(exp) && exp < now) {
      tokenMemory.delete(digest);
      changed = true;
    }
  }
  if (changed) persistTokens();
}, 6 * 60 * 60 * 1000).unref();

// === Anti-brute-force ===
const AUTH_FAIL_WINDOW = 5 * 60 * 1000; // 5 minutes
const AUTH_FAIL_MAX = 3;
const BAN_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days
const authFailures = new Map(); // ip -> [timestamp, ...]
let bannedIPs = new Map(); // ip -> expireTimestamp

// Tailscale / loopback whitelist — never ban these IPs.
// Extra whitelist can be provided via env var (comma/space separated):
//   CC_WEB_IP_WHITELIST="<ip1>,<ip2>"
const EXTRA_WHITELIST_IPS = new Set(
  String(process.env.CC_WEB_IP_WHITELIST || '')
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.replace(/^::ffff:/, ''))
);

// 可信代理 CIDR/IP 列表（仅这些来源的 X-Forwarded-For 才被信任）：
//   CC_WEB_TRUSTED_PROXIES="127.0.0.1,10.0.0.0/8,::1,2001:db8::/32"
// 默认空 = 不信任任何 XFF（最严格，clientIP = socket.remoteAddress）
// 文档必须强调：反向代理需主动清洗客户端伪造的 XFF 头
// （Nginx: proxy_set_header X-Forwarded-For $remote_addr;）
// 实现与单测见 lib/client-ip.js。
const clientIpResolver = createClientIpResolver(process.env.CC_WEB_TRUSTED_PROXIES);
const isTrustedProxy = clientIpResolver.isTrustedProxy;
const resolveClientIP = clientIpResolver.resolveClientIP;

function isWhitelistedIP(ip) {
  if (!ip) return false;
  const cleaned = ip.replace(/^::ffff:/, '');
  return cleaned === '127.0.0.1'
    || cleaned === '::1'
    || cleaned.startsWith('100.')
    || EXTRA_WHITELIST_IPS.has(cleaned);
}

function loadBannedIPs() {
  try {
    if (fs.existsSync(BANNED_IPS_PATH)) {
      const data = JSON.parse(fs.readFileSync(BANNED_IPS_PATH, 'utf8'));
      if (Array.isArray(data)) {
        const exp = Date.now() + BAN_DURATION;
        bannedIPs = new Map(data.map(ip => [ip, exp]));
      } else {
        bannedIPs = new Map(Object.entries(data).map(([ip, t]) => [ip, Number(t)]));
      }
    }
  } catch { bannedIPs = new Map(); }
}
function saveBannedIPs() {
  const obj = Object.fromEntries(bannedIPs);
  atomicWriteJson(BANNED_IPS_PATH, JSON.stringify(obj, null, 2));
}
loadBannedIPs();

function isBanned(ip) {
  if (!ip || !bannedIPs.has(ip)) return false;
  const exp = bannedIPs.get(ip);
  if (exp !== -1 && Date.now() > exp) {
    bannedIPs.delete(ip);
    saveBannedIPs();
    return false;
  }
  return true;
}

function recordAuthFailure(ip) {
  if (!ip || isWhitelistedIP(ip)) return false;
  const now = Date.now();
  let list = authFailures.get(ip) || [];
  list.push(now);
  list = list.filter(t => now - t < AUTH_FAIL_WINDOW);
  authFailures.set(ip, list);
  if (list.length >= AUTH_FAIL_MAX) {
    bannedIPs.set(ip, Date.now() + BAN_DURATION);
    saveBannedIPs();
    authFailures.delete(ip);
    plog('WARN', 'ip_banned', { ip, reason: `${AUTH_FAIL_MAX} failed auth in ${AUTH_FAIL_WINDOW / 1000}s` });
    return true;
  }
  return false;
}

// Pending slash command metadata: sessionId -> { kind: string }
const pendingSlashCommands = new Map();

// Pending compact retry metadata: sessionId -> { text: string, mode: string, reason: string }
const pendingCompactRetries = new Map();

// P2 预防性水位压缩阈值（%）：Claude resume 前读 transcript jsonl 水位，
// 达到 窗口大小 × 该比例 则先自动 /compact 再重放原消息（CC_WEB_AUTOCOMPACT_PCT 可调，收敛到 10-99）
const AUTOCOMPACT_PCT = Math.min(99, Math.max(10, parseInt(process.env.CC_WEB_AUTOCOMPACT_PCT, 10) || 80));

// P2 防循环护栏：已对本会话做过预防压缩、且尚未观察到一次正常完成前，不再重复预防压缩。
// 非压缩进程正常退出 / 手动 /compact / 删除会话 时解除。
const preemptCompactGuard = new Set();

// Per-session loop timers. Schedule data itself is persisted on session.loop.
const activeLoops = new Map();
const LOOP_MIN_INTERVAL_MS = 1000;
const LOOP_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Active processes: sessionId -> { pid, ws, fullText, toolCalls, lastCost, tailer }
const activeProcesses = new Map();

// Track which session each ws is viewing: ws -> sessionId
const wsSessionMap = new Map();

// Default fallback MODEL_MAP (overridden by model config at runtime)
// opus/sonnet use [1m] suffix to enable 1M context window by default
let MODEL_MAP = {
  opus: 'claude-opus-4-6[1m]',
  sonnet: 'claude-sonnet-4-6[1m]',
  haiku: 'claude-haiku-4-5-20251001',
};

const VALID_AGENTS = new Set(['claude', 'codex']);

// Final fallback only. New Codex sessions prefer:
// 1) active custom profile model
// 2) ~/.codex/config.toml top-level model
// 3) this constant
const DEFAULT_CODEX_MODEL = 'gpt-5.5';

// === Model Config ===
const DEFAULT_MODEL_CONFIG = {
  mode: 'local',      // 'local' | 'custom'
  templates: [],      // array of { name, apiKey, apiBase, defaultModel, opusModel, sonnetModel, haikuModel }
  activeTemplate: '', // name of active template (for 'custom' mode)
  localSnapshot: {},  // saved snapshot of local ~/.claude/settings.json API config
};

const DEFAULT_CODEX_CONFIG = {
  mode: 'local',
  activeProfile: '',
  profiles: [],
  enableSearch: false,
  supportsSearch: false,
  localSnapshot: {},  // saved snapshot of local ~/.codex config (archive-only, no restore)
};

function splitCodexModelSpec(model) {
  const raw = String(model || '').trim();
  if (!raw) return { raw: '', base: '', reasoning: '' };
  const match = raw.match(/^(.*)\((medium|high|xhigh)\)\s*$/i);
  if (!match) return { raw, base: raw, reasoning: '' };
  return {
    raw,
    base: String(match[1] || '').trim(),
    reasoning: String(match[2] || '').trim().toLowerCase(),
  };
}

function normalizeCodexModelList(models, defaultModel = '') {
  const seen = new Set();
  const list = [];

  function addModel(value) {
    const model = String(value || '').trim();
    if (!model || seen.has(model)) return;
    seen.add(model);
    list.push(model);
  }

  if (Array.isArray(models)) {
    models.forEach(addModel);
  }
  addModel(defaultModel);
  return list;
}

function readCodexLocalConfigSnapshot() {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const config = { apiKey: '', apiBase: '', model: '' };
  let sourceFound = false;
  let hasApiKey = false;

  const codexConfigToml = path.join(homeDir, '.codex', 'config.toml');
  try {
    if (fs.existsSync(codexConfigToml)) {
      sourceFound = true;
      const toml = fs.readFileSync(codexConfigToml, 'utf8');
      const baseMatch = toml.match(/base_url\s*=\s*"([^"]+)"/);
      const modelMatch = toml.match(/^\s*model\s*=\s*"([^"]+)"/m);
      if (baseMatch) config.apiBase = baseMatch[1];
      if (modelMatch) config.model = modelMatch[1];
    }
  } catch {}

  const codexAuthJson = path.join(homeDir, '.codex', 'auth.json');
  try {
    if (fs.existsSync(codexAuthJson)) {
      sourceFound = true;
      const auth = JSON.parse(fs.readFileSync(codexAuthJson, 'utf8'));
      if (auth.OPENAI_API_KEY) {
        config.apiKey = auth.OPENAI_API_KEY;
        hasApiKey = true;
      }
    }
  } catch {}

  return { config, sourceFound, hasApiKey };
}

function resolveDefaultCodexModel() {
  const codexConfig = loadCodexConfig();
  if (codexConfig.mode === 'custom' && codexConfig.activeProfile) {
    const activeProfile = (codexConfig.profiles || []).find((profile) => profile.name === codexConfig.activeProfile);
    const profileModel = String(activeProfile?.model || '').trim();
    return profileModel || DEFAULT_CODEX_MODEL;
  }
  const localModel = String(readCodexLocalConfigSnapshot().config.model || '').trim();
  return localModel || DEFAULT_CODEX_MODEL;
}

function loadModelConfig() {
  try {
    if (fs.existsSync(MODEL_CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(MODEL_CONFIG_PATH, 'utf8'));
      if (!config.localSnapshot) config.localSnapshot = {};
      return config;
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_MODEL_CONFIG));
}

function saveModelConfig(config) {
  atomicWriteJson(MODEL_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function loadCodexConfig() {
  try {
    if (fs.existsSync(CODEX_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CODEX_CONFIG_PATH, 'utf8'));
      return {
        mode: raw.mode === 'custom' ? 'custom' : 'local',
        activeProfile: raw.activeProfile || '',
        profiles: Array.isArray(raw.profiles) ? raw.profiles.map((profile) => ({
          name: String(profile?.name || '').trim(),
          apiKey: String(profile?.apiKey || ''),
          apiBase: String(profile?.apiBase || '').trim(),
          model: String(profile?.model || '').trim(),
          models: normalizeCodexModelList(profile?.models, profile?.model),
        })).filter((profile) => profile.name) : [],
        enableSearch: false,
        supportsSearch: false,
        storedEnableSearch: !!raw.enableSearch,
        localSnapshot: raw.localSnapshot || {},
      };
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_CODEX_CONFIG));
}

function saveCodexConfig(config) {
  atomicWriteJson(CODEX_CONFIG_PATH, JSON.stringify({
    mode: config.mode === 'custom' ? 'custom' : 'local',
    activeProfile: config.activeProfile || '',
    profiles: Array.isArray(config.profiles) ? config.profiles.map((profile) => ({
      name: String(profile?.name || '').trim(),
      apiKey: String(profile?.apiKey || ''),
      apiBase: String(profile?.apiBase || '').trim(),
      model: String(profile?.model || '').trim(),
      models: normalizeCodexModelList(profile?.models, profile?.model),
    })).filter((profile) => profile.name) : [],
    enableSearch: false,
  }, null, 2), 0o600);
}

function getCodexConfigMasked() {
  const config = loadCodexConfig();
  return {
    mode: config.mode === 'custom' ? 'custom' : 'local',
    activeProfile: config.activeProfile || '',
    profiles: (config.profiles || []).map((profile) => ({
      name: profile.name,
      apiKey: maskSecret(profile.apiKey),
      apiBase: profile.apiBase || '',
      model: profile.model || '',
      models: normalizeCodexModelList(profile.models, profile.model),
    })),
    enableSearch: false,
    supportsSearch: false,
    storedEnableSearch: !!config.storedEnableSearch,
    localSnapshot: config.localSnapshot || {},
  };
}

function maskSecret(str) {
  if (!str || str.length <= 8) return str ? '****' : '';
  return str.slice(0, 4) + '****' + str.slice(-4);
}

function getModelConfigMasked() {
  const config = loadModelConfig();
  return {
    mode: config.mode,
    activeTemplate: config.activeTemplate,
    templates: (config.templates || []).map(t => ({
      name: t.name,
      apiKey: maskSecret(t.apiKey),
      apiBase: t.apiBase || '',
      defaultModel: t.defaultModel || '',
      opusModel: t.opusModel || '',
      sonnetModel: t.sonnetModel || '',
      haikuModel: t.haikuModel || '',
    })),
    localSnapshot: config.localSnapshot || {},
  };
}

// === Dev Config (GitHub / SSH) ===
const DEV_CONFIG_PATH = path.join(CONFIG_DIR, 'dev.json');
const DEFAULT_DEV_CONFIG = { github: { token: '', repos: [] }, ssh: { hosts: [] }, cloudflare: { apiToken: '', zones: [] } };

function loadDevConfig() {
  try {
    if (fs.existsSync(DEV_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(DEV_CONFIG_PATH, 'utf8'));
      return {
        github: {
          token: raw.github?.token || '',
          repos: Array.isArray(raw.github?.repos) ? raw.github.repos : [],
        },
        ssh: {
          hosts: Array.isArray(raw.ssh?.hosts) ? raw.ssh.hosts : [],
        },
        cloudflare: {
          apiToken: raw.cloudflare?.apiToken || '',
          zones: Array.isArray(raw.cloudflare?.zones) ? raw.cloudflare.zones : [],
        },
      };
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_DEV_CONFIG));
}

function saveDevConfig(config) {
  atomicWriteJson(DEV_CONFIG_PATH, JSON.stringify(config, null, 2), 0o600);
}

function getDevConfigMasked() {
  const config = loadDevConfig();
  return {
    github: {
      token: maskSecret(config.github.token),
      repos: config.github.repos || [],
    },
    ssh: {
      hosts: (config.ssh.hosts || []).map(h => ({
        id: h.id || '',
        name: h.name || '',
        host: h.host || '',
        port: h.port || 22,
        user: h.user || '',
        authType: h.authType || 'key',
        identityFile: h.identityFile || '',
        password: maskSecret(h.password || ''),
        description: h.description || '',
      })),
    },
    cloudflare: {
      apiToken: maskSecret(config.cloudflare.apiToken),
      zones: (config.cloudflare.zones || []).map(z => ({
        id: z.id || '',
        name: z.name || '',
        notes: z.notes || '',
      })),
    },
  };
}

function handleSaveDevConfig(ws, msg) {
  if (!msg.config || typeof msg.config !== 'object') {
    return wsSend(ws, { type: 'error', message: '无效的开发者配置' });
  }
  const current = loadDevConfig();
  let token = String(msg.config.github?.token || '');
  // Mask merge: keep existing if masked
  if (token.includes('****')) token = current.github.token;
  const repos = Array.isArray(msg.config.github?.repos) ? msg.config.github.repos.map(r => ({
    id: r.id || ('r_' + crypto.randomBytes(4).toString('hex')),
    name: String(r.name || '').trim(),
    url: String(r.url || '').trim(),
    branch: String(r.branch || 'main').trim(),
    notes: String(r.notes || '').trim(),
  })).filter(r => r.name && r.url) : [];
  const oldHosts = Array.isArray(current.ssh?.hosts) ? current.ssh.hosts : [];
  const hosts = Array.isArray(msg.config.ssh?.hosts) ? msg.config.ssh.hosts.map(h => {
    const old = oldHosts.find(oh => oh.id === h.id || oh.name === h.name);
    const authType = h.authType === 'password' ? 'password' : 'key';
    let password = String(h.password || '');
    if (password.includes('****')) password = old?.password || '';
    return {
      id: h.id || ('h_' + crypto.randomBytes(4).toString('hex')),
      name: String(h.name || '').trim(),
      host: String(h.host || '').trim(),
      port: parseInt(h.port) || 22,
      user: String(h.user || '').trim(),
      authType,
      identityFile: authType === 'key' ? String(h.identityFile || '').trim() : '',
      password: authType === 'password' ? password : '',
      description: String(h.description || '').trim(),
    };
  }).filter(h => h.name && h.host) : [];
  const cfToken = String(msg.config.cloudflare?.apiToken || '');
  // Mask merge: keep existing if masked (aligned with github token)
  const resolvedCfToken = cfToken.includes('****') ? (current.cloudflare?.apiToken || '') : cfToken;
  const zones = Array.isArray(msg.config.cloudflare?.zones) ? msg.config.cloudflare.zones.map(z => ({
    id: z.id || ('z_' + crypto.randomBytes(4).toString('hex')),
    name: String(z.name || '').trim(),
    notes: String(z.notes || '').trim(),
  })).filter(z => z.name) : [];
  const merged = { github: { token, repos }, ssh: { hosts }, cloudflare: { apiToken: resolvedCfToken, zones } };
  saveDevConfig(merged);
  plog('INFO', 'dev_config_saved', { repoCount: repos.length, hostCount: hosts.length, zoneCount: zones.length });
  wsSend(ws, { type: 'dev_config', config: getDevConfigMasked() });
  wsSend(ws, { type: 'system_message', message: '开发者配置已保存' });
}

const CODEX_RUNTIME_HOME = path.join(CONFIG_DIR, 'codex-runtime-home');

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

function normalizeCodexRuntimeApiBase(apiBase) {
  const raw = String(apiBase || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/v1';
      return url.toString().replace(/\/+$/, '');
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return raw;
  }
}

function codexSessionHomeDir(sessionId) {
  return path.join(CONFIG_DIR, 'codex-session-home', sanitizeId(sessionId || 'default'));
}

function walkJsonlFiles(dir, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonlFiles(fullPath, files);
    else if (entry.isFile() && fullPath.endsWith('.jsonl')) files.push(fullPath);
  }
  return files;
}

function copyCodexThreadRollouts(threadId, targetHomeDir) {
  if (!threadId || !targetHomeDir) return;
  const targetSessionsDir = path.join(targetHomeDir, 'sessions');
  fs.mkdirSync(targetSessionsDir, { recursive: true });
  const sourceDirs = [CODEX_SESSIONS_DIR, path.join(CODEX_RUNTIME_HOME, 'sessions')];
  for (const sourceDir of sourceDirs) {
    try {
      for (const filePath of walkJsonlFiles(sourceDir)) {
        if (!filePath.includes(threadId)) continue;
        const rel = path.relative(sourceDir, filePath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
        const target = path.join(targetSessionsDir, rel);
        if (fs.existsSync(target)) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(filePath, target);
      }
    } catch {}
  }
}

function prepareCodexLocalRuntimeHome(homeDir) {
  fs.mkdirSync(homeDir, { recursive: true });
  const sourceHome = path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex');
  for (const filename of ['config.toml', 'auth.json']) {
    try {
      const source = path.join(sourceHome, filename);
      if (!fs.existsSync(source)) continue;
      fs.copyFileSync(source, path.join(homeDir, filename));
    } catch {}
  }
}

function ensureCodexSessionHome(session) {
  if (!session?.id) return CODEX_RUNTIME_HOME;
  if (!session.codexHomeDir) session.codexHomeDir = codexSessionHomeDir(session.id);
  if (session.codexThreadId) copyCodexThreadRollouts(session.codexThreadId, session.codexHomeDir);
  fs.mkdirSync(session.codexHomeDir, { recursive: true });
  return session.codexHomeDir;
}

function prepareCodexCustomRuntime(config, session = null) {
  const homeDir = ensureCodexSessionHome(session);
  if (!config || config.mode !== 'custom') {
    prepareCodexLocalRuntimeHome(homeDir);
    if (session) {
      session.codexHomeDir = homeDir;
      session.codexRuntimeKey = 'local';
    }
    return { mode: 'local', homeDir, runtimeKey: 'local' };
  }
  const profiles = Array.isArray(config.profiles) ? config.profiles : [];
  const activeProfile = profiles.find((profile) => profile.name === config.activeProfile) || null;
  if (!activeProfile) {
    return { error: 'Codex 自定义配置缺少已激活的 profile。请先在设置中创建并激活一个 API 配置。' };
  }
  if (!activeProfile.apiKey || !activeProfile.apiBase) {
    return { error: `Codex profile「${activeProfile.name}」缺少 API Key 或 API Base URL。` };
  }

  fs.mkdirSync(homeDir, { recursive: true });
  const modelSpec = splitCodexModelSpec(activeProfile.model || DEFAULT_CODEX_MODEL);
  const runtimeApiBase = normalizeCodexRuntimeApiBase(activeProfile.apiBase);
  const configToml = [
    'preferred_auth_method = "apikey"',
    'model_provider = "openai_compat"',
    ...(modelSpec.base ? [`model = ${tomlString(modelSpec.base)}`] : []),
    ...(modelSpec.reasoning ? [`model_reasoning_effort = ${tomlString(modelSpec.reasoning)}`] : []),
    '',
    '[model_providers.openai_compat]',
    `name = ${tomlString(activeProfile.name || 'OpenAI Compat')}`,
    `base_url = ${tomlString(runtimeApiBase)}`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(homeDir, 'config.toml'), configToml);
  if (session) {
    session.codexHomeDir = homeDir;
    session.codexRuntimeKey = `custom:${activeProfile.name}`;
  }

  return {
    mode: 'custom',
    homeDir,
    apiKey: activeProfile.apiKey,
    apiBase: runtimeApiBase,
    model: activeProfile.model || '',
    runtimeKey: `custom:${activeProfile.name}`,
    profileName: activeProfile.name,
  };
}

// Read ~/.claude.json for model name overrides
function loadClaudeJsonModelMap() {
  try {
    const p = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude.json');
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const env = raw?.env || {};
    const map = {};
    // Append [1m] to opus/sonnet for 1M context window; haiku uses model name as-is
    if (env.ANTHROPIC_DEFAULT_OPUS_MODEL) map.opus = env.ANTHROPIC_DEFAULT_OPUS_MODEL + '[1m]';
    if (env.ANTHROPIC_DEFAULT_SONNET_MODEL) map.sonnet = env.ANTHROPIC_DEFAULT_SONNET_MODEL + '[1m]';
    if (env.ANTHROPIC_DEFAULT_HAIKU_MODEL) map.haiku = env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    // Fallback: ANTHROPIC_MODEL maps to opus slot
    if (!map.opus && env.ANTHROPIC_MODEL) map.opus = env.ANTHROPIC_MODEL + '[1m]';
    return Object.keys(map).length > 0 ? map : null;
  } catch {
    return null;
  }
}

// Apply model config to runtime MODEL_MAP only (env vars are injected per-spawn, not here)
const CLAUDE_SETTINGS_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'settings.json');
const SETTINGS_API_KEYS = ['ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_REASONING_MODEL'];

function applyCustomTemplateToSettings(tpl) {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8')); } catch {}
  const cleanedEnv = {};
  for (const [k, v] of Object.entries(settings.env || {})) {
    if (!SETTINGS_API_KEYS.includes(k)) cleanedEnv[k] = v;
  }
  if (tpl.apiKey)       { cleanedEnv.ANTHROPIC_AUTH_TOKEN = tpl.apiKey; }
  if (tpl.apiBase)      cleanedEnv.ANTHROPIC_BASE_URL = tpl.apiBase;
  if (tpl.defaultModel) cleanedEnv.ANTHROPIC_MODEL = tpl.defaultModel;
  if (tpl.opusModel)    cleanedEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = tpl.opusModel;
  if (tpl.sonnetModel)  cleanedEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = tpl.sonnetModel;
  if (tpl.haikuModel)   cleanedEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = tpl.haikuModel;
  settings.env = cleanedEnv;
  // 原子写入：先写临时文件再 rename，避免 Claude 子进程读到写了一半的文件
  const tmpPath = CLAUDE_SETTINGS_PATH + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
    fs.renameSync(tmpPath, CLAUDE_SETTINGS_PATH);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

function applyModelConfig() {
  const config = loadModelConfig();
  if (config.mode === 'custom' && config.activeTemplate) {
    const tpl = (config.templates || []).find(t => t.name === config.activeTemplate);
    if (tpl) {
      if (tpl.opusModel) MODEL_MAP.opus = tpl.opusModel.endsWith('[1m]') ? tpl.opusModel : tpl.opusModel + '[1m]';
      if (tpl.sonnetModel) MODEL_MAP.sonnet = tpl.sonnetModel.endsWith('[1m]') ? tpl.sonnetModel : tpl.sonnetModel + '[1m]';
      if (tpl.haikuModel) MODEL_MAP.haiku = tpl.haikuModel;
      return;
    }
  }
  // mode === 'local': read model names from ~/.claude.json
  const localMap = loadClaudeJsonModelMap();
  if (localMap) {
    if (localMap.opus) MODEL_MAP.opus = localMap.opus;
    if (localMap.sonnet) MODEL_MAP.sonnet = localMap.sonnet;
    if (localMap.haiku) MODEL_MAP.haiku = localMap.haiku;
  }
}

// Apply on startup
applyModelConfig();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// === Utility Functions ===

const WS_BACKLOG_LIMIT = 4 * 1024 * 1024; // 4MB per socket

function wsSend(ws, data, dropIfBacklogged = false) {
  if (!ws || ws.readyState !== 1) return;
  if (dropIfBacklogged && ws.bufferedAmount > WS_BACKLOG_LIMIT) return;
  ws.send(JSON.stringify(data));
}

function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9\-]/g, '');
}

function sessionPath(id) {
  return path.join(SESSIONS_DIR, `${sanitizeId(id)}.json`);
}

function runDir(sessionId) {
  return path.join(SESSIONS_DIR, `${sanitizeId(sessionId)}-run`);
}

function attachmentDataPath(id, ext = '') {
  return path.join(ATTACHMENTS_DIR, `${sanitizeId(id)}${ext}`);
}

function attachmentMetaPath(id) {
  return path.join(ATTACHMENTS_DIR, `${sanitizeId(id)}.json`);
}

function safeFilename(name) {
  return String(name || 'image')
    .replace(/[\/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'image';
}

function extFromMime(mime) {
  switch (mime) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    default: return '';
  }
}

function loadAttachmentMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(attachmentMetaPath(id), 'utf8'));
  } catch {
    return null;
  }
}

function saveAttachmentMeta(meta) {
  atomicWriteJson(attachmentMetaPath(meta.id), JSON.stringify(meta, null, 2));
}

function removeAttachmentById(id) {
  const meta = loadAttachmentMeta(id);
  const paths = new Set([attachmentMetaPath(id)]);
  if (meta?.path) paths.add(meta.path);
  for (const filePath of paths) {
    try {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
  }
}

function currentAttachmentState(meta) {
  if (!meta) return 'missing';
  const expiresAtMs = new Date(meta.expiresAt || 0).getTime();
  if (expiresAtMs && Date.now() > expiresAtMs) return 'expired';
  if (!meta.path || !fs.existsSync(meta.path)) return 'missing';
  return 'available';
}

function normalizeMessageAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  const normalized = [];
  for (const attachment of attachments) {
    const id = sanitizeId(attachment?.id || '');
    if (!id) continue;
    const meta = loadAttachmentMeta(id);
    const state = currentAttachmentState(meta);
    if (state === 'expired') removeAttachmentById(id);
    normalized.push({
      id,
      kind: 'image',
      filename: meta?.filename || attachment?.filename || 'image',
      mime: meta?.mime || attachment?.mime || 'image/png',
      size: meta?.size || attachment?.size || 0,
      createdAt: meta?.createdAt || attachment?.createdAt || null,
      expiresAt: meta?.expiresAt || attachment?.expiresAt || null,
      storageState: state === 'available' ? 'available' : 'expired',
    });
  }
  return normalized;
}

function resolveMessageAttachments(attachments) {
  const resolved = [];
  for (const attachment of normalizeMessageAttachments(attachments)) {
    if (attachment.storageState !== 'available') continue;
    const meta = loadAttachmentMeta(attachment.id);
    if (!meta?.path || !fs.existsSync(meta.path)) continue;
    resolved.push({
      ...attachment,
      path: meta.path,
    });
  }
  return resolved;
}

function cleanupExpiredAttachments() {
  try {
    const files = fs.readdirSync(ATTACHMENTS_DIR).filter((name) => name.endsWith('.json'));
    for (const file of files) {
      const id = file.replace(/\.json$/, '');
      const meta = loadAttachmentMeta(id);
      if (!meta || currentAttachmentState(meta) === 'expired') {
        removeAttachmentById(id);
      }
    }
  } catch {}
}

function collectSessionAttachmentIds(session) {
  const ids = new Set();
  for (const message of Array.isArray(session?.messages) ? session.messages : []) {
    for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
      const id = sanitizeId(attachment?.id || '');
      if (id) ids.add(id);
    }
  }
  return Array.from(ids);
}

function extractBearerToken(req) {
  const authHeader = String(req.headers.authorization || '');
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : '';
}

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(JSON.stringify(payload));
}

const INITIAL_HISTORY_COUNT = 12;
const HISTORY_CHUNK_SIZE = 24;

function normalizeAgent(agent) {
  return VALID_AGENTS.has(agent) ? agent : 'claude';
}

/**
 * 会话对象加载时归一化字段默认值（前向兼容）。
 *
 * **新增字段必须在此设默认值**，否则旧 session 加载时会是 undefined。
 *
 * 当前在此设默认值的字段：agent / claudeSessionId / codexThreadId /
 * codexHomeDir / codexRuntimeKey / totalCost / totalUsage / taskMode /
 * sshHostId / remoteCwd / messages。
 *
 * 注意：permissionMode / hasUnread / updated **不**在此设默认值：
 *   - permissionMode 由 handleNewSession / handleMessage 创建时显式赋值（默认 'yolo'）
 *   - hasUnread 由消息处理路径动态置位
 *   - updated 由各业务路径写入
 *
 * 详见 docs/RUNTIME.md "Session 对象关键字段"。
 *
 * @param {object} session - 原始 session 对象
 * @returns {object} 归一化后的 session（原地修改）
 */
function normalizeSession(session) {
  if (!session || typeof session !== 'object') return session;
  session.agent = normalizeAgent(session.agent);
  if (!Object.prototype.hasOwnProperty.call(session, 'claudeSessionId')) session.claudeSessionId = null;
  if (!Object.prototype.hasOwnProperty.call(session, 'codexThreadId')) session.codexThreadId = null;
  if (!Object.prototype.hasOwnProperty.call(session, 'codexHomeDir')) session.codexHomeDir = '';
  if (!Object.prototype.hasOwnProperty.call(session, 'codexRuntimeKey')) session.codexRuntimeKey = '';
  if (!Object.prototype.hasOwnProperty.call(session, 'totalCost')) session.totalCost = 0;
  if (!Object.prototype.hasOwnProperty.call(session, 'totalUsage') || !session.totalUsage) {
    session.totalUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  }
  if (!Object.prototype.hasOwnProperty.call(session, 'taskMode')) session.taskMode = 'local';
  if (!Object.prototype.hasOwnProperty.call(session, 'sshHostId')) session.sshHostId = '';
  if (!Object.prototype.hasOwnProperty.call(session, 'remoteCwd')) session.remoteCwd = '';
  if (!Object.prototype.hasOwnProperty.call(session, 'group')) session.group = '';
  if (!Object.prototype.hasOwnProperty.call(session, 'loop')) session.loop = null;
  if (session.loop) {
    const intervalMs = Number(session.loop.intervalMs);
    const prompt = typeof session.loop.prompt === 'string' ? session.loop.prompt.trim() : '';
    if (!Number.isFinite(intervalMs) || intervalMs < LOOP_MIN_INTERVAL_MS || intervalMs > LOOP_MAX_INTERVAL_MS || !prompt) {
      session.loop = null;
    } else {
      session.loop = {
        intervalMs,
        prompt,
        nextRunAt: typeof session.loop.nextRunAt === 'string' ? session.loop.nextRunAt : new Date().toISOString(),
      };
    }
  }
  if (!Object.prototype.hasOwnProperty.call(session, 'messages')) session.messages = [];
  if (Array.isArray(session.messages)) {
    session.messages = session.messages.map((message) => {
      if (!message || typeof message !== 'object') return message;
      if (message.attachments) {
        return { ...message, attachments: normalizeMessageAttachments(message.attachments) };
      }
      return message;
    });
  }
  return session;
}

function getSessionAgent(session) {
  return normalizeAgent(session?.agent);
}

function isClaudeSession(session) {
  return getSessionAgent(session) === 'claude';
}

function getRuntimeSessionId(session) {
  if (!session) return null;
  return getSessionAgent(session) === 'codex'
    ? (session.codexThreadId || null)
    : (session.claudeSessionId || null);
}

function setRuntimeSessionId(session, runtimeId) {
  if (!session) return;
  if (getSessionAgent(session) === 'codex') {
    session.codexThreadId = runtimeId || null;
  } else {
    session.claudeSessionId = runtimeId || null;
  }
}

function clearRuntimeSessionId(session) {
  setRuntimeSessionId(session, null);
}

function loadSession(id) {
  try {
    return normalizeSession(JSON.parse(fs.readFileSync(sessionPath(id), 'utf8')));
  } catch {
    return null;
  }
}

// 原子写 JSON（tmp + rename）：防止崩溃导致 JSON 文件半写状态损坏。
// 不 fsync（session 数据非高敏感，重启丢失可接受；敏感数据如 tokens.json 由 auth.js 自己原子写）。
// mode 可选：含密钥的配置（dev.json/codex.json）必须传 0o600 防止 umask 漏洞让同机用户读到。
function atomicWriteJson(filePath, data, mode) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `.${base}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const writeOpts = mode != null ? { mode } : {};
  fs.writeFileSync(tmp, data, writeOpts);
  if (mode != null) {
    try { fs.chmodSync(tmp, mode); } catch {}
  }
  fs.renameSync(tmp, filePath);
}

function saveSession(session) {
  normalizeSession(session);
  atomicWriteJson(sessionPath(session.id), JSON.stringify(session, null, 2));
}

function modelShortName(fullModel) {
  if (!fullModel) return null;
  const entry = Object.entries(MODEL_MAP).find(([, v]) => v === fullModel);
  return entry ? entry[0] : null;
}

function sessionModelLabel(session) {
  if (!session?.model) return null;
  return isClaudeSession(session) ? (modelShortName(session.model) || session.model) : session.model;
}

function splitHistoryMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length <= INITIAL_HISTORY_COUNT) {
    return { recentMessages: list, olderChunks: [] };
  }
  const recentMessages = list.slice(-INITIAL_HISTORY_COUNT);
  const older = list.slice(0, -INITIAL_HISTORY_COUNT);
  const olderChunks = [];
  for (let end = older.length; end > 0; end -= HISTORY_CHUNK_SIZE) {
    const start = Math.max(0, end - HISTORY_CHUNK_SIZE);
    olderChunks.push(older.slice(start, end));
  }
  return { recentMessages, olderChunks };
}

const IS_WIN = process.platform === 'win32';

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcess(pid, force = false) {
  if (!pid) return;
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    if (IS_WIN) {
      // taskkill /T 递归杀整棵进程树
      const args = ['/T', '/PID', String(pid)];
      if (force) args.unshift('/F');
      spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    } else {
      // detached spawn 时子进程是 pgid leader，杀整个进程组（避免孙子进程成孤儿继续烧 token）
      // 先尝试 -pid（进程组），失败回退到单 pid
      try {
        process.kill(-pid, signal);
      } catch {
        process.kill(pid, signal);
      }
    }
  } catch {}
}

function cleanRunDir(sessionId) {
  const dir = runDir(sessionId);
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  } catch {}
}

function sendSessionList(ws) {
  try {
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    const sessions = [];
    for (const f of files) {
      try {
        const s = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')));
        sessions.push({
          id: s.id,
          title: s.title || 'Untitled',
          updated: s.updated,
          hasUnread: !!s.hasUnread,
          agent: getSessionAgent(s),
          isRunning: activeProcesses.has(s.id),
          group: s.group || '',
        });
      } catch {}
    }
    sessions.sort((a, b) => new Date(b.updated) - new Date(a.updated));
    wsSend(ws, { type: 'session_list', sessions });
  } catch {
    wsSend(ws, { type: 'session_list', sessions: [] });
  }
}

// === 会话分组（groups.json） ===
// 损坏文件容错：解析失败回退空分组（会话侧仅丢失归组信息，不阻塞启动）
function loadGroups() {
  try {
    const raw = JSON.parse(fs.readFileSync(GROUPS_CONFIG_PATH, 'utf8'));
    if (!raw || !Array.isArray(raw.groups)) return [];
    return raw.groups
      .filter((g) => g && typeof g.id === 'string' && typeof g.name === 'string' && g.id && g.name)
      .map((g) => ({ id: g.id, name: g.name, created: typeof g.created === 'string' ? g.created : new Date().toISOString() }));
  } catch {
    return [];
  }
}

const groups = loadGroups();

function saveGroups() {
  atomicWriteJson(GROUPS_CONFIG_PATH, JSON.stringify({ groups }, null, 2));
}

function sendGroupList(ws) {
  wsSend(ws, { type: 'group_list', groups: groups.map((g) => ({ id: g.id, name: g.name })) });
}

// 分组/归组变更后向所有已认证连接广播 group_list + session_list（多设备同步，
// 遍历写法对齐 handleChangePassword 的踢人遍历，但不 close 连接）
function broadcastGroupUpdate() {
  for (const client of wss.clients) {
    if (client._ccwebAuthed && client.readyState === 1) {
      sendGroupList(client);
      sendSessionList(client);
    }
  }
}

function getSessionIdsInGroup(groupId) {
  const ids = [];
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))) {
      try {
        const s = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')));
        if ((s.group || '') === groupId) ids.push(s.id);
      } catch {}
    }
  } catch {}
  return ids;
}

function handleGroupCreate(ws, msg) {
  const name = typeof msg?.name === 'string' ? msg.name.trim() : '';
  if (!name) return wsSend(ws, { type: 'error', message: '分组名不能为空' });
  if (groups.some((g) => g.name === name)) {
    return wsSend(ws, { type: 'error', message: `分组「${name}」已存在` });
  }
  groups.push({ id: 'g_' + crypto.randomBytes(4).toString('hex'), name: name.slice(0, 50), created: new Date().toISOString() });
  saveGroups();
  plog('INFO', 'group_create', {});
  broadcastGroupUpdate();
}

function handleGroupRename(ws, msg) {
  const group = groups.find((g) => g.id === msg?.groupId);
  if (!group) return wsSend(ws, { type: 'error', message: '分组不存在' });
  const name = typeof msg?.name === 'string' ? msg.name.trim() : '';
  if (!name) return wsSend(ws, { type: 'error', message: '分组名不能为空' });
  if (groups.some((g) => g.name === name && g.id !== group.id)) {
    return wsSend(ws, { type: 'error', message: `分组「${name}」已存在` });
  }
  group.name = name.slice(0, 50);
  saveGroups();
  plog('INFO', 'group_rename', {});
  broadcastGroupUpdate();
}

function handleGroupDelete(ws, msg) {
  const group = groups.find((g) => g.id === msg?.groupId);
  if (!group) return wsSend(ws, { type: 'error', message: '分组不存在' });
  // 语义：先删组内全部会话（复用单删清理逻辑），再移除分组
  const sessionIds = getSessionIdsInGroup(group.id);
  groups.splice(groups.indexOf(group), 1);
  saveGroups();
  for (const sessionId of sessionIds) {
    try { deleteSessionCleanup(sessionId); } catch {}
  }
  plog('INFO', 'group_delete', { deletedSessions: sessionIds.length });
  broadcastGroupUpdate();
}

function handleSessionMove(ws, msg) {
  const sessionId = msg?.sessionId;
  const groupId = msg?.groupId == null ? '' : String(msg.groupId);
  if (!sessionId) return wsSend(ws, { type: 'error', message: '缺少 sessionId' });
  if (groupId && !groups.some((g) => g.id === groupId)) {
    return wsSend(ws, { type: 'error', message: '分组不存在' });
  }
  const session = loadSession(sessionId);
  if (!session) return wsSend(ws, { type: 'error', message: '会话不存在' });
  if ((session.group || '') === groupId) return; // no-op：归组未变化直接忽略
  session.group = groupId;
  // 注意：不改 session.updated —— 归组不算会话活动，避免列表时间戳跳动
  saveSession(session);
  plog('INFO', 'session_move', { sessionId: sessionId.slice(0, 8) });
  broadcastGroupUpdate();
}

function parseLoopInterval(value) {
  const match = String(value || '').trim().match(/^(\d+)(s|m|h)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === 'h' ? 60 * 60 * 1000 : unit === 'm' ? 60 * 1000 : 1000;
  const intervalMs = amount * multiplier;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < LOOP_MIN_INTERVAL_MS || intervalMs > LOOP_MAX_INTERVAL_MS) return null;
  return intervalMs;
}

function formatLoopInterval(intervalMs) {
  if (intervalMs % (60 * 60 * 1000) === 0) return `${intervalMs / (60 * 60 * 1000)}h`;
  if (intervalMs % (60 * 1000) === 0) return `${intervalMs / (60 * 1000)}m`;
  return `${intervalMs / 1000}s`;
}

function getSessionSocket(sessionId) {
  for (const [ws, viewedSessionId] of wsSessionMap) {
    if (viewedSessionId === sessionId && ws.readyState === 1) return ws;
  }
  return null;
}

function stopSessionLoop(sessionId) {
  const timer = activeLoops.get(sessionId);
  if (timer) clearTimeout(timer);
  activeLoops.delete(sessionId);
}

function scheduleSessionLoop(sessionId) {
  stopSessionLoop(sessionId);
  const session = loadSession(sessionId);
  if (!session?.loop) return;
  const dueAt = Date.parse(session.loop.nextRunAt);
  const delay = Math.max(0, (Number.isFinite(dueAt) ? dueAt : Date.now()) - Date.now());
  activeLoops.set(sessionId, setTimeout(() => runSessionLoop(sessionId), delay));
}

function runSessionLoop(sessionId) {
  activeLoops.delete(sessionId);
  const session = loadSession(sessionId);
  if (!session?.loop) return;

  const { intervalMs, prompt } = session.loop;
  session.loop.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  session.updated = new Date().toISOString();
  saveSession(session);
  scheduleSessionLoop(sessionId);

  const ws = getSessionSocket(sessionId);
  if (activeProcesses.has(sessionId)) {
    wsSend(ws, { type: 'system_message', message: `◎ Loop · 当前任务仍在运行，已跳过本轮；下次 ${formatLoopInterval(intervalMs)} 后重试。` });
    return;
  }

  wsSend(ws, { type: 'system_message', message: `◎ Loop · 正在执行周期提示：${prompt}` });
  handleMessage(ws, {
    text: prompt,
    sessionId,
    mode: session.permissionMode || 'yolo',
    agent: getSessionAgent(session),
  }, { hideInHistory: true });
}

function restoreSessionLoops() {
  try {
    for (const file of fs.readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith('.json')) continue;
      const session = loadSession(path.basename(file, '.json'));
      if (session?.loop) scheduleSessionLoop(session.id);
    }
  } catch (err) {
    plog('WARN', 'loop_restore_failed', { error: err.message });
  }
}

// === File Tailer ===
/**
 * 增量 tail 文件，遇到完整行回调 onLine。
 *
 * 双保险机制：fs.watch() 监听 + 500ms 备份轮询。按字节偏移只读新内容，
 * 缓冲半截 JSON 行直到 newline。
 *
 * 主要用途：tail sessions/<id>-run/output.jsonl 把 Claude/Codex 流式输出
 * 推回前端。详见 docs/RUNTIME.md "FileTailer"。
 */
class FileTailer {
  constructor(filePath, onLine) {
    this.filePath = filePath;
    this.onLine = onLine;
    this.offset = 0;
    this.buffer = '';
    this.watcher = null;
    this.interval = null;
    this.stopped = false;
  }

  start() {
    this.readNew();
    try {
      this.watcher = fs.watch(this.filePath, () => {
        if (!this.stopped) this.readNew();
      });
      this.watcher.on('error', () => {});
    } catch {}
    // Backup poll every 500ms (fs.watch not always reliable on all systems)
    this.interval = setInterval(() => {
      if (!this.stopped) this.readNew();
    }, 500);
  }

  readNew() {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size <= this.offset) return;
      const buf = Buffer.alloc(stat.size - this.offset);
      const fd = fs.openSync(this.filePath, 'r');
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      fs.closeSync(fd);
      this.offset = stat.size;
      this.buffer += buf.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) this.onLine(line);
      }
    } catch {}
  }

  stop() {
    this.stopped = true;
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }
}

// === Process Lifecycle ===

function firstMeaningfulLine(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function condenseRuntimeError(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const usageIndex = lines.findIndex((line) => /^Usage:/i.test(line));
  if (usageIndex >= 0) return lines.slice(0, usageIndex).join(' ');
  return lines.slice(0, 3).join(' ');
}

function formatRuntimeError(agent, raw, context = {}) {
  const condensed = condenseRuntimeError(raw);
  const exitInfo = typeof context.exitCode === 'number' ? `（退出码 ${context.exitCode}）` : '';
  if (!condensed) {
    return agent === 'codex'
      ? `Codex 任务异常结束${exitInfo}，但 CLI 没有返回更多错误信息。`
      : `Claude 任务异常结束${exitInfo}，但 CLI 没有返回更多错误信息。`;
  }

  if (agent === 'codex') {
    if (/stream disconnected before completion|stream closed before response\.completed|response\.completed/i.test(condensed)) {
      return 'Codex 上游响应流提前中断：当前自定义 API 的 Responses 流式协议没有完整发送 response.completed。请检查该 API 端点是否完整兼容 OpenAI Responses SSE，或切回确认兼容的 API 模板。';
    }
    if (/ENOENT|not found|No such file/i.test(condensed)) {
      return '找不到 Codex CLI。请检查 Codex 设置里的 CLI 路径，或确认系统 PATH 中可直接运行 `codex`。';
    }
    if (/unexpected argument|unexpected option|Usage:\s*codex/i.test(raw || '')) {
      return `Codex CLI 参数不兼容：${firstMeaningfulLine(condensed)}。建议检查当前 CLI 版本与 cc-web 的参数约定是否匹配。`;
    }
    if (/permission denied|EACCES|EPERM/i.test(condensed)) {
      return 'Codex CLI 启动失败：当前环境没有足够权限执行该命令或访问目标目录。';
    }
    if (/authentication|unauthorized|forbidden|login|api key|credential/i.test(condensed)) {
      return 'Codex 鉴权失败。请确认本机 Codex CLI 已完成登录，且当前凭据仍然有效。';
    }
    if (/rate limit|quota|billing|credits/i.test(condensed)) {
      return 'Codex 请求被额度或速率限制拦截。请检查账号配额、计费状态或稍后重试。';
    }
    if (/network|timed out|timeout|ECONNRESET|ENOTFOUND|TLS|certificate|fetch failed/i.test(condensed)) {
      return 'Codex 运行时网络请求失败。请检查当前网络、代理或证书环境后重试。';
    }
    if (/sandbox|approval|read-only|bypass-approvals/i.test(condensed)) {
      return `Codex 当前的审批或沙箱设置阻止了这次执行：${firstMeaningfulLine(condensed)}`;
    }
    return `Codex 任务失败${exitInfo}：${condensed}`;
  }

  if (/ENOENT|not found|No such file/i.test(condensed)) {
    return '找不到 Claude CLI。请检查当前环境是否能直接运行 `claude`。';
  }
  if (/authentication|unauthorized|forbidden|api key|credential/i.test(condensed)) {
    return 'Claude 鉴权失败。请确认本机 Claude CLI 已完成登录，且凭据仍然有效。';
  }
  return `Claude 任务失败${exitInfo}：${condensed}`;
}

function compactStartMessage(agent) {
  return agent === 'codex'
    ? '正在执行 Codex /compact 压缩上下文，请稍候…'
    : '正在执行 Claude 原生 /compact 压缩上下文，请稍候…';
}

function compactDoneMessage(agent) {
  return agent === 'codex'
    ? '上下文压缩完成。已执行 Codex /compact，下次继续在同一会话发送即可。'
    : '上下文压缩完成。已按 Claude Code 原生策略执行 /compact，下次继续在同一会话发送即可。';
}

function initStartMessage(agent) {
  return agent === 'codex'
    ? '正在分析项目并生成 AGENTS.md ...'
    : '正在分析项目并生成 CLAUDE.md ...';
}

function buildCodexInitPrompt(cwd) {
  const targetPath = path.join(cwd || process.cwd(), 'AGENTS.md');
  return [
    'You are running cc-web\'s /init for a Codex session.',
    'Analyze the current workspace and create or update AGENTS.md at the repository root.',
    `The file path to write is: ${targetPath}`,
    'Requirements:',
    '- Actually write the file; do not stop after summarizing in chat.',
    '- If AGENTS.md already exists, update it in place instead of creating a duplicate.',
    '- Keep the document concise and practical for future coding agents working in this repo.',
    '- Include the project purpose, key entry points, dev/test commands, important workflows, and repo-specific safety constraints.',
    '- Prefer facts from the actual codebase over README claims when they differ.',
    '- After editing the file, reply with a brief summary of what you wrote.',
  ].join('\n');
}

function compactAutoStartMessage(agent) {
  return agent === 'codex'
    ? '检测到上下文达到上限，正在按 Codex /compact 自动压缩，然后继续当前任务…'
    : '检测到上下文达到上限，正在按 Claude Code 原版策略自动执行 /compact，然后继续当前任务…';
}

function compactAutoResumeMessage(agent) {
  return agent === 'codex'
    ? '检测到上一条请求因上下文过大失败，现已按 Codex 压缩计划继续执行。'
    : '检测到上一条请求因上下文过大失败，现已自动按压缩计划继续执行。';
}

function isContextLimitError(agent, raw) {
  const text = String(raw || '');
  if (!text) return false;
  if (agent === 'claude') {
    // P0：Claude 超限识别。原版只匹配 `Request too large (max 20MB)`（请求体大小限制，
    // 不是 token 超限），导致 Claude 侧自动 compact 兜底长期失效。
    // 现补全 token 超限短语（均短语级匹配，禁止裸词宽匹配避免误判模型正文）：
    //   - "prompt is too long"           ← API Error: Prompt is too long: N tokens > M maximum
    //   - "context window / length"
    //   - "exceed(s|ed) the maximum/context/token (limit/length)"
    //   - "token limit" / "too many input tokens" / "maximum context length"
    return /Request too large \(max 20MB\)|prompt is too long|context (window|length)|exceed(?:ed|s)?\s*(?:the\s*)?(?:maximum|context|token)|token limit|too many (?:input\s+)?tokens|maximum(?:\s+context)?\s+length/i.test(text);
  }
  return /context\s+(window|length)|maximum context length|context limit|token limit|too many tokens|input.*too long|prompt.*too long|request too large|please use\s*\/compact|use\s*\/compact|reduce (the )?(input|prompt|message)|exceed(?:ed|s).*(token|context)/i.test(text);
}

/**
 * 子进程退出后的统一处理（约 193 行，server.js 最复杂的函数）。
 *
 * 职责混合：
 *   1. 累计 cost / usage 到 session
 *   2. 检测 context limit → 自动注入 /compact + 重放原 prompt（pendingCompactRetries）
 *   3. 驱动 /goal 多轮自治（pendingSlashCommands）
 *   4. 触发 background_done 通知（仅 WS 断开期间完成时）
 *   5. 清理 activeProcesses Map
 *
 * 详见 docs/RUNTIME.md "Detached 进程生命周期" 与 "自动 compact 重试"。
 *
 * @param {string} sessionId
 * @param {number} exitCode
 * @param {string|null} signal
 */
function handleProcessComplete(sessionId, exitCode, signal) {
  const entry = activeProcesses.get(sessionId);
  if (!entry) return;

  const completeTime = new Date().toISOString();
  const wsConnected = !!entry.ws;
  const disconnectGap = entry.wsDisconnectTime
    ? ((new Date(completeTime) - new Date(entry.wsDisconnectTime)) / 1000).toFixed(1) + 's'
    : null;

  const pendingRetry = pendingCompactRetries.get(sessionId) || null;
  let contextLimitExceeded = false;

  // Read stderr for error clues
  let stderrSnippet = '';
  try {
    const errPath = path.join(runDir(sessionId), 'error.log');
    if (fs.existsSync(errPath)) {
      const content = fs.readFileSync(errPath, 'utf8').trim();
      if (content) stderrSnippet = content.slice(-500);
    }
  } catch {}

  const rawCompletionError = entry.lastError || (
    ((typeof exitCode === 'number' && exitCode !== 0) || (!!signal && signal !== 'SIGTERM'))
      ? (stderrSnippet || null)
      : null
  );
  contextLimitExceeded = isContextLimitError(entry.agent || 'claude', `${entry.fullText || ''}\n${stderrSnippet || ''}\n${rawCompletionError || ''}`);
  let completionError = rawCompletionError ? formatRuntimeError(entry.agent || 'claude', rawCompletionError, { exitCode, signal }) : null;
  if (!entry.lastError && rawCompletionError) entry.lastError = rawCompletionError;

  plog(exitCode === 0 || exitCode === null ? 'INFO' : 'WARN', 'process_complete', {
    sessionId: sessionId.slice(0, 8),
    pid: entry.pid,
    agent: entry.agent || 'claude',
    exitCode,
    signal,
    wsConnected,
    wsDisconnectTime: entry.wsDisconnectTime || null,
    disconnectToDeathGap: disconnectGap,
    responseLen: (entry.fullText || '').length,
    toolCallCount: (entry.toolCalls || []).length,
    cost: entry.lastCost,
    usage: entry.lastUsage || null,
    error: rawCompletionError,
    stderr: stderrSnippet || null,
    requestTooLarge: contextLimitExceeded,
  });

  // Final read
  if (entry.tailer) {
    entry.tailer.readNew();
    entry.tailer.stop();
  }

  const pendingSlash = pendingSlashCommands.get(sessionId) || null;
  if (pendingSlash) pendingSlashCommands.delete(sessionId);
  // P2 护栏解除：一次正常（非 slash 注入）运行完成 = 预防压缩 → 重放 的完整闭环走通，
  // 后续消息可再次按水位触发预防压缩；压缩运行本身不清除（防 compact→重放→再预防死循环）
  else preemptCompactGuard.delete(sessionId);

  // Save result to session
  const session = loadSession(sessionId);
  const retryCodexWithoutResume = !!(
    session
    && entry.agent === 'codex'
    && entry.codexResumed
    && !entry.codexResumeFallbackAttempted
    && /custom tool call output is missing/i.test(`${stderrSnippet}\n${rawCompletionError || ''}`)
  );
  if (retryCodexWithoutResume) {
    clearRuntimeSessionId(session);
    session.updated = new Date().toISOString();
    saveSession(session);
    completionError = null;
  }
  if (session && entry.fullText) {
    const msg = {
      role: 'assistant',
      content: entry.fullText,
      toolCalls: entry.toolCalls || [],
      timestamp: new Date().toISOString(),
    };
    if (entry.fullTextTruncated) msg.truncated = true;
    if (entry.toolCallsTruncated) msg.toolCallsTruncated = true;
    session.messages.push(msg);
    session.updated = new Date().toISOString();
    if (!entry.ws) session.hasUnread = true;
    saveSession(session);
  }

  if (pendingSlash?.kind === 'compact' && session) {
    if (entry.lastCost) {
      session.totalCost = Math.max(0, (session.totalCost || 0) - entry.lastCost);
    }
    session.updated = new Date().toISOString();
    saveSession(session);
  }

  let shouldReturnForFollowup = false;
  let shouldAutoCompact = false;

  activeProcesses.delete(sessionId);
  cleanRunDir(sessionId);
  pendingSlashCommands.delete(sessionId);

  // Notify client
  if (entry.ws) {
    if (pendingSlash?.kind === 'compact') {
      const retry = pendingCompactRetries.get(sessionId);
      const autoRetryRequested = !!(retry?.text && retry?.reason === 'auto');
      if (autoRetryRequested) {
        if (contextLimitExceeded) {
          pendingCompactRetries.delete(sessionId);
          wsSend(entry.ws, { type: 'system_message', message: '已尝试执行 /compact，但仍未成功解除上下文超限。请手动缩小输入范围后重试。' });
        } else {
          wsSend(entry.ws, { type: 'system_message', message: compactDoneMessage(entry.agent || 'claude') });
          wsSend(entry.ws, { type: 'system_message', message: compactAutoResumeMessage(entry.agent || 'claude') });
          shouldReturnForFollowup = true;
        }
      } else {
        wsSend(entry.ws, { type: 'system_message', message: compactDoneMessage(entry.agent || 'claude') });
      }
    }

    if (contextLimitExceeded && !pendingSlash && session && getRuntimeSessionId(session)) {
      pendingCompactRetries.set(sessionId, { text: pendingRetry?.text || '', mode: pendingRetry?.mode || session.permissionMode || 'yolo', reason: 'auto' });
      wsSend(entry.ws, { type: 'system_message', message: compactAutoStartMessage(entry.agent || 'claude') });
      shouldAutoCompact = true;
    }

    if (completionError && !entry.errorSent && !shouldAutoCompact) {
      entry.errorSent = true;
      wsSend(entry.ws, { type: 'error', message: completionError });
    }

    wsSend(entry.ws, { type: 'done', sessionId, costUsd: entry.lastCost || null });
    sendSessionList(entry.ws);
    // Push notification when trigger='always' (user online but still wants notification)
    (() => {
      const notifyCfg = loadNotifyConfig();
      if (!notifyCfg.provider || notifyCfg.provider === 'off') return;
      if ((notifyCfg.summary?.trigger || 'background') !== 'always') return;
      const sess = loadSession(sessionId);
      buildNotifyContent(entry, sess, completionError, contextLimitExceeded).then(({ title: ntitle, content }) => {
        sendNotification(ntitle, content);
      });
    })();
  } else {
    // Process completed while browser was disconnected — notify all connected clients
    const sess = loadSession(sessionId);
    const title = sess?.title || 'Untitled';
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        wsSend(client, {
          type: 'background_done',
          sessionId,
          title,
          costUsd: entry.lastCost || null,
          responseLen: (entry.fullText || '').length,
        });
      }
    }
    // Push notification (background task)
    buildNotifyContent(entry, sess, completionError, contextLimitExceeded).then(({ title: ntitle, content }) => {
      sendNotification(ntitle, content);
    });
  }

  if (retryCodexWithoutResume && entry.ws && entry.ws.readyState === 1 && session) {
    wsSend(entry.ws, { type: 'system_message', message: '当前 Codex 线程包含无法由 cc-web 回放的宿主工具调用，已自动新建上下文并重试本次请求。' });
    handleMessage(entry.ws, {
      text: entry.inputText,
      sessionId,
      mode: entry.mode || session.permissionMode || 'yolo',
      agent: 'codex',
    }, { hideInHistory: true, codexResumeFallbackAttempted: true });
    return;
  }

  if (!shouldReturnForFollowup && !shouldAutoCompact && !contextLimitExceeded && pendingRetry && pendingRetry.text === (entry.fullText || '').trim()) {
    pendingCompactRetries.delete(sessionId);
  }

  if (shouldReturnForFollowup && entry.ws && entry.ws.readyState === 1 && session) {
    if (pendingSlash?.kind === 'compact') {
      const retry = pendingCompactRetries.get(sessionId);
      if (retry?.text) {
        pendingCompactRetries.delete(sessionId);
        handleMessage(entry.ws, { text: retry.text, sessionId, mode: retry.mode || session.permissionMode || 'yolo' });
      }
      return;
    }
  }

  if (shouldAutoCompact && entry.ws && entry.ws.readyState === 1 && session) {
    pendingSlashCommands.set(sessionId, { kind: 'compact' });
    handleMessage(entry.ws, { text: '/compact', sessionId, mode: session.permissionMode || 'yolo' }, { hideInHistory: true });
    return;
  }
}

// Global PID monitor: detect process completion (especially after server restart)
setInterval(() => {
  for (const [sessionId, entry] of activeProcesses) {
    if (entry.pid && !isProcessRunning(entry.pid)) {
      plog('INFO', 'pid_monitor_detected_exit', {
        sessionId: sessionId.slice(0, 8),
        pid: entry.pid,
        wsConnected: !!entry.ws,
      });
      handleProcessComplete(sessionId, null, 'unknown (detected by monitor)');
    }
  }
}, 2000);

cleanupExpiredAttachments();
setInterval(cleanupExpiredAttachments, 6 * 60 * 60 * 1000);

/**
 * 启动时扫描所有残留 sessions/*-run/ 目录，恢复 detached 子进程。
 *
 * - PID 仍存活 → 重新 attach（继续 tail output.jsonl），plog recovery_alive
 * - PID 已死 → finalize 输出到 session JSON，plog recovery_dead
 *
 * 关键含义：服务重启不会终止进行中的 Claude/Codex 工作。
 * 详见 docs/RUNTIME.md "recoverProcesses"。
 */
function recoverProcesses() {
  try {
    const entries = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('-run') && fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory());
    if (entries.length === 0) return;
    plog('INFO', 'recovery_start', { runDirs: entries.length });
    for (const dirName of entries) {
      const sessionId = dirName.replace('-run', '');
      const dir = path.join(SESSIONS_DIR, dirName);
      const pidPath = path.join(dir, 'pid');
      const outputPath = path.join(dir, 'output.jsonl');
      const session = loadSession(sessionId);
      const agent = getSessionAgent(session);

      if (!fs.existsSync(pidPath)) {
        try { fs.rmSync(dir, { recursive: true }); } catch {}
        continue;
      }

      const pid = parseInt(fs.readFileSync(pidPath, 'utf8'));

      if (isProcessRunning(pid)) {
        console.log(`[recovery] Re-attaching to session ${sessionId} (PID ${pid})`);
        plog('INFO', 'recovery_alive', { sessionId: sessionId.slice(0, 8), pid, agent });
        const entry = { pid, ws: null, agent, fullText: '', toolCalls: [], lastCost: null, lastUsage: null, lastError: null, errorSent: false, tailer: null };
        activeProcesses.set(sessionId, entry);

        if (fs.existsSync(outputPath)) {
          entry.tailer = new FileTailer(outputPath, (line) => {
            try {
              const event = JSON.parse(line);
              processRuntimeEvent(entry, event, sessionId);
            } catch {}
          });
          entry.tailer.start();
        }
      } else {
        // Process finished while server was down — read all output and save
        console.log(`[recovery] Processing completed output for session ${sessionId}`);
        plog('INFO', 'recovery_dead', { sessionId: sessionId.slice(0, 8), pid, agent });
        if (fs.existsSync(outputPath)) {
          const tempEntry = { pid: 0, ws: null, agent, fullText: '', toolCalls: [], lastCost: null, lastUsage: null, lastError: null, errorSent: false, tailer: null };
          const content = fs.readFileSync(outputPath, 'utf8');
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              processRuntimeEvent(tempEntry, event, sessionId);
            } catch {}
          }
          if (session && tempEntry.fullText) {
            session.messages.push({
              role: 'assistant',
              content: tempEntry.fullText,
              toolCalls: tempEntry.toolCalls || [],
              timestamp: new Date().toISOString(),
            });
            session.updated = new Date().toISOString();
            saveSession(session);
          }
        }
        try { fs.rmSync(dir, { recursive: true }); } catch {}
      }
    }
  } catch (err) {
    console.error('[recovery] Error:', err.message);
  }
}

// === HTTP Static File Server ===
// CSP 头作为 XSS 纵深防御：renderMarkdown 已用 DOMPurify sanitize 用户/LLM 内容，
// CSP 在 sanitize 失效或第三方库被污染时兜底拦截内联脚本执行。
// - script-src 限 'self' + cdnjs.cloudflare.com（marked/highlight.js/DOMPurify CDN）
// - style-src 加 'unsafe-inline'（marked/highlight.js 输出含 style 属性，应用自身也用内联 style）
// - frame-src 'self' 允许 sandbox srcdoc iframe 预览
const CSP_HEADER = "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";

const server = http.createServer((req, res) => {
  res.setHeader('Content-Security-Policy', CSP_HEADER);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 统一 /api/* 前置封禁检查：IP 被封后任何 API 调用都直接 403
  if (url.pathname.startsWith('/api/')) {
    const ip = resolveClientIP(req);
    if (ip && isBanned(ip)) {
      plog('WARN', 'banned_ip_rejected_http', { ip, path: url.pathname });
      return jsonResponse(res, 403, { ok: false, message: 'IP banned', banned: true });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/attachments') {
    const token = extractBearerToken(req);
    if (!isTokenValid(token)) {
      return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    }
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const rawName = decodeURIComponent(String(req.headers['x-filename'] || 'image'));
    const filename = safeFilename(rawName);
    if (!IMAGE_MIME_TYPES.has(mime)) {
      return jsonResponse(res, 400, { ok: false, message: '仅支持 PNG/JPG/WEBP/GIF 图片' });
    }

    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_ATTACHMENT_SIZE) {
        aborted = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) {
        return jsonResponse(res, 413, { ok: false, message: '图片大小不能超过 10MB' });
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) {
        return jsonResponse(res, 400, { ok: false, message: '图片内容为空' });
      }
      const id = crypto.randomUUID();
      const ext = extFromMime(mime) || path.extname(filename) || '';
      const dataPath = attachmentDataPath(id, ext);
      const now = new Date();
      const meta = {
        id,
        kind: 'image',
        filename,
        mime,
        size: buffer.length,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ATTACHMENT_TTL_MS).toISOString(),
        path: dataPath,
      };
      try {
        fs.writeFileSync(dataPath, buffer);
        saveAttachmentMeta(meta);
        return jsonResponse(res, 200, {
          ok: true,
          attachment: {
            id,
            kind: 'image',
            filename,
            mime,
            size: buffer.length,
            createdAt: meta.createdAt,
            expiresAt: meta.expiresAt,
            storageState: 'available',
          },
        });
      } catch (err) {
        try { if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath); } catch {}
        try { if (fs.existsSync(attachmentMetaPath(id))) fs.unlinkSync(attachmentMetaPath(id)); } catch {}
        return jsonResponse(res, 500, { ok: false, message: `保存附件失败: ${err.message}` });
      }
    });
    req.on('error', () => {
      if (!res.headersSent) jsonResponse(res, 500, { ok: false, message: '上传过程中断' });
    });
    return;
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/attachments/')) {
    const token = extractBearerToken(req);
    if (!isTokenValid(token)) {
      return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    }
    const id = sanitizeId(url.pathname.split('/').pop() || '');
    if (!id) {
      return jsonResponse(res, 400, { ok: false, message: '缺少附件 ID' });
    }
    removeAttachmentById(id);
    return jsonResponse(res, 200, { ok: true });
  }

  let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  filePath = path.resolve(filePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// === WebSocket Server ===
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  // WS 心跳状态初始化：pong 回应会刷新 isAlive；连续两轮无 pong 由启动区定时器 terminate
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const clientIP = resolveClientIP(req);

  // Check if IP is banned
  if (clientIP && isBanned(clientIP)) {
    plog('WARN', 'banned_ip_rejected', { ip: clientIP });
    wsSend(ws, { type: 'auth_result', success: false, banned: true });
    ws.close();
    return;
  }

  let authenticated = false;
  let authToken = null;
  const wsId = crypto.randomBytes(4).toString('hex'); // short id for log correlation
  const wsConnectTime = new Date().toISOString();
  plog('INFO', 'ws_connect', { wsId });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return wsSend(ws, { type: 'error', message: 'Invalid JSON' });
    }

    if (msg.type === 'auth') {
      ensureAuthLoaded();
      // Check ban before processing auth
      if (clientIP && isBanned(clientIP)) {
        wsSend(ws, { type: 'auth_result', success: false, banned: true });
        ws.close();
        return;
      }
      const tokenValid = msg.token ? isTokenValid(msg.token) : false;
      const passwordProvided = typeof msg.password === 'string' && msg.password.length > 0;
      const passwordOk = passwordProvided && authStore.verifyPassword(msg.password, authConfig);
      if (passwordOk || tokenValid) {
        // 命中即签发/复用 token：token 命中则复用原值（保持持久），否则签发新 token
        let token;
        if (tokenValid) {
          token = msg.token;
        } else {
          const issued = authStore.issueToken();
          token = issued.token;
          tokenMemory.set(issued.digest, { record: issued, lastActive: Date.now() });
          persistTokens();
        }
        authToken = token;
        authenticated = true;
        ws._ccwebAuthed = true;
        wsSend(ws, { type: 'auth_result', success: true, token: authToken, mustChangePassword: !!authConfig.mustChange });
        sendGroupList(ws);
        sendSessionList(ws);
      } else {
        // 失败原因细分：token 提供但无效 → session_expired；密码错 → invalid_password；兜底 auth_failed
        let reason;
        if (msg.token && !tokenValid) {
          reason = 'session_expired';
        } else if (passwordProvided) {
          reason = 'invalid_password';
        } else {
          reason = 'auth_failed';
        }
        const justBanned = passwordProvided ? recordAuthFailure(clientIP) : false;
        wsSend(ws, { type: 'auth_result', success: false, banned: justBanned, reason });
        if (justBanned) ws.close();
      }
      return;
    }

    if (!authenticated || ws._ccwebAuthed === false) {
      // _ccwebAuthed=false 拦截 close race：handleChangePassword 已标记 client 失效，
      // 即使 close 前事件队列里还有业务消息，也拒绝处理
      return wsSend(ws, { type: 'error', message: 'Not authenticated' });
    }

    // WS 客户端→服务端消息分发（auth 单独分支 + 34 个 switch case）。
    // 完整清单与契约见 docs/PROTOCOL.md "客户端 → 服务端"。
    // /goal 通过正则排除走 handleMessage 独立路径，详见 docs/RUNTIME.md "/goal 多轮自治"。
    switch (msg.type) {
      case 'message':
        if (msg.text && msg.text.trim().startsWith('/') && !/^\/goal(?:\s|$)/i.test(msg.text.trim())) {
          handleSlashCommand(ws, msg.text.trim(), msg.sessionId, msg.agent);
        } else {
          handleMessage(ws, msg);
        }
        break;
      case 'abort':
        handleAbort(ws);
        break;
      case 'new_session':
        handleNewSession(ws, msg);
        break;
      case 'load_session':
        handleLoadSession(ws, msg.sessionId);
        break;
      case 'delete_session':
        handleDeleteSession(ws, msg.sessionId);
        break;
      case 'rename_session':
        handleRenameSession(ws, msg.sessionId, msg.title);
        break;
      case 'set_mode':
        handleSetMode(ws, msg.sessionId, msg.mode);
        break;
      case 'list_sessions':
        sendSessionList(ws);
        break;
      case 'detach_view':
        handleDetachView(ws);
        break;
      case 'get_notify_config':
        wsSend(ws, { type: 'notify_config', config: getNotifyConfigMasked() });
        break;
      case 'save_notify_config':
        handleSaveNotifyConfig(ws, msg.config);
        break;
      case 'test_notify':
        handleTestNotify(ws);
        break;
      case 'change_password':
        handleChangePassword(ws, msg, authToken);
        break;
      case 'get_model_config':
        wsSend(ws, { type: 'model_config', config: getModelConfigMasked() });
        break;
      case 'save_model_config':
        handleSaveModelConfig(ws, msg.config);
        break;
      case 'get_codex_config':
        wsSend(ws, { type: 'codex_config', config: getCodexConfigMasked() });
        break;
      case 'save_codex_config':
        handleSaveCodexConfig(ws, msg.config);
        break;
      case 'fetch_models':
        handleFetchModels(ws, msg);
        break;
      case 'check_update':
        handleCheckUpdate(ws);
        break;
      case 'read_claude_local_config':
        handleReadClaudeLocalConfig(ws);
        break;
      case 'read_codex_local_config':
        handleReadCodexLocalConfig(ws);
        break;
      case 'save_local_snapshot':
        handleSaveLocalSnapshot(ws, msg);
        break;
      case 'restore_claude_local_snapshot':
        handleRestoreClaudeLocalSnapshot(ws);
        break;
      case 'get_dev_config':
        wsSend(ws, { type: 'dev_config', config: getDevConfigMasked() });
        break;
      case 'save_dev_config':
        handleSaveDevConfig(ws, msg);
        break;
      case 'list_native_sessions':
        handleListNativeSessions(ws);
        break;
      case 'import_native_session':
        handleImportNativeSession(ws, msg);
        break;
      case 'list_codex_sessions':
        handleListCodexSessions(ws);
        break;
      case 'import_codex_session':
        handleImportCodexSession(ws, msg);
        break;
      case 'list_cwd_suggestions':
        handleListCwdSuggestions(ws);
        break;
      case 'group_create':
        handleGroupCreate(ws, msg);
        break;
      case 'group_rename':
        handleGroupRename(ws, msg);
        break;
      case 'group_delete':
        handleGroupDelete(ws, msg);
        break;
      case 'session_move':
        handleSessionMove(ws, msg);
        break;
      default:
        wsSend(ws, { type: 'error', message: `Unknown type: ${msg.type}` });
    }
  });

  ws.on('close', () => handleDisconnect(ws, wsId));
  ws.on('error', (err) => {
    plog('WARN', 'ws_error', { wsId, error: err.message });
    handleDisconnect(ws, wsId);
  });
});

// === Notify Config Handlers ===
function handleSaveNotifyConfig(ws, newConfig) {
  if (!newConfig || !newConfig.provider) {
    return wsSend(ws, { type: 'error', message: '无效的通知配置' });
  }
  const current = loadNotifyConfig();
  // Merge: only update fields that are not masked (contain ****)
  const merged = { provider: newConfig.provider };
  // pushplus
  merged.pushplus = { token: (newConfig.pushplus?.token && !newConfig.pushplus.token.includes('****')) ? newConfig.pushplus.token : current.pushplus?.token || '' };
  // telegram
  merged.telegram = {
    botToken: (newConfig.telegram?.botToken && !newConfig.telegram.botToken.includes('****')) ? newConfig.telegram.botToken : current.telegram?.botToken || '',
    chatId: newConfig.telegram?.chatId !== undefined ? newConfig.telegram.chatId : current.telegram?.chatId || '',
  };
  // serverchan
  merged.serverchan = { sendKey: (newConfig.serverchan?.sendKey && !newConfig.serverchan.sendKey.includes('****')) ? newConfig.serverchan.sendKey : current.serverchan?.sendKey || '' };
  // feishu
  merged.feishu = { webhook: (newConfig.feishu?.webhook && !newConfig.feishu.webhook.includes('****')) ? newConfig.feishu.webhook : current.feishu?.webhook || '' };
  // qqbot
  merged.qqbot = { qmsgKey: (newConfig.qqbot?.qmsgKey && !newConfig.qqbot.qmsgKey.includes('****')) ? newConfig.qqbot.qmsgKey : current.qqbot?.qmsgKey || '' };
  // summary
  const ns = newConfig.summary || {};
  const cs = current.summary || {};
  merged.summary = {
    enabled: !!ns.enabled,
    trigger: ['background', 'always'].includes(ns.trigger) ? ns.trigger : (cs.trigger || 'background'),
    apiSource: ['claude', 'codex', 'custom'].includes(ns.apiSource) ? ns.apiSource : (cs.apiSource || 'claude'),
    apiBase: ns.apiBase !== undefined ? ns.apiBase : (cs.apiBase || ''),
    apiKey: (ns.apiKey && !ns.apiKey.includes('****')) ? ns.apiKey : (cs.apiKey || ''),
    model: ns.model !== undefined ? ns.model : (cs.model || ''),
  };

  saveNotifyConfig(merged);
  plog('INFO', 'notify_config_saved', { provider: merged.provider });
  wsSend(ws, { type: 'notify_config', config: getNotifyConfigMasked() });
  wsSend(ws, { type: 'system_message', message: '通知配置已保存' });
}

function handleTestNotify(ws) {
  const config = loadNotifyConfig();
  if (!config.provider || config.provider === 'off') {
    return wsSend(ws, { type: 'notify_test_result', success: false, message: '通知已关闭，无法测试' });
  }
  sendNotification('CC-Web 测试通知', '这是一条测试消息，如果你收到了说明通知配置正确！').then((result) => {
    wsSend(ws, { type: 'notify_test_result', success: result.ok, message: result.ok ? '测试消息已发送，请检查是否收到' : `发送失败: ${result.error || result.body || '未知错误'}` });
  });
}

function handleChangePassword(ws, msg, currentToken) {
  const { currentPassword, newPassword } = msg;

  // Validate current password（用 verifyPassword 常量时间比较）
  if (!authStore.verifyPassword(currentPassword || '', authConfig)) {
    return wsSend(ws, { type: 'password_changed', success: false, message: '当前密码错误' });
  }

  // Validate new password strength
  const strength = validatePasswordStrength(newPassword);
  if (!strength.valid) {
    return wsSend(ws, { type: 'password_changed', success: false, message: strength.message });
  }

  // 原子封装（revokeAllTokens 内部顺序：先写空 tokens.json → 再写新 hash → 签新 token 落盘）
  // 任意点崩溃都不会出现"密码已改但旧 token 仍可用"
  const newHash = { ...authStore.hashPassword(newPassword), mustChange: false, version: 2 };
  const { tokenMap, newToken } = authStore.revokeAllTokens({
    newHashConfig: newHash,
    issueNewForConnection: true,
  });
  // revokeAllTokens 返回 Map<digest, tokenRecord>；tokenMemory 期望 Map<digest, { record, lastActive }>
  tokenMemory = new Map();
  for (const [digest, rec] of tokenMap) {
    tokenMemory.set(digest, { record: rec, lastActive: Date.now() });
  }
  authConfig = newHash;
  // 踢掉所有其他已认证连接：已建立的 WS 即使 token 失效，认证位仍开着，必须主动 close
  // 客户端会自动重连，重连时旧 token 已失效 → session_expired → 跳登录页
  // 先置 _ccwebAuthed=false 拦截 close race：close 前已入队的事件不再处理
  for (const client of wss.clients) {
    if (client !== ws && client._ccwebAuthed && client.readyState === 1) {
      client._ccwebAuthed = false;
      try { client.close(); } catch {}
    }
  }
  plog('INFO', 'password_changed', {});

  wsSend(ws, { type: 'password_changed', success: true, token: newToken.token, message: '密码修改成功' });
}

// === Model Config Handler ===
function handleSaveModelConfig(ws, newConfig) {
  if (!newConfig || !['local', 'custom'].includes(newConfig.mode)) {
    return wsSend(ws, { type: 'error', message: '无效的模型配置' });
  }
  const current = loadModelConfig();
  const merged = {
    mode: newConfig.mode,
    activeTemplate: newConfig.activeTemplate || '',
    templates: [],
    localSnapshot: newConfig.localSnapshot || current.localSnapshot || {},
  };

  // Merge templates: keep existing secrets if masked
  const newTemplates = Array.isArray(newConfig.templates) ? newConfig.templates : [];
  const oldTemplates = Array.isArray(current.templates) ? current.templates : [];
  for (const nt of newTemplates) {
    if (!nt.name || !nt.name.trim()) continue;
    const old = oldTemplates.find(t => t.name === nt.name);
    merged.templates.push({
      name: nt.name.trim(),
      apiKey: (nt.apiKey && !nt.apiKey.includes('****')) ? nt.apiKey : (old?.apiKey || ''),
      apiBase: nt.apiBase || '',
      defaultModel: nt.defaultModel || '',
      opusModel: nt.opusModel || '',
      sonnetModel: nt.sonnetModel || '',
      haikuModel: nt.haikuModel || '',
    });
  }

  saveModelConfig(merged);

  // Re-apply at runtime (mutate in-place to preserve agent-runtime closure reference)
  MODEL_MAP.opus = 'claude-opus-4-6';
  MODEL_MAP.sonnet = 'claude-sonnet-4-6';
  MODEL_MAP.haiku = 'claude-haiku-4-5-20251001';
  applyModelConfig();
  // custom mode: write to ~/.claude/settings.json immediately on save
  if (merged.mode === 'custom' && merged.activeTemplate) {
    const tpl = merged.templates.find(t => t.name === merged.activeTemplate);
    if (tpl) applyCustomTemplateToSettings(tpl);
  }

  // Remap ALL Claude sessions' model to current runtime MODEL_MAP values.
  // Build reverse map from BOTH pre-save and post-save template model names:
  // - current.templates: identifies sessions created under old model names (including edited/renamed)
  // - merged.templates: keeps post-save model names in the lookup as well
  // Include both raw and [1m]-suffixed keys: applyModelConfig() appends [1m] to
  // opus/sonnet when storing into session.model, so we need both forms to match.
  const modelToTier = new Map();
  const lookupTemplates = [
    ...(Array.isArray(current.templates) ? current.templates : []),
    ...(Array.isArray(merged.templates) ? merged.templates : []),
  ];
  for (const tpl of lookupTemplates) {
    if (tpl.opusModel) {
      modelToTier.set(tpl.opusModel, 'opus');
      if (!tpl.opusModel.endsWith('[1m]')) modelToTier.set(tpl.opusModel + '[1m]', 'opus');
    }
    if (tpl.sonnetModel) {
      modelToTier.set(tpl.sonnetModel, 'sonnet');
      if (!tpl.sonnetModel.endsWith('[1m]')) modelToTier.set(tpl.sonnetModel + '[1m]', 'sonnet');
    }
    if (tpl.haikuModel) modelToTier.set(tpl.haikuModel, 'haiku');
  }
  try {
    for (const file of fs.readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith('.json')) continue;
      const sessionId = file.slice(0, -5);
      try {
        const session = loadSession(sessionId);
        if (!session?.model || session.agent === 'codex') continue;
        const tier = modelToTier.get(session.model);
        if (tier && MODEL_MAP[tier] !== session.model) {
          session.model = MODEL_MAP[tier];
          // 不刷新 updated：模型配置变更不应改变会话"最后活跃"时间（避免批量污染会话列表时间戳）
          saveSession(session);
        }
      } catch {}
    }
  } catch {}

  plog('INFO', 'model_config_saved', { mode: merged.mode, activeTemplate: merged.activeTemplate });
  wsSend(ws, { type: 'model_config', config: getModelConfigMasked() });
  wsSend(ws, { type: 'system_message', message: '模型配置已保存' });
}

function handleSaveCodexConfig(ws, newConfig) {
  if (!newConfig || typeof newConfig !== 'object') {
    return wsSend(ws, { type: 'error', message: '无效的 Codex 配置' });
  }
  const current = loadCodexConfig();
  const newProfiles = Array.isArray(newConfig.profiles) ? newConfig.profiles : [];
  const oldProfiles = Array.isArray(current.profiles) ? current.profiles : [];
  const mergedProfiles = [];
  for (const profile of newProfiles) {
    const name = String(profile?.name || '').trim();
    if (!name) continue;
    const old = oldProfiles.find((item) => item.name === name);
    const rawApiKey = String(profile?.apiKey || '');
    const rawModel = String(profile?.model || '').trim();
    const mergedModel = rawModel || String(old?.model || '').trim();
    const incomingModels = Array.isArray(profile?.models) ? profile.models : null;
    const mergedModelsSource = incomingModels && incomingModels.length > 0 ? incomingModels : old?.models;
    mergedProfiles.push({
      name,
      apiKey: rawApiKey && !rawApiKey.includes('****') ? rawApiKey : (old?.apiKey || ''),
      apiBase: String(profile?.apiBase || '').trim(),
      model: mergedModel,
      models: normalizeCodexModelList(
        mergedModelsSource,
        mergedModel,
      ),
    });
  }
  const requestedSearch = !!newConfig.enableSearch;
  const merged = {
    mode: newConfig.mode === 'custom' ? 'custom' : 'local',
    activeProfile: String(newConfig.activeProfile || '').trim(),
    profiles: mergedProfiles,
    enableSearch: false,
    supportsSearch: false,
    storedEnableSearch: requestedSearch,
    localSnapshot: newConfig.localSnapshot || current.localSnapshot || {},
  };
  if (merged.mode === 'custom' && merged.profiles.length > 0 && !merged.profiles.some((profile) => profile.name === merged.activeProfile)) {
    merged.activeProfile = merged.profiles[0].name;
  }
  saveCodexConfig(merged);
  const nextDefaultModel = resolveDefaultCodexModel();
  if (nextDefaultModel) {
    try {
      for (const file of fs.readdirSync(SESSIONS_DIR)) {
        if (!file.endsWith('.json')) continue;
        const sessionId = file.slice(0, -5);
        try {
          const session = loadSession(sessionId);
          if (!session || getSessionAgent(session) !== 'codex') continue;
          session.model = nextDefaultModel;
          // 模型重映射不改 updated（保存配置不应刷新会话"最后活跃时间"，与 Claude 侧重映射一致）
          saveSession(session);
        } catch {}
      }
    } catch {}
  }
  plog('INFO', 'codex_config_saved', {
    mode: merged.mode,
    activeProfile: merged.activeProfile || null,
    profileCount: merged.profiles.length,
    defaultModel: nextDefaultModel || null,
    enableSearchRequested: requestedSearch,
    enableSearchEffective: false,
  });
  wsSend(ws, { type: 'codex_config', config: getCodexConfigMasked() });
  wsSend(ws, {
    type: 'system_message',
    message: requestedSearch
      ? 'Codex 配置已保存。当前 cc-web 的 Codex exec 路径暂未接入 Web Search，已自动忽略该开关。'
      : 'Codex 配置已保存',
  });
}

// === Local Config Snapshot Handlers ===
function handleReadClaudeLocalConfig(ws) {
  let settings = {};
  let sourceFound = false;
  try {
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
      sourceFound = true;
    }
  } catch {}
  const env = settings.env || {};
  const config = {
    apiKey: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '',
    apiBase: env.ANTHROPIC_BASE_URL || '',
    defaultModel: env.ANTHROPIC_MODEL || '',
    opusModel: env.ANTHROPIC_DEFAULT_OPUS_MODEL || '',
    sonnetModel: env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
    haikuModel: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '',
  };
  wsSend(ws, { type: 'claude_local_config', config, sourceFound });
}

function handleReadCodexLocalConfig(ws) {
  const { config, sourceFound, hasApiKey } = readCodexLocalConfigSnapshot();
  const result = { type: 'codex_local_config', config, sourceFound, hasApiKey };
  if (!hasApiKey) result.warning = '本机使用登录态认证，未检测到 API Key';
  wsSend(ws, result);
}

function handleSaveLocalSnapshot(ws, msg) {
  const config = loadModelConfig();
  config.localSnapshot = msg.snapshot || {};
  saveModelConfig(config);
  wsSend(ws, { type: 'model_config', config: getModelConfigMasked() });
  wsSend(ws, { type: 'system_message', message: '本地配置快照已保存' });
}

function handleRestoreClaudeLocalSnapshot(ws) {
  const config = loadModelConfig();
  const snapshot = config.localSnapshot;
  if (!snapshot || Object.keys(snapshot).length === 0) {
    return wsSend(ws, { type: 'error', message: '没有已保存的本地配置快照' });
  }
  applyCustomTemplateToSettings(snapshot);
  // Switch to local mode after restore
  config.mode = 'local';
  config.activeTemplate = '';
  saveModelConfig(config);
  // Reset MODEL_MAP to local defaults
  MODEL_MAP.opus = 'claude-opus-4-6';
  MODEL_MAP.sonnet = 'claude-sonnet-4-6';
  MODEL_MAP.haiku = 'claude-haiku-4-5-20251001';
  applyModelConfig();
  wsSend(ws, { type: 'model_config', config: getModelConfigMasked() });
  wsSend(ws, { type: 'system_message', message: '已恢复本地配置快照到 ~/.claude/settings.json' });
}

// === Fetch Upstream Models ===
function handleFetchModels(ws, msg) {
  const { apiBase, apiKey, modelsEndpoint } = msg;
  if (!apiBase || !apiKey) {
    return wsSend(ws, { type: 'fetch_models_result', success: false, message: '需要填写 API Base 和 API Key' });
  }
  // Build URL: apiBase + modelsEndpoint (default /v1/models)
  let base = apiBase.replace(/\/+$/, '');
  const endpoint = modelsEndpoint || '/v1/models';
  const fullUrl = base + endpoint;

  let parsed;
  try { parsed = new URL(fullUrl); } catch {
    return wsSend(ws, { type: 'fetch_models_result', success: false, message: '无效的 URL: ' + fullUrl });
  }

  // Resolve real apiKey (if masked, look up saved config by template name or apiBase)
  let realKey = apiKey;
  if (apiKey.includes('****')) {
    const modelConfig = loadModelConfig();
    const codexConfig = loadCodexConfig();
    const savedTemplates = modelConfig.templates || [];
    const savedProfiles = codexConfig.profiles || [];
    const tpl = (msg.templateName && savedTemplates.find((t) => t.name === msg.templateName))
      || savedTemplates.find((t) => t.apiBase && t.apiBase.replace(/\/+$/, '') === base)
      || null;
    const profile = (msg.profileName && savedProfiles.find((p) => p.name === msg.profileName))
      || savedProfiles.find((p) => p.apiBase && p.apiBase.replace(/\/+$/, '') === base)
      || null;
    if (tpl?.apiKey && !tpl.apiKey.includes('****')) realKey = tpl.apiKey;
    else if (profile?.apiKey && !profile.apiKey.includes('****')) realKey = profile.apiKey;
    else return wsSend(ws, { type: 'fetch_models_result', success: false, message: 'API Key 已脱敏，请重新输入完整 Key' });
  }

  const mod = parsed.protocol === 'https:' ? require('https') : require('http');
  const reqOptions = {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${realKey}` },
    timeout: 15000,
  };

  const req = mod.request(parsed, reqOptions, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      if (res.statusCode !== 200) {
        return wsSend(ws, { type: 'fetch_models_result', success: false, message: `HTTP ${res.statusCode}: ${body.slice(0, 200)}` });
      }
      try {
        const json = JSON.parse(body);
        const models = (json.data || json.models || []).map(m => typeof m === 'string' ? m : m.id || m.name || '').filter(Boolean).sort();
        wsSend(ws, { type: 'fetch_models_result', success: true, models });
      } catch (e) {
        wsSend(ws, { type: 'fetch_models_result', success: false, message: '解析响应失败: ' + e.message });
      }
    });
  });

  req.on('error', (e) => {
    wsSend(ws, { type: 'fetch_models_result', success: false, message: '请求失败: ' + e.message });
  });
  req.on('timeout', () => {
    req.destroy();
    wsSend(ws, { type: 'fetch_models_result', success: false, message: '请求超时 (15s)' });
  });
  req.end();
}

// === Slash Command Handler ===
/**
 * 斜杠命令分发器（/clear /mode /model /cost /compact /init /github /ssh /help）。
 *
 * 注意：/goal 不走此 switch，由 handleMessage 独立处理。
 * 各命令行号与行为见 docs/PROTOCOL.md "斜杠命令"。
 *
 * @param {object} ws
 * @param {string} text - 用户输入的完整命令字符串
 * @param {string} sessionId
 * @param {'claude'|'codex'} fallbackAgent - session 不存在时的回退 agent
 */
function handleSlashCommand(ws, text, sessionId, fallbackAgent) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  let session = sessionId ? loadSession(sessionId) : null;
  const agent = session ? getSessionAgent(session) : normalizeAgent(fallbackAgent);

  // 带任务指令的命令（/github /cf /ssh /loop）留痕到会话历史：命令后跟用户的具体任务，
  // 不显示会造成回看时无法理解。/goal 走普通消息路径已留痕；纯命令（/clear /compact 等）不留。
  if (session && /^(?:\/github|\/cf|\/ssh|\/loop)$/.test(cmd)) {
    session.messages.push({ role: 'user', content: text, timestamp: new Date().toISOString() });
    session.updated = new Date().toISOString();
    saveSession(session);
  }

  switch (cmd) {
    case '/clear': {
      if (session) {
        stopSessionLoop(session.id);
        session.loop = null;
        if (activeProcesses.has(sessionId)) {
          const entry = activeProcesses.get(sessionId);
          killProcess(entry.pid);
          if (entry.tailer) entry.tailer.stop();
          activeProcesses.delete(sessionId);
          cleanRunDir(sessionId);
        }
        session.messages = [];
        clearRuntimeSessionId(session);
        session.updated = new Date().toISOString();
        saveSession(session);
        wsSend(ws, {
          type: 'session_info',
          sessionId: session.id,
          messages: [],
          title: session.title,
          mode: session.permissionMode || 'yolo',
          model: sessionModelLabel(session),
          agent: getSessionAgent(session),
          cwd: session.cwd || null,
          totalCost: session.totalCost || 0,
          totalUsage: session.totalUsage || null,
          taskMode: session.taskMode || 'local',
          sshHostId: session.sshHostId || '',
          remoteCwd: session.remoteCwd || '',
        });
      }
      wsSend(ws, { type: 'system_message', message: '会话已清除，上下文已重置。' });
      break;
    }

    case '/loop': {
      if (!sessionId || !session) {
        wsSend(ws, { type: 'system_message', message: '请先创建或进入一个会话，再设置 /loop。' });
        break;
      }
      const loopArgument = String(parts[1] || '').toLowerCase();
      if (loopArgument === 'off' || loopArgument === 'clear') {
        const wasActive = !!session.loop;
        stopSessionLoop(session.id);
        session.loop = null;
        session.updated = new Date().toISOString();
        saveSession(session);
        wsSend(ws, { type: 'system_message', message: wasActive ? '已停止当前会话的 /loop。' : '当前会话没有运行中的 /loop。' });
        break;
      }
      const intervalMs = parseLoopInterval(parts[1]);
      const prompt = text.replace(/^\/loop\s+\S+\s*/i, '').trim();
      if (!intervalMs || !prompt) {
        wsSend(ws, { type: 'system_message', message: '用法: /loop <间隔> <提示>，间隔支持 s、m、h（1s–24h）。例如: /loop 10m 检查测试状态并继续完成剩余工作。\n用 /loop off 停止。' });
        break;
      }
      session.loop = {
        intervalMs,
        prompt,
        nextRunAt: new Date(Date.now() + intervalMs).toISOString(),
      };
      session.updated = new Date().toISOString();
      saveSession(session);
      scheduleSessionLoop(session.id);
      wsSend(ws, { type: 'system_message', message: `已设置 /loop：每 ${formatLoopInterval(intervalMs)} 执行一次“${prompt}”。任务运行中时会跳过本轮；用 /loop off 停止。` });
      break;
    }

    case '/model': {
      const modelInput = parts[1];
      if (agent === 'codex') {
        if (!modelInput) {
          const current = session?.model || resolveDefaultCodexModel() || '配置默认模型';
          wsSend(ws, { type: 'system_message', message: `当前 Codex 模型: ${current}\n用法: /model <模型名>` });
        } else {
          if (session) {
            session.model = modelInput;
            session.updated = new Date().toISOString();
            saveSession(session);
          }
          wsSend(ws, { type: 'model_changed', model: modelInput });
          wsSend(ws, { type: 'system_message', message: `Codex 模型已切换为: ${modelInput}` });
        }
      } else if (!modelInput) {
        const current = session?.model ? modelShortName(session.model) || session.model : 'opus (默认)';
        wsSend(ws, { type: 'system_message', message: `当前模型: ${current}\n可选: opus, sonnet, haiku` });
      } else {
        const modelKey = modelInput.toLowerCase();
        if (!MODEL_MAP[modelKey]) {
          wsSend(ws, { type: 'system_message', message: `无效模型: ${modelInput}\n可选: opus, sonnet, haiku` });
        } else {
          const model = MODEL_MAP[modelKey];
          if (session) {
            session.model = model;
            session.updated = new Date().toISOString();
            saveSession(session);
          }
          wsSend(ws, { type: 'model_changed', model: modelKey });
          wsSend(ws, { type: 'system_message', message: `模型已切换为: ${modelKey}` });
        }
      }
      break;
    }

    case '/cost': {
      if (agent === 'codex') {
        const usage = session?.totalUsage || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
        wsSend(ws, {
          type: 'system_message',
          message: `当前会话累计 Token: 输入 ${usage.inputTokens}，缓存 ${usage.cachedInputTokens}，输出 ${usage.outputTokens}`,
        });
      } else {
        const cost = session?.totalCost || 0;
        wsSend(ws, { type: 'system_message', message: `当前会话累计费用: $${cost.toFixed(4)}` });
      }
      break;
    }

    case '/compact': {
      if (!sessionId || !session) {
        wsSend(ws, { type: 'system_message', message: '当前没有可压缩的会话。请先进入一个已进行过对话的会话后再执行 /compact。' });
        break;
      }
      if (activeProcesses.has(sessionId)) {
        wsSend(ws, { type: 'system_message', message: '当前会话正在处理中，请先等待完成或点击停止，再执行 /compact。' });
        break;
      }
      const runtimeId = getRuntimeSessionId(session);
      if (!runtimeId) {
        wsSend(ws, {
          type: 'system_message',
          message: agent === 'codex'
            ? '当前会话尚未建立 Codex 上下文，暂时无需压缩。'
            : '当前会话尚未建立 Claude 上下文，暂时无需压缩。',
        });
        break;
      }

      wsSend(ws, { type: 'system_message', message: compactStartMessage(agent) });
      preemptCompactGuard.delete(session.id); // 手动 /compact 会重置水位，解除预防压缩护栏
      pendingSlashCommands.set(session.id, { kind: 'compact' });
      handleMessage(ws, { text: '/compact', sessionId: session.id, mode: session.permissionMode || 'yolo' }, { hideInHistory: true });
      break;
    }

    case '/init': {
      if (!sessionId || !session) {
        wsSend(ws, { type: 'system_message', message: '请先进入一个会话后再执行 /init。' });
        break;
      }
      if (activeProcesses.has(sessionId)) {
        wsSend(ws, { type: 'system_message', message: '当前会话正在处理中，请先等待完成或点击停止。' });
        break;
      }
      wsSend(ws, { type: 'system_message', message: initStartMessage(agent) });
      pendingSlashCommands.set(session.id, { kind: 'init' });
      handleMessage(ws, {
        text: agent === 'codex' ? buildCodexInitPrompt(session.cwd) : '/init',
        sessionId: session.id,
        mode: session.permissionMode || 'yolo',
      }, { hideInHistory: true });
      break;
    }

    case '/github': {
      if (!sessionId || !session) {
        wsSend(ws, { type: 'system_message', message: '请先进入一个会话后再执行 /github。' });
        break;
      }
      if (activeProcesses.has(sessionId)) {
        wsSend(ws, { type: 'system_message', message: '当前会话正在处理中，请先等待完成或点击停止。' });
        break;
      }
      const ghArgs = parts.slice(1).join(' ').trim() || '列出所有可用仓库';
      const ghPrompt = [
        '[系统指令]',
        '用户请求执行 GitHub 相关操作。请按以下步骤执行：',
        `1. 使用 Read 工具读取 ${DEV_CONFIG_PATH} 获取 GitHub token 和仓库信息`,
        '2. 根据用户的自然语言指令匹配对应的仓库（按 name 或 notes 字段）',
        '3. 使用读取到的 token 进行 git 认证（可设置环境变量 GIT_TOKEN 或直接在 URL 中使用）',
        '4. 严格禁止在回复中打印、回显或引用 token 的完整内容',
        '5. 操作完成后简要报告结果',
        '',
        `用户指令：${ghArgs}`,
      ].join('\n');
      pendingSlashCommands.set(session.id, { kind: 'github' });
      handleMessage(ws, {
        text: ghPrompt,
        sessionId: session.id,
        mode: session.permissionMode || 'yolo',
      }, { hideInHistory: true });
      break;
    }

    case '/ssh': {
      if (!sessionId || !session) {
        wsSend(ws, { type: 'system_message', message: '请先进入一个会话后再执行 /ssh。' });
        break;
      }
      if (activeProcesses.has(sessionId)) {
        wsSend(ws, { type: 'system_message', message: '当前会话正在处理中，请先等待完成或点击停止。' });
        break;
      }
      const sshArgs = parts.slice(1).join(' ').trim() || '列出所有可用主机';
      const sshPrompt = [
        '[系统指令]',
        '用户请求执行 SSH 远程操作。请按以下步骤执行：',
        `1. 使用 Read 工具读取 ${DEV_CONFIG_PATH} 获取 SSH 主机信息`,
        '2. 根据用户的自然语言指令匹配对应的主机（按 name 或 description 字段）',
        '3. 根据主机的 authType 字段选择认证方式：',
        '   - authType 为 "key" 时：使用 ssh -i {identityFile} -p {port} {user}@{host} 连接',
        '   - authType 为 "password" 时：使用 sshpass -p {password} ssh -p {port} {user}@{host} 连接（如系统无 sshpass 可先安装）',
        '4. 严格禁止在回复中打印任何密钥或密码内容',
        '5. 操作完成后简要报告结果',
        '',
        `用户指令：${sshArgs}`,
      ].join('\n');
      pendingSlashCommands.set(session.id, { kind: 'ssh' });
      handleMessage(ws, {
        text: sshPrompt,
        sessionId: session.id,
        mode: session.permissionMode || 'yolo',
      }, { hideInHistory: true });
      break;
    }

    case '/cf': {
      if (!sessionId || !session) {
        wsSend(ws, { type: 'system_message', message: '请先进入一个会话后再执行 /cf。' });
        break;
      }
      if (activeProcesses.has(sessionId)) {
        wsSend(ws, { type: 'system_message', message: '当前会话正在处理中，请先等待完成或点击停止。' });
        break;
      }
      const cfArgs = parts.slice(1).join(' ').trim();
      if (!cfArgs) {
        wsSend(ws, {
          type: 'system_message',
          message: '用法: /cf [指令]\n例如: /cf 查看 example.com 的 DNS 记录\n不带指令时将列出所有已配置的 Cloudflare 域名。',
        });
        break;
      }
      const devConfig = loadDevConfig();
      const cfToken = devConfig.cloudflare?.apiToken || '';
      if (!cfToken) {
        wsSend(ws, { type: 'system_message', message: '尚未配置 Cloudflare API Token，请先在 设置 > 开发者设置 中填写。' });
        break;
      }
      const zoneList = (devConfig.cloudflare?.zones || []).map(z => `- ${z.name}${z.notes ? `（${z.notes}）` : ''}`).join('\n') || '（未配置域名）';
      const cfPrompt = [
        '[系统指令]',
        '用户请求执行 Cloudflare 相关操作。请按以下配置与说明执行：',
        '1. API 端点: https://api.cloudflare.com/client/v4',
        `2. 认证方式: HTTP Header "Authorization: Bearer ${cfToken}"（可用 curl 调用）`,
        '3. 常用能力: zones 列表查询（GET /zones）、DNS 记录查询与增改（GET/POST/PUT /zones/{zone_id}/dns_records）、缓存清理、WAF/规则等',
        '4. 根据用户的自然语言指令匹配对应的域名（zones 配置见下方，可用 GET /zones 查询 zone_id）',
        '5. 严格禁止在回复中打印、回显或引用 API Token 的完整内容',
        '6. 操作完成后简要报告结果',
        '',
        '已配置域名:',
        zoneList,
        '',
        `用户指令：${cfArgs}`,
      ].join('\n');
      pendingSlashCommands.set(session.id, { kind: 'cf' });
      handleMessage(ws, {
        text: cfPrompt,
        sessionId: session.id,
        mode: session.permissionMode || 'yolo',
      }, { hideInHistory: true });
      break;
    }

		    case '/mode': {
		      const modeInput = parts[1];
		      const VALID_MODES = ['default', 'plan', 'yolo'];
		      const MODE_DESC = { default: '默认（需权限审批，受限操作）', plan: 'Plan（需确认计划后执行）', yolo: 'YOLO（跳过所有权限检查）' };
		      if (!modeInput) {
		        const cur = session?.permissionMode || 'yolo';
		        wsSend(ws, { type: 'system_message', message: `当前模式: ${MODE_DESC[cur] || cur}\n可选: default, plan, yolo` });
		      } else if (VALID_MODES.includes(modeInput.toLowerCase())) {
		        const mode = modeInput.toLowerCase();
		        if (session) {
		          session.permissionMode = mode;
		          // Mode switching should not reset runtime context (Claude/Codex both resume).
		          session.updated = new Date().toISOString();
		          saveSession(session);
		        }
		        wsSend(ws, { type: 'system_message', message: `权限模式已切换为: ${MODE_DESC[mode]}` });
		        wsSend(ws, { type: 'mode_changed', mode });
		      } else {
	        wsSend(ws, { type: 'system_message', message: `无效模式: ${modeInput}\n可选: default, plan, yolo` });
      }
      break;
    }

    case '/help': {
      const base = '可用指令:\n' +
        '/clear — 清除当前会话（含上下文）\n' +
        '/mode [模式] — 查看/切换权限模式（default, plan, yolo）\n' +
        '/cost — 查看当前会话累计统计\n' +
        '/goal <条件> — 建立并持续维护目标（Claude 原生；Codex 兼容提示）\n' +
        '/loop <间隔> <提示> — 定期执行提示（如 /loop 10m 检查测试）\n' +
        '/loop off — 停止当前会话的定期执行\n' +
        '/github [指令] — GitHub 操作（读取开发者配置后执行）\n' +
        '/ssh [指令] — SSH 远程操作（读取开发者配置后执行）\n' +
        '/cf [指令] — Cloudflare API 操作（如 /cf 查看 example.com 的 DNS 记录）\n' +
        '/help — 显示本帮助';
      wsSend(ws, {
        type: 'system_message',
        message: agent === 'codex'
          ? base + '\n/model [名称] — 查看/切换 Codex 模型（自由输入）\n/compact — 执行 Codex /compact 压缩上下文\n/init — 分析项目并生成/更新 AGENTS.md'
          : base + '\n/model [名称] — 查看/切换模型（opus, sonnet, haiku）\n/compact — 执行 Claude 原生上下文压缩（保留压缩计划并可自动续跑）\n/init — 分析项目并生成/更新 CLAUDE.md',
      });
      break;
    }

    default:
      wsSend(ws, { type: 'system_message', message: `未知指令: ${cmd}\n输入 /help 查看可用指令` });
  }
}

// === Session Handlers ===
function handleNewSession(ws, msg) {
  const cwd = (msg && msg.cwd) ? String(msg.cwd) : null;
  const agent = normalizeAgent(msg?.agent);
  const requestedMode = ['default', 'plan', 'yolo'].includes(msg?.mode) ? msg.mode : 'yolo';
  const taskMode = msg?.taskMode === 'remote' ? 'remote' : 'local';
  const sshHostId = String(msg?.sshHostId || '').trim();
  const remoteCwd = String(msg?.remoteCwd || '').trim();

  let resolvedCwd = cwd || (agent === 'claude' ? (process.env.HOME || process.env.USERPROFILE || process.cwd()) : null);
  let hostInfo = null;

  // Remote task: create host-specific directory and inject host info
  if (taskMode === 'remote' && sshHostId) {
    const devConfig = loadDevConfig();
    hostInfo = (devConfig.ssh.hosts || []).find(h => h.id === sshHostId) || null;
    if (hostInfo) {
      const hostDir = path.join(CONFIG_DIR, 'host', sshHostId);
      fs.mkdirSync(hostDir, { recursive: true });
      resolvedCwd = hostDir;
    }
  }

  const id = crypto.randomUUID();
  const session = {
    id,
    title: 'New Chat',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    agent,
    claudeSessionId: null,
    codexThreadId: null,
    model: agent === 'codex' ? resolveDefaultCodexModel() : MODEL_MAP.opus,
    permissionMode: requestedMode,
    totalCost: 0,
    totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    messages: [],
    cwd: resolvedCwd,
    taskMode,
    sshHostId: taskMode === 'remote' ? sshHostId : '',
    remoteCwd: taskMode === 'remote' ? remoteCwd : '',
  };
  saveSession(session);
  wsSessionMap.set(ws, id);
  wsSend(ws, {
    type: 'session_info',
    sessionId: id,
    messages: [],
    title: session.title,
    mode: session.permissionMode,
    model: sessionModelLabel(session),
    agent,
    cwd: session.cwd,
    totalCost: 0,
    totalUsage: session.totalUsage,
    updated: session.updated,
    hasUnread: false,
    historyPending: false,
    isRunning: false,
    taskMode: session.taskMode,
    sshHostId: session.sshHostId,
    remoteCwd: session.remoteCwd,
  });
  sendSessionList(ws);

  // Inject initial prompt for remote sessions
  if (taskMode === 'remote' && hostInfo) {
    const authType = hostInfo.authType || 'key';
    const authInfo = authType === 'password'
      ? `密码认证（密码已配置，使用 sshpass 连接）`
      : `密钥认证：${hostInfo.identityFile || '(未配置)'}`;
    const sshCmd = authType === 'password'
      ? `sshpass -p <password> ssh -p ${hostInfo.port} ${hostInfo.user}@${hostInfo.host}`
      : `ssh -i ${hostInfo.identityFile} -p ${hostInfo.port} ${hostInfo.user}@${hostInfo.host}`;
    const initPrompt = [
      '[系统上下文]',
      '当前为远程任务会话。目标主机信息：',
      `- 主机名：${hostInfo.name}`,
      `- 地址：${hostInfo.user}@${hostInfo.host}:${hostInfo.port}`,
      `- 认证方式：${authInfo}`,
      `- 远端工作目录：${remoteCwd || 'SSH 默认目录'}`,
      `本地工作目录为 ${resolvedCwd}。`,
      `连接命令：${sshCmd}`,
      '严格禁止在回复中打印任何密钥或密码内容。',
    ].join('\n');
    handleMessage(ws, {
      text: initPrompt,
      sessionId: id,
      mode: requestedMode,
    }, { hideInHistory: true });
  }
}

function handleLoadSession(ws, sessionId) {
  const session = loadSession(sessionId);
  if (!session) {
    return wsSend(ws, { type: 'error', message: 'Session not found' });
  }
  if (getSessionAgent(session) === 'claude' && !session.cwd && session.claudeSessionId) {
    const localMeta = resolveClaudeSessionLocalMeta(session.claudeSessionId);
    if (localMeta?.cwd) {
      session.cwd = localMeta.cwd;
      if (!session.importedFrom && localMeta.projectDir) session.importedFrom = localMeta.projectDir;
      saveSession(session);
    }
  }
  const { recentMessages, olderChunks } = splitHistoryMessages(session.messages);
  const effectiveCwd = session.cwd || activeProcesses.get(sessionId)?.cwd || null;

  // Detach ws from any previous session's process
  for (const [, entry] of activeProcesses) {
    if (entry.ws === ws) entry.ws = null;
  }

  wsSessionMap.set(ws, sessionId);

  // Read and clear unread flag
  const hadUnread = !!session.hasUnread;
  if (session.hasUnread) {
    session.hasUnread = false;
    saveSession(session);
  }

  wsSend(ws, {
    type: 'session_info',
    sessionId: session.id,
    messages: recentMessages,
    title: session.title,
    mode: session.permissionMode || 'yolo',
    model: sessionModelLabel(session),
    agent: getSessionAgent(session),
    hasUnread: hadUnread,
    cwd: effectiveCwd,
    totalCost: session.totalCost || 0,
    totalUsage: session.totalUsage || null,
    historyTotal: session.messages.length,
    historyBuffered: recentMessages.length,
    historyPending: olderChunks.length > 0,
    updated: session.updated,
    isRunning: activeProcesses.has(sessionId),
    // 断线补齐数据源：运行中任务的实时全量输出（内存 fullText，尚未落盘）。
    // undefined 时 JSON.stringify 自动省略该键，无任务的 load_session 行为与旧版完全一致
    activeOutput: activeProcesses.has(sessionId) ? (activeProcesses.get(sessionId).fullText || '') : undefined,
    taskMode: session.taskMode || 'local',
    sshHostId: session.sshHostId || '',
    remoteCwd: session.remoteCwd || '',
  });

  if (olderChunks.length > 0) {
    olderChunks.forEach((chunk, index) => {
      wsSend(ws, {
        type: 'session_history_chunk',
        sessionId: session.id,
        messages: chunk,
        remaining: Math.max(0, olderChunks.length - index - 1),
      });
    });
  }

  // Resume streaming if process is still active
  if (activeProcesses.has(sessionId)) {
    const entry = activeProcesses.get(sessionId);
    entry.ws = ws;
    entry.wsDisconnectTime = null; // clear disconnect marker
    plog('INFO', 'ws_resume_attach', {
      sessionId: sessionId.slice(0, 8),
      pid: entry.pid,
      responseLen: (entry.fullText || '').length,
    });
    wsSend(ws, {
      type: 'resume_generating',
      sessionId,
      text: entry.fullText || '',
      toolCalls: entry.toolCalls || [],
    });
  }
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function deleteClaudeLocalSession(claudeSessionId) {
  if (!claudeSessionId) return;
  const projectsDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'projects');
  try {
    for (const proj of fs.readdirSync(projectsDir)) {
      const target = path.join(projectsDir, proj, `${claudeSessionId}.jsonl`);
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
  } catch {}
}

function deleteCodexLocalSession(session) {
  const threadId = session?.codexThreadId;
  if (!threadId) return { removedFiles: 0, removedDbRows: false };

  const rolloutPaths = new Set();
  if (session.importedRolloutPath) rolloutPaths.add(path.resolve(session.importedRolloutPath));
  try {
    for (const filePath of getCodexRolloutFiles()) {
      if (filePath.includes(threadId)) rolloutPaths.add(path.resolve(filePath));
    }
  } catch {}

  let removedFiles = 0;
  for (const filePath of rolloutPaths) {
    try {
      if (filePath.startsWith(CODEX_SESSIONS_DIR) && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        removedFiles++;
      }
    } catch {}
  }

  let removedDbRows = false;
  try {
    const sqlitePath = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' });
    if (sqlitePath.status === 0) {
      const quotedThreadId = sqlQuote(threadId);
      const stateSql = [
        'PRAGMA foreign_keys = ON;',
        `DELETE FROM thread_dynamic_tools WHERE thread_id = ${quotedThreadId};`,
        `DELETE FROM stage1_outputs WHERE thread_id = ${quotedThreadId};`,
        `DELETE FROM logs WHERE thread_id = ${quotedThreadId};`,
        `DELETE FROM threads WHERE id = ${quotedThreadId};`,
      ].join(' ');
      const stateResult = spawnSync('sqlite3', [CODEX_STATE_DB_PATH, stateSql], { stdio: 'ignore' });
      if (stateResult.status === 0) removedDbRows = true;

      if (fs.existsSync(CODEX_LOG_DB_PATH)) {
        spawnSync('sqlite3', [CODEX_LOG_DB_PATH, `DELETE FROM logs WHERE thread_id = ${quotedThreadId};`], { stdio: 'ignore' });
      }
    }
  } catch {}

  return { removedFiles, removedDbRows };
}

// 单会话删除的完整清理逻辑（handleDeleteSession 与 group_delete 共用，语义必须保持一致）：
// 清 pending 状态 → 杀运行中进程并给查看端发 done → 清 run 目录 → 删 json/附件 → 删本地 CLI 历史
function deleteSessionCleanup(sessionId) {
  pendingSlashCommands.delete(sessionId);
  pendingCompactRetries.delete(sessionId);
  preemptCompactGuard.delete(sessionId);
  if (activeProcesses.has(sessionId)) {
    const entry = activeProcesses.get(sessionId);
    try { killProcess(entry.pid); } catch {}
    if (entry.tailer) entry.tailer.stop();
    activeProcesses.delete(sessionId);
    if (entry.ws) wsSend(entry.ws, { type: 'done', sessionId });
  }
  cleanRunDir(sessionId);
  const p = sessionPath(sessionId);
  const session = loadSession(sessionId);
  const sessionAgent = getSessionAgent(session);
  for (const attachmentId of collectSessionAttachmentIds(session)) {
    removeAttachmentById(attachmentId);
  }
  if (fs.existsSync(p)) fs.unlinkSync(p);
  if (sessionAgent === 'codex') {
    const result = deleteCodexLocalSession(session);
    plog('INFO', 'codex_local_session_deleted', {
      sessionId: sessionId.slice(0, 8),
      threadId: session?.codexThreadId || null,
      removedFiles: result.removedFiles,
      removedDbRows: result.removedDbRows,
    });
  } else {
    deleteClaudeLocalSession(session?.claudeSessionId || null);
  }
}

function handleDeleteSession(ws, sessionId) {
  try {
    deleteSessionCleanup(sessionId);
    sendSessionList(ws);
  } catch {
    wsSend(ws, { type: 'error', message: 'Failed to delete session' });
  }
}

function handleRenameSession(ws, sessionId, title) {
  if (!sessionId || !title) return;
  const session = loadSession(sessionId);
  if (session) {
    session.title = String(title).slice(0, 100);
    session.updated = new Date().toISOString();
    saveSession(session);
    sendSessionList(ws);
    wsSend(ws, { type: 'session_renamed', sessionId, title: session.title });
  }
}

		function handleSetMode(ws, sessionId, mode) {
		  const VALID_MODES = ['default', 'plan', 'yolo'];
		  if (!mode || !VALID_MODES.includes(mode)) return;
		  if (sessionId) {
		    const session = loadSession(sessionId);
		    if (session) {
		      session.permissionMode = mode;
		      // Same rule as /mode: don't clear runtime context on mode changes.
		      session.updated = new Date().toISOString();
		      saveSession(session);
		    }
		  }
		  wsSend(ws, { type: 'mode_changed', mode });
		}

function handleDisconnect(ws, wsId) {
  const affectedSessions = [];
  for (const [sid, entry] of activeProcesses) {
    if (entry.ws === ws) {
      entry.ws = null;
      entry.wsDisconnectTime = new Date().toISOString();
      affectedSessions.push({ sessionId: sid.slice(0, 8), pid: entry.pid });
    }
  }
  wsSessionMap.delete(ws);
  plog('INFO', 'ws_disconnect', { wsId, activeProcessesAffected: affectedSessions });
}

function handleDetachView(ws) {
  for (const [, entry] of activeProcesses) {
    if (entry.ws === ws) {
      entry.ws = null;
      entry.wsDisconnectTime = new Date().toISOString();
    }
  }
  wsSessionMap.delete(ws);
}

function handleAbort(ws) {
  const sessionId = wsSessionMap.get(ws);
  if (!sessionId) return;
  const entry = activeProcesses.get(sessionId);
  if (!entry) return;

  plog('INFO', 'user_abort', { sessionId: sessionId.slice(0, 8), pid: entry.pid });
  killProcess(entry.pid);
  setTimeout(() => {
    killProcess(entry.pid, true);
  }, 3000);
  // handleProcessComplete will be triggered by the PID monitor
}

// === Runtime Message Handler ===
/**
 * 处理用户消息（文本/附件）并 spawn Claude/Codex detached 子进程。
 *
 * 特殊路径：/goal 命令在此函数独立处理（绕过 handleSlashCommand），驱动
 * 多轮自治循环。详见 docs/RUNTIME.md "/goal 多轮自治"。
 *
 * 附件校验：解析 msg.attachments，过期则报错返回。
 *
 * @param {object} ws
 * @param {object} msg - { text, sessionId, mode, attachments, agent }
 * @param {object} [options={}] - { hideInHistory }
 */
function handleMessage(ws, msg, options = {}) {
  const { text, sessionId, mode } = msg;
  const { hideInHistory = false } = options;
  const textValue = typeof text === 'string' ? text : '';
  const attachments = Array.isArray(msg.attachments) ? msg.attachments.slice(0, MAX_MESSAGE_ATTACHMENTS) : [];
  const normalizedText = textValue.trim();
  const resolvedAttachments = resolveMessageAttachments(attachments);
  if (attachments.length > 0 && resolvedAttachments.length === 0) {
    return wsSend(ws, { type: 'error', message: '图片附件已过期或不可用，请重新上传后再发送。' });
  }
  if (!normalizedText && resolvedAttachments.length === 0) return;

  const savedAttachments = resolvedAttachments.map((attachment) => ({
    id: attachment.id,
    kind: 'image',
    filename: attachment.filename,
    mime: attachment.mime,
    size: attachment.size,
    createdAt: attachment.createdAt,
    expiresAt: attachment.expiresAt,
    storageState: attachment.storageState,
  }));

  if (sessionId && activeProcesses.has(sessionId)) {
    return wsSend(ws, { type: 'error', message: '正在处理中，请先点击停止按钮。' });
  }

  const derivedTitle = normalizedText
    ? textValue.slice(0, 60).replace(/\n/g, ' ')
    : `图片: ${savedAttachments[0]?.filename || 'image'}`;

  let session;
  if (sessionId) session = loadSession(sessionId);
  if (!session) {
    const id = crypto.randomUUID();
    const agent = normalizeAgent(msg.agent);
    const resolvedCwd = agent === 'claude' ? (process.env.HOME || process.env.USERPROFILE || process.cwd()) : null;
	    session = {
	      id,
	      title: derivedTitle,
	      created: new Date().toISOString(),
	      updated: new Date().toISOString(),
	      agent,
	      claudeSessionId: null,
	      codexThreadId: null,
	      model: agent === 'codex' ? resolveDefaultCodexModel() : null,
	      permissionMode: mode || 'yolo',
	      totalCost: 0,
	      totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
	      messages: [],
	      cwd: resolvedCwd,
	    };
	  }
  normalizeSession(session);

  if (normalizedText.startsWith('/') && !/^\/goal(?:\s|$)/i.test(normalizedText) && resolvedAttachments.length > 0) {
    return wsSend(ws, { type: 'error', message: '命令消息暂不支持同时附带图片。请先发送图片说明，再单独使用 /model 或 /mode。' });
  }

  if (mode && ['default', 'plan', 'yolo'].includes(mode)) {
    session.permissionMode = mode;
  }

  // === P2 预防性水位压缩（仅 Claude resume 场景）===
  // 发送前读 transcript jsonl 水位，接近上限（默认 80%）则先 /compact 再重放原消息，
  // 复用 P0 自动 compact 注入链路（pendingCompactRetries + pendingSlashCommands + 重放）。
  // 约束：定位/估算/判定任何一步不确定（无 jsonl、无 usage、解析失败、带附件无法重放、
  // 处于自动压缩重试循环等）一律不触发，直接走原流程——正常路径零改变。
  if (
    isClaudeSession(session)
    && session.claudeSessionId
    && normalizedText
    && normalizedText !== '/compact'
    && !hideInHistory
    && resolvedAttachments.length === 0
    && !preemptCompactGuard.has(session.id)
    && pendingCompactRetries.get(session.id)?.reason !== 'auto'
  ) {
    try {
      const jsonlPath = locateClaudeSessionJsonl(session.claudeSessionId);
      const usageTokens = jsonlPath ? estimateClaudeContextUsage(jsonlPath) : null;
      if (usageTokens !== null && shouldPreemptiveCompact(usageTokens, session.model, AUTOCOMPACT_PCT)) {
        preemptCompactGuard.add(session.id);
        session.updated = new Date().toISOString();
        saveSession(session);
        plog('INFO', 'preemptive_compact', {
          sessionId: session.id.slice(0, 8),
          usageTokens,
          windowTokens: /1m/i.test(String(session.model || '')) ? 1_000_000 : 200_000,
          pct: AUTOCOMPACT_PCT,
          model: session.model || 'default',
        });
        wsSend(ws, { type: 'system_message', kind: 'compact', message: '◎ 检测到上下文接近上限，先执行压缩再发送您的消息' });
        // 与 handleProcessComplete 的 auto 分支完全一致的注入方式：
        // reason:'auto' 的重试条目 + kind:'compact' 的 slash 标记 + /compact 走 handleMessage spawn
        pendingCompactRetries.set(session.id, { text: normalizedText, mode: session.permissionMode || 'yolo', reason: 'auto' });
        pendingSlashCommands.set(session.id, { kind: 'compact' });
        handleMessage(ws, { text: '/compact', sessionId: session.id, mode: session.permissionMode || 'yolo' }, { hideInHistory: true });
        return;
      }
    } catch {}
  }

  if (!hideInHistory && normalizedText !== '/compact' && getRuntimeSessionId(session)) {
    pendingCompactRetries.set(session.id, { text: normalizedText, mode: session.permissionMode || 'yolo', reason: 'normal' });
  }

  if (session.title === 'New Chat' || session.title === 'Untitled') {
    session.title = derivedTitle;
  }

  if (!hideInHistory) {
    session.messages.push({
      role: 'user',
      content: textValue,
      attachments: savedAttachments,
      timestamp: new Date().toISOString(),
    });
  }
  session.updated = new Date().toISOString();
  saveSession(session);

  const currentSessionId = session.id;

  for (const [, entry] of activeProcesses) {
    if (entry.ws === ws) entry.ws = null;
  }
  wsSessionMap.set(ws, currentSessionId);

  if (!sessionId) {
    wsSend(ws, {
      type: 'session_info',
      sessionId: currentSessionId,
      messages: session.messages,
      title: session.title,
      mode: session.permissionMode || 'yolo',
      model: sessionModelLabel(session),
      agent: getSessionAgent(session),
      cwd: session.cwd || null,
      totalCost: session.totalCost || 0,
      totalUsage: session.totalUsage || null,
      updated: session.updated,
      hasUnread: false,
      historyPending: false,
      isRunning: false,
      taskMode: session.taskMode || 'local',
      sshHostId: session.sshHostId || '',
      remoteCwd: session.remoteCwd || '',
    });
  }
  sendSessionList(ws);

  const codexGoalMatch = getSessionAgent(session) === 'codex'
    ? normalizedText.match(/^\/goal(?:\s+(.+))?$/i)
    : null;
  const spawnText = codexGoalMatch
    ? (codexGoalMatch[1]
      ? `Create and persist a durable goal for this thread: ${codexGoalMatch[1].trim()}\n\nWork autonomously toward this goal now. Keep the goal updated with meaningful progress, and only mark it complete when the stated condition is satisfied.`
      : 'Clear the durable goal for this thread. Confirm that it has been removed.')
    : textValue;
  const spawnSpec = isClaudeSession(session)
    ? buildClaudeSpawnSpec(session, { attachments: resolvedAttachments })
    : buildCodexSpawnSpec(session, { attachments: resolvedAttachments });
  if (spawnSpec?.error) {
    return wsSend(ws, { type: 'error', message: spawnSpec.error });
  }
  saveSession(session);

  // === Detached process with file-based I/O ===
  const dir = runDir(currentSessionId);
  fs.mkdirSync(dir, { recursive: true });

  const inputPath = path.join(dir, 'input.txt');
  const outputPath = path.join(dir, 'output.jsonl');
  const errorPath = path.join(dir, 'error.log');

  const useStreamJson = isClaudeSession(session) && resolvedAttachments.length > 0;

  if (useStreamJson) {
    const content = [];
    if (spawnText) content.push({ type: 'text', text: spawnText });
    for (const attachment of resolvedAttachments) {
      const data = fs.readFileSync(attachment.path).toString('base64');
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: attachment.mime,
          data,
        },
      });
    }
    fs.writeFileSync(inputPath, `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content,
      },
    })}\n`);
  } else {
    fs.writeFileSync(inputPath, spawnText);
  }

  const outputFd = fs.openSync(outputPath, 'w');
  const errorFd = fs.openSync(errorPath, 'w');

  let proc;
  try {
    let stdinSource;
    if (useStreamJson) {
      // stream-json requires an open pipe (not a closed file) so Claude doesn't exit on EOF
      stdinSource = 'pipe';
    } else {
      stdinSource = fs.openSync(inputPath, 'r');
    }
    proc = spawn(spawnSpec.command, spawnSpec.args, {
      env: spawnSpec.env,
      cwd: spawnSpec.cwd,
      stdio: [stdinSource, outputFd, errorFd],
      detached: !IS_WIN,
      windowsHide: true,
    });
    if (useStreamJson) {
      // Write the stream-json message then close stdin so Claude knows input is done
      proc.stdin.write(fs.readFileSync(inputPath));
      proc.stdin.end();
    } else {
      fs.closeSync(stdinSource);
    }
  } catch (err) {
    fs.closeSync(outputFd);
    fs.closeSync(errorFd);
    cleanRunDir(currentSessionId);
    plog('ERROR', 'process_spawn_fail', { sessionId: currentSessionId.slice(0, 8), error: err.message });
    const agent = getSessionAgent(session);
    return wsSend(ws, { type: 'error', message: formatRuntimeError(agent, err.message, { exitCode: null, signal: null }) });
  }

  fs.closeSync(outputFd);
  fs.closeSync(errorFd);

  fs.writeFileSync(path.join(dir, 'pid'), String(proc.pid));
  proc.unref(); // Process survives Node.js exit

  plog('INFO', 'process_spawn', {
    sessionId: currentSessionId.slice(0, 8),
    pid: proc.pid,
    agent: getSessionAgent(session),
    mode: spawnSpec.mode,
    model: session.model || 'default',
    resume: spawnSpec.resume,
    codexHomeDir: spawnSpec.codexHomeDir || null,
    codexRuntimeKey: spawnSpec.codexRuntimeKey || null,
    args: spawnSpec.args.join(' '),
  });

  // Fast exit detection (while Node.js is running)
  proc.on('exit', (code, signal) => {
    plog('INFO', 'process_exit_event', {
      sessionId: currentSessionId.slice(0, 8),
      pid: proc.pid,
      exitCode: code,
      signal: signal,
    });
    // Small delay to ensure file is fully flushed
    setTimeout(() => {
      // pid 一致性守卫：300ms 窗口内若收尾已被 pid monitor 等通道执行（entry 已删），
      // 或该会话已 spawn 新进程，此处必须跳过——否则会错杀新进程的 entry
      // （吞掉其输出、提前推送 done，表现为任务"瞬间完成且无回复"）
      const current = activeProcesses.get(currentSessionId);
      if (current && current.pid === proc.pid) {
        handleProcessComplete(currentSessionId, code, signal);
      }
    }, 300);
  });

  const entry = {
    pid: proc.pid,
    ws,
    agent: getSessionAgent(session),
    cwd: spawnSpec.cwd,
    inputText: spawnText,
    mode: session.permissionMode || 'yolo',
    codexResumed: !!spawnSpec.resume,
    codexResumeFallbackAttempted: !!options.codexResumeFallbackAttempted,
    fullText: '',
    attachments: resolvedAttachments,
    toolCalls: [],
    lastCost: null,
    lastUsage: null,
    lastError: null,
    errorSent: false,
    codexHomeDir: spawnSpec.codexHomeDir || '',
    codexRuntimeKey: spawnSpec.codexRuntimeKey || '',
    tailer: null,
  };
  activeProcesses.set(currentSessionId, entry);
  sendSessionList(ws);

  // Tail the output file for real-time streaming
  entry.tailer = new FileTailer(outputPath, (line) => {
    try {
      const event = JSON.parse(line);
      processRuntimeEvent(entry, event, currentSessionId);
    } catch {}
  });
  entry.tailer.start();
}

function truncateObj(obj, maxLen) {
  const s = JSON.stringify(obj);
  if (s.length <= maxLen) return obj;
  return s.slice(0, maxLen) + '...';
}

function safeJsonParse(input) {
  if (input === null || input === undefined) return input;
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (!trimmed) return input;
  if (!((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) {
    return input;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return input;
  }
}

function sanitizeToolInput(toolName, input) {
  const parsed = safeJsonParse(input);
  if (toolName === 'AskUserQuestion') {
    return parsed;
  }
  return truncateObj(parsed, 500);
}

const {
  buildClaudeSpawnSpec,
  buildCodexSpawnSpec,
  processClaudeEvent,
  processCodexEvent,
  processRuntimeEvent,
} = createAgentRuntime({
  processEnv: process.env,
  CLAUDE_PATH,
  CODEX_PATH,
  MODEL_MAP,
  loadModelConfig,
  applyCustomTemplateToSettings,
  loadCodexConfig,
  prepareCodexCustomRuntime,
  wsSend,
  truncateObj,
  sanitizeToolInput,
  loadSession,
  saveSession,
  setRuntimeSessionId,
  getRuntimeSessionId,
});

// === Check Update ===
function handleCheckUpdate(ws) {
  const localVersion = (() => {
    try {
      const cl = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8');
      const m = cl.match(/##\s*v([\d.]+)/) || cl.match(/\*\*v([\d.]+)\*\*/);
      if (m) return m[1];
    } catch {}
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || 'unknown'; } catch {}
    return 'unknown';
  })();

  const https = require('https');
  const options = {
    hostname: 'raw.githubusercontent.com',
    path: '/ZgDaniel/cc-web/main/CHANGELOG.md',
    headers: { 'User-Agent': 'cc-web-update-check' },
    timeout: 10000,
  };

  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      if (res.statusCode !== 200) {
        return wsSend(ws, { type: 'update_info', localVersion, error: `HTTP ${res.statusCode}` });
      }
      const m = body.match(/##\s*v([\d.]+)/) || body.match(/\*\*v([\d.]+)\*\*/);
      const latest = m ? m[1] : null;
      if (!latest) {
        return wsSend(ws, { type: 'update_info', localVersion, error: '无法解析远端版本号' });
      }
      const hasUpdate = latest !== localVersion;
      wsSend(ws, {
        type: 'update_info',
        localVersion,
        latestVersion: latest,
        hasUpdate,
        releaseUrl: 'https://github.com/ZgDaniel/cc-web',
      });
    });
  });
  req.on('error', (e) => {
    wsSend(ws, { type: 'update_info', localVersion, error: '网络请求失败: ' + e.message });
  });
  req.on('timeout', () => {
    req.destroy();
    wsSend(ws, { type: 'update_info', localVersion, error: '请求超时' });
  });
  req.end();
}

// === Native Session Import ===

const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'projects');
const CODEX_SESSIONS_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex', 'sessions');
const CODEX_STATE_DB_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex', 'state_5.sqlite');
const CODEX_LOG_DB_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex', 'logs_1.sqlite');

// 从 ~/.claude/projects/<dir>/<sanitized-id>.jsonl 定位 Claude 原生 transcript 文件。
// 找不到（含 HOME 缺失/目录不可读）返回 null；调用方必须容忍 null。
function locateClaudeSessionJsonl(claudeSessionId) {
  if (!claudeSessionId) return null;
  try {
    const dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR).filter((dir) => {
      try { return fs.statSync(path.join(CLAUDE_PROJECTS_DIR, dir)).isDirectory(); } catch { return false; }
    });
    for (const dir of dirs) {
      const filePath = path.join(CLAUDE_PROJECTS_DIR, dir, `${sanitizeId(claudeSessionId)}.jsonl`);
      if (fs.existsSync(filePath)) return filePath;
    }
  } catch {}
  return null;
}

function resolveClaudeSessionLocalMeta(claudeSessionId) {
  if (!claudeSessionId) return null;
  const filePath = locateClaudeSessionJsonl(claudeSessionId);
  if (!filePath) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    let cwd = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (entry.type === 'user' && entry.cwd) {
          cwd = entry.cwd;
          break;
        }
      } catch {}
    }
    return { cwd, projectDir: path.basename(path.dirname(filePath)), filePath };
  } catch {}
  return null;
}

function parseJsonlToMessages(lines) {
  const messages = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    if (entry.type === 'user') {
      const raw = entry.message?.content;
      let content = '';
      if (typeof raw === 'string') {
        content = raw;
      } else if (Array.isArray(raw)) {
        // skip tool_result blocks, only take text blocks
        content = raw
          .filter(b => b.type === 'text')
          .map(b => b.text || '')
          .join('');
      }
      if (content.trim()) {
        messages.push({ role: 'user', content, timestamp: entry.timestamp || null });
      }
    } else if (entry.type === 'assistant') {
      const blocks = entry.message?.content;
      if (!Array.isArray(blocks)) continue;
      let content = '';
      const toolCalls = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) {
          content += b.text;
        } else if (b.type === 'tool_use') {
          toolCalls.push({ name: b.name, id: b.id, input: b.input, done: true });
        }
        // skip thinking blocks
      }
      if (content.trim() || toolCalls.length > 0) {
        messages.push({ role: 'assistant', content, toolCalls, timestamp: entry.timestamp || null });
      }
    }
    // skip other types
  }
  return messages;
}

const {
  parseCodexRolloutLines,
  getCodexRolloutFiles,
  getImportedCodexThreadIds,
  parseCodexRolloutFile,
} = createCodexRolloutStore({
  codexSessionsDir: CODEX_SESSIONS_DIR,
  sessionsDir: SESSIONS_DIR,
  normalizeSession,
  sanitizeToolInput,
});

function getImportedSessionIds() {
  const imported = new Set();
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
        if (s.claudeSessionId) imported.add(s.claudeSessionId);
      } catch {}
    }
  } catch {}
  return imported;
}

function handleListNativeSessions(ws) {
  const groups = [];
  try {
    const imported = getImportedSessionIds();
    const dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR).filter(d => {
      try { return fs.statSync(path.join(CLAUDE_PROJECTS_DIR, d)).isDirectory(); } catch { return false; }
    });
    for (const dir of dirs) {
      const dirPath = path.join(CLAUDE_PROJECTS_DIR, dir);
      const sessionItems = [];
      try {
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
        for (const f of files) {
          const sessionId = f.replace('.jsonl', '');
          const filePath = path.join(dirPath, f);
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n');
            // Find first user message for title
            let title = sessionId.slice(0, 20);
            let cwd = null;
            let updatedAt = null;
            let lastTs = null;
            for (const line of lines) {
              const t = line.trim();
              if (!t) continue;
              try {
                const e = JSON.parse(t);
                if (e.timestamp) lastTs = e.timestamp;
                if (e.type === 'user' && !cwd) {
                  cwd = e.cwd || null;
                  const raw = e.message?.content;
                  let text = '';
                  if (typeof raw === 'string') text = raw;
                  else if (Array.isArray(raw)) text = raw.filter(b => b.type === 'text').map(b => b.text || '').join('');
                  if (text.trim()) title = text.trim().slice(0, 80).replace(/\n/g, ' ');
                }
              } catch {}
            }
            updatedAt = lastTs;
            sessionItems.push({ sessionId, title, cwd, updatedAt, alreadyImported: imported.has(sessionId) });
          } catch {}
        }
      } catch {}
      if (sessionItems.length > 0) {
        sessionItems.sort((a, b) => {
          if (!a.updatedAt) return 1;
          if (!b.updatedAt) return -1;
          return new Date(b.updatedAt) - new Date(a.updatedAt);
        });
        groups.push({ dir, sessions: sessionItems });
      }
    }
  } catch {}
  wsSend(ws, { type: 'native_sessions', groups });
}

function handleImportNativeSession(ws, msg) {
  const { sessionId, projectDir } = msg;
  if (!sessionId || !projectDir) {
    return wsSend(ws, { type: 'error', message: '缺少 sessionId 或 projectDir' });
  }
  const filePath = path.join(CLAUDE_PROJECTS_DIR, String(projectDir), `${sanitizeId(sessionId)}.jsonl`);
  if (!filePath.startsWith(CLAUDE_PROJECTS_DIR)) {
    return wsSend(ws, { type: 'error', message: '非法路径' });
  }
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch {
    return wsSend(ws, { type: 'error', message: '无法读取会话文件' });
  }
  const lines = content.split('\n');
  const messages = parseJsonlToMessages(lines);

  // Find or create cc-web session with this claudeSessionId
  let existingSession = null;
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
        if (s.claudeSessionId === sessionId) { existingSession = s; break; }
      } catch {}
    }
  } catch {}

  // Determine title and cwd from messages/raw
  let title = sessionId.slice(0, 20);
  let cwd = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e.type === 'user') {
        if (!cwd) cwd = e.cwd || null;
        const raw = e.message?.content;
        let text = '';
        if (typeof raw === 'string') text = raw;
        else if (Array.isArray(raw)) text = raw.filter(b => b.type === 'text').map(b => b.text || '').join('');
        if (text.trim()) { title = text.trim().slice(0, 60).replace(/\n/g, ' '); break; }
      }
    } catch {}
  }

  const id = existingSession ? existingSession.id : crypto.randomUUID();
  const session = {
    id,
    title,
    created: existingSession?.created || new Date().toISOString(),
    updated: new Date().toISOString(),
    agent: 'claude',
    claudeSessionId: sessionId,
    codexThreadId: null,
    importedFrom: projectDir,
    model: existingSession?.model || null,
    permissionMode: existingSession?.permissionMode || 'yolo',
    totalCost: existingSession?.totalCost || 0,
    totalUsage: existingSession?.totalUsage || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    messages,
    cwd: cwd || existingSession?.cwd || null,
  };
  saveSession(session);
  wsSessionMap.set(ws, id);
  wsSend(ws, {
    type: 'session_info',
    sessionId: id,
    messages: session.messages,
    title: session.title,
    mode: session.permissionMode,
    model: sessionModelLabel(session),
    agent: getSessionAgent(session),
    cwd: session.cwd,
    totalCost: session.totalCost || 0,
    totalUsage: session.totalUsage || null,
    updated: session.updated,
    hasUnread: false,
    historyPending: false,
    isRunning: false,
    taskMode: session.taskMode || 'local',
    sshHostId: session.sshHostId || '',
    remoteCwd: session.remoteCwd || '',
  });
  sendSessionList(ws);
}

function handleListCodexSessions(ws) {
  const imported = getImportedCodexThreadIds();
  const items = [];
  const seen = new Set();
  for (const filePath of getCodexRolloutFiles()) {
    const parsed = parseCodexRolloutFile(filePath);
    if (!parsed?.meta?.threadId) continue;
    if (seen.has(parsed.meta.threadId)) continue;
    seen.add(parsed.meta.threadId);
    const title = parsed.meta.title || parsed.meta.threadId.slice(0, 20);
    items.push({
      threadId: parsed.meta.threadId,
      title,
      cwd: parsed.meta.cwd || null,
      updatedAt: parsed.meta.updatedAt || null,
      cliVersion: parsed.meta.cliVersion || '',
      source: parsed.meta.source || '',
      rolloutPath: filePath,
      alreadyImported: imported.has(parsed.meta.threadId),
    });
  }
  wsSend(ws, { type: 'codex_sessions', sessions: items });
}

function handleImportCodexSession(ws, msg) {
  const threadId = String(msg?.threadId || '').trim();
  if (!threadId) {
    return wsSend(ws, { type: 'error', message: '缺少 threadId' });
  }

  let parsed = null;
  const requestedPath = msg?.rolloutPath ? path.resolve(String(msg.rolloutPath)) : '';
  if (requestedPath && requestedPath.startsWith(CODEX_SESSIONS_DIR) && fs.existsSync(requestedPath)) {
    parsed = parseCodexRolloutFile(requestedPath);
  }
  if (!parsed) {
    for (const filePath of getCodexRolloutFiles()) {
      const candidate = parseCodexRolloutFile(filePath);
      if (candidate?.meta?.threadId === threadId) {
        parsed = candidate;
        break;
      }
    }
  }

  if (!parsed || parsed.meta.threadId !== threadId) {
    return wsSend(ws, { type: 'error', message: '未找到对应的 Codex 会话文件' });
  }

  let existingSession = null;
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const s = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')));
        if (s.codexThreadId === threadId) { existingSession = s; break; }
      } catch {}
    }
  } catch {}

  const id = existingSession ? existingSession.id : crypto.randomUUID();
  const session = {
    id,
    title: parsed.meta.title || existingSession?.title || threadId.slice(0, 20),
    created: existingSession?.created || new Date().toISOString(),
    updated: new Date().toISOString(),
    agent: 'codex',
    claudeSessionId: null,
    codexThreadId: threadId,
    importedFrom: 'codex',
    importedRolloutPath: parsed.filePath,
    model: existingSession?.model || null,
    permissionMode: existingSession?.permissionMode || 'yolo',
    totalCost: existingSession?.totalCost || 0,
    totalUsage: parsed.totalUsage || existingSession?.totalUsage || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    messages: parsed.messages,
    cwd: parsed.meta.cwd || existingSession?.cwd || null,
  };

  saveSession(session);
  wsSessionMap.set(ws, id);
  wsSend(ws, {
    type: 'session_info',
    sessionId: id,
    messages: session.messages,
    title: session.title,
    mode: session.permissionMode,
    model: sessionModelLabel(session),
    agent: getSessionAgent(session),
    cwd: session.cwd,
    totalCost: session.totalCost || 0,
    totalUsage: session.totalUsage || null,
    updated: session.updated,
    hasUnread: false,
    historyPending: false,
    isRunning: false,
    taskMode: session.taskMode || 'local',
    sshHostId: session.sshHostId || '',
    remoteCwd: session.remoteCwd || '',
  });
  sendSessionList(ws);
}

function handleListCwdSuggestions(ws) {
  const paths = new Set();
  // Always include HOME
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) paths.add(home);
  wsSend(ws, { type: 'cwd_suggestions', paths: Array.from(paths).sort() });
}

// === Startup ===
recoverProcesses();
restoreSessionLoops();

// WS 心跳（ws 库官方 heartbeat 模式）：每轮先把客户端标记为待验证并发 ping；
// 下一轮仍见 isAlive===false（无 pong 回应）判定为死连接，terminate 释放。
// 网络闪断后无需等 TCP 超时即可发现死连接。定时器不 unref（服务常驻）
setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) { client.terminate(); continue; }
    client.isAlive = false;
    try { client.ping(); } catch {}
  }
}, WS_PING_INTERVAL_MS);

// Periodic heartbeat: log active processes status every 60s
setInterval(() => {
  if (activeProcesses.size === 0) return;
  const procs = [];
  for (const [sid, entry] of activeProcesses) {
    const alive = isProcessRunning(entry.pid);
    procs.push({
      sessionId: sid.slice(0, 8),
      pid: entry.pid,
      alive,
      wsConnected: !!entry.ws,
      wsDisconnectTime: entry.wsDisconnectTime || null,
      responseLen: (entry.fullText || '').length,
    });
  }
  plog('INFO', 'heartbeat', { activeCount: procs.length, wsClients: wss.clients.size, processes: procs });
}, 60000);

plog('INFO', 'server_start', { port: PORT });

let shuttingDown = false;

function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  plog('INFO', 'server_shutdown_start', { reason, activeProcesses: activeProcesses.size });

  try {
    for (const client of wss.clients) {
      try { client.close(1001, 'server shutting down'); } catch {}
    }
  } catch {}

  try {
    for (const [, entry] of activeProcesses) {
      if (entry.tailer) entry.tailer.stop();
    }
  } catch {}

  const forceTimer = setTimeout(() => {
    plog('WARN', 'server_shutdown_forced', { reason });
    process.exit(exitCode);
  }, 5000);
  forceTimer.unref?.();

  try {
    server.close(() => {
      clearTimeout(forceTimer);
      plog('INFO', 'server_shutdown_complete', { reason });
      process.exit(exitCode);
    });
  } catch (err) {
    clearTimeout(forceTimer);
    plog('ERROR', 'server_shutdown_error', { reason, error: err.message });
    process.exit(exitCode);
  }
}

function killPortOccupant(port) {
  try {
    const result = require('child_process').execSync(`lsof -ti :${port}`, { encoding: 'utf8' }).trim();
    if (!result) return false;
    for (const pid of result.split('\n').map(Number).filter(Boolean)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    // Wait for port to be released
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        const check = require('child_process').execSync(`lsof -ti :${port}`, { encoding: 'utf8' }).trim();
        if (!check) return true;
      } catch { return true; }
      require('child_process').execSync('sleep 0.2', { stdio: 'ignore' });
    }
    return true;
  } catch { return false; }
}

function handleServerListenError(err) {
  if (err && err.code === 'EADDRINUSE') {
    plog('WARN', 'server_port_in_use_retry', { port: PORT, host: '127.0.0.1' });
    if (killPortOccupant(PORT)) {
      try { server.listen(PORT, '127.0.0.1'); } catch {}
      return;
    }
    plog('ERROR', 'server_port_in_use', { port: PORT, error: err.message });
    console.error(`CC-Web server failed: 127.0.0.1:${PORT} is already in use.`);
    process.exit(98);
    return;
  }
  plog('ERROR', 'server_error', { error: err?.message || String(err) });
  console.error(err);
  process.exit(1);
}

server.on('error', handleServerListenError);

process.on('SIGTERM', () => shutdown('SIGTERM', 0));
process.on('SIGINT', () => shutdown('SIGINT', 0));
process.on('uncaughtException', (err) => {
  if (err && err.code === 'EADDRINUSE') return handleServerListenError(err);
  plog('ERROR', 'uncaught_exception', { error: err?.stack || err?.message || String(err) });
  console.error(err);
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  plog('ERROR', 'unhandled_rejection', { error: reason?.stack || reason?.message || String(reason) });
});

server.listen(PORT, '127.0.0.1', () => {
  ensureAuthLoaded();
  console.log(`CC-Web server listening on 127.0.0.1:${PORT}`);
});
