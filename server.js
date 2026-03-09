const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

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
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOGS_DIR = path.join(__dirname, 'logs');
const NOTIFY_CONFIG_PATH = path.join(__dirname, 'config', 'notify.json');
const AUTH_CONFIG_PATH = path.join(__dirname, 'config', 'auth.json');

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(path.dirname(NOTIFY_CONFIG_PATH), { recursive: true });

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
function loadNotifyConfig() {
  try {
    if (fs.existsSync(NOTIFY_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(NOTIFY_CONFIG_PATH, 'utf8'));
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
  return {
    provider: config.provider,
    pushplus: { token: maskToken(config.pushplus?.token) },
    telegram: { botToken: maskToken(config.telegram?.botToken), chatId: config.telegram?.chatId || '' },
    serverchan: { sendKey: maskToken(config.serverchan?.sendKey) },
    feishu: { webhook: maskToken(config.feishu?.webhook) },
    qqbot: { qmsgKey: maskToken(config.qqbot?.qmsgKey) },
  };
}

function sendNotification(title, content) {
  const config = loadNotifyConfig();
  if (!config.provider || config.provider === 'off') return Promise.resolve({ ok: true, skipped: true });
  const https = require('https');

  return new Promise((resolve) => {
    let url, data;
    let isFormData = false;
    switch (config.provider) {
      case 'pushplus': {
        if (!config.pushplus?.token) return resolve({ ok: false, error: 'PushPlus token 未配置' });
        url = 'https://www.pushplus.plus/send';
        data = JSON.stringify({ token: config.pushplus.token, title, content, template: 'txt' });
        break;
      }
      case 'telegram': {
        if (!config.telegram?.botToken || !config.telegram?.chatId) return resolve({ ok: false, error: 'Telegram botToken 或 chatId 未配置' });
        url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;
        data = JSON.stringify({ chat_id: config.telegram.chatId, text: `${title}\n\n${content}` });
        break;
      }
      case 'serverchan': {
        if (!config.serverchan?.sendKey) return resolve({ ok: false, error: 'Server酱 sendKey 未配置' });
        url = `https://sctapi.ftqq.com/${config.serverchan.sendKey}.send`;
        data = JSON.stringify({ title, desp: content });
        break;
      }
      case 'feishu': {
        if (!config.feishu?.webhook) return resolve({ ok: false, error: '飞书 Webhook 未配置' });
        url = config.feishu.webhook;
        data = JSON.stringify({ msg_type: 'text', content: { text: `${title}\n\n${content}` } });
        break;
      }
      case 'qqbot': {
        if (!config.qqbot?.qmsgKey) return resolve({ ok: false, error: 'Qmsg Key 未配置' });
        url = `https://qmsg.zendee.cn/send/${config.qqbot.qmsgKey}`;
        data = `msg=${encodeURIComponent(`${title}\n\n${content}`)}`;
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

// Active processes: sessionId -> { pid, ws, fullText, toolCalls, lastCost, tailer }
const activeProcesses = new Map();

// Track which session each ws is viewing: ws -> sessionId
const wsSessionMap = new Map();

const MODEL_MAP = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

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

function loadSession(id) {
  try {
    return JSON.parse(fs.readFileSync(sessionPath(id), 'utf8'));
  } catch {
    return null;
  }
}

function saveSession(session) {
  fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
}

function modelShortName(fullModel) {
  if (!fullModel) return null;
  const entry = Object.entries(MODEL_MAP).find(([, v]) => v === fullModel);
  return entry ? entry[0] : null;
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
        const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
        sessions.push({ id: s.id, title: s.title || 'Untitled', updated: s.updated, hasUnread: !!s.hasUnread });
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

function handleProcessComplete(sessionId, exitCode, signal) {
  const entry = activeProcesses.get(sessionId);
  if (!entry) return;

  const completeTime = new Date().toISOString();
  const wsConnected = !!entry.ws;
  const disconnectGap = entry.wsDisconnectTime
    ? ((new Date(completeTime) - new Date(entry.wsDisconnectTime)) / 1000).toFixed(1) + 's'
    : null;

  // Read stderr for error clues
  let stderrSnippet = '';
  try {
    const errPath = path.join(runDir(sessionId), 'error.log');
    if (fs.existsSync(errPath)) {
      const content = fs.readFileSync(errPath, 'utf8').trim();
      if (content) stderrSnippet = content.slice(-500);
    }
  } catch {}

  plog(exitCode === 0 || exitCode === null ? 'INFO' : 'WARN', 'process_complete', {
    sessionId: sessionId.slice(0, 8),
    pid: entry.pid,
    exitCode,
    signal,
    wsConnected,
    wsDisconnectTime: entry.wsDisconnectTime || null,
    disconnectToDeathGap: disconnectGap,
    responseLen: (entry.fullText || '').length,
    toolCallCount: (entry.toolCalls || []).length,
    cost: entry.lastCost,
    stderr: stderrSnippet || null,
  });

  // Final read
  if (entry.tailer) {
    entry.tailer.readNew();
    entry.tailer.stop();
  }

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

  // Notify client
  if (entry.ws) {
    wsSend(entry.ws, { type: 'done', sessionId, costUsd: entry.lastCost || null });
    sendSessionList(entry.ws);
  } else {
    // Process completed while browser was disconnected — notify all connected clients
    const session = loadSession(sessionId);
    const title = session?.title || 'Untitled';
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
    // Push notification
    const cost = entry.lastCost ? `$${entry.lastCost.toFixed(4)}` : '';
    const respLen = (entry.fullText || '').length;
    sendNotification(
      `CC-Web 任务完成`,
      `会话: ${title}\n字数: ${respLen}\n费用: ${cost}`
    );
  }

  activeProcesses.delete(sessionId);
  cleanRunDir(sessionId);
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

      if (!fs.existsSync(pidPath)) {
        try { fs.rmSync(dir, { recursive: true }); } catch {}
        continue;
      }

      const pid = parseInt(fs.readFileSync(pidPath, 'utf8'));

      if (isProcessRunning(pid)) {
        console.log(`[recovery] Re-attaching to session ${sessionId} (PID ${pid})`);
        plog('INFO', 'recovery_alive', { sessionId: sessionId.slice(0, 8), pid });
        const entry = { pid, ws: null, fullText: '', toolCalls: [], lastCost: null, tailer: null };
        activeProcesses.set(sessionId, entry);

        if (fs.existsSync(outputPath)) {
          entry.tailer = new FileTailer(outputPath, (line) => {
            try {
              const event = JSON.parse(line);
              processClaudeEvent(entry, event, sessionId);
            } catch {}
          });
          entry.tailer.start();
        }
      } else {
        // Process finished while server was down — read all output and save
        console.log(`[recovery] Processing completed output for session ${sessionId}`);
        plog('INFO', 'recovery_dead', { sessionId: sessionId.slice(0, 8), pid });
        if (fs.existsSync(outputPath)) {
          const tempEntry = { pid: 0, ws: null, fullText: '', toolCalls: [], lastCost: null, tailer: null };
          const content = fs.readFileSync(outputPath, 'utf8');
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              processClaudeEvent(tempEntry, event, sessionId);
            } catch {}
          }
          const session = loadSession(sessionId);
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

wss.on('connection', (ws) => {
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
      if (msg.password === PASSWORD || (msg.token && activeTokens.has(msg.token))) {
        authToken = msg.token && activeTokens.has(msg.token) ? msg.token : crypto.randomBytes(32).toString('hex');
        activeTokens.add(authToken);
        authenticated = true;
        wsSend(ws, { type: 'auth_result', success: true, token: authToken, mustChangePassword: !!authConfig.mustChange });
        sendSessionList(ws);
      } else {
        wsSend(ws, { type: 'auth_result', success: false });
      }
      return;
    }

    if (!authenticated) {
      return wsSend(ws, { type: 'error', message: 'Not authenticated' });
    }

    switch (msg.type) {
      case 'message':
        if (msg.text && msg.text.trim().startsWith('/')) {
          handleSlashCommand(ws, msg.text.trim(), msg.sessionId);
        } else {
          handleMessage(ws, msg);
        }
        break;
      case 'abort':
        handleAbort(ws);
        break;
      case 'new_session':
        handleNewSession(ws);
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

// === Slash Command Handler ===
function handleSlashCommand(ws, text, sessionId) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  let session = sessionId ? loadSession(sessionId) : null;

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
        session.claudeSessionId = null;
        session.updated = new Date().toISOString();
        saveSession(session);
        wsSend(ws, { type: 'session_info', sessionId: session.id, messages: [], title: session.title });
      }
      wsSend(ws, { type: 'system_message', message: '会话已清除，上下文已重置。' });
      break;
    }

    case '/model': {
      const modelInput = parts[1];
      if (!modelInput) {
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
      const cost = session?.totalCost || 0;
      wsSend(ws, { type: 'system_message', message: `当前会话累计费用: $${cost.toFixed(4)}` });
      break;
    }

    case '/compact': {
      if (session) {
        session.claudeSessionId = null;
        session.updated = new Date().toISOString();
        saveSession(session);
      }
      wsSend(ws, { type: 'system_message', message: '上下文已压缩（Claude 会话 ID 已重置，下次发送将开始新的 Claude 会话，但聊天记录保留）。' });
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
          session.claudeSessionId = null;
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
      wsSend(ws, {
        type: 'system_message',
        message: '可用指令:\n' +
          '/clear — 清除当前会话（含上下文）\n' +
          '/model [名称] — 查看/切换模型（opus, sonnet, haiku）\n' +
          '/mode [模式] — 查看/切换权限模式（default, plan, yolo）\n' +
          '/cost — 查看当前会话累计费用\n' +
          '/compact — 压缩上下文（重置 Claude 会话但保留聊天记录）\n' +
          '/help — 显示本帮助',
      });
      break;
    }

    default:
      wsSend(ws, { type: 'system_message', message: `未知指令: ${cmd}\n输入 /help 查看可用指令` });
  }
}

// === Session Handlers ===
function handleNewSession(ws) {
  const id = crypto.randomUUID();
  const session = {
    id,
    title: 'New Chat',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    claudeSessionId: null,
    model: null,
    permissionMode: 'yolo',
    totalCost: 0,
    messages: [],
  };
  saveSession(session);
  wsSessionMap.set(ws, id);
  wsSend(ws, { type: 'session_info', sessionId: id, messages: [], title: session.title, mode: session.permissionMode, model: null });
  sendSessionList(ws);
}

function handleLoadSession(ws, sessionId) {
  const session = loadSession(sessionId);
  if (!session) {
    return wsSend(ws, { type: 'error', message: 'Session not found' });
  }

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
    messages: session.messages,
    title: session.title,
    mode: session.permissionMode || 'yolo',
    model: modelShortName(session.model),
    hasUnread: hadUnread,
  });

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

function handleDeleteSession(ws, sessionId) {
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
    if (fs.existsSync(p)) fs.unlinkSync(p);
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
      session.claudeSessionId = null;
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

// === Claude Message Handler ===
function handleMessage(ws, msg) {
  const { text, sessionId, mode } = msg;
  if (!text || !text.trim()) return;

  if (sessionId && activeProcesses.has(sessionId)) {
    return wsSend(ws, { type: 'error', message: '正在处理中，请先点击停止按钮。' });
  }

  let session;
  if (sessionId) session = loadSession(sessionId);
  if (!session) {
    const id = crypto.randomUUID();
    session = {
      id,
      title: text.slice(0, 60).replace(/\n/g, ' '),
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      claudeSessionId: null,
      model: null,
      permissionMode: mode || 'yolo',
      totalCost: 0,
      messages: [],
    };
  }

  if (mode && ['default', 'plan', 'yolo'].includes(mode)) {
    session.permissionMode = mode;
  }

  if (session.title === 'New Chat' || session.title === 'Untitled') {
    session.title = text.slice(0, 60).replace(/\n/g, ' ');
  }

  session.messages.push({ role: 'user', content: text, timestamp: new Date().toISOString() });
  session.updated = new Date().toISOString();
  saveSession(session);

  const currentSessionId = session.id;

  for (const [, entry] of activeProcesses) {
    if (entry.ws === ws) entry.ws = null;
  }
  wsSessionMap.set(ws, currentSessionId);

  if (!sessionId) {
    wsSend(ws, { type: 'session_info', sessionId: currentSessionId, messages: session.messages, title: session.title, mode: session.permissionMode || 'yolo', model: modelShortName(session.model) });
  }
  sendSessionList(ws);

  // Build claude args
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  const permMode = session.permissionMode || 'yolo';
  switch (permMode) {
    case 'yolo':
      args.push('--dangerously-skip-permissions');
      break;
    case 'plan':
      args.push('--permission-mode', 'plan');
      break;
    case 'default':
      break;
  }
  if (session.claudeSessionId) {
    args.push('--resume', session.claudeSessionId);
  }
  if (session.model) {
    args.push('--model', session.model);
  }

  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;
  delete env.CC_WEB_PASSWORD;

  // === Detached process with file-based I/O ===
  const dir = runDir(currentSessionId);
  fs.mkdirSync(dir, { recursive: true });

  const inputPath = path.join(dir, 'input.txt');
  const outputPath = path.join(dir, 'output.jsonl');
  const errorPath = path.join(dir, 'error.log');

  fs.writeFileSync(inputPath, text);

  const inputFd = fs.openSync(inputPath, 'r');
  const outputFd = fs.openSync(outputPath, 'w');
  const errorFd = fs.openSync(errorPath, 'w');

  let proc;
  try {
    proc = spawn(CLAUDE_PATH, args, {
      env,
      cwd: process.env.HOME || process.env.USERPROFILE || process.cwd(),
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
    return wsSend(ws, { type: 'error', message: `启动 Claude 失败: ${err.message}` });
  }

  fs.closeSync(inputFd);
  fs.closeSync(outputFd);
  fs.closeSync(errorFd);

  fs.writeFileSync(path.join(dir, 'pid'), String(proc.pid));
  proc.unref(); // Process survives Node.js exit

  plog('INFO', 'process_spawn', {
    sessionId: currentSessionId.slice(0, 8),
    pid: proc.pid,
    mode: permMode,
    model: session.model || 'default',
    resume: !!session.claudeSessionId,
    args: args.join(' '),
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

  const entry = { pid: proc.pid, ws, fullText: '', toolCalls: [], lastCost: null, tailer: null };
  activeProcesses.set(currentSessionId, entry);

  // Tail the output file for real-time streaming
  entry.tailer = new FileTailer(outputPath, (line) => {
    try {
      const event = JSON.parse(line);
      processClaudeEvent(entry, event, currentSessionId);
    } catch {}
  });
  entry.tailer.start();
}

// === Claude Event Processing ===
function processClaudeEvent(entry, event, sessionId) {
  if (!event || !event.type) return;

  switch (event.type) {
    case 'system':
      if (event.session_id) {
        const session = loadSession(sessionId);
        if (session) {
          session.claudeSessionId = event.session_id;
          saveSession(session);
        }
      }
      break;

    case 'assistant': {
      const content = event.message?.content;
      if (!Array.isArray(content)) break;

      for (const block of content) {
        if (block.type === 'text' && block.text) {
          entry.fullText += block.text;
          wsSend(entry.ws, { type: 'text_delta', text: block.text });
        } else if (block.type === 'tool_use') {
          const toolInput = sanitizeToolInput(block.name, block.input);
          const tc = { name: block.name, id: block.id, input: toolInput, done: false };
          entry.toolCalls.push(tc);
          wsSend(entry.ws, { type: 'tool_start', name: block.name, toolUseId: block.id, input: tc.input });
        } else if (block.type === 'tool_result') {
          const resultText = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map(c => c.text || '').join('\n')
              : JSON.stringify(block.content);
          const tc = entry.toolCalls.find(t => t.id === block.tool_use_id);
          if (tc) { tc.done = true; tc.result = resultText.slice(0, 2000); }
          wsSend(entry.ws, { type: 'tool_end', toolUseId: block.tool_use_id, result: resultText.slice(0, 2000) });
        }
      }

      if (event.session_id) {
        const session = loadSession(sessionId);
        if (session && !session.claudeSessionId) {
          session.claudeSessionId = event.session_id;
          saveSession(session);
        }
      }
      break;
    }

    case 'result': {
      const session = loadSession(sessionId);
      if (session) {
        if (event.session_id) session.claudeSessionId = event.session_id;
        if (event.total_cost_usd) session.totalCost = (session.totalCost || 0) + event.total_cost_usd;
        saveSession(session);
      }
      entry.lastCost = event.total_cost_usd || null;
      if (entry.ws && event.total_cost_usd !== undefined) {
        wsSend(entry.ws, { type: 'cost', costUsd: session?.totalCost || 0 });
      }
      break;
    }
  }
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
