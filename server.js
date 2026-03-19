const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { WebSocketServer } = require('ws');
const { createAgentRuntime } = require('./lib/agent-runtime');
const { createCodexRolloutStore } = require('./lib/codex-rollouts');

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
const MODEL_CONFIG_PATH = path.join(CONFIG_DIR, 'model.json');
const CODEX_CONFIG_PATH = path.join(CONFIG_DIR, 'codex.json');
const BANNED_IPS_PATH = path.join(CONFIG_DIR, 'banned_ips.json');

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

// === Process Lifecycle Logger ===
const LOG_FILE = path.join(LOGS_DIR, 'process.log');
const LOG_MAX_SIZE = 2 * 1024 * 1024; // 2MB per file

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
  fs.writeFileSync(NOTIFY_CONFIG_PATH, JSON.stringify(config, null, 2));
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
        return { apiBase: profile.apiBase, apiKey: profile.apiKey, model: summaryConfig.model || '' };
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

function loadAuthConfig() {
  // Priority 1: config/auth.json exists with password
  try {
    if (fs.existsSync(AUTH_CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(AUTH_CONFIG_PATH, 'utf8'));
      if (config.password) return config;
    }
  } catch {}

  // Priority 2: .env has CC_WEB_PASSWORD → migrate
  const envPw = process.env.CC_WEB_PASSWORD;
  if (envPw && envPw !== 'changeme') {
    const config = { password: envPw, mustChange: false };
    saveAuthConfig(config);
    return config;
  }

  // Priority 3: Generate random password
  const pw = generateRandomPassword(12);
  const config = { password: pw, mustChange: true };
  saveAuthConfig(config);
  console.log('========================================');
  console.log('  自动生成初始密码: ' + pw);
  console.log('  首次登录后将要求修改密码');
  console.log('========================================');
  return config;
}

function saveAuthConfig(config) {
  fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(config, null, 2));
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

let authConfig = loadAuthConfig();
let PASSWORD = authConfig.password;

const activeTokens = new Set();

// === Anti-brute-force ===
const AUTH_FAIL_WINDOW = 5 * 60 * 1000; // 5 minutes
const AUTH_FAIL_MAX = 3;
const authFailures = new Map(); // ip -> [timestamp, ...]
let bannedIPs = new Set();

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
      const list = JSON.parse(fs.readFileSync(BANNED_IPS_PATH, 'utf8'));
      bannedIPs = new Set(Array.isArray(list) ? list : []);
    }
  } catch { bannedIPs = new Set(); }
}
function saveBannedIPs() {
  fs.writeFileSync(BANNED_IPS_PATH, JSON.stringify([...bannedIPs], null, 2));
}
loadBannedIPs();

function getClientIP(ws) {
  const req = ws._req;
  if (!req) return null;
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

function recordAuthFailure(ip) {
  if (!ip || isWhitelistedIP(ip)) return false;
  const now = Date.now();
  let list = authFailures.get(ip) || [];
  list.push(now);
  list = list.filter(t => now - t < AUTH_FAIL_WINDOW);
  authFailures.set(ip, list);
  if (list.length >= AUTH_FAIL_MAX) {
    bannedIPs.add(ip);
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

// Codex CLI has its own default model if --model is omitted. We override it for new Codex sessions
// to keep cc-web behavior stable and predictable.
const DEFAULT_CODEX_MODEL = 'gpt-5.4';

// === Model Config ===
const DEFAULT_MODEL_CONFIG = {
  mode: 'local',      // 'local' | 'custom'
  templates: [],      // array of { name, apiKey, apiBase, defaultModel, opusModel, sonnetModel, haikuModel }
  activeTemplate: '', // name of active template (for 'custom' mode)
};

const DEFAULT_CODEX_CONFIG = {
  mode: 'local',
  activeProfile: '',
  profiles: [],
  enableSearch: false,
  supportsSearch: false,
};

function loadModelConfig() {
  try {
    if (fs.existsSync(MODEL_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(MODEL_CONFIG_PATH, 'utf8'));
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_MODEL_CONFIG));
}

function saveModelConfig(config) {
  fs.writeFileSync(MODEL_CONFIG_PATH, JSON.stringify(config, null, 2));
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
        })).filter((profile) => profile.name) : [],
        enableSearch: false,
        supportsSearch: false,
        storedEnableSearch: !!raw.enableSearch,
      };
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_CODEX_CONFIG));
}

function saveCodexConfig(config) {
  fs.writeFileSync(CODEX_CONFIG_PATH, JSON.stringify({
    mode: config.mode === 'custom' ? 'custom' : 'local',
    activeProfile: config.activeProfile || '',
    profiles: Array.isArray(config.profiles) ? config.profiles.map((profile) => ({
      name: String(profile?.name || '').trim(),
      apiKey: String(profile?.apiKey || ''),
      apiBase: String(profile?.apiBase || '').trim(),
    })).filter((profile) => profile.name) : [],
    enableSearch: false,
  }, null, 2));
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
    })),
    enableSearch: false,
    supportsSearch: false,
    storedEnableSearch: !!config.storedEnableSearch,
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
  };
}

const CODEX_RUNTIME_HOME = path.join(CONFIG_DIR, 'codex-runtime-home');

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

function prepareCodexCustomRuntime(config) {
  if (!config || config.mode !== 'custom') return { mode: 'local' };
  const profiles = Array.isArray(config.profiles) ? config.profiles : [];
  const activeProfile = profiles.find((profile) => profile.name === config.activeProfile) || null;
  if (!activeProfile) {
    return { error: 'Codex 自定义配置缺少已激活的 profile。请先在设置中创建并激活一个 API 配置。' };
  }
  if (!activeProfile.apiKey || !activeProfile.apiBase) {
    return { error: `Codex profile「${activeProfile.name}」缺少 API Key 或 API Base URL。` };
  }

  fs.mkdirSync(CODEX_RUNTIME_HOME, { recursive: true });
  const configToml = [
    'preferred_auth_method = "apikey"',
    'model_provider = "openai_compat"',
    '',
    '[model_providers.openai_compat]',
    `name = ${tomlString(activeProfile.name || 'OpenAI Compat')}`,
    `base_url = ${tomlString(activeProfile.apiBase)}`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(CODEX_RUNTIME_HOME, 'config.toml'), configToml);

  return {
    mode: 'custom',
    homeDir: CODEX_RUNTIME_HOME,
    apiKey: activeProfile.apiKey,
    apiBase: activeProfile.apiBase,
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
  if (tpl.apiKey)       { cleanedEnv.ANTHROPIC_AUTH_TOKEN = tpl.apiKey; cleanedEnv.ANTHROPIC_API_KEY = tpl.apiKey; }
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

function wsSend(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
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
  fs.writeFileSync(attachmentMetaPath(meta.id), JSON.stringify(meta, null, 2));
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

function normalizeSession(session) {
  if (!session || typeof session !== 'object') return session;
  session.agent = normalizeAgent(session.agent);
  if (!Object.prototype.hasOwnProperty.call(session, 'claudeSessionId')) session.claudeSessionId = null;
  if (!Object.prototype.hasOwnProperty.call(session, 'codexThreadId')) session.codexThreadId = null;
  if (!Object.prototype.hasOwnProperty.call(session, 'totalCost')) session.totalCost = 0;
  if (!Object.prototype.hasOwnProperty.call(session, 'totalUsage') || !session.totalUsage) {
    session.totalUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
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

function saveSession(session) {
  normalizeSession(session);
  fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
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
  try {
    if (IS_WIN) {
      const args = ['/T', '/PID', String(pid)];
      if (force) args.unshift('/F');
      spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
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
        });
      } catch {}
    }
    sessions.sort((a, b) => new Date(b.updated) - new Date(a.updated));
    wsSend(ws, { type: 'session_list', sessions });
  } catch {
    wsSend(ws, { type: 'session_list', sessions: [] });
  }
}

// === File Tailer ===
// Tails a file and calls onLine for each new complete line.
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
    return /Request too large \(max 20MB\)/i.test(text);
  }
  return /context\s+(window|length)|maximum context length|context limit|token limit|too many tokens|input.*too long|prompt.*too long|request too large|please use\s*\/compact|use\s*\/compact|reduce (the )?(input|prompt|message)|exceed(?:ed|s).*(token|context)/i.test(text);
}

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
  const completionError = rawCompletionError ? formatRuntimeError(entry.agent || 'claude', rawCompletionError, { exitCode, signal }) : null;
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

  // Save result to session
  const session = loadSession(sessionId);
  if (session && entry.fullText) {
    session.messages.push({
      role: 'assistant',
      content: entry.fullText,
      toolCalls: entry.toolCalls || [],
      timestamp: new Date().toISOString(),
    });
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

// Recover processes that were running before server restart
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
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname === '/api/attachments') {
    const token = extractBearerToken(req);
    if (!token || !activeTokens.has(token)) {
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
    if (!token || !activeTokens.has(token)) {
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
  ws._req = req;
  const clientIP = getClientIP(ws);

  // Check if IP is banned
  if (clientIP && bannedIPs.has(clientIP)) {
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
      // Check ban before processing auth
      if (clientIP && bannedIPs.has(clientIP)) {
        wsSend(ws, { type: 'auth_result', success: false, banned: true });
        ws.close();
        return;
      }
      if (msg.password === PASSWORD || (msg.token && activeTokens.has(msg.token))) {
        authToken = msg.token && activeTokens.has(msg.token) ? msg.token : crypto.randomBytes(32).toString('hex');
        activeTokens.add(authToken);
        authenticated = true;
        wsSend(ws, { type: 'auth_result', success: true, token: authToken, mustChangePassword: !!authConfig.mustChange });
        sendSessionList(ws);
      } else {
        const justBanned = recordAuthFailure(clientIP);
        wsSend(ws, { type: 'auth_result', success: false, banned: justBanned });
        if (justBanned) ws.close();
      }
      return;
    }

    if (!authenticated) {
      return wsSend(ws, { type: 'error', message: 'Not authenticated' });
    }

    switch (msg.type) {
      case 'message':
        if (msg.text && msg.text.trim().startsWith('/')) {
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

  // Validate current password
  if (currentPassword !== PASSWORD) {
    return wsSend(ws, { type: 'password_changed', success: false, message: '当前密码错误' });
  }

  // Validate new password strength
  const strength = validatePasswordStrength(newPassword);
  if (!strength.valid) {
    return wsSend(ws, { type: 'password_changed', success: false, message: strength.message });
  }

  // Save new password
  authConfig = { password: newPassword, mustChange: false };
  saveAuthConfig(authConfig);
  PASSWORD = newPassword;
  plog('INFO', 'password_changed', {});

  // Clear all tokens (force all sessions to re-login)
  activeTokens.clear();

  // Generate new token for current connection
  const newToken = crypto.randomBytes(32).toString('hex');
  activeTokens.add(newToken);

  wsSend(ws, { type: 'password_changed', success: true, token: newToken, message: '密码修改成功' });
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

  // Remap ALL Claude sessions' model to current template values.
  // Build a reverse map: modelName → tier, from ALL templates (not just old/new).
  // This handles switches between any pair of templates regardless of name overlap.
  const modelToTier = new Map();
  for (const tpl of (merged.templates || [])) {
    if (tpl.opusModel) modelToTier.set(tpl.opusModel, 'opus');
    if (tpl.sonnetModel) modelToTier.set(tpl.sonnetModel, 'sonnet');
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
          session.updated = new Date().toISOString();
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
    mergedProfiles.push({
      name,
      apiKey: rawApiKey && !rawApiKey.includes('****') ? rawApiKey : (old?.apiKey || ''),
      apiBase: String(profile?.apiBase || '').trim(),
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
  };
  if (merged.mode === 'custom' && merged.profiles.length > 0 && !merged.profiles.some((profile) => profile.name === merged.activeProfile)) {
    merged.activeProfile = merged.profiles[0].name;
  }
  saveCodexConfig(merged);
  plog('INFO', 'codex_config_saved', {
    mode: merged.mode,
    activeProfile: merged.activeProfile || null,
    profileCount: merged.profiles.length,
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
    const config = loadModelConfig();
    const saved = (config.templates || []);
    // Match by template name first, then by apiBase
    const tpl = (msg.templateName && saved.find(t => t.name === msg.templateName))
      || saved.find(t => t.apiBase && t.apiBase.replace(/\/+$/, '') === base)
      || null;
    if (tpl && tpl.apiKey && !tpl.apiKey.includes('****')) realKey = tpl.apiKey;
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
function handleSlashCommand(ws, text, sessionId, fallbackAgent) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  let session = sessionId ? loadSession(sessionId) : null;
  const agent = session ? getSessionAgent(session) : normalizeAgent(fallbackAgent);

  switch (cmd) {
    case '/clear': {
      if (session) {
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
        });
      }
      wsSend(ws, { type: 'system_message', message: '会话已清除，上下文已重置。' });
      break;
    }

    case '/model': {
      const modelInput = parts[1];
      if (agent === 'codex') {
        if (!modelInput) {
          const current = session?.model || '配置默认模型';
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
  const resolvedCwd = cwd || (agent === 'claude' ? (process.env.HOME || process.env.USERPROFILE || process.cwd()) : null);
  const id = crypto.randomUUID();
  const session = {
    id,
    title: 'New Chat',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    agent,
    claudeSessionId: null,
    codexThreadId: null,
    // For Codex: explicitly set a default model on creation so we don't inherit Codex CLI defaults.
    // For Claude: default to opus (1M) so --model is always passed to CLI.
    model: agent === 'codex' ? DEFAULT_CODEX_MODEL : MODEL_MAP.opus,
    permissionMode: requestedMode,
    totalCost: 0,
    totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    messages: [],
    cwd: resolvedCwd,
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
  });
  sendSessionList(ws);
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

function handleDeleteSession(ws, sessionId) {
  pendingSlashCommands.delete(sessionId);
  pendingCompactRetries.delete(sessionId);
  if (activeProcesses.has(sessionId)) {
    const entry = activeProcesses.get(sessionId);
    try { killProcess(entry.pid); } catch {}
    if (entry.tailer) entry.tailer.stop();
    activeProcesses.delete(sessionId);
    if (entry.ws) wsSend(entry.ws, { type: 'done', sessionId });
  }
  cleanRunDir(sessionId);
  try {
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
	      model: agent === 'codex' ? DEFAULT_CODEX_MODEL : null,
	      permissionMode: mode || 'yolo',
	      totalCost: 0,
	      totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
	      messages: [],
	      cwd: resolvedCwd,
	    };
	  }
  normalizeSession(session);

  if (normalizedText.startsWith('/') && resolvedAttachments.length > 0) {
    return wsSend(ws, { type: 'error', message: '命令消息暂不支持同时附带图片。请先发送图片说明，再单独使用 /model 或 /mode。' });
  }

  if (mode && ['default', 'plan', 'yolo'].includes(mode)) {
    session.permissionMode = mode;
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
    });
  }
  sendSessionList(ws);

  const spawnSpec = isClaudeSession(session)
    ? buildClaudeSpawnSpec(session, { attachments: resolvedAttachments })
    : buildCodexSpawnSpec(session, { attachments: resolvedAttachments });
  if (spawnSpec?.error) {
    return wsSend(ws, { type: 'error', message: spawnSpec.error });
  }

  // === Detached process with file-based I/O ===
  const dir = runDir(currentSessionId);
  fs.mkdirSync(dir, { recursive: true });

  const inputPath = path.join(dir, 'input.txt');
  const outputPath = path.join(dir, 'output.jsonl');
  const errorPath = path.join(dir, 'error.log');

  if (isClaudeSession(session) && resolvedAttachments.length > 0) {
    const content = [];
    if (textValue) content.push({ type: 'text', text: textValue });
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
    fs.writeFileSync(inputPath, textValue);
  }

  const inputFd = fs.openSync(inputPath, 'r');
  const outputFd = fs.openSync(outputPath, 'w');
  const errorFd = fs.openSync(errorPath, 'w');

  let proc;
  try {
    proc = spawn(spawnSpec.command, spawnSpec.args, {
      env: spawnSpec.env,
      cwd: spawnSpec.cwd,
      stdio: [inputFd, outputFd, errorFd],
      detached: !IS_WIN,
      windowsHide: true,
    });
  } catch (err) {
    fs.closeSync(inputFd);
    fs.closeSync(outputFd);
    fs.closeSync(errorFd);
    cleanRunDir(currentSessionId);
    plog('ERROR', 'process_spawn_fail', { sessionId: currentSessionId.slice(0, 8), error: err.message });
    const agent = getSessionAgent(session);
    return wsSend(ws, { type: 'error', message: formatRuntimeError(agent, err.message, { exitCode: null, signal: null }) });
  }

  fs.closeSync(inputFd);
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
    setTimeout(() => handleProcessComplete(currentSessionId, code, signal), 300);
  });

  const entry = {
    pid: proc.pid,
    ws,
    agent: getSessionAgent(session),
    cwd: spawnSpec.cwd,
    fullText: '',
    attachments: resolvedAttachments,
    toolCalls: [],
    lastCost: null,
    lastUsage: null,
    lastError: null,
    errorSent: false,
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

function resolveClaudeSessionLocalMeta(claudeSessionId) {
  if (!claudeSessionId) return null;
  try {
    const dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR).filter((dir) => {
      try { return fs.statSync(path.join(CLAUDE_PROJECTS_DIR, dir)).isDirectory(); } catch { return false; }
    });
    for (const dir of dirs) {
      const filePath = path.join(CLAUDE_PROJECTS_DIR, dir, `${sanitizeId(claudeSessionId)}.jsonl`);
      if (!fs.existsSync(filePath)) continue;
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
        return { cwd, projectDir: dir, filePath };
      } catch {}
    }
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`CC-Web server listening on 127.0.0.1:${PORT}`);
});
