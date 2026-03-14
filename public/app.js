// === CC-Web Frontend ===
(function () {
  'use strict';

  const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const RENDER_DEBOUNCE = 100;

  const SLASH_COMMANDS = [
    { cmd: '/clear', desc: '清除当前会话' },
    { cmd: '/model', desc: '查看/切换模型' },
    { cmd: '/mode', desc: '查看/切换权限模式' },
    { cmd: '/cost', desc: '查看会话费用' },
    { cmd: '/compact', desc: '压缩上下文' },
    { cmd: '/help', desc: '显示帮助' },
  ];

  const MODE_LABELS = {
    default: '默认',
    plan: 'Plan',
    yolo: 'YOLO',
  };

  const AGENT_LABELS = {
    claude: 'Claude',
    codex: 'Codex',
  };

  const DEFAULT_AGENT = 'claude';
  const SESSION_CACHE_LIMIT = 4;
  const SESSION_CACHE_MAX_WEIGHT = 1_500_000;
  const SIDEBAR_SWIPE_TRIGGER = 72;
  const SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT = 42;

  const MODEL_OPTIONS = [
    { value: 'opus', label: 'Opus', desc: '最强大，适合复杂任务' },
    { value: 'sonnet', label: 'Sonnet', desc: '平衡性能与速度' },
    { value: 'haiku', label: 'Haiku', desc: '最快速，适合简单任务' },
  ];

  const DEFAULT_CODEX_MODEL_OPTIONS = [
    { value: 'gpt-5.4', label: 'GPT-5.4', desc: '当前主力 Codex 模型' },
    { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', desc: '偏工程执行场景' },
    { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', desc: '兼容旧路由与旧配置' },
    { value: 'gpt-5.2', label: 'GPT-5.2', desc: '通用 OpenAI 兼容模型' },
    { value: 'o3', label: 'o3', desc: '偏强推理路径' },
    { value: 'o4-mini', label: 'o4-mini', desc: '轻量快速响应' },
  ];

  const MODE_PICKER_OPTIONS = [
    { value: 'yolo', label: 'YOLO', desc: '跳过所有权限检查' },
    { value: 'plan', label: 'Plan', desc: '执行前需确认计划' },
    { value: 'default', label: '默认', desc: '标准权限审批' },
  ];

  const THEME_OPTIONS = [
    {
      value: 'washi',
      label: 'Washi Warm',
      desc: '暖纸色与朱砂点缀，保留当前熟悉的 CC-Web 气质。',
      swatches: ['#faf6f0', '#f2ebe2', '#c0553a', '#5d8a54'],
    },
    {
      value: 'coolvibe',
      label: 'CoolVibe Light',
      desc: '保留 CoolVibe 的青色科技感，但改成更干净的浅色工作台。',
      swatches: ['#f7fbfc', '#eef7f9', '#0891b2', '#ffffff'],
    },
    {
      value: 'editorial',
      label: 'Editorial Sand',
      desc: '更明亮的留白和更克制的棕色强调，像编辑台一样安静。',
      swatches: ['#f6f1e8', '#efe8dc', '#8b5e3c', '#2f4b45'],
    },
  ];

  // --- State ---
  let ws = null;
  let authToken = localStorage.getItem('cc-web-token');
  let currentSessionId = null;
  let sessions = [];
  let sessionCache = new Map();
  let isGenerating = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let pendingText = '';
  let renderTimer = null;
  let activeToolCalls = new Map();
  let toolGroupCount = 0;   // 当前 .msg-tools 直接子节点数（含已有父目录）
  let hasGrouped = false;  // 本次输出是否已触发过折叠
  let cmdMenuIndex = -1;
  let currentMode = 'yolo';
  let currentModel = 'opus';
  let currentAgent = AGENT_LABELS[localStorage.getItem('cc-web-agent')] ? localStorage.getItem('cc-web-agent') : DEFAULT_AGENT;
  let currentTheme = (document.documentElement.dataset.theme || localStorage.getItem('cc-web-theme') || 'washi');
  let codexConfigCache = null;
  let loadedHistorySessionId = null;
  let activeSessionLoad = null;
  let sidebarSwipe = null;
  let pendingAttachments = [];
  let uploadingAttachments = [];
  let loginPasswordValue = ''; // store login password for force-change flow
  let currentCwd = null;
  let currentSessionRunning = false;
  let skipDeleteConfirm = localStorage.getItem('cc-web-skip-delete-confirm') === '1';
  let pendingInitialSessionLoad = false;

  // --- DOM ---
  const $ = (sel) => document.querySelector(sel);
  const loginOverlay = $('#login-overlay');
  const loginForm = $('#login-form');
  const loginPassword = $('#login-password');
  const loginError = $('#login-error');
  const rememberPw = $('#remember-pw');
  const app = $('#app');
  const sessionLoadingOverlay = $('#session-loading-overlay');
  const sessionLoadingLabel = $('#session-loading-label');
  const sidebar = $('#sidebar');
  const sidebarOverlay = $('#sidebar-overlay');
  const menuBtn = $('#menu-btn');
  const chatMain = document.querySelector('.chat-main');
  const newChatSplit = sidebar.querySelector('.new-chat-split');
  const newChatBtn = $('#new-chat-btn');
  const newChatArrow = $('#new-chat-arrow');
  const newChatDropdown = $('#new-chat-dropdown');
  const importSessionBtn = $('#import-session-btn');
  const sessionList = $('#session-list');
  const chatTitle = $('#chat-title');
  const chatAgentBtn = $('#chat-agent-btn');
  const chatAgentMenu = $('#chat-agent-menu');
  const chatRuntimeState = $('#chat-runtime-state');
  const chatCwd = $('#chat-cwd');
  const costDisplay = $('#cost-display');
  const attachmentTray = $('#attachment-tray');
  const imageUploadInput = $('#image-upload-input');
  const attachBtn = $('#attach-btn');
  const messagesDiv = $('#messages');
  const msgInput = $('#msg-input');
  const inputWrapper = msgInput.closest('.input-wrapper');
  const sendBtn = $('#send-btn');
  const abortBtn = $('#abort-btn');
  const cmdMenu = $('#cmd-menu');
  const modeSelect = $('#mode-select');

  // --- Viewport height fix for mobile browsers ---
  function setVH() {
    document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
  }
  setVH();
  window.addEventListener('resize', setVH);
  window.addEventListener('orientationchange', () => setTimeout(setVH, 100));

  function buildWelcomeMarkup(agent) {
    const label = AGENT_LABELS[agent] || AGENT_LABELS.claude;
    return `<div class="welcome-msg"><div class="welcome-icon">✿</div><h3>欢迎使用 CC-Web</h3><p>开始与 ${label} 对话</p></div>`;
  }

  function normalizeAgent(agent) {
    return AGENT_LABELS[agent] ? agent : DEFAULT_AGENT;
  }

  function normalizeTheme(theme) {
    return THEME_OPTIONS.some((item) => item.value === theme) ? theme : 'washi';
  }

  function getThemeOption(theme) {
    return THEME_OPTIONS.find((item) => item.value === normalizeTheme(theme)) || THEME_OPTIONS[0];
  }

  function refreshThemeSummaries() {
    const label = getThemeOption(currentTheme).label;
    document.querySelectorAll('[data-theme-summary]').forEach((node) => {
      node.textContent = label;
    });
  }

  function applyTheme(theme) {
    currentTheme = normalizeTheme(theme);
    document.documentElement.dataset.theme = currentTheme;
    localStorage.setItem('cc-web-theme', currentTheme);
    refreshThemeSummaries();
  }

  function buildThemePickerHtml(options = {}) {
    const { showSectionTitle = true } = options;
    return `
      ${showSectionTitle ? '<div class="settings-section-title">界面主题</div>' : ''}
      <div class="theme-grid">
        ${THEME_OPTIONS.map((theme) => `
          <button class="theme-card${theme.value === currentTheme ? ' active' : ''}" type="button" data-theme-value="${theme.value}">
            <div class="theme-card-preview">
              ${theme.swatches.map((color) => `<span class="theme-card-swatch" style="background:${color}"></span>`).join('')}
            </div>
            <div class="theme-card-title">${escapeHtml(theme.label)}</div>
            <div class="theme-card-desc">${escapeHtml(theme.desc)}</div>
          </button>
        `).join('')}
      </div>
    `;
  }

  function mountThemePicker(panel) {
    panel.querySelectorAll('[data-theme-value]').forEach((button) => {
      button.addEventListener('click', () => {
        applyTheme(button.dataset.themeValue);
        panel.querySelectorAll('[data-theme-value]').forEach((item) => {
          item.classList.toggle('active', item.dataset.themeValue === currentTheme);
        });
      });
    });
  }

  function buildThemeEntryHtml() {
    return `
      <div class="settings-section-title">外观</div>
      <button class="settings-nav-card" type="button" data-open-theme-page>
        <span class="settings-nav-card-main">
          <span class="settings-nav-card-title">界面主题</span>
          <span class="settings-nav-card-meta">当前：<span data-theme-summary>${escapeHtml(getThemeOption(currentTheme).label)}</span></span>
        </span>
        <span class="settings-nav-card-arrow" aria-hidden="true">›</span>
      </button>
    `;
  }

  function buildNotifyEntryHtml(config) {
    const provider = config?.provider || 'off';
    const providerLabel = PROVIDER_OPTIONS.find(o => o.value === provider)?.label || '关闭';
    const summaryOn = config?.summary?.enabled ? '摘要已启用' : '摘要关闭';
    const meta = provider === 'off' ? '未启用' : `${providerLabel} · ${summaryOn}`;
    return `
      <div class="settings-section-title">通知</div>
      <button class="settings-nav-card" type="button" data-open-notify-page>
        <span class="settings-nav-card-main">
          <span class="settings-nav-card-title">通知设置</span>
          <span class="settings-nav-card-meta" data-notify-summary>${escapeHtml(meta)}</span>
        </span>
        <span class="settings-nav-card-arrow" aria-hidden="true">›</span>
      </button>
    `;
  }

  function openNotifySubpage() {
    send({ type: 'get_notify_config' });

    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay settings-subpage-overlay';
    overlay.style.zIndex = '10001';

    const panel = document.createElement('div');
    panel.className = 'settings-panel settings-subpage-panel';
    panel.innerHTML = `
      <div class="settings-header settings-subpage-header">
        <button class="settings-back" type="button" aria-label="返回">‹</button>
        <div class="settings-subpage-copy">
          <div class="settings-subpage-kicker">Notification</div>
          <h3>通知设置</h3>
        </div>
      </div>
      <div class="settings-field">
        <label>通知方式</label>
        <select class="settings-select" id="notify-provider">
          ${PROVIDER_OPTIONS.map(o => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join('')}
        </select>
      </div>
      <div id="notify-fields"></div>
      <div id="notify-summary-area"></div>
      <div class="settings-actions">
        <button class="btn-test" id="notify-test-btn">测试</button>
        <button class="btn-save" id="notify-save-btn">保存</button>
      </div>
      <div class="settings-status" id="notify-status"></div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const providerSelect = panel.querySelector('#notify-provider');
    const fieldsDiv = panel.querySelector('#notify-fields');
    const summaryArea = panel.querySelector('#notify-summary-area');
    const statusDiv = panel.querySelector('#notify-status');
    const testBtn = panel.querySelector('#notify-test-btn');
    const saveBtn = panel.querySelector('#notify-save-btn');

    let currentNotifyConfig = null;

    function renderFields(provider) {
      renderNotifyFields(fieldsDiv, currentNotifyConfig, provider);
      if (summaryArea) {
        summaryArea.innerHTML = buildSummarySettingsHtml(currentNotifyConfig);
        bindSummarySettingsEvents(panel);
      }
    }

    function collectConfig() {
      return collectNotifyConfigFromPanel(panel, currentNotifyConfig, providerSelect.value);
    }

    function showStatus(msg, type) {
      statusDiv.textContent = msg;
      statusDiv.className = 'settings-status ' + (type || '');
    }

    function refreshParentSummary(config) {
      const provider = config?.provider || 'off';
      const providerLabel = PROVIDER_OPTIONS.find(o => o.value === provider)?.label || '关闭';
      const summaryOn = config?.summary?.enabled ? '摘要已启用' : '摘要关闭';
      const meta = provider === 'off' ? '未启用' : `${providerLabel} · ${summaryOn}`;
      document.querySelectorAll('[data-notify-summary]').forEach(el => { el.textContent = meta; });
    }

    const savedOnNotifyConfig = _onNotifyConfig;
    _onNotifyConfig = (config) => {
      currentNotifyConfig = config;
      providerSelect.value = config.provider || 'off';
      renderFields(config.provider || 'off');
      if (savedOnNotifyConfig) savedOnNotifyConfig(config);
    };

    const savedOnNotifyTestResult = _onNotifyTestResult;
    _onNotifyTestResult = (msg) => {
      showStatus(msg.message, msg.success ? 'success' : 'error');
      if (savedOnNotifyTestResult) savedOnNotifyTestResult(msg);
    };

    providerSelect.addEventListener('change', () => renderFields(providerSelect.value));

    testBtn.addEventListener('click', () => {
      const config = collectConfig();
      send({ type: 'save_notify_config', config });
      showStatus('正在发送测试消息...', '');
      send({ type: 'test_notify' });
    });

    saveBtn.addEventListener('click', () => {
      const config = collectConfig();
      send({ type: 'save_notify_config', config });
      refreshParentSummary(config);
      showStatus('已保存', 'success');
    });

    const closeSubpage = () => {
      _onNotifyConfig = savedOnNotifyConfig;
      _onNotifyTestResult = savedOnNotifyTestResult;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    panel.querySelector('.settings-back').addEventListener('click', closeSubpage);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSubpage(); });
  }

  function openThemeSubpage() {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay settings-subpage-overlay';
    overlay.style.zIndex = '10001';

    const panel = document.createElement('div');
    panel.className = 'settings-panel settings-subpage-panel';
    panel.innerHTML = `
      <div class="settings-header settings-subpage-header">
        <button class="settings-back" type="button" aria-label="返回">‹</button>
        <div class="settings-subpage-copy">
          <div class="settings-subpage-kicker">Appearance</div>
          <h3>界面主题</h3>
        </div>
        <button class="settings-close" type="button" title="关闭">&times;</button>
      </div>
      ${buildThemePickerHtml({ showSectionTitle: false })}
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    mountThemePicker(panel);
    refreshThemeSummaries();

    const closeSubpage = () => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    panel.querySelector('.settings-back').addEventListener('click', closeSubpage);
    panel.querySelector('.settings-close').addEventListener('click', closeSubpage);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeSubpage();
    });
  }

  function getAgentSessionStorageKey(agent) {
    return `cc-web-session-${normalizeAgent(agent)}`;
  }

  function getAgentModeStorageKey(agent) {
    return `cc-web-mode-${normalizeAgent(agent)}`;
  }

  function getLastSessionForAgent(agent) {
    return localStorage.getItem(getAgentSessionStorageKey(agent));
  }

  function setLastSessionForAgent(agent, sessionId) {
    localStorage.setItem(getAgentSessionStorageKey(agent), sessionId);
    localStorage.setItem('cc-web-session', sessionId);
  }

  function getSessionMeta(sessionId) {
    return sessions.find((s) => s.id === sessionId) || null;
  }

  function deepClone(value) {
    if (value === null || value === undefined) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function cloneMessages(messages) {
    return Array.isArray(messages) ? deepClone(messages) : [];
  }

  function estimateSessionMessageWeight(message) {
    const content = typeof message?.content === 'string' ? message.content.length : JSON.stringify(message?.content || '').length;
    const toolCalls = Array.isArray(message?.toolCalls) ? JSON.stringify(message.toolCalls).length : 0;
    return content + toolCalls + 64;
  }

  function estimateSessionSnapshotWeight(snapshot) {
    const base = JSON.stringify({
      title: snapshot.title || '',
      mode: snapshot.mode || '',
      model: snapshot.model || '',
      agent: snapshot.agent || '',
      cwd: snapshot.cwd || '',
      updated: snapshot.updated || '',
    }).length;
    return base + (snapshot.messages || []).reduce((sum, message) => sum + estimateSessionMessageWeight(message), 0);
  }

  function normalizeSessionSnapshot(payload, options = {}) {
    return {
      sessionId: payload.sessionId,
      messages: cloneMessages(payload.messages || []),
      title: payload.title || '新会话',
      mode: payload.mode || 'yolo',
      model: payload.model || '',
      agent: normalizeAgent(payload.agent),
      hasUnread: !!payload.hasUnread,
      cwd: payload.cwd || null,
      totalCost: typeof payload.totalCost === 'number' ? payload.totalCost : 0,
      totalUsage: payload.totalUsage ? deepClone(payload.totalUsage) : null,
      updated: payload.updated || null,
      isRunning: !!payload.isRunning,
      historyPending: !!payload.historyPending,
      complete: options.complete !== undefined ? !!options.complete : !payload.historyPending,
    };
  }

  function touchSessionCache(sessionId) {
    const entry = sessionCache.get(sessionId);
    if (entry) entry.lastUsed = Date.now();
  }

  function invalidateSessionCache(sessionId) {
    if (!sessionId) return;
    sessionCache.delete(sessionId);
  }

  function pruneSessionCache() {
    let totalWeight = 0;
    for (const entry of sessionCache.values()) totalWeight += entry.weight || 0;
    while (sessionCache.size > SESSION_CACHE_LIMIT || totalWeight > SESSION_CACHE_MAX_WEIGHT) {
      let oldestId = null;
      let oldestTs = Infinity;
      for (const [sessionId, entry] of sessionCache) {
        if ((entry.lastUsed || 0) < oldestTs) {
          oldestTs = entry.lastUsed || 0;
          oldestId = sessionId;
        }
      }
      if (!oldestId) break;
      totalWeight -= sessionCache.get(oldestId)?.weight || 0;
      sessionCache.delete(oldestId);
    }
  }

  function cacheSessionSnapshot(snapshot) {
    if (!snapshot?.sessionId || !snapshot.complete) return;
    const cachedSnapshot = deepClone(snapshot);
    const weight = estimateSessionSnapshotWeight(cachedSnapshot);
    if (weight > SESSION_CACHE_MAX_WEIGHT) {
      invalidateSessionCache(cachedSnapshot.sessionId);
      return;
    }
    const meta = getSessionMeta(cachedSnapshot.sessionId);
    sessionCache.set(cachedSnapshot.sessionId, {
      snapshot: cachedSnapshot,
      version: cachedSnapshot.updated || null,
      meta: meta ? deepClone(meta) : null,
      weight,
      lastUsed: Date.now(),
    });
    pruneSessionCache();
  }

  function updateCachedSession(sessionId, updater) {
    const entry = sessionCache.get(sessionId);
    if (!entry) return;
    const nextSnapshot = deepClone(entry.snapshot);
    updater(nextSnapshot);
    entry.snapshot = nextSnapshot;
    entry.weight = estimateSessionSnapshotWeight(nextSnapshot);
    entry.lastUsed = Date.now();
    if (nextSnapshot.updated) entry.version = nextSnapshot.updated;
    pruneSessionCache();
  }

  function reconcileSessionCacheWithSessions() {
    const knownIds = new Set(sessions.map((session) => session.id));
    for (const [sessionId, entry] of sessionCache) {
      if (!knownIds.has(sessionId)) {
        sessionCache.delete(sessionId);
        continue;
      }
      const meta = getSessionMeta(sessionId);
      entry.meta = meta ? deepClone(meta) : null;
    }
  }

  function getSessionCacheDisposition(sessionId) {
    const entry = sessionCache.get(sessionId);
    const meta = getSessionMeta(sessionId);
    if (!entry?.snapshot?.complete || !meta) return 'miss';
    if (entry.version === (meta.updated || null) && !meta.hasUnread && !meta.isRunning) {
      return 'strong';
    }
    return 'weak';
  }

  function buildCachedSessionSnapshot(sessionId) {
    const entry = sessionCache.get(sessionId);
    if (!entry?.snapshot) return null;
    const snapshot = deepClone(entry.snapshot);
    const meta = getSessionMeta(sessionId) || entry.meta;
    if (meta) {
      snapshot.title = meta.title || snapshot.title;
      snapshot.agent = normalizeAgent(meta.agent || snapshot.agent);
      snapshot.hasUnread = !!meta.hasUnread;
      snapshot.updated = meta.updated || snapshot.updated;
      snapshot.isRunning = !!meta.isRunning;
    }
    return snapshot;
  }

  function formatFileSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size}B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
    return `${(size / (1024 * 1024)).toFixed(1)}MB`;
  }

  function syncAttachmentActions() {
    const uploading = uploadingAttachments.length > 0;
    if (attachBtn) attachBtn.disabled = uploading;
  }

  function replaceFileExtension(filename, ext) {
    const base = String(filename || 'image').replace(/\.[^/.]+$/, '');
    return `${base}${ext}`;
  }

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('读取图片失败'));
      };
      img.src = url;
    });
  }

  async function compressImageFile(file) {
    if (!file || !/^image\/(png|jpeg|webp)$/i.test(file.type || '')) return file;
    const img = await loadImageFromFile(file);
    const maxDimension = 2000;
    const maxOriginalBytes = 2 * 1024 * 1024;
    const largestSide = Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height);
    if (file.size <= maxOriginalBytes && largestSide <= maxDimension) {
      return file;
    }

    const scale = Math.min(1, maxDimension / largestSide);
    const width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
    const height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, width, height);

    const targetType = 'image/webp';
    const qualities = [0.9, 0.84, 0.78, 0.72];
    let bestBlob = null;
    for (const quality of qualities) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, targetType, quality));
      if (!blob) continue;
      if (!bestBlob || blob.size < bestBlob.size) bestBlob = blob;
      if (blob.size <= Math.max(maxOriginalBytes, file.size * 0.72)) break;
    }
    if (!bestBlob || bestBlob.size >= file.size) return file;
    return new File([bestBlob], replaceFileExtension(file.name || 'image', '.webp'), {
      type: bestBlob.type,
      lastModified: Date.now(),
    });
  }

  async function deleteUploadedAttachment(id) {
    if (!id) return;
    try {
      await ensureAuthenticatedWs();
      await fetch(`/api/attachments/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
    } catch {}
  }

  function ensureAuthenticatedWs() {
    return new Promise((resolve, reject) => {
      if (ws && ws.readyState === 1 && authToken) {
        resolve(authToken);
        return;
      }
      const savedPassword = localStorage.getItem('cc-web-pw');
      if (!savedPassword) {
        reject(new Error('登录状态已失效，请刷新页面后重新登录再上传图片。'));
        return;
      }
      const timeout = setTimeout(() => {
        reject(new Error('登录状态恢复超时，请刷新页面后重试。'));
      }, 8000);

      const cleanup = () => {
        clearTimeout(timeout);
        document.removeEventListener('cc-web-auth-restored', onRestored);
        document.removeEventListener('cc-web-auth-failed', onFailed);
      };
      const onRestored = () => {
        cleanup();
        resolve(authToken);
      };
      const onFailed = () => {
        cleanup();
        reject(new Error('登录状态已失效，请刷新页面后重新登录再上传图片。'));
      };
      document.addEventListener('cc-web-auth-restored', onRestored);
      document.addEventListener('cc-web-auth-failed', onFailed);

      if (!ws || ws.readyState > 1) {
        connect();
      } else if (ws.readyState === 1) {
        send({ type: 'auth', password: savedPassword });
      }
    });
  }

  function renderAttachmentLabels(attachments, options = {}) {
    if (!Array.isArray(attachments) || attachments.length === 0) return '';
    const labels = attachments.map((attachment) => {
      const stateSuffix = attachment.storageState === 'expired' ? '（已过期）' : '';
      const name = escapeHtml(attachment.filename || 'image');
      return `<span class="msg-attachment-label">图片: ${name}${stateSuffix}</span>`;
    }).join('');
    return `<div class="msg-attachments${options.compact ? ' compact' : ''}">${labels}</div>`;
  }

  function renderPendingAttachments() {
    if (!attachmentTray) return;
    if (!pendingAttachments.length && !uploadingAttachments.length) {
      attachmentTray.hidden = true;
      attachmentTray.innerHTML = '';
      syncAttachmentActions();
      return;
    }
    attachmentTray.hidden = false;
    const uploadingHtml = uploadingAttachments.map((attachment) => `
      <div class="attachment-chip uploading">
        <div class="attachment-chip-meta">
          <span class="attachment-chip-name">${escapeHtml(attachment.filename || 'image')}</span>
          <span class="attachment-chip-note">上传中 · ${formatFileSize(attachment.size)}</span>
        </div>
      </div>
    `).join('');
    const readyHtml = pendingAttachments.map((attachment, index) => `
      <div class="attachment-chip" data-index="${index}">
        <div class="attachment-chip-meta">
          <span class="attachment-chip-name">${escapeHtml(attachment.filename || 'image')}</span>
          <span class="attachment-chip-note">${formatFileSize(attachment.size)} · 将随下一条消息发送</span>
        </div>
        <button class="attachment-chip-remove" type="button" data-index="${index}" title="移除">✕</button>
      </div>
    `).join('');
    const noteHtml = [
      uploadingAttachments.length > 0
        ? '<div class="attachment-tray-note">图片上传中，此时发送不会包含尚未完成的图片。</div>'
        : '',
    ].join('');
    attachmentTray.innerHTML = `${uploadingHtml}${readyHtml}${noteHtml}`;
    attachmentTray.querySelectorAll('.attachment-chip-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = Number(btn.dataset.index);
        const [removed] = pendingAttachments.splice(index, 1);
        renderPendingAttachments();
        deleteUploadedAttachment(removed?.id);
      });
    });
    syncAttachmentActions();
  }

  async function uploadImageFile(file) {
    await ensureAuthenticatedWs();
    const headers = {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': file.type || 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name || 'image'),
    };
    const response = await fetch('/api/attachments', {
      method: 'POST',
      headers,
      body: file,
    });
    const rawText = await response.text();
    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      data = null;
    }
    if (response.status === 401) {
      throw new Error('登录状态已失效，请刷新页面后重新登录再上传图片。');
    }
    if (response.status === 413) {
      throw new Error('图片大小超过当前上传限制，请压缩到 10MB 以内后重试。');
    }
    if (!response.ok || !data?.ok) {
      throw new Error(data?.message || `上传失败 (${response.status})`);
    }
    return data.attachment;
  }

  async function handleSelectedImageFiles(fileList) {
    const files = Array.from(fileList || []).filter((file) => file && /^image\//.test(file.type || ''));
    if (!files.length) return;
    if (pendingAttachments.length + files.length > 4) {
      appendError('单条消息最多附带 4 张图片。');
      return;
    }
    const batch = files.map((file, index) => ({
      id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      filename: file.name || 'image',
      size: file.size || 0,
    }));
    uploadingAttachments.push(...batch);
    renderPendingAttachments();
    try {
      const results = await Promise.allSettled(files.map(async (file) => {
        const optimized = await compressImageFile(file);
        return uploadImageFile(optimized);
      }));
      const errors = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          pendingAttachments.push(result.value);
        } else {
          errors.push(result.reason?.message || '图片上传失败');
        }
      }
      if (errors.length > 0) {
        appendError(errors[0]);
      }
    } catch (err) {
      appendError(err.message || '图片上传失败');
    } finally {
      uploadingAttachments = uploadingAttachments.filter((item) => !batch.some((entry) => entry.id === item.id));
      renderPendingAttachments();
      if (imageUploadInput) imageUploadInput.value = '';
    }
  }

  function getVisibleSessions() {
    return sessions.filter((s) => normalizeAgent(s.agent) === currentAgent);
  }

  function shouldOverlayRuntimeBadge() {
    return window.matchMedia('(max-width: 768px), (pointer: coarse)').matches;
  }

  function updateCwdBadge() {
    if (!chatCwd) return;
    if (currentCwd) {
      const parts = currentCwd.replace(/\/+$/, '').split('/');
      const short = parts.slice(-2).join('/') || currentCwd;
      chatCwd.textContent = '~/' + short;
      chatCwd.title = currentCwd;
    } else {
      chatCwd.textContent = '';
      chatCwd.title = '';
    }
    chatCwd.hidden = !currentCwd || (currentSessionRunning && shouldOverlayRuntimeBadge());
  }

  function setCurrentSessionRunningState(isRunning) {
    const running = !!isRunning;
    currentSessionRunning = running;
    if (chatRuntimeState) {
      chatRuntimeState.hidden = !running;
      chatRuntimeState.textContent = running ? '运行中' : '';
    }
    updateCwdBadge();
  }

  function updateAgentScopedUI() {
    if (chatAgentBtn) {
      chatAgentBtn.textContent = AGENT_LABELS[currentAgent];
      chatAgentBtn.setAttribute('aria-expanded', chatAgentMenu && !chatAgentMenu.hidden ? 'true' : 'false');
    }
    if (chatAgentMenu) {
      chatAgentMenu.querySelectorAll('.chat-agent-option').forEach((btn) => {
        const active = btn.dataset.agent === currentAgent;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }
    if (importSessionBtn) {
      importSessionBtn.textContent = currentAgent === 'codex' ? '导入本地 Codex 会话' : '导入本地 Claude 会话';
    }
  }

  function setCurrentAgent(agent) {
    currentAgent = normalizeAgent(agent);
    localStorage.setItem('cc-web-agent', currentAgent);
    currentMode = localStorage.getItem(getAgentModeStorageKey(currentAgent)) || 'yolo';
    modeSelect.value = currentMode;
    updateAgentScopedUI();
  }

  function closeAgentMenu() {
    if (!chatAgentMenu) return;
    chatAgentMenu.hidden = true;
    if (chatAgentBtn) chatAgentBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleAgentMenu() {
    if (!chatAgentMenu || !chatAgentBtn) return;
    const willOpen = chatAgentMenu.hidden;
    chatAgentMenu.hidden = !willOpen;
    chatAgentBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  }

  function resetChatView(agent) {
    setCurrentAgent(agent);
    currentSessionId = null;
    loadedHistorySessionId = null;
    clearSessionLoading();
    setCurrentSessionRunningState(false);
    currentCwd = null;
    currentModel = currentAgent === 'claude' ? 'opus' : '';
    isGenerating = false;
    pendingText = '';
    pendingAttachments = [];
    uploadingAttachments = [];
    activeToolCalls.clear();
    sendBtn.hidden = false;
    abortBtn.hidden = true;
    chatTitle.textContent = '新会话';
    updateCwdBadge();
    messagesDiv.innerHTML = buildWelcomeMarkup(currentAgent);
    setStatsDisplay(null);
    renderPendingAttachments();
    highlightActiveSession();
  }

  function applySessionSnapshot(snapshot, options = {}) {
    if (!snapshot) return;
    const preserveStreaming = !!(options.preserveStreaming && isGenerating && snapshot.sessionId === currentSessionId && snapshot.isRunning);
    if (isGenerating && !preserveStreaming) {
      isGenerating = false;
      sendBtn.hidden = false;
      abortBtn.hidden = true;
      pendingText = '';
      activeToolCalls.clear();
    }
    currentSessionId = snapshot.sessionId;
    loadedHistorySessionId = snapshot.sessionId;
    setLastSessionForAgent(snapshot.agent, currentSessionId);
    chatTitle.textContent = snapshot.title || '新会话';
    setCurrentAgent(snapshot.agent);
    setCurrentSessionRunningState(snapshot.isRunning);
    setStatsDisplay(snapshot);
    currentCwd = snapshot.cwd || null;
    updateCwdBadge();
    if (snapshot.mode && MODE_LABELS[snapshot.mode]) {
      currentMode = snapshot.mode;
      modeSelect.value = currentMode;
      localStorage.setItem(getAgentModeStorageKey(currentAgent), currentMode);
    }
    currentModel = snapshot.model || '';
    if (!preserveStreaming) {
      renderMessages(snapshot.messages || [], { immediate: !!options.immediate });
    }
    highlightActiveSession();
    renderSessionList();
    if (!options.skipCloseSidebar) closeSidebar();
    if (snapshot.hasUnread && !options.suppressUnreadToast) {
      showToast('后台任务已完成', snapshot.sessionId);
    }
  }

  function syncViewForAgent(agent, options = {}) {
    const targetAgent = normalizeAgent(agent);
    const { preserveCurrent = true, loadLast = true } = options;
    setCurrentAgent(targetAgent);
    renderSessionList();

    const currentMeta = currentSessionId ? getSessionMeta(currentSessionId) : null;
    if (preserveCurrent && currentMeta && normalizeAgent(currentMeta.agent) === targetAgent) {
      highlightActiveSession();
      return;
    }

    if (currentSessionId && (!currentMeta || normalizeAgent(currentMeta.agent) !== targetAgent)) {
      send({ type: 'detach_view' });
    }

    resetChatView(targetAgent);

    if (!loadLast) return;
    const lastSessionId = getLastSessionForAgent(targetAgent);
    const lastMeta = lastSessionId ? getSessionMeta(lastSessionId) : null;
    if (lastMeta && normalizeAgent(lastMeta.agent) === targetAgent) {
      openSession(lastSessionId);
    }
  }

  function getSessionLoadLabel(sessionId) {
    const meta = sessionId ? getSessionMeta(sessionId) : null;
    const title = meta?.title ? `“${meta.title}”` : '所选会话';
    return `正在载入 ${title} 的完整消息记录…`;
  }

  function setSessionLoading(sessionId, options = {}) {
    const loading = !!sessionId;
    const blocking = options.blocking !== false;
    activeSessionLoad = loading ? { sessionId, blocking, snapshot: null } : null;
    const showOverlay = !!(loading && blocking);
    document.body.classList.toggle('session-loading-active', showOverlay);
    sessionLoadingOverlay.hidden = !showOverlay;
    sessionLoadingOverlay.setAttribute('aria-hidden', showOverlay ? 'false' : 'true');
    sessionLoadingLabel.textContent = loading ? (options.label || getSessionLoadLabel(sessionId)) : '正在整理消息与上下文…';
    msgInput.disabled = showOverlay;
    modeSelect.disabled = showOverlay;
    sendBtn.disabled = showOverlay;
    abortBtn.disabled = showOverlay;
    if (showOverlay && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }

  function clearSessionLoading(sessionId) {
    if (sessionId && activeSessionLoad && activeSessionLoad.sessionId !== sessionId) return;
    setSessionLoading(null, { blocking: false });
  }

  function isBlockingSessionLoad(sessionId) {
    return !!(activeSessionLoad &&
      activeSessionLoad.blocking &&
      (!sessionId || activeSessionLoad.sessionId === sessionId));
  }

  function finishSessionSwitch(sessionId) {
    if (isBlockingSessionLoad(sessionId)) {
      scrollToBottom();
      requestAnimationFrame(() => clearSessionLoading(sessionId));
      return;
    }
    clearSessionLoading(sessionId);
  }

  function finalizeLoadedSession(sessionId) {
    if (activeSessionLoad?.sessionId === sessionId && activeSessionLoad.snapshot) {
      activeSessionLoad.snapshot.complete = true;
      cacheSessionSnapshot(activeSessionLoad.snapshot);
    }
    finishSessionSwitch(sessionId);
  }

  function beginSessionSwitch(sessionId, options = {}) {
    if (!sessionId) return;
    const blocking = options.blocking !== false;
    const force = options.force === true;
    if (!force && activeSessionLoad?.sessionId === sessionId) return;
    if (!force && sessionId === currentSessionId && !activeSessionLoad) return;
    renderEpoch++;
    loadedHistorySessionId = null;
    setSessionLoading(sessionId, { blocking, label: options.label });
    send({ type: 'load_session', sessionId });
  }

  function showCachedSession(sessionId) {
    const snapshot = buildCachedSessionSnapshot(sessionId);
    if (!snapshot) return false;
    if (currentSessionId && currentSessionId !== sessionId) {
      send({ type: 'detach_view' });
    }
    clearSessionLoading();
    touchSessionCache(sessionId);
    applySessionSnapshot(snapshot, { immediate: true, suppressUnreadToast: true });
    return true;
  }

  function openSession(sessionId, options = {}) {
    if (!sessionId) return;
    if (options.forceSync) {
      beginSessionSwitch(sessionId, { blocking: options.blocking !== false, force: true, label: options.label });
      return;
    }
    if (!options.force && sessionId === currentSessionId && !activeSessionLoad) return;

    const disposition = getSessionCacheDisposition(sessionId);
    if (disposition === 'strong') {
      showCachedSession(sessionId);
      return;
    }
    if (disposition === 'weak' && showCachedSession(sessionId)) {
      beginSessionSwitch(sessionId, { blocking: false, force: true, label: options.label });
      return;
    }
    beginSessionSwitch(sessionId, { blocking: options.blocking !== false, force: options.force === true, label: options.label });
  }

  function setStatsDisplay(msg) {
    if (currentAgent === 'codex' && msg && msg.totalUsage) {
      const usage = msg.totalUsage;
      if ((usage.inputTokens || 0) > 0 || (usage.outputTokens || 0) > 0) {
        const cacheText = usage.cachedInputTokens ? ` · cache ${usage.cachedInputTokens}` : '';
        costDisplay.textContent = `in ${usage.inputTokens} · out ${usage.outputTokens}${cacheText}`;
        return;
      }
    }
    if (msg && typeof msg.totalCost === 'number' && msg.totalCost > 0) {
      costDisplay.textContent = `$${msg.totalCost.toFixed(4)}`;
      return;
    }
    costDisplay.textContent = '';
  }

  function getCodexModelOptions() {
    const seen = new Set();
    const options = [];

    function addOption(value, label, desc) {
      const v = (value || '').trim();
      if (!v || seen.has(v)) return;
      seen.add(v);
      options.push({ value: v, label: label || v, desc: desc || 'Codex 模型' });
    }

    DEFAULT_CODEX_MODEL_OPTIONS.forEach((opt) => addOption(opt.value, opt.label, opt.desc));
    addOption(currentModel, currentModel, '当前会话模型');
    sessions
      .filter((s) => normalizeAgent(s.agent) === 'codex' && s.id === currentSessionId)
      .forEach((s) => addOption(s.model, s.model, '当前会话已保存模型'));

    return options;
  }

  // --- marked config ---
  const PREVIEW_LANGS = new Set(['html', 'svg']);
  const _previewCodeMap = new Map();
  let _previewCodeId = 0;

  const renderer = new marked.Renderer();
  renderer.code = function (code, language) {
    const lang = (language || 'plaintext').toLowerCase();
    let highlighted;
    try {
      if (hljs.getLanguage(lang)) {
        highlighted = hljs.highlight(code, { language: lang }).value;
      } else {
        highlighted = hljs.highlightAuto(code).value;
      }
    } catch {
      highlighted = escapeHtml(code);
    }
    const canPreview = PREVIEW_LANGS.has(lang);
    const previewBtn = canPreview
      ? `<button class="code-preview-btn" onclick="ccTogglePreview(this)">Preview</button>`
      : '';
    const previewPane = canPreview
      ? `<div class="code-preview-pane"><iframe class="code-preview-iframe" sandbox="allow-scripts" loading="lazy"></iframe></div>`
      : '';
    const cid = canPreview ? (++_previewCodeId) : 0;
    if (canPreview) _previewCodeMap.set(cid, code);
    return `<div class="code-block-wrapper${canPreview ? ' has-preview' : ''}"${canPreview ? ` data-cid="${cid}"` : ''}>
      <div class="code-block-header">
        <span>${escapeHtml(lang)}</span>
        <div class="code-block-actions">${previewBtn}<button class="code-copy-btn" onclick="ccCopyCode(this)">Copy</button></div>
      </div>
      ${previewPane}<pre><code class="hljs language-${escapeHtml(lang)}">${highlighted}</code></pre>
    </div>`;
  };
  marked.setOptions({ renderer, breaks: true, gfm: true });

  window.ccCopyCode = function (btn) {
    const wrapper = btn.closest('.code-block-wrapper');
    const cid = wrapper.dataset.cid ? Number(wrapper.dataset.cid) : 0;
    const code = (cid && _previewCodeMap.has(cid)) ? _previewCodeMap.get(cid) : wrapper.querySelector('code').textContent;
    navigator.clipboard.writeText(code).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    });
  };

  window.ccTogglePreview = function (btn) {
    const wrapper = btn.closest('.code-block-wrapper');
    const inPreview = wrapper.classList.contains('preview-mode');
    if (inPreview) {
      wrapper.classList.remove('preview-mode');
      btn.textContent = 'Preview';
    } else {
      const iframe = wrapper.querySelector('.code-preview-iframe');
      if (iframe && !iframe.dataset.loaded) {
        const cid = wrapper.dataset.cid ? Number(wrapper.dataset.cid) : 0;
        iframe.srcdoc = (cid && _previewCodeMap.has(cid)) ? _previewCodeMap.get(cid) : '';
        iframe.dataset.loaded = '1';
      }
      wrapper.classList.add('preview-mode');
      btn.textContent = 'Source';
    }
  };

  // --- WebSocket ---
  function connect() {
    if (ws && ws.readyState <= 1) return;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      reconnectAttempts = 0;
      if (authToken) send({ type: 'auth', token: authToken });
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleServerMessage(msg);
    };

    ws.onclose = () => {
      clearSessionLoading();
      scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  function send(data) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  // --- Server Message Handler ---
  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'auth_result':
        if (msg.success) {
          authToken = msg.token;
          localStorage.setItem('cc-web-token', msg.token);
          document.dispatchEvent(new CustomEvent('cc-web-auth-restored'));
          loginOverlay.hidden = true;
          app.hidden = false;
          send({ type: 'get_codex_config' });
          // Check if must change password
          if (msg.mustChangePassword) {
            showForceChangePassword();
          } else {
            pendingInitialSessionLoad = true;
          }
        } else {
          authToken = null;
          localStorage.removeItem('cc-web-token');
          document.dispatchEvent(new CustomEvent('cc-web-auth-failed'));
          loginOverlay.hidden = false;
          app.hidden = true;
          loginError.hidden = false;
        }
        break;

      case 'session_list':
        sessions = msg.sessions || [];
        reconcileSessionCacheWithSessions();
        renderSessionList();
        if (currentSessionId) {
          setCurrentSessionRunningState(!!getSessionMeta(currentSessionId)?.isRunning);
        }
        if (pendingInitialSessionLoad) {
          pendingInitialSessionLoad = false;
          syncViewForAgent(currentAgent, { preserveCurrent: false, loadLast: true });
        } else if (currentSessionId && !getSessionMeta(currentSessionId)) {
          resetChatView(currentAgent);
        }
        break;

      case 'session_info':
        const snapshot = normalizeSessionSnapshot(msg);
        if (activeSessionLoad?.sessionId === msg.sessionId) {
          activeSessionLoad.snapshot = snapshot;
        }
        applySessionSnapshot(snapshot, {
          immediate: isBlockingSessionLoad(msg.sessionId),
          suppressUnreadToast: false,
          preserveStreaming: msg.sessionId === currentSessionId && msg.isRunning,
        });
        if (!msg.historyPending) {
          if (activeSessionLoad?.sessionId === msg.sessionId) {
            finalizeLoadedSession(msg.sessionId);
          } else {
            cacheSessionSnapshot(snapshot);
            finishSessionSwitch(msg.sessionId);
          }
        }
        break;

      case 'session_history_chunk':
        if (msg.sessionId === currentSessionId && loadedHistorySessionId === msg.sessionId) {
          const blocking = isBlockingSessionLoad(msg.sessionId);
          if (activeSessionLoad?.sessionId === msg.sessionId && activeSessionLoad.snapshot) {
            activeSessionLoad.snapshot.messages = cloneMessages(msg.messages || []).concat(activeSessionLoad.snapshot.messages);
          }
          prependHistoryMessages(msg.messages || [], {
            preserveScroll: !blocking,
            skipScrollbar: blocking,
          });
          if (!msg.remaining) {
            finalizeLoadedSession(msg.sessionId);
          }
        }
        break;

      case 'session_renamed':
        sessions = sessions.map((session) => session.id === msg.sessionId ? { ...session, title: msg.title } : session);
        updateCachedSession(msg.sessionId, (snapshot) => { snapshot.title = msg.title; });
        if (msg.sessionId === currentSessionId) {
          chatTitle.textContent = msg.title;
        }
        renderSessionList();
        break;

      case 'text_delta':
        if (!isGenerating) startGenerating();
        pendingText += msg.text;
        scheduleRender();
        break;

      case 'tool_start':
        if (!isGenerating) startGenerating();
        activeToolCalls.set(msg.toolUseId, { name: msg.name, input: msg.input, kind: msg.kind || null, meta: msg.meta || null, done: false });
        appendToolCall(msg.toolUseId, msg.name, msg.input, false, msg.kind || null, msg.meta || null);
        break;

      case 'tool_end':
        if (activeToolCalls.has(msg.toolUseId)) {
          activeToolCalls.get(msg.toolUseId).done = true;
          if (msg.kind) activeToolCalls.get(msg.toolUseId).kind = msg.kind;
          if (msg.meta) activeToolCalls.get(msg.toolUseId).meta = msg.meta;
          activeToolCalls.get(msg.toolUseId).result = msg.result;
        }
        updateToolCall(msg.toolUseId, msg.result);
        break;

      case 'cost':
        costDisplay.textContent = `$${msg.costUsd.toFixed(4)}`;
        if (currentSessionId) {
          updateCachedSession(currentSessionId, (snapshot) => { snapshot.totalCost = msg.costUsd; });
        }
        break;

      case 'usage':
        if (msg.totalUsage) {
          const cacheText = msg.totalUsage.cachedInputTokens ? ` · cache ${msg.totalUsage.cachedInputTokens}` : '';
          costDisplay.textContent = `in ${msg.totalUsage.inputTokens} · out ${msg.totalUsage.outputTokens}${cacheText}`;
          if (currentSessionId) {
            updateCachedSession(currentSessionId, (snapshot) => { snapshot.totalUsage = deepClone(msg.totalUsage); });
          }
        }
        break;

      case 'done':
        finishGenerating(msg.sessionId);
        break;

      case 'system_message':
        appendSystemMessage(msg.message);
        break;

      case 'mode_changed':
        if (msg.mode && MODE_LABELS[msg.mode]) {
          currentMode = msg.mode;
          modeSelect.value = currentMode;
          localStorage.setItem(getAgentModeStorageKey(currentAgent), currentMode);
          if (currentSessionId) {
            updateCachedSession(currentSessionId, (snapshot) => { snapshot.mode = msg.mode; });
          }
        }
        break;

      case 'model_changed':
        if (msg.model) {
          currentModel = msg.model;
          if (currentSessionId) {
            updateCachedSession(currentSessionId, (snapshot) => { snapshot.model = msg.model; });
          }
        }
        break;

      case 'resume_generating':
        // Server has an active process for this session — resume streaming
        setCurrentSessionRunningState(true);
        if (!isGenerating || !document.getElementById('streaming-msg')) {
          startGenerating();
        } else {
          sendBtn.hidden = true;
          abortBtn.hidden = false;
          toolGroupCount = 0;
          hasGrouped = false;
          activeToolCalls.clear();
          const toolsDiv = document.querySelector('#streaming-msg .msg-tools');
          if (toolsDiv) toolsDiv.innerHTML = '';
        }
        pendingText = msg.text || '';
        flushRender();
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            activeToolCalls.set(tc.id, {
              name: tc.name,
              input: tc.input,
              result: tc.result,
              kind: tc.kind || null,
              meta: tc.meta || null,
              done: tc.done,
            });
            appendToolCall(tc.id, tc.name, tc.input, tc.done, tc.kind || null, tc.meta || null);
            if (tc.done && tc.result) {
              updateToolCall(tc.id, tc.result);
            }
          }
        }
        break;

      case 'error':
        appendError(msg.message);
        clearSessionLoading();
        if (!isGenerating && currentSessionId) {
          setCurrentSessionRunningState(!!getSessionMeta(currentSessionId)?.isRunning);
        }
        if (isGenerating) finishGenerating();
        break;

      case 'notify_config':
        if (typeof _onNotifyConfig === 'function') _onNotifyConfig(msg.config);
        // Update summary in parent settings panel if visible
        if (msg.config) {
          const provider = msg.config.provider || 'off';
          const providerLabel = PROVIDER_OPTIONS.find(o => o.value === provider)?.label || '关闭';
          const summaryOn = msg.config.summary?.enabled ? '摘要已启用' : '摘要关闭';
          const meta = provider === 'off' ? '未启用' : `${providerLabel} · ${summaryOn}`;
          document.querySelectorAll('[data-notify-summary]').forEach(el => { el.textContent = meta; });
        }
        break;

      case 'notify_test_result':
        if (typeof _onNotifyTestResult === 'function') _onNotifyTestResult(msg);
        break;

      case 'model_config':
        if (typeof _onModelConfig === 'function') _onModelConfig(msg.config);
        break;

      case 'codex_config':
        codexConfigCache = msg.config || null;
        if (typeof _onCodexConfig === 'function') _onCodexConfig(msg.config);
        break;

      case 'fetch_models_result':
        if (typeof _onFetchModelsResult === 'function') _onFetchModelsResult(msg);
        break;

      case 'background_done':
        // A background task completed (browser was disconnected or viewing another session)
        showToast(`「${msg.title}」任务完成`, msg.sessionId);
        showBrowserNotification(msg.title);
        if (msg.sessionId === currentSessionId) {
          // Reload current session to show completed response
          openSession(msg.sessionId, { forceSync: true, blocking: false });
        } else {
          send({ type: 'list_sessions' });
        }
        break;

      case 'password_changed':
        handlePasswordChanged(msg);
        break;

      case 'native_sessions':
        if (typeof _onNativeSessions === 'function') _onNativeSessions(msg.groups || []);
        break;

      case 'codex_sessions':
        if (typeof _onCodexSessions === 'function') _onCodexSessions(msg.sessions || []);
        break;

      case 'cwd_suggestions':
        if (typeof _onCwdSuggestions === 'function') _onCwdSuggestions(msg.paths || []);
        break;

      case 'update_info':
        if (typeof window._ccOnUpdateInfo === 'function') window._ccOnUpdateInfo(msg);
        break;
    }
  }

  // --- Generating State ---
  function startGenerating() {
    isGenerating = true;
    setCurrentSessionRunningState(true);
    pendingText = '';
    activeToolCalls.clear();
    toolGroupCount = 0;
    hasGrouped = false;
    sendBtn.hidden = true;
    abortBtn.hidden = false;
    // 不禁用输入框，允许用户继续输入（但无法发送）

    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();

    const msgEl = createMsgElement('assistant', '');
    msgEl.id = 'streaming-msg';
    // 流式消息 bubble 拆为 .msg-text 和 .msg-tools 两个子容器
    const bubble = msgEl.querySelector('.msg-bubble');
    bubble.innerHTML = '';
    const textDiv = document.createElement('div');
    textDiv.className = 'msg-text';
    textDiv.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    const toolsDiv = document.createElement('div');
    toolsDiv.className = 'msg-tools';
    bubble.appendChild(textDiv);
    bubble.appendChild(toolsDiv);
    messagesDiv.appendChild(msgEl);
    scrollToBottom();
  }

  function finishGenerating(sessionId) {
    isGenerating = false;
    sendBtn.hidden = false;
    abortBtn.hidden = true;
    setCurrentSessionRunningState(false);
    msgInput.focus();

    if (pendingText) flushRender();

    const typing = document.querySelector('.typing-indicator');
    if (typing) typing.remove();

    const streamEl = document.getElementById('streaming-msg');
    if (streamEl) {
      // 若本轮出现过父目录，把末尾散落的 .tool-call 也一并收入同一父节点
      if (hasGrouped) {
        const toolsDiv = streamEl.querySelector('.msg-tools');
        if (toolsDiv) {
          const loose = Array.from(toolsDiv.children).filter(c => c.classList.contains('tool-call'));
          if (loose.length > 0) {
            let group = toolsDiv.querySelector(':scope > .tool-group');
            if (!group) {
              group = document.createElement('details');
              group.className = 'tool-group';
              const gs = document.createElement('summary');
              gs.className = 'tool-group-summary';
              group.appendChild(gs);
              const inner = document.createElement('div');
              inner.className = 'tool-group-inner';
              group.appendChild(inner);
              toolsDiv.insertBefore(group, toolsDiv.firstChild);
            }
            const inner = group.querySelector('.tool-group-inner');
            loose.forEach(c => inner.appendChild(c));
            _refreshGroupSummary(group);
          }
        }
      }
      streamEl.removeAttribute('id');
    }

    if (sessionId) currentSessionId = sessionId;
    pendingText = '';
    activeToolCalls.clear();
    toolGroupCount = 0;
    hasGrouped = false;
  }

  // --- Rendering ---
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      flushRender();
    }, RENDER_DEBOUNCE);
  }

  function flushRender() {
    const streamEl = document.getElementById('streaming-msg');
    if (!streamEl) return;
    const bubble = streamEl.querySelector('.msg-bubble');
    if (!bubble) return;
    let textDiv = bubble.querySelector('.msg-text');
    if (!textDiv) { textDiv = bubble; }
    textDiv.innerHTML = renderMarkdown(pendingText);
    scrollToBottom();
  }

  function renderMarkdown(text) {
    if (!text) return '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    try { return marked.parse(text); }
    catch { return escapeHtml(text); }
  }

  function createMsgElement(role, content, attachments = []) {
    const div = document.createElement('div');
    div.className = `msg ${role}${role === 'assistant' ? ' agent-' + currentAgent : ''}`;

    if (role === 'system') {
      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';
      bubble.textContent = content;
      div.appendChild(bubble);
      return div;
    }

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    if (role === 'user') {
      avatar.textContent = 'U';
    } else if (currentAgent === 'codex') {
      avatar.innerHTML = `<svg viewBox="0 0 41 41" xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor"><path d="M37.532 16.87a9.963 9.963 0 0 0-.856-8.184 10.078 10.078 0 0 0-10.855-4.835A9.964 9.964 0 0 0 18.306.5a10.079 10.079 0 0 0-9.614 6.977 9.967 9.967 0 0 0-6.664 4.834 10.08 10.08 0 0 0 1.24 11.817 9.965 9.965 0 0 0 .856 8.185 10.079 10.079 0 0 0 10.855 4.835 9.965 9.965 0 0 0 7.516 3.35 10.078 10.078 0 0 0 9.617-6.981 9.967 9.967 0 0 0 6.663-4.834 10.079 10.079 0 0 0-1.243-11.813zM22.498 37.886a7.474 7.474 0 0 1-4.799-1.735c.061-.033.168-.091.237-.134l7.964-4.6a1.294 1.294 0 0 0 .655-1.134V19.054l3.366 1.944a.12.12 0 0 1 .066.092v9.299a7.505 7.505 0 0 1-7.49 7.496zM6.392 31.006a7.471 7.471 0 0 1-.894-5.023c.06.036.162.099.237.141l7.964 4.6a1.297 1.297 0 0 0 1.308 0l9.724-5.614v3.888a.12.12 0 0 1-.048.103l-8.051 4.649a7.504 7.504 0 0 1-10.24-2.744zM4.297 13.62A7.469 7.469 0 0 1 8.2 10.333c0 .068-.004.19-.004.274v9.201a1.294 1.294 0 0 0 .654 1.132l9.723 5.614-3.366 1.944a.12.12 0 0 1-.114.012L6.044 23.86a7.504 7.504 0 0 1-1.747-10.24zm27.658 6.437l-9.724-5.615 3.367-1.943a.121.121 0 0 1 .114-.012l9.048 5.228a7.498 7.498 0 0 1-1.158 13.528v-9.476a1.293 1.293 0 0 0-.647-1.71zm3.35-5.043c-.059-.037-.162-.099-.236-.141l-7.965-4.6a1.298 1.298 0 0 0-1.308 0l-9.723 5.614v-3.888a.12.12 0 0 1 .048-.103l8.05-4.645a7.497 7.497 0 0 1 11.135 7.763zm-21.063 6.929l-3.367-1.944a.12.12 0 0 1-.065-.092v-9.299a7.497 7.497 0 0 1 12.293-5.756 6.94 6.94 0 0 0-.236.134l-7.965 4.6a1.294 1.294 0 0 0-.654 1.132l-.006 11.225zm1.829-3.943l4.33-2.501 4.332 2.5v4.999l-4.331 2.5-4.331-2.5V18z"/></svg>`;
    } else {
      // Pixel-style Claude crab mascot, transparent bg, fixed colors matching original
      avatar.innerHTML = `<svg viewBox="0 0 49 32" xmlns="http://www.w3.org/2000/svg" width="28" height="20" shape-rendering="crispEdges">
        <!-- body -->
        <rect x="7" y="1" width="35" height="22" fill="#d47f5a"/>
        <!-- body outline -->
        <rect x="7" y="1" width="35" height="1" fill="#714333"/>
        <rect x="7" y="22" width="35" height="1" fill="#714333"/>
        <rect x="7" y="1" width="1" height="22" fill="#714333"/>
        <rect x="41" y="1" width="1" height="22" fill="#714333"/>
        <!-- left eye -->
        <rect x="13" y="6" width="2" height="6" fill="#2c0700"/>
        <rect x="13" y="6" width="2" height="1" fill="#000"/>
        <!-- right eye -->
        <rect x="34" y="6" width="2" height="6" fill="#2c0700"/>
        <rect x="34" y="6" width="2" height="1" fill="#000"/>
        <!-- left claw arm -->
        <rect x="1" y="12" width="6" height="6" fill="#d47f5a"/>
        <rect x="1" y="12" width="1" height="6" fill="#714333"/>
        <rect x="1" y="12" width="6" height="1" fill="#714333"/>
        <rect x="1" y="17" width="6" height="1" fill="#714333"/>
        <!-- left claw tip -->
        <rect x="0" y="11" width="3" height="4" fill="#714333"/>
        <rect x="0" y="15" width="3" height="3" fill="#2c0700"/>
        <!-- right claw arm -->
        <rect x="42" y="12" width="6" height="6" fill="#d47f5a"/>
        <rect x="47" y="12" width="1" height="6" fill="#714333"/>
        <rect x="42" y="12" width="6" height="1" fill="#714333"/>
        <rect x="42" y="17" width="6" height="1" fill="#714333"/>
        <!-- right claw tip -->
        <rect x="46" y="11" width="3" height="4" fill="#714333"/>
        <rect x="46" y="15" width="3" height="3" fill="#2c0700"/>
        <!-- legs left 1 -->
        <rect x="9" y="23" width="3" height="6" fill="#d47f5a"/>
        <rect x="9" y="28" width="3" height="2" fill="#9d6452"/>
        <!-- legs left 2 -->
        <rect x="15" y="23" width="3" height="7" fill="#d47f5a"/>
        <rect x="15" y="29" width="3" height="2" fill="#9d6452"/>
        <!-- legs left 3 -->
        <rect x="21" y="23" width="3" height="6" fill="#d47f5a"/>
        <rect x="21" y="28" width="3" height="2" fill="#9d6452"/>
        <!-- legs right 1 -->
        <rect x="37" y="23" width="3" height="6" fill="#d47f5a"/>
        <rect x="37" y="28" width="3" height="2" fill="#9d6452"/>
        <!-- legs right 2 -->
        <rect x="31" y="23" width="3" height="7" fill="#d47f5a"/>
        <rect x="31" y="29" width="3" height="2" fill="#9d6452"/>
        <!-- legs right 3 -->
        <rect x="25" y="23" width="3" height="6" fill="#d47f5a"/>
        <rect x="25" y="28" width="3" height="2" fill="#9d6452"/>
      </svg>`;
    }

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    if (role === 'user') {
      if (content) {
        const textNode = document.createElement('div');
        textNode.className = 'msg-text';
        textNode.style.whiteSpace = 'pre-wrap';
        textNode.textContent = content;
        bubble.appendChild(textNode);
      }
      if (attachments.length > 0) {
        bubble.insertAdjacentHTML('beforeend', renderAttachmentLabels(attachments));
      }
    } else {
      bubble.innerHTML = content ? renderMarkdown(content) : '';
      if (attachments.length > 0) {
        bubble.insertAdjacentHTML('beforeend', renderAttachmentLabels(attachments));
      }
    }

    div.appendChild(avatar);
    div.appendChild(bubble);
    return div;
  }

  let renderEpoch = 0;

  function toolKind(tool) {
    return tool?.kind || tool?.meta?.kind || '';
  }

  function toolTitle(tool) {
    if (tool?.meta?.title) return tool.meta.title;
    return tool?.name || 'Tool';
  }

  function toolSubtitle(tool) {
    if (tool?.meta?.subtitle) return tool.meta.subtitle;
    if (toolKind(tool) === 'command_execution') {
      return tool?.input?.command || '';
    }
    return '';
  }

  function stringifyToolValue(value) {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function toolStateLabel(tool, done) {
    if (!done) return 'Running';
    if (toolKind(tool) === 'command_execution' && typeof tool?.meta?.exitCode === 'number') {
      return `Exit ${tool.meta.exitCode}`;
    }
    return 'Done';
  }

  function toolStateClass(tool, done) {
    if (!done) return 'running';
    if (toolKind(tool) === 'command_execution' && typeof tool?.meta?.exitCode === 'number' && tool.meta.exitCode !== 0) {
      return 'error';
    }
    return 'done';
  }

  function applyToolSummary(summary, tool, done) {
    summary.innerHTML = '';
    const icon = document.createElement('span');
    icon.className = `tool-call-icon ${done ? 'done' : 'running'}`;

    const main = document.createElement('span');
    main.className = 'tool-call-summary-main';
    const label = document.createElement('span');
    label.className = 'tool-call-label';
    label.textContent = toolTitle(tool);
    main.appendChild(label);

    const subtitleText = toolSubtitle(tool);
    if (subtitleText) {
      const subtitle = document.createElement('span');
      subtitle.className = 'tool-call-subtitle';
      subtitle.textContent = subtitleText;
      main.appendChild(subtitle);
    }

    const state = document.createElement('span');
    state.className = `tool-call-state ${toolStateClass(tool, done)}`;
    state.textContent = toolStateLabel(tool, done);

    summary.appendChild(icon);
    summary.appendChild(main);
    summary.appendChild(state);
  }

  function buildStructuredToolSection(labelText, bodyText) {
    const section = document.createElement('div');
    section.className = 'tool-call-section';
    const label = document.createElement('div');
    label.className = 'tool-call-section-label';
    label.textContent = labelText;
    const pre = document.createElement('pre');
    pre.className = 'tool-call-code';
    pre.textContent = bodyText;
    section.appendChild(label);
    section.appendChild(pre);
    return section;
  }

  function buildMsgElement(m) {
    const el = createMsgElement(m.role, m.content, m.attachments || []);
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const bubble = el.querySelector('.msg-bubble');
      const FOLD_AT = 5;
      let grouped = false;
      for (const tc of m.toolCalls) {
        const details = createToolCallElement(tc.id || `saved-${Math.random().toString(36).slice(2)}`, tc, true);

        // 散落的 .tool-call 达到 FOLD_AT 个时，移入唯一 .tool-group
        const loose = Array.from(bubble.children).filter(c => c.classList.contains('tool-call'));
        if (loose.length >= FOLD_AT) {
          let group = bubble.querySelector(':scope > .tool-group');
          if (!group) {
            group = document.createElement('details');
            group.className = 'tool-group';
            const gs = document.createElement('summary');
            gs.className = 'tool-group-summary';
            group.appendChild(gs);
            const inner = document.createElement('div');
            inner.className = 'tool-group-inner';
            group.appendChild(inner);
            bubble.insertBefore(group, bubble.firstChild);
            grouped = true;
          }
          const inner = group.querySelector('.tool-group-inner');
          loose.forEach(c => inner.appendChild(c));
          _refreshGroupSummary(group);
        }
        bubble.appendChild(details);
      }
      // 结束时若出现过父目录，收尾散落项
      if (grouped) {
        const loose = Array.from(bubble.children).filter(c => c.classList.contains('tool-call'));
        if (loose.length > 0) {
          const group = bubble.querySelector(':scope > .tool-group');
          if (group) {
            const inner = group.querySelector('.tool-group-inner');
            loose.forEach(c => inner.appendChild(c));
            _refreshGroupSummary(group);
          }
        }
      }
    }
    return el;
  }

  function renderMessages(messages, options = {}) {
    renderEpoch++;
    const epoch = renderEpoch;
    messagesDiv.innerHTML = '';
    if (messages.length === 0) {
      messagesDiv.innerHTML = buildWelcomeMarkup(currentAgent);
      return;
    }
    if (options.immediate) {
      const frag = document.createDocumentFragment();
      messages.forEach((message) => frag.appendChild(buildMsgElement(message)));
      messagesDiv.appendChild(frag);
      scrollToBottom();
      return;
    }
    // Batch render: last 10 first, then next 20, then the rest
    const batches = [];
    const len = messages.length;
    if (len <= 10) {
      batches.push([0, len]);
    } else if (len <= 30) {
      batches.push([len - 10, len]);
      batches.push([0, len - 10]);
    } else {
      batches.push([len - 10, len]);
      batches.push([len - 30, len - 10]);
      batches.push([0, len - 30]);
    }

    // Render first batch immediately
    const frag0 = document.createDocumentFragment();
    for (let i = batches[0][0]; i < batches[0][1]; i++) frag0.appendChild(buildMsgElement(messages[i]));
    messagesDiv.appendChild(frag0);
    scrollToBottom();

    // Render remaining batches asynchronously, prepending each
    // Use scrollHeight delta to keep current view position stable after prepend
    let delay = 0;
    for (let b = 1; b < batches.length; b++) {
      const [start, end] = batches[b];
      delay += 16;
      setTimeout(() => {
        if (renderEpoch !== epoch) return; // session switched, abort stale render
        const prevHeight = messagesDiv.scrollHeight;
        const prevScrollTop = messagesDiv.scrollTop;
        const frag = document.createDocumentFragment();
        for (let i = start; i < end; i++) frag.appendChild(buildMsgElement(messages[i]));
        messagesDiv.insertBefore(frag, messagesDiv.firstChild);
        // Compensate scrollTop so visible area stays unchanged
        messagesDiv.scrollTop = prevScrollTop + (messagesDiv.scrollHeight - prevHeight);
        updateScrollbar();
      }, delay);
    }
  }

  function prependHistoryMessages(messages, options = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return;
    const preserveScroll = options.preserveScroll !== false;
    const skipScrollbar = options.skipScrollbar === true;
    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();
    const frag = document.createDocumentFragment();
    messages.forEach((m) => frag.appendChild(buildMsgElement(m)));
    if (!preserveScroll) {
      messagesDiv.insertBefore(frag, messagesDiv.firstChild);
      if (!skipScrollbar) updateScrollbar();
      return;
    }
    const prevHeight = messagesDiv.scrollHeight;
    const prevScrollTop = messagesDiv.scrollTop;
    messagesDiv.insertBefore(frag, messagesDiv.firstChild);
    messagesDiv.scrollTop = prevScrollTop + (messagesDiv.scrollHeight - prevHeight);
    if (!skipScrollbar) updateScrollbar();
  }

  function normalizeAskUserInput(input) {
    if (input === null || input === undefined) return null;
    if (typeof input === 'string') {
      const trimmed = input.trim();
      if (!trimmed) return null;
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    }
    return input;
  }

  function extractAskUserQuestions(input) {
    const parsed = normalizeAskUserInput(input);
    if (!parsed || !Array.isArray(parsed.questions)) return [];
    return parsed.questions;
  }

  function appendAskOptionToInput(question, option) {
    const header = (question?.header || '').trim() || '问题';
    const line = `【${header}】${option?.label || ''}`;
    const current = msgInput.value.trim();
    msgInput.value = current ? `${current}\n${line}` : line;
    autoResize();
    msgInput.focus();
  }

  function createAskUserQuestionView(questions) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ask-user-question';

    questions.forEach((q, idx) => {
      const card = document.createElement('div');
      card.className = 'ask-question-card';

      const header = document.createElement('div');
      header.className = 'ask-question-header';
      header.textContent = `${idx + 1}. ${q.header || '问题'}`;
      card.appendChild(header);

      const body = document.createElement('div');
      body.className = 'ask-question-text';
      body.textContent = q.question || '';
      card.appendChild(body);

      if (Array.isArray(q.options) && q.options.length > 0) {
        const hasDesc = q.options.some(o => o.description);

        // 左右分栏容器
        const layout = document.createElement('div');
        layout.className = 'ask-options-layout' + (hasDesc ? ' has-preview' : '');

        const opts = document.createElement('div');
        opts.className = 'ask-question-options';

        // 右侧预览区（仅在有 description 时创建）
        const preview = hasDesc ? document.createElement('div') : null;
        if (preview) {
          preview.className = 'ask-option-preview';
          // 默认显示第一项
          preview.textContent = q.options[0].description || '';
        }

        // 当前选中项（移动端 tap-to-preview 状态）
        let selectedOpt = null;
        let selectedBtn = null;

        q.options.forEach((opt, i) => {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'ask-option-item';

          const title = document.createElement('div');
          title.className = 'ask-option-label';
          title.textContent = `${i + 1}. ${opt.label || ''}`;
          item.appendChild(title);

          // 桌面：hover 切换预览
          if (preview) {
            item.addEventListener('mouseenter', () => {
              preview.textContent = opt.description || '';
            });
          }

          item.addEventListener('click', (e) => {
            const isTouch = item.dataset.touchActivated === '1';
            item.dataset.touchActivated = '';

            if (isTouch) {
              // 移动端：第一次 tap = 选中预览，不发送
              if (selectedBtn !== item) {
                if (selectedBtn) selectedBtn.classList.remove('ask-option-selected');
                selectedBtn = item;
                selectedOpt = opt;
                item.classList.add('ask-option-selected');
                if (preview) preview.textContent = opt.description || '';
                return;
              }
              // 第二次 tap 同一项 = 发送
            }

            // 桌面直接发送
            appendAskOptionToInput(q, opt);
          });

          item.addEventListener('touchstart', () => {
            item.dataset.touchActivated = '1';
          }, { passive: true });

          opts.appendChild(item);
        });

        layout.appendChild(opts);
        if (preview) {
          layout.appendChild(preview);
          // 预览区最小高度 = 左侧选项列表总高度（渲染后同步）
          requestAnimationFrame(() => {
            preview.style.minHeight = opts.offsetHeight + 'px';
          });
        }

        // 移动端确认按钮
        if (hasDesc) {
          const confirmBtn = document.createElement('button');
          confirmBtn.type = 'button';
          confirmBtn.className = 'ask-confirm-btn';
          confirmBtn.textContent = '确认选择';
          confirmBtn.addEventListener('click', () => {
            if (selectedOpt) {
              appendAskOptionToInput(q, selectedOpt);
            } else if (q.options.length > 0) {
              appendAskOptionToInput(q, q.options[0]);
            }
          });
          layout.appendChild(confirmBtn);
        }

        card.appendChild(layout);
      }

      wrapper.appendChild(card);
    });

    return wrapper;
  }

  function buildToolContentElement(name, input) {
    const tool = typeof name === 'object' && name !== null ? name : { name, input };
    const effectiveName = tool.name || name;
    const effectiveInput = tool.input !== undefined ? tool.input : input;
    const effectiveResult = tool.result;
    const kind = toolKind(tool);
    if (effectiveName === 'AskUserQuestion') {
      const questions = extractAskUserQuestions(effectiveInput);
      if (questions.length > 0) {
        return createAskUserQuestionView(questions);
      }
    }

    if (kind === 'command_execution') {
      const wrapper = document.createElement('div');
      wrapper.className = 'tool-call-content command';
      const stack = document.createElement('div');
      stack.className = 'tool-call-structured';
      const commandText = effectiveInput?.command || tool?.meta?.subtitle || '';
      if (commandText) stack.appendChild(buildStructuredToolSection('Command', commandText));
      if (effectiveResult) {
        stack.appendChild(buildStructuredToolSection('Output', stringifyToolValue(effectiveResult)));
      } else if (!tool.done) {
        const empty = document.createElement('div');
        empty.className = 'tool-call-empty';
        empty.textContent = '等待命令输出…';
        stack.appendChild(empty);
      }
      wrapper.appendChild(stack);
      return wrapper;
    }

    if (kind === 'reasoning') {
      const content = document.createElement('div');
      content.className = 'tool-call-content reasoning';
      const text = stringifyToolValue(effectiveResult || effectiveInput);
      content.innerHTML = text ? renderMarkdown(text) : '<div class="tool-call-empty">暂无推理内容</div>';
      return content;
    }

    if (kind === 'file_change' || kind === 'mcp_tool_call') {
      const wrapper = document.createElement('div');
      wrapper.className = `tool-call-content ${kind === 'file_change' ? 'file-change' : ''}`.trim();
      const stack = document.createElement('div');
      stack.className = 'tool-call-structured';
      if (tool?.meta?.subtitle) {
        stack.appendChild(buildStructuredToolSection(kind === 'file_change' ? 'Target' : 'Tool', tool.meta.subtitle));
      }
      const payloadText = stringifyToolValue(effectiveResult || effectiveInput);
      if (payloadText) {
        stack.appendChild(buildStructuredToolSection('Payload', payloadText));
      }
      wrapper.appendChild(stack);
      return wrapper;
    }

    const inputStr = stringifyToolValue(effectiveResult || effectiveInput);
    const content = document.createElement('div');
    content.className = 'tool-call-content';
    content.textContent = inputStr;
    return content;
  }

  function createToolCallElement(toolUseId, tool, done) {
    const details = document.createElement('details');
    details.className = 'tool-call';
    details.id = `tool-${toolUseId}`;
    details.dataset.toolName = tool.name || '';
    if (toolKind(tool)) {
      details.dataset.toolKind = toolKind(tool);
      details.classList.add(`codex-${toolKind(tool).replace(/_/g, '-')}`);
    }
    if (tool.name === 'AskUserQuestion' || (!done && toolKind(tool) === 'command_execution')) details.open = true;

    const summary = document.createElement('summary');
    applyToolSummary(summary, tool, done);
    details.appendChild(summary);
    details.appendChild(buildToolContentElement({ ...tool, done }));
    return details;
  }

  function appendToolCall(toolUseId, name, input, done, kind = null, meta = null) {
    const streamEl = document.getElementById('streaming-msg');
    if (!streamEl) return;
    const bubble = streamEl.querySelector('.msg-bubble');
    if (!bubble) return;
    let toolsDiv = bubble.querySelector('.msg-tools');
    if (!toolsDiv) { toolsDiv = bubble; }

    const tool = { id: toolUseId, name, input, kind, meta, done };

    const details = createToolCallElement(toolUseId, tool, done);

    // 折叠策略：只维护唯一一个 .tool-group 父节点
    // 散落的 .tool-call 直接子节点达到5个时，将它们全部移入父节点；之后继续散落，再达5个再移入
    const FOLD_AT = 5;
    const looseBefore = Array.from(toolsDiv.children).filter(c => c.classList.contains('tool-call'));
    if (looseBefore.length >= FOLD_AT) {
      // 确保存在唯一的 .tool-group
      let group = toolsDiv.querySelector(':scope > .tool-group');
      if (!group) {
        group = document.createElement('details');
        group.className = 'tool-group';
        const gs = document.createElement('summary');
        gs.className = 'tool-group-summary';
        group.appendChild(gs);
        const inner = document.createElement('div');
        inner.className = 'tool-group-inner';
        group.appendChild(inner);
        toolsDiv.insertBefore(group, toolsDiv.firstChild);
        hasGrouped = true;
      }
      const inner = group.querySelector('.tool-group-inner');
      looseBefore.forEach(c => inner.appendChild(c));
      _refreshGroupSummary(group);
    }
    toolsDiv.appendChild(details);
    scrollToBottom();
  }

  function _refreshGroupSummary(group) {
    const inner = group.querySelector('.tool-group-inner');
    const count = inner ? inner.childElementCount : 0;
    const summary = group.querySelector('.tool-group-summary');
    if (summary) summary.textContent = `展开 ${count} 个工具调用`;
  }

  function updateToolCall(toolUseId, result) {
    const el = document.getElementById(`tool-${toolUseId}`);
    if (!el) return;
    const tool = activeToolCalls.get(toolUseId) || {
      id: toolUseId,
      name: el.dataset.toolName || '',
      kind: el.dataset.toolKind || null,
      done: true,
    };
    tool.done = true;
    if (result !== undefined) tool.result = result;
    const summary = el.querySelector('summary');
    if (summary) applyToolSummary(summary, tool, true);
    if (tool.name === 'AskUserQuestion') return;
    const nextContent = buildToolContentElement(tool);
    const content = el.querySelector('.tool-call-content');
    if (content) content.replaceWith(nextContent);
  }

  function getDeleteConfirmMessage(agent) {
    const normalized = normalizeAgent(agent);
    if (normalized === 'codex') {
      return '删除本会话将同步删去本地 Codex rollout 历史与线程记录，不可恢复。确认删除？';
    }
    return '删除本会话将同步删去本地 Claude 中的会话历史，不可恢复。确认删除？';
  }

  function showDeleteConfirm(agent, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.style.zIndex = '10002';

    const box = document.createElement('div');
    box.className = 'settings-panel';
    box.innerHTML = `
      <div style="font-size:0.9em;color:var(--text-primary);margin-bottom:20px;line-height:1.7">${escapeHtml(getDeleteConfirmMessage(agent))}</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button id="del-confirm-ok" style="width:100%;padding:10px;border:none;border-radius:10px;background:var(--accent);color:#fff;font-size:0.95em;font-weight:600;cursor:pointer;font-family:inherit">确认删除</button>
        <button id="del-confirm-skip" style="width:100%;padding:9px;border:1px solid var(--border-color);border-radius:10px;background:var(--bg-tertiary);color:var(--text-secondary);font-size:0.85em;cursor:pointer;font-family:inherit">确认且不再提示</button>
        <button id="del-confirm-cancel" style="width:100%;padding:9px;border:none;border-radius:10px;background:transparent;color:var(--text-muted);font-size:0.85em;cursor:pointer;font-family:inherit">取消</button>
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = () => document.body.removeChild(overlay);
    box.querySelector('#del-confirm-ok').addEventListener('click', () => { close(); onConfirm(); });
    box.querySelector('#del-confirm-skip').addEventListener('click', () => {
      skipDeleteConfirm = true;
      localStorage.setItem('cc-web-skip-delete-confirm', '1');
      close();
      onConfirm();
    });
    box.querySelector('#del-confirm-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  }

  function appendSystemMessage(message) {
    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();
    messagesDiv.appendChild(createMsgElement('system', message));
    scrollToBottom();
  }

  function appendError(message) {
    const div = document.createElement('div');
    div.className = 'msg system';
    div.innerHTML = `<div class="msg-bubble" style="border-color:var(--danger);color:var(--danger)">⚠ ${escapeHtml(message)}</div>`;
    messagesDiv.appendChild(div);
    scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
      updateScrollbar();
    });
  }

  // --- Custom Scrollbar ---
  const scrollbarEl = document.getElementById('custom-scrollbar');
  const thumbEl = document.getElementById('custom-scrollbar-thumb');

  function updateScrollbar() {
    if (!scrollbarEl || !thumbEl) return;
    const { scrollTop, scrollHeight, clientHeight } = messagesDiv;
    if (scrollHeight <= clientHeight) {
      thumbEl.style.display = 'none';
      return;
    }
    thumbEl.style.display = '';
    const trackH = scrollbarEl.clientHeight;
    const thumbH = Math.max(30, trackH * clientHeight / scrollHeight);
    const thumbTop = (scrollTop / (scrollHeight - clientHeight)) * (trackH - thumbH);
    thumbEl.style.height = thumbH + 'px';
    thumbEl.style.top = thumbTop + 'px';
  }

  messagesDiv.addEventListener('scroll', () => {
    updateScrollbar();
    // 移动端：滚动时短暂显示滑块，停止后淡出
    scrollbarEl.classList.add('scrolling');
    clearTimeout(scrollbarEl._hideTimer);
    scrollbarEl._hideTimer = setTimeout(() => {
      if (!isDragging) scrollbarEl.classList.remove('scrolling');
    }, 1200);
  }, { passive: true });
  new ResizeObserver(updateScrollbar).observe(messagesDiv);

  // Drag logic
  let dragStartY = 0, dragStartScrollTop = 0, isDragging = false;

  function onDragStart(e) {
    isDragging = true;
    dragStartY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
    dragStartScrollTop = messagesDiv.scrollTop;
    thumbEl.classList.add('dragging');
    scrollbarEl.classList.add('active');
    e.preventDefault();
  }

  function onDragMove(e) {
    if (!isDragging) return;
    const clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
    const dy = clientY - dragStartY;
    const { scrollHeight, clientHeight } = messagesDiv;
    const trackH = scrollbarEl.clientHeight;
    const thumbH = Math.max(30, trackH * clientHeight / scrollHeight);
    const ratio = (scrollHeight - clientHeight) / (trackH - thumbH);
    messagesDiv.scrollTop = dragStartScrollTop + dy * ratio;
    e.preventDefault();
  }

  function onDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    thumbEl.classList.remove('dragging');
    scrollbarEl.classList.remove('active');
  }

  thumbEl.addEventListener('mousedown', onDragStart);
  thumbEl.addEventListener('touchstart', onDragStart, { passive: false });
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('touchmove', onDragMove, { passive: false });
  document.addEventListener('mouseup', onDragEnd);
  document.addEventListener('touchend', onDragEnd);

  updateScrollbar();


  function renderSessionList() {
    sessionList.innerHTML = '';
    const visibleSessions = getVisibleSessions();
    if (visibleSessions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'session-list-empty';
      empty.textContent = `暂无 ${AGENT_LABELS[currentAgent]} 会话，点击“新会话”开始。`;
      sessionList.appendChild(empty);
      return;
    }

    for (const s of visibleSessions) {
      const item = document.createElement('div');
      item.className = `session-item${s.id === currentSessionId ? ' active' : ''}`;
      item.dataset.id = s.id;
      item.innerHTML = `
        <div class="session-item-main">
          <span class="session-item-title">${escapeHtml(s.title || 'Untitled')}</span>
          ${s.isRunning ? '<span class="session-item-status">运行中</span>' : ''}
        </div>
        ${s.hasUnread ? '<span class="session-unread-dot"></span>' : ''}
        <span class="session-item-time">${timeAgo(s.updated)}</span>
        <div class="session-item-actions">
          <button class="session-item-btn edit" title="重命名">✎</button>
          <button class="session-item-btn delete" title="删除">×</button>
        </div>
      `;

      item.addEventListener('click', (e) => {
        const target = e.target;
        if (target.classList.contains('delete')) {
          e.stopPropagation();
          const doDelete = () => {
            if (getLastSessionForAgent(currentAgent) === s.id) {
              localStorage.removeItem(getAgentSessionStorageKey(currentAgent));
            }
            invalidateSessionCache(s.id);
            send({ type: 'delete_session', sessionId: s.id });
            if (s.id === currentSessionId) {
              resetChatView(currentAgent);
            }
          };
          if (skipDeleteConfirm) {
            doDelete();
          } else {
            showDeleteConfirm(s.agent, doDelete);
          }
          return;
        }
        if (target.classList.contains('edit')) {
          e.stopPropagation();
          startEditSessionTitle(item, s);
          return;
        }
        openSession(s.id);
      });

      sessionList.appendChild(item);
    }
  }

  function startEditSessionTitle(itemEl, session) {
    const titleEl = itemEl.querySelector('.session-item-title');
    const currentTitle = session.title || '';
    const input = document.createElement('input');
    input.className = 'session-item-edit-input';
    input.value = currentTitle;
    input.maxLength = 100;

    titleEl.replaceWith(input);
    input.focus();
    input.select();

    // Hide actions during edit
    const actions = itemEl.querySelector('.session-item-actions');
    const time = itemEl.querySelector('.session-item-time');
    if (actions) actions.style.display = 'none';
    if (time) time.style.display = 'none';

    function save() {
      const newTitle = input.value.trim() || currentTitle;
      if (newTitle !== currentTitle) {
        send({ type: 'rename_session', sessionId: session.id, title: newTitle });
      }
      // Restore
      const span = document.createElement('span');
      span.className = 'session-item-title';
      span.textContent = newTitle;
      input.replaceWith(span);
      if (actions) actions.style.display = '';
      if (time) time.style.display = '';
    }

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = currentTitle; input.blur(); }
    });
  }

  function highlightActiveSession() {
    document.querySelectorAll('.session-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.id === currentSessionId);
    });
  }

  // --- Header title editing (contenteditable) ---
  chatTitle.addEventListener('click', () => {
    if (!currentSessionId || chatTitle.contentEditable === 'true') return;
    const originalText = chatTitle.textContent;
    chatTitle.contentEditable = 'true';
    chatTitle.style.background = '#fff';
    chatTitle.style.outline = '1px solid var(--accent)';
    chatTitle.style.borderRadius = '6px';
    chatTitle.style.padding = '2px 8px';
    chatTitle.style.minWidth = '96px';
    chatTitle.style.whiteSpace = 'normal';
    chatTitle.style.overflow = 'visible';
    chatTitle.style.textOverflow = 'clip';
    chatTitle.focus();
    // Select all text
    const range = document.createRange();
    range.selectNodeContents(chatTitle);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    function finish(save) {
      chatTitle.contentEditable = 'false';
      chatTitle.style.background = '';
      chatTitle.style.outline = '';
      chatTitle.style.borderRadius = '';
      chatTitle.style.padding = '';
      chatTitle.style.minWidth = '';
      chatTitle.style.whiteSpace = '';
      chatTitle.style.overflow = '';
      chatTitle.style.textOverflow = '';
      const newTitle = chatTitle.textContent.trim() || originalText;
      chatTitle.textContent = newTitle;
      if (save && newTitle !== originalText && currentSessionId) {
        send({ type: 'rename_session', sessionId: currentSessionId, title: newTitle });
      }
    }

    chatTitle.addEventListener('blur', () => finish(true), { once: true });
    chatTitle.addEventListener('keydown', function handler(e) {
      if (e.key === 'Enter') { e.preventDefault(); chatTitle.removeEventListener('keydown', handler); chatTitle.blur(); }
      if (e.key === 'Escape') { chatTitle.textContent = originalText; chatTitle.removeEventListener('keydown', handler); chatTitle.blur(); }
    });
  });

  // --- Sidebar ---
  function openSidebar() {
    sidebar.classList.add('open');
    sidebarOverlay.hidden = false;
  }
  function closeSidebar() {
    sidebar.classList.remove('open');
    sidebarOverlay.hidden = true;
  }

  function canOpenSidebarBySwipe(target) {
    if (!window.matchMedia('(max-width: 768px), (pointer: coarse)').matches) return false;
    if (sidebar.classList.contains('open')) return false;
    if (sessionLoadingOverlay && !sessionLoadingOverlay.hidden) return false;
    if (!chatMain || !target || !chatMain.contains(target)) return false;
    if (!app.hidden && target && target.closest('input, textarea, select, button, .modal-panel, .settings-panel, .option-picker, .cmd-menu')) {
      return false;
    }
    return true;
  }

  function canCloseSidebarBySwipe(target) {
    if (!window.matchMedia('(max-width: 768px), (pointer: coarse)').matches) return false;
    if (!sidebar.classList.contains('open')) return false;
    if (!target) return false;
    return sidebar.contains(target) || target === sidebarOverlay;
  }

  function handleSidebarSwipeStart(e) {
    if (!e.touches || e.touches.length !== 1) return;
    const touch = e.touches[0];
    if (canCloseSidebarBySwipe(e.target)) {
      sidebarSwipe = {
        startX: touch.clientX,
        startY: touch.clientY,
        active: true,
        mode: 'close',
      };
      return;
    }
    if (!canOpenSidebarBySwipe(e.target)) {
      sidebarSwipe = null;
      return;
    }
    sidebarSwipe = {
      startX: touch.clientX,
      startY: touch.clientY,
      active: true,
      mode: 'open',
    };
  }

  function handleSidebarSwipeMove(e) {
    if (!sidebarSwipe?.active || !e.touches || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const deltaX = touch.clientX - sidebarSwipe.startX;
    const deltaY = touch.clientY - sidebarSwipe.startY;
    if (Math.abs(deltaY) > SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT && Math.abs(deltaY) > Math.abs(deltaX)) {
      sidebarSwipe = null;
      return;
    }
    const horizontalIntent = sidebarSwipe.mode === 'open' ? deltaX > 12 : deltaX < -12;
    if (horizontalIntent && Math.abs(deltaY) < SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT) {
      e.preventDefault();
    }
  }

  function handleSidebarSwipeEnd(e) {
    if (!sidebarSwipe?.active) return;
    const touch = e.changedTouches && e.changedTouches[0];
    const endX = touch ? touch.clientX : sidebarSwipe.startX;
    const endY = touch ? touch.clientY : sidebarSwipe.startY;
    const deltaX = endX - sidebarSwipe.startX;
    const deltaY = endY - sidebarSwipe.startY;
    const shouldOpen = sidebarSwipe.mode === 'open' &&
      deltaX >= SIDEBAR_SWIPE_TRIGGER &&
      Math.abs(deltaY) <= SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT;
    const shouldClose = sidebarSwipe.mode === 'close' &&
      deltaX <= -SIDEBAR_SWIPE_TRIGGER &&
      Math.abs(deltaY) <= SIDEBAR_SWIPE_MAX_VERTICAL_DRIFT;
    sidebarSwipe = null;
    if (shouldOpen) {
      openSidebar();
    } else if (shouldClose) {
      closeSidebar();
    }
  }

  // --- Slash Command Menu ---
  function showCmdMenu(filter) {
    const filtered = SLASH_COMMANDS.filter(c =>
      c.cmd.startsWith(filter) || c.desc.includes(filter.slice(1))
    );
    // Exact match first (fixes /mode vs /model ambiguity)
    filtered.sort((a, b) => (b.cmd === filter ? 1 : 0) - (a.cmd === filter ? 1 : 0));
    if (filtered.length === 0) {
      hideCmdMenu();
      return;
    }
    cmdMenuIndex = 0;
    cmdMenu.innerHTML = filtered.map((c, i) =>
      `<div class="cmd-item${i === 0 ? ' active' : ''}" data-cmd="${c.cmd}">
        <span class="cmd-item-cmd">${c.cmd}</span>
        <span class="cmd-item-desc">${c.desc}</span>
      </div>`
    ).join('');
    cmdMenu.hidden = false;

    // Click handlers
    cmdMenu.querySelectorAll('.cmd-item').forEach(el => {
      el.addEventListener('click', () => {
        const cmd = el.dataset.cmd;
        if (cmd === '/model') {
          hideCmdMenu();
          msgInput.value = '';
          showModelPicker();
          return;
        }
        if (cmd === '/mode') {
          hideCmdMenu();
          msgInput.value = '';
          showModePicker();
          return;
        }
        msgInput.value = cmd + ' ';
        hideCmdMenu();
        msgInput.focus();
      });
    });
  }

  function hideCmdMenu() {
    cmdMenu.hidden = true;
    cmdMenuIndex = -1;
  }

  function navigateCmdMenu(direction) {
    const items = cmdMenu.querySelectorAll('.cmd-item');
    if (items.length === 0) return;
    items[cmdMenuIndex]?.classList.remove('active');
    cmdMenuIndex = (cmdMenuIndex + direction + items.length) % items.length;
    items[cmdMenuIndex]?.classList.add('active');
  }

  function selectCmdMenuItem() {
    const items = cmdMenu.querySelectorAll('.cmd-item');
    if (cmdMenuIndex >= 0 && items[cmdMenuIndex]) {
      const cmd = items[cmdMenuIndex].dataset.cmd;
      if (cmd === '/model') {
        hideCmdMenu();
        msgInput.value = '';
        showModelPicker();
        return;
      }
      if (cmd === '/mode') {
        hideCmdMenu();
        msgInput.value = '';
        showModePicker();
        return;
      }
      msgInput.value = cmd + ' ';
      hideCmdMenu();
      msgInput.focus();
    }
  }

  // --- Option Picker (generic) ---
  function showOptionPicker(title, options, currentValue, onSelect) {
    hideOptionPicker();

    const picker = document.createElement('div');
    picker.className = 'option-picker';
    picker.id = 'option-picker';

    picker.innerHTML = `
      <div class="option-picker-title">${escapeHtml(title)}</div>
      ${options.map(opt => `
        <div class="option-picker-item${opt.value === currentValue ? ' active' : ''}" data-value="${opt.value}">
          <div class="option-picker-item-info">
            <div class="option-picker-item-label">${escapeHtml(opt.label)}</div>
            <div class="option-picker-item-desc">${escapeHtml(opt.desc)}</div>
          </div>
          ${opt.value === currentValue ? '<span class="option-picker-item-check">✓</span>' : ''}
        </div>
      `).join('')}
    `;

    const chatMain = document.querySelector('.chat-main');
    chatMain.appendChild(picker);

    picker.querySelectorAll('.option-picker-item').forEach(el => {
      el.addEventListener('click', () => {
        onSelect(el.dataset.value);
        hideOptionPicker();
      });
    });

    // Close on outside click (delayed to avoid immediate close)
    setTimeout(() => {
      document.addEventListener('click', _pickerOutsideClick);
    }, 0);
    document.addEventListener('keydown', _pickerEscape);
  }

  function hideOptionPicker() {
    const picker = document.getElementById('option-picker');
    if (picker) picker.remove();
    document.removeEventListener('click', _pickerOutsideClick);
    document.removeEventListener('keydown', _pickerEscape);
  }

  function _pickerOutsideClick(e) {
    const picker = document.getElementById('option-picker');
    if (picker && !picker.contains(e.target)) {
      hideOptionPicker();
    }
  }

  function _pickerEscape(e) {
    if (e.key === 'Escape') {
      hideOptionPicker();
    }
  }

  function showModelPicker() {
    if (currentAgent === 'codex') {
      const options = getCodexModelOptions();
      showOptionPicker('选择 Codex 模型', options, currentModel || '', (value) => {
        send({ type: 'message', text: `/model ${value}`, sessionId: currentSessionId, mode: currentMode, agent: currentAgent });
      });
      return;
    }
    showOptionPicker('选择模型', MODEL_OPTIONS, currentModel, (value) => {
      send({ type: 'message', text: `/model ${value}`, sessionId: currentSessionId, mode: currentMode, agent: currentAgent });
    });
  }

  function showModePicker() {
    showOptionPicker('选择权限模式', MODE_PICKER_OPTIONS, currentMode, (value) => {
      currentMode = value;
      modeSelect.value = currentMode;
      localStorage.setItem(getAgentModeStorageKey(currentAgent), currentMode);
      if (currentSessionId) {
        send({ type: 'set_mode', sessionId: currentSessionId, mode: currentMode });
      }
    });
  }

  // --- Send Message ---
  function sendMessage() {
    const text = msgInput.value.trim();
    if ((!text && pendingAttachments.length === 0) || isGenerating || isBlockingSessionLoad()) return;
    hideCmdMenu();
    hideOptionPicker();

    // Slash commands: don't show as user bubble
    if (text.startsWith('/')) {
      if (pendingAttachments.length > 0) {
        appendError('命令消息暂不支持附带图片，请先移除图片或发送普通消息。');
        return;
      }
      // /model without argument → show interactive picker
      if (text === '/model' || text === '/model ') {
        showModelPicker();
        msgInput.value = '';
        autoResize();
        return;
      }
      // /mode without argument → show interactive picker
      if (text === '/mode' || text === '/mode ') {
        showModePicker();
        msgInput.value = '';
        autoResize();
        return;
      }
      send({ type: 'message', text, sessionId: currentSessionId, mode: currentMode, agent: currentAgent });
      msgInput.value = '';
      autoResize();
      return;
    }

    // Regular message
    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();
    const attachments = pendingAttachments.map((attachment) => ({ ...attachment }));
    messagesDiv.appendChild(createMsgElement('user', text, attachments));
    scrollToBottom();

    send({ type: 'message', text, attachments, sessionId: currentSessionId, mode: currentMode, agent: currentAgent });
    msgInput.value = '';
    pendingAttachments = [];
    renderPendingAttachments();
    autoResize();
    startGenerating();
  }

  function autoResize() {
    msgInput.style.height = 'auto';
    const max = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--input-max-height')) || 200;
    msgInput.style.height = Math.min(msgInput.scrollHeight, max) + 'px';
  }

  function isMobileInputMode() {
    return window.matchMedia('(max-width: 768px), (pointer: coarse)').matches;
  }

  // --- Event Listeners ---
  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const pw = loginPassword.value;
    if (!pw) return;
    loginError.hidden = true;
    loginPasswordValue = pw;
    // Remember password
    if (rememberPw.checked) {
      localStorage.setItem('cc-web-pw', pw);
    } else {
      localStorage.removeItem('cc-web-pw');
    }
    send({ type: 'auth', password: pw });
    // Request notification permission on first user interaction
    requestNotificationPermission();
  });

  menuBtn.addEventListener('click', () => {
    sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
  });

  sidebarOverlay.addEventListener('click', closeSidebar);
  document.addEventListener('touchstart', handleSidebarSwipeStart, { passive: true });
  document.addEventListener('touchmove', handleSidebarSwipeMove, { passive: false });
  document.addEventListener('touchend', handleSidebarSwipeEnd, { passive: true });
  document.addEventListener('touchcancel', () => { sidebarSwipe = null; }, { passive: true });

  if (chatAgentBtn && chatAgentMenu) {
    chatAgentBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAgentMenu();
    });
    chatAgentMenu.querySelectorAll('.chat-agent-option').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAgentMenu();
        const targetAgent = normalizeAgent(btn.dataset.agent);
        if (targetAgent === currentAgent) return;
        syncViewForAgent(targetAgent, { preserveCurrent: false, loadLast: true });
      });
    });
  }

  // Split new-chat button
  newChatBtn.addEventListener('click', () => showNewSessionModal());
  newChatArrow.addEventListener('click', (e) => {
    e.stopPropagation();
    newChatDropdown.hidden = !newChatDropdown.hidden;
  });
  importSessionBtn.addEventListener('click', () => {
    newChatDropdown.hidden = true;
    if (currentAgent === 'codex') {
      showImportCodexSessionModal();
    } else {
      showImportSessionModal();
    }
  });
  document.addEventListener('click', (e) => {
    if (!newChatDropdown.hidden &&
        !newChatDropdown.contains(e.target) &&
        e.target !== newChatArrow) {
      newChatDropdown.hidden = true;
    }
    if (chatAgentMenu && !chatAgentMenu.hidden &&
        !chatAgentMenu.contains(e.target) &&
        e.target !== chatAgentBtn) {
      closeAgentMenu();
    }
  });
  sendBtn.addEventListener('click', sendMessage);
  abortBtn.addEventListener('click', () => send({ type: 'abort' }));
  if (attachBtn && imageUploadInput) {
    attachBtn.addEventListener('click', () => imageUploadInput.click());
    imageUploadInput.addEventListener('change', () => {
      handleSelectedImageFiles(imageUploadInput.files);
    });
  }
  if (inputWrapper) {
    inputWrapper.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      inputWrapper.classList.add('drag-active');
    });
    inputWrapper.addEventListener('dragleave', (e) => {
      if (e.target === inputWrapper) inputWrapper.classList.remove('drag-active');
    });
    inputWrapper.addEventListener('drop', (e) => {
      e.preventDefault();
      inputWrapper.classList.remove('drag-active');
      handleSelectedImageFiles(e.dataTransfer?.files);
    });
  }

  // Mode selector
  modeSelect.value = currentMode;
  modeSelect.addEventListener('change', () => {
    currentMode = modeSelect.value;
    localStorage.setItem(getAgentModeStorageKey(currentAgent), currentMode);
    if (currentSessionId) {
      send({ type: 'set_mode', sessionId: currentSessionId, mode: currentMode });
    }
    if (currentMode === 'default') {
      appendSystemMessage('⚠ 由于项目设计与 CLI 原生逻辑不同，默认模式的授权申请功能暂未实现，建议搭配 Plan 或 YOLO 模式使用。');
    }
  });

  msgInput.addEventListener('input', () => {
    autoResize();
    const val = msgInput.value;
    // Show slash command menu
    if (val.startsWith('/') && !val.includes('\n')) {
      showCmdMenu(val);
    } else {
      hideCmdMenu();
    }
  });

  msgInput.addEventListener('keydown', (e) => {
    // Command menu navigation
    if (!cmdMenu.hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); navigateCmdMenu(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); navigateCmdMenu(-1); return; }
      if (e.key === 'Tab') { e.preventDefault(); selectCmdMenuItem(); return; }
      if (e.key === 'Escape') { hideCmdMenu(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (isMobileInputMode()) {
        if (!cmdMenu.hidden) {
          e.preventDefault();
          selectCmdMenuItem();
        }
        return;
      }

      e.preventDefault();
      if (!cmdMenu.hidden) {
        // If menu is open and user presses Enter, select the item
        selectCmdMenuItem();
      } else {
        sendMessage();
      }
    }
  });

  msgInput.addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const files = items
      .filter((item) => item.kind === 'file' && /^image\//.test(item.type || ''))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length > 0) {
      e.preventDefault();
      handleSelectedImageFiles(files);
    }
  });

  // Close cmd menu on outside click
  document.addEventListener('click', (e) => {
    if (!cmdMenu.contains(e.target) && e.target !== msgInput) {
      hideCmdMenu();
    }
  });

  // --- Toast Notification ---
  function showToast(text, sessionId) {
    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.textContent = text;
    if (sessionId) {
      toast.style.cursor = 'pointer';
      toast.addEventListener('click', () => {
        openSession(sessionId);
        toast.remove();
      });
    }
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }

  // --- Browser Notification (via Service Worker for mobile) ---
  function showBrowserNotification(title) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then((reg) => {
        reg.showNotification('CC-Web', {
          body: `「${title}」任务完成`,
          tag: 'cc-web-task',
          renotify: true,
        });
      }).catch(() => {});
    }
  }

  function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  // --- Settings Panel ---
  let _onNotifyConfig = null;
  let _onNotifyTestResult = null;
  let _onModelConfig = null;
  let _onCodexConfig = null;
  let _onFetchModelsResult = null;
  let _onCodexSessions = null;

  const settingsBtn = $('#settings-btn');

  const PROVIDER_OPTIONS = [
    { value: 'off', label: '关闭' },
    { value: 'pushplus', label: 'PushPlus' },
    { value: 'telegram', label: 'Telegram' },
    { value: 'serverchan', label: 'Server酱' },
    { value: 'feishu', label: '飞书机器人' },
    { value: 'qqbot', label: 'QQ（Qmsg）' },
  ];

  function buildNotifyFieldsHtml(config, provider) {
    if (provider === 'pushplus') {
      return `
        <div class="settings-field">
          <label>Token</label>
          <input type="text" id="notify-pushplus-token" placeholder="PushPlus Token" value="${escapeHtml(config?.pushplus?.token || '')}">
        </div>
      `;
    }
    if (provider === 'telegram') {
      return `
        <div class="settings-field">
          <label>Bot Token</label>
          <input type="text" id="notify-tg-bottoken" placeholder="123456:ABC-DEF..." value="${escapeHtml(config?.telegram?.botToken || '')}">
        </div>
        <div class="settings-field">
          <label>Chat ID</label>
          <input type="text" id="notify-tg-chatid" placeholder="Chat ID" value="${escapeHtml(config?.telegram?.chatId || '')}">
        </div>
      `;
    }
    if (provider === 'serverchan') {
      return `
        <div class="settings-field">
          <label>SendKey</label>
          <input type="text" id="notify-sc-sendkey" placeholder="Server酱 SendKey" value="${escapeHtml(config?.serverchan?.sendKey || '')}">
        </div>
      `;
    }
    if (provider === 'feishu') {
      return `
        <div class="settings-field">
          <label>Webhook 地址</label>
          <input type="text" id="notify-feishu-webhook" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxx" value="${escapeHtml(config?.feishu?.webhook || '')}">
        </div>
      `;
    }
    if (provider === 'qqbot') {
      return `
        <div class="settings-field">
          <label>Qmsg Key</label>
          <input type="text" id="notify-qmsg-key" placeholder="Qmsg 推送 Key" value="${escapeHtml(config?.qqbot?.qmsgKey || '')}">
        </div>
      `;
    }
    return '';
  }

  function buildAgentContextCard(agent, title, copy) {
    const label = AGENT_LABELS[normalizeAgent(agent)] || AGENT_LABELS.claude;
    return `
      <div class="agent-context-card">
        <div class="agent-context-kicker">${escapeHtml(label)} Space</div>
        <div class="agent-context-title">${escapeHtml(title)}</div>
        <div class="agent-context-copy">${escapeHtml(copy)}</div>
      </div>
    `;
  }

  function renderNotifyFields(fieldsDiv, config, provider) {
    fieldsDiv.innerHTML = buildNotifyFieldsHtml(config, provider);
  }

  function collectNotifyConfigFromPanel(panel, currentConfig, provider) {
    const pp = panel.querySelector('#notify-pushplus-token');
    const tgBot = panel.querySelector('#notify-tg-bottoken');
    const tgChat = panel.querySelector('#notify-tg-chatid');
    const sc = panel.querySelector('#notify-sc-sendkey');
    const feishuWh = panel.querySelector('#notify-feishu-webhook');
    const qmsgKey = panel.querySelector('#notify-qmsg-key');
    // Summary config
    const summaryEnabled = panel.querySelector('#notify-summary-enabled');
    const summaryTrigger = panel.querySelector('#notify-summary-trigger');
    const summarySource = panel.querySelector('#notify-summary-source');
    const summaryApiBase = panel.querySelector('#notify-summary-apibase');
    const summaryApiKey = panel.querySelector('#notify-summary-apikey');
    const summaryModel = panel.querySelector('#notify-summary-model');
    const cs = currentConfig?.summary || {};
    return {
      provider,
      pushplus: { token: pp ? pp.value.trim() : (currentConfig?.pushplus?.token || '') },
      telegram: {
        botToken: tgBot ? tgBot.value.trim() : (currentConfig?.telegram?.botToken || ''),
        chatId: tgChat ? tgChat.value.trim() : (currentConfig?.telegram?.chatId || ''),
      },
      serverchan: { sendKey: sc ? sc.value.trim() : (currentConfig?.serverchan?.sendKey || '') },
      feishu: { webhook: feishuWh ? feishuWh.value.trim() : (currentConfig?.feishu?.webhook || '') },
      qqbot: { qmsgKey: qmsgKey ? qmsgKey.value.trim() : (currentConfig?.qqbot?.qmsgKey || '') },
      summary: {
        enabled: summaryEnabled ? summaryEnabled.checked : !!cs.enabled,
        trigger: summaryTrigger ? summaryTrigger.value : (cs.trigger || 'background'),
        apiSource: summarySource ? summarySource.value : (cs.apiSource || 'claude'),
        apiBase: summaryApiBase ? summaryApiBase.value.trim() : (cs.apiBase || ''),
        apiKey: summaryApiKey ? summaryApiKey.value.trim() : (cs.apiKey || ''),
        model: summaryModel ? summaryModel.value.trim() : (cs.model || ''),
      },
    };
  }

  function buildSummarySettingsHtml(config) {
    const s = config?.summary || {};
    const enabled = !!s.enabled;
    const trigger = s.trigger || 'background';
    const src = s.apiSource || 'claude';
    const customVisible = src === 'custom' ? '' : 'display:none';
    return `
      <div class="settings-divider"></div>
      <div class="settings-section-title">通知摘要</div>
      <div class="settings-field" style="flex-direction:row;align-items:center;gap:10px">
        <label style="margin:0;flex:1">启用 AI 摘要</label>
        <input type="checkbox" id="notify-summary-enabled" ${enabled ? 'checked' : ''} style="width:auto;margin:0">
      </div>
      <div id="notify-summary-options" style="${enabled ? '' : 'display:none'}">
        <div class="settings-field">
          <label>推送时机</label>
          <select class="settings-select" id="notify-summary-trigger">
            <option value="background" ${trigger === 'background' ? 'selected' : ''}>仅后台任务</option>
            <option value="always" ${trigger === 'always' ? 'selected' : ''}>所有任务</option>
          </select>
        </div>
        <div class="settings-field">
          <label>摘要 API 来源</label>
          <select class="settings-select" id="notify-summary-source">
            <option value="claude" ${src === 'claude' ? 'selected' : ''}>Claude 活跃模板</option>
            <option value="codex" ${src === 'codex' ? 'selected' : ''}>Codex 活跃 Profile</option>
            <option value="custom" ${src === 'custom' ? 'selected' : ''}>独立配置</option>
          </select>
        </div>
        <div id="notify-summary-custom" style="${customVisible}">
          <div class="settings-field">
            <label>API Base URL</label>
            <input type="text" id="notify-summary-apibase" placeholder="https://api.example.com" value="${escapeHtml(s.apiBase || '')}">
          </div>
          <div class="settings-field">
            <label>API Key</label>
            <input type="text" id="notify-summary-apikey" placeholder="sk-..." value="${escapeHtml(s.apiKey || '')}">
          </div>
          <div class="settings-field">
            <label>模型</label>
            <input type="text" id="notify-summary-model" placeholder="claude-opus-4-6" value="${escapeHtml(s.model || '')}">
          </div>
        </div>
      </div>
    `;
  }

  function bindSummarySettingsEvents(panel) {
    const enabledCb = panel.querySelector('#notify-summary-enabled');
    const optionsDiv = panel.querySelector('#notify-summary-options');
    const sourceSelect = panel.querySelector('#notify-summary-source');
    const customDiv = panel.querySelector('#notify-summary-custom');
    if (!enabledCb || !optionsDiv || !sourceSelect || !customDiv) return;
    enabledCb.addEventListener('change', () => {
      optionsDiv.style.display = enabledCb.checked ? '' : 'none';
    });
    sourceSelect.addEventListener('change', () => {
      customDiv.style.display = sourceSelect.value === 'custom' ? '' : 'none';
    });
  }

  function openPasswordModal() {
    const pwOverlay = document.createElement('div');
    pwOverlay.className = 'settings-overlay';
    pwOverlay.style.zIndex = '10001';
    const pwModal = document.createElement('div');
    pwModal.className = 'settings-panel';
    pwModal.style.maxWidth = '400px';
    pwModal.innerHTML = `
      <div class="settings-header">
        <h3>修改密码</h3>
        <button class="settings-close" id="pw-modal-close">&times;</button>
      </div>
      <div class="settings-field">
        <label>当前密码</label>
        <input type="password" id="pw-modal-current" placeholder="当前密码" autocomplete="current-password">
      </div>
      <div class="settings-field">
        <label>新密码</label>
        <input type="password" id="pw-modal-new" placeholder="新密码" autocomplete="new-password">
        <div class="password-hint" id="pw-modal-hint">至少 8 位，包含大写/小写/数字/特殊字符中的 2 种</div>
      </div>
      <div class="settings-field">
        <label>确认新密码</label>
        <input type="password" id="pw-modal-confirm" placeholder="确认新密码" autocomplete="new-password">
      </div>
      <div class="settings-actions">
        <button class="btn-save" id="pw-modal-submit" disabled>修改密码</button>
      </div>
      <div class="settings-status" id="pw-modal-status"></div>
    `;
    pwOverlay.appendChild(pwModal);
    document.body.appendChild(pwOverlay);

    const currentPwIn = pwModal.querySelector('#pw-modal-current');
    const newPwIn = pwModal.querySelector('#pw-modal-new');
    const confirmPwIn = pwModal.querySelector('#pw-modal-confirm');
    const hint = pwModal.querySelector('#pw-modal-hint');
    const submitBtn = pwModal.querySelector('#pw-modal-submit');
    const status = pwModal.querySelector('#pw-modal-status');

    function checkPw() {
      const newPw = newPwIn.value;
      const confirmPw = confirmPwIn.value;
      const currentPw = currentPwIn.value;
      if (!newPw) {
        hint.textContent = '至少 8 位，包含大写/小写/数字/特殊字符中的 2 种';
        hint.className = 'password-hint';
        submitBtn.disabled = true;
        return;
      }
      const result = clientValidatePassword(newPw);
      if (!result.valid) {
        hint.textContent = result.message;
        hint.className = 'password-hint error';
        submitBtn.disabled = true;
        return;
      }
      hint.textContent = '密码强度符合要求';
      hint.className = 'password-hint success';
      submitBtn.disabled = !currentPw || !confirmPw || confirmPw !== newPw;
    }

    currentPwIn.addEventListener('input', checkPw);
    newPwIn.addEventListener('input', checkPw);
    confirmPwIn.addEventListener('input', checkPw);

    const closePwModal = () => { document.body.removeChild(pwOverlay); };
    pwModal.querySelector('#pw-modal-close').addEventListener('click', closePwModal);
    pwOverlay.addEventListener('click', (e) => { if (e.target === pwOverlay) closePwModal(); });

    submitBtn.addEventListener('click', () => {
      const currentPw = currentPwIn.value;
      const newPw = newPwIn.value;
      const confirmPw = confirmPwIn.value;
      if (newPw !== confirmPw) {
        status.textContent = '两次密码不一致';
        status.className = 'settings-status error';
        return;
      }
      submitBtn.disabled = true;
      status.textContent = '正在修改...';
      status.className = 'settings-status';
      _onPasswordChanged = (result) => {
        if (result.success) {
          status.textContent = result.message || '密码修改成功';
          status.className = 'settings-status success';
          setTimeout(closePwModal, 1200);
        } else {
          status.textContent = result.message || '修改失败';
          status.className = 'settings-status error';
          submitBtn.disabled = false;
        }
      };
      send({ type: 'change_password', currentPassword: currentPw, newPassword: newPw });
    });

    currentPwIn.focus();
  }

  function showCodexSettingsPanel() {
    send({ type: 'get_codex_config' });
    send({ type: 'get_notify_config' });

    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.id = 'settings-overlay';

    const panel = document.createElement('div');
    panel.className = 'settings-panel';
    panel.innerHTML = `
      <h3>
        ⚙ Codex 设置
        <button class="settings-close" title="关闭">&times;</button>
      </h3>

      <div class="settings-section-title">Codex 运行配置</div>
      <div class="settings-field">
        <label>配置模式</label>
        <select class="settings-select" id="codex-mode">
          <option value="local">读取本机 Codex 登录态 / ~/.codex/config.toml</option>
          <option value="custom">自定义 API Profile</option>
        </select>
      </div>
      <div id="codex-profile-area"></div>
      <div class="settings-actions">
        <button class="btn-save" id="codex-save-btn">保存 Codex 配置</button>
      </div>
      <div class="settings-status" id="codex-status"></div>

      <div class="settings-divider"></div>

      ${buildThemeEntryHtml()}

      <div class="settings-divider"></div>

      ${buildNotifyEntryHtml(null)}

      <div class="settings-divider"></div>

      <div class="settings-section-title">系统</div>
      <div class="settings-actions" style="margin-top:0;flex-wrap:wrap;gap:10px">
        <button class="btn-test" id="pw-open-modal-btn" style="padding:6px 16px">修改密码</button>
        <button class="btn-test" id="check-update-btn" style="padding:6px 16px">检查更新</button>
      </div>
      <div class="settings-status" id="update-status" style="margin-top:8px"></div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    const themePageBtn = panel.querySelector('[data-open-theme-page]');
    if (themePageBtn) themePageBtn.addEventListener('click', openThemeSubpage);
    const notifyPageBtn = panel.querySelector('[data-open-notify-page]');
    if (notifyPageBtn) notifyPageBtn.addEventListener('click', openNotifySubpage);

    const closeBtn = panel.querySelector('.settings-close');
    const codexModeSelect = panel.querySelector('#codex-mode');
    const codexProfileArea = panel.querySelector('#codex-profile-area');
    const codexStatus = panel.querySelector('#codex-status');
    const codexSaveBtn = panel.querySelector('#codex-save-btn');

    const pwOpenModalBtn = panel.querySelector('#pw-open-modal-btn');
    const checkUpdateBtn = panel.querySelector('#check-update-btn');
    const updateStatusEl = panel.querySelector('#update-status');

    let currentCodexConfig = null;
    let codexEditingProfiles = [];
    let codexActiveProfile = '';
    let _onUpdateInfo = null;

    function showCodexStatus(msg, type) {
      codexStatus.textContent = msg;
      codexStatus.className = 'settings-status ' + (type || '');
    }

    function renderCodexProfileArea() {
      const mode = codexModeSelect.value;
      if (mode === 'local') {
        codexProfileArea.innerHTML = `
          <div class="settings-inline-note">
            当前将直接复用本机 <code>codex</code> 的登录态与 <code>~/.codex/config.toml</code>。这适合你已经在终端里正常使用 Codex 的场景。
          </div>
        `;
        return;
      }

      if (codexEditingProfiles.length === 0) {
        codexProfileArea.innerHTML = `
          <div class="settings-inline-note">
            自定义模式适合接 OpenAI 兼容服务，例如你提到的第三方 API 入口。这里仅覆盖 <strong>API Key</strong> 和 <strong>API Base URL</strong>，不会让配置页随意改模型 ID。
          </div>
          <div class="settings-actions" style="margin-top:0">
            <button class="btn-test" id="codex-profile-add-first">+ 新建 Profile</button>
          </div>
        `;
        panel.querySelector('#codex-profile-add-first').addEventListener('click', () => openCodexProfileModal());
        return;
      }

      const options = codexEditingProfiles.map((profile) =>
        `<option value="${escapeHtml(profile.name)}" ${profile.name === codexActiveProfile ? 'selected' : ''}>${escapeHtml(profile.name)}</option>`
      ).join('');
      const currentProfile = codexEditingProfiles.find((profile) => profile.name === codexActiveProfile) || codexEditingProfiles[0];
      if (currentProfile && !codexActiveProfile) codexActiveProfile = currentProfile.name;
      const summaryBase = currentProfile?.apiBase ? escapeHtml(currentProfile.apiBase) : '未设置 API Base URL';

      codexProfileArea.innerHTML = `
        <div class="settings-inline-note">
          自定义模式会为 cc-web 生成独立的 Codex 运行配置，只覆盖当前激活 Profile 的 <strong>API Key</strong> 与 <strong>API Base URL</strong>，不去碰你平时终端里用的全局登录态。
        </div>
        <div class="settings-field">
          <label>激活 Profile</label>
          <div style="display:flex;gap:6px;align-items:center">
            <select class="settings-select" id="codex-profile-select" style="flex:1">
              ${options}
              <option value="__new__">+ 新建 Profile</option>
            </select>
            <button class="btn-test" id="codex-profile-edit" style="padding:4px 10px">编辑</button>
            <button class="btn-test" id="codex-profile-del" title="删除" style="padding:4px 8px">删除</button>
          </div>
        </div>
        <div class="settings-inline-note">
          当前 Profile：<strong>${escapeHtml(currentProfile?.name || '未选择')}</strong><br>
          API Base URL：<code>${summaryBase}</code>
        </div>
      `;

      panel.querySelector('#codex-profile-select').addEventListener('change', (e) => {
        if (e.target.value === '__new__') {
          openCodexProfileModal();
          return;
        }
        codexActiveProfile = e.target.value;
        renderCodexProfileArea();
      });

      panel.querySelector('#codex-profile-edit').addEventListener('click', () => {
        openCodexProfileModal(codexActiveProfile);
      });

      panel.querySelector('#codex-profile-del').addEventListener('click', () => {
        if (!codexActiveProfile) return;
        if (!confirm(`确认删除 Codex Profile「${codexActiveProfile}」?`)) return;
        codexEditingProfiles = codexEditingProfiles.filter((profile) => profile.name !== codexActiveProfile);
        codexActiveProfile = codexEditingProfiles[0]?.name || '';
        renderCodexProfileArea();
      });
    }

    function openCodexProfileModal(profileName = '') {
      const current = profileName
        ? codexEditingProfiles.find((profile) => profile.name === profileName)
        : null;
      const draft = current || { name: '', apiKey: '', apiBase: '' };

      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>${current ? `编辑 Profile: ${escapeHtml(current.name)}` : '新建 Codex Profile'}</h3>
          <button class="settings-close" id="codex-profile-modal-close">&times;</button>
        </div>
        <div class="settings-field">
          <label>Profile 名称</label>
          <input type="text" id="codex-profile-name" placeholder="例如 OpenRouter Work" value="${escapeHtml(draft.name || '')}">
        </div>
        <div class="settings-field">
          <label>API Key</label>
          <input type="text" id="codex-profile-apikey" placeholder="sk-..." value="${escapeHtml(draft.apiKey || '')}">
        </div>
        <div class="settings-field">
          <label>API Base URL</label>
          <input type="text" id="codex-profile-apibase" placeholder="https://api.openai.com/v1" value="${escapeHtml(draft.apiBase || '')}">
        </div>
        <div class="settings-inline-note">
          这里不开放模型 ID 编辑。Codex 仍使用上方“默认模型”以及会话内的模型切换逻辑，只把 API 入口和密钥切换到当前 Profile。
        </div>
        <div class="settings-actions">
          <button class="btn-save" id="codex-profile-ok">确定</button>
        </div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);

      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#codex-profile-modal-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

      modal.querySelector('#codex-profile-ok').addEventListener('click', () => {
        const name = modal.querySelector('#codex-profile-name').value.trim();
        const apiKey = modal.querySelector('#codex-profile-apikey').value.trim();
        const apiBase = modal.querySelector('#codex-profile-apibase').value.trim();
        if (!name) {
          alert('请填写 Profile 名称');
          return;
        }
        if (!apiKey) {
          alert('请填写 API Key');
          return;
        }
        if (!apiBase) {
          alert('请填写 API Base URL');
          return;
        }
        const existing = codexEditingProfiles.find((profile) => profile.name === name);
        if (existing && existing !== current) {
          alert('Profile 名称已存在');
          return;
        }
        if (current) {
          current.name = name;
          current.apiKey = apiKey;
          current.apiBase = apiBase;
        } else {
          codexEditingProfiles.push({ name, apiKey, apiBase });
        }
        codexActiveProfile = name;
        closeModal();
        renderCodexProfileArea();
      });
    }

    _onCodexConfig = (config) => {
      currentCodexConfig = config || {};
      codexModeSelect.value = currentCodexConfig.mode || 'local';
      codexEditingProfiles = (currentCodexConfig.profiles || []).map((profile) => ({ ...profile }));
      codexActiveProfile = currentCodexConfig.activeProfile || (codexEditingProfiles[0]?.name || '');
      renderCodexProfileArea();
    };

    codexModeSelect.addEventListener('change', renderCodexProfileArea);

    codexSaveBtn.addEventListener('click', () => {
      if (codexModeSelect.value === 'custom' && codexEditingProfiles.length === 0) {
        showCodexStatus('自定义模式至少需要一个 Codex Profile', 'error');
        return;
      }
      const config = {
        mode: codexModeSelect.value,
        activeProfile: codexActiveProfile,
        profiles: codexEditingProfiles,
        enableSearch: false,
      };
      send({ type: 'save_codex_config', config });
      showCodexStatus('已保存', 'success');
    });

    pwOpenModalBtn.addEventListener('click', openPasswordModal);

    checkUpdateBtn.addEventListener('click', () => {
      updateStatusEl.textContent = '正在检查...';
      updateStatusEl.className = 'settings-status';
      _onUpdateInfo = (info) => {
        _onUpdateInfo = null;
        if (info.error) {
          updateStatusEl.textContent = '检查失败: ' + info.error;
          updateStatusEl.className = 'settings-status error';
          return;
        }
        if (info.hasUpdate) {
          updateStatusEl.innerHTML = `有新版本 <strong>v${escapeHtml(info.latestVersion)}</strong>（当前 v${escapeHtml(info.localVersion)}）&nbsp;<a href="${escapeHtml(info.releaseUrl)}" target="_blank" style="color:var(--accent)">查看更新</a>`;
          updateStatusEl.className = 'settings-status success';
        } else {
          updateStatusEl.textContent = `已是最新版本 v${info.localVersion}`;
          updateStatusEl.className = 'settings-status success';
        }
      };
      send({ type: 'check_update' });
    });

    window._ccOnUpdateInfo = (info) => { if (_onUpdateInfo) _onUpdateInfo(info); };

    closeBtn.addEventListener('click', hideSettingsPanel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) hideSettingsPanel(); });
    document.addEventListener('keydown', _settingsEscape);
  }

  function showSettingsPanel() {
    if (currentAgent === 'codex') {
      showCodexSettingsPanel();
      return;
    }
    // Request current configs (notify config is loaded on demand inside subpage)
    send({ type: 'get_model_config' });
    send({ type: 'get_notify_config' });

    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.id = 'settings-overlay';

    const panel = document.createElement('div');
    panel.className = 'settings-panel';

    panel.innerHTML = `
      <h3>
        ⚙ Claude 设置
        <button class="settings-close" title="关闭">&times;</button>
      </h3>

      <div class="settings-section-title">Claude 配置</div>
      <div class="settings-field">
        <label>配置模式</label>
        <select class="settings-select" id="model-mode">
          <option value="local">读取本地配置文件 (~/.claude.json)</option>
          <option value="custom">自定义配置</option>
        </select>
      </div>
      <div id="model-custom-area"></div>
      <div class="settings-actions" id="model-actions" style="display:none">
        <button class="btn-save" id="model-save-btn">保存模型配置</button>
      </div>
      <div class="settings-status" id="model-status"></div>

      <div class="settings-divider"></div>

      ${buildThemeEntryHtml()}

      <div class="settings-divider"></div>

      ${buildNotifyEntryHtml(null)}

      <div class="settings-divider"></div>

      <div class="settings-section-title">系统</div>
      <div class="settings-actions" style="margin-top:0;flex-wrap:wrap;gap:10px">
        <button class="btn-test" id="pw-open-modal-btn" style="padding:6px 16px">修改密码</button>
        <button class="btn-test" id="check-update-btn" style="padding:6px 16px">检查更新</button>
      </div>
      <div class="settings-status" id="update-status" style="margin-top:8px"></div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    const themePageBtn = panel.querySelector('[data-open-theme-page]');
    if (themePageBtn) themePageBtn.addEventListener('click', openThemeSubpage);
    const notifyPageBtn2 = panel.querySelector('[data-open-notify-page]');
    if (notifyPageBtn2) notifyPageBtn2.addEventListener('click', openNotifySubpage);

    // === Model Config UI ===
    const modelModeSelect = panel.querySelector('#model-mode');
    const modelCustomArea = panel.querySelector('#model-custom-area');
    const modelActionsDiv = panel.querySelector('#model-actions');
    const modelSaveBtn = panel.querySelector('#model-save-btn');
    const modelStatusDiv = panel.querySelector('#model-status');

    let modelCurrentConfig = null;
    let modelEditingTemplates = [];
    let modelActiveTemplate = '';

    function showModelStatus(msg, type) {
      modelStatusDiv.textContent = msg;
      modelStatusDiv.className = 'settings-status ' + (type || '');
    }

    function renderModelCustomArea() {
      if (modelModeSelect.value === 'local') {
        modelCustomArea.innerHTML = `<div class="settings-field" style="color:var(--text-warning, #e8a838);font-size:0.85em">⚠ 使用自定义模板会覆盖本地 API 配置，请提前做好备份。</div>`;
        modelActionsDiv.style.display = 'flex';
      } else {
        renderModelTemplateEditor();
        modelActionsDiv.style.display = 'flex';
      }
    }

    function renderModelTemplateEditor() {
      const activeName = modelActiveTemplate;
      const tpl = modelEditingTemplates.find(t => t.name === activeName) || null;
      const tplOptions = modelEditingTemplates.map(t =>
        `<option value="${escapeHtml(t.name)}" ${t.name === activeName ? 'selected' : ''}>${escapeHtml(t.name)}</option>`
      ).join('');

      if (modelEditingTemplates.length === 0) {
        modelCustomArea.innerHTML = `
          <div class="settings-field" style="color:var(--text-secondary);font-size:0.85em">尚无模板，点击下方按钮新建。</div>
          <div class="settings-actions" style="margin-top:0">
            <button class="btn-test" id="model-tpl-add-first">+ 新建模板</button>
          </div>
        `;
        panel.querySelector('#model-tpl-add-first').addEventListener('click', () => {
          const newName = prompt('输入新模板名称:');
          if (!newName || !newName.trim()) return;
          const n = newName.trim();
          modelEditingTemplates.push({ name: n, apiKey: '', apiBase: '', defaultModel: '', opusModel: '', sonnetModel: '', haikuModel: '' });
          modelActiveTemplate = n;
          renderModelTemplateEditor();
        });
        return;
      }

      modelCustomArea.innerHTML = `
        <div class="settings-field">
          <label>激活模板</label>
          <div style="display:flex;gap:6px;align-items:center">
            <select class="settings-select" id="model-tpl-select" style="flex:1">
              ${tplOptions}
              <option value="__new__">+ 新建模板</option>
            </select>
            <button class="btn-test" id="model-tpl-edit" style="padding:4px 10px">编辑</button>
            <button class="btn-test" id="model-tpl-del" title="删除" style="padding:4px 8px">删除</button>
          </div>
        </div>
      `;

      panel.querySelector('#model-tpl-select').addEventListener('change', (e) => {
        if (e.target.value === '__new__') {
          const newName = prompt('输入新模板名称:');
          if (!newName || !newName.trim()) { e.target.value = modelActiveTemplate; return; }
          const n = newName.trim();
          if (modelEditingTemplates.find(t => t.name === n)) { alert('模板名称已存在'); e.target.value = modelActiveTemplate; return; }
          modelEditingTemplates.push({ name: n, apiKey: '', apiBase: '', defaultModel: '', opusModel: '', sonnetModel: '', haikuModel: '' });
          modelActiveTemplate = n;
          renderModelTemplateEditor();
          openTplEditModal();
        } else {
          modelActiveTemplate = e.target.value;
          renderModelTemplateEditor();
        }
      });

      panel.querySelector('#model-tpl-edit').addEventListener('click', () => {
        openTplEditModal();
      });

      const delBtn = panel.querySelector('#model-tpl-del');
      if (delBtn) {
        delBtn.addEventListener('click', () => {
          if (!modelActiveTemplate) return;
          if (!confirm(`确认删除模板「${modelActiveTemplate}」?`)) return;
          modelEditingTemplates = modelEditingTemplates.filter(t => t.name !== modelActiveTemplate);
          modelActiveTemplate = modelEditingTemplates[0]?.name || '';
          renderModelTemplateEditor();
        });
      }
    }

    function openTplEditModal() {
      const tpl = modelEditingTemplates.find(t => t.name === modelActiveTemplate);
      if (!tpl) return;

      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>编辑模板: ${escapeHtml(tpl.name)}</h3>
          <button class="settings-close" id="tpl-modal-close">&times;</button>
        </div>
        <div class="settings-field">
          <label>模板名称</label>
          <input type="text" id="tpl-ed-name" value="${escapeHtml(tpl.name)}">
        </div>
        <div class="settings-field">
          <label>API Key</label>
          <input type="text" id="tpl-ed-apikey" placeholder="sk-ant-..." value="${escapeHtml(tpl.apiKey || '')}">
        </div>
        <div class="settings-field">
          <label>API Base URL</label>
          <input type="text" id="tpl-ed-apibase" placeholder="https://api.anthropic.com" value="${escapeHtml(tpl.apiBase || '')}">
        </div>

        <div class="settings-divider" style="margin:12px 0"></div>

        <div class="settings-field">
          <label style="display:flex;align-items:center;gap:8px;font-weight:600">
            获取上游模型列表
          </label>
          <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
            <label style="font-size:0.85em;display:flex;align-items:center;gap:4px;cursor:pointer">
              <input type="checkbox" id="tpl-ed-custom-endpoint"> 端点
            </label>
            <input type="text" id="tpl-ed-models-endpoint" placeholder="/v1/models" style="flex:1;display:none" value="">
          </div>
          <div style="display:flex;gap:6px;margin-top:6px;align-items:center">
            <button class="btn-test" id="tpl-ed-fetch-models" style="padding:4px 12px;white-space:nowrap">获取模型</button>
            <span id="tpl-ed-fetch-status" style="font-size:0.85em;color:var(--text-secondary)"></span>
          </div>
        </div>

        <div class="settings-divider" style="margin:12px 0"></div>

        <div class="settings-field">
          <label>默认模型 (ANTHROPIC_MODEL)</label>
          <input type="text" id="tpl-ed-default" list="tpl-dl-models" placeholder="claude-opus-4-6" value="${escapeHtml(tpl.defaultModel || '')}" autocomplete="off">
        </div>
        <div class="settings-field">
          <label>Opus 模型名</label>
          <input type="text" id="tpl-ed-opus" list="tpl-dl-models" placeholder="claude-opus-4-6" value="${escapeHtml(tpl.opusModel || '')}" autocomplete="off">
        </div>
        <div class="settings-field">
          <label>Sonnet 模型名</label>
          <input type="text" id="tpl-ed-sonnet" list="tpl-dl-models" placeholder="claude-sonnet-4-6" value="${escapeHtml(tpl.sonnetModel || '')}" autocomplete="off">
        </div>
        <div class="settings-field">
          <label>Haiku 模型名</label>
          <input type="text" id="tpl-ed-haiku" list="tpl-dl-models" placeholder="claude-haiku-4-5-20251001" value="${escapeHtml(tpl.haikuModel || '')}" autocomplete="off">
        </div>
        <datalist id="tpl-dl-models"></datalist>
        <div class="settings-actions">
          <button class="btn-save" id="tpl-ed-ok">确定</button>
        </div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);

      // Custom endpoint checkbox toggle
      const customEndpointCb = modal.querySelector('#tpl-ed-custom-endpoint');
      const endpointInput = modal.querySelector('#tpl-ed-models-endpoint');
      customEndpointCb.addEventListener('change', () => {
        endpointInput.style.display = customEndpointCb.checked ? '' : 'none';
      });

      // Fetch models
      const fetchBtn = modal.querySelector('#tpl-ed-fetch-models');
      const fetchStatus = modal.querySelector('#tpl-ed-fetch-status');
      const datalist = modal.querySelector('#tpl-dl-models');

      fetchBtn.addEventListener('click', () => {
        const apiBase = modal.querySelector('#tpl-ed-apibase').value.trim();
        const apiKey = modal.querySelector('#tpl-ed-apikey').value.trim();
        if (!apiBase || !apiKey) {
          fetchStatus.textContent = '请先填写 API Base 和 API Key';
          fetchStatus.style.color = 'var(--text-error, #e85d5d)';
          return;
        }
        const modelsEndpoint = customEndpointCb.checked ? endpointInput.value.trim() : '';
        fetchBtn.disabled = true;
        fetchStatus.textContent = '正在获取...';
        fetchStatus.style.color = 'var(--text-secondary)';

        _onFetchModelsResult = (result) => {
          _onFetchModelsResult = null;
          fetchBtn.disabled = false;
          if (result.success) {
            datalist.innerHTML = result.models.map(m => `<option value="${escapeHtml(m)}">`).join('');
            fetchStatus.textContent = `获取到 ${result.models.length} 个模型`;
            fetchStatus.style.color = 'var(--text-success, #5dbe5d)';
          } else {
            fetchStatus.textContent = result.message || '获取失败';
            fetchStatus.style.color = 'var(--text-error, #e85d5d)';
          }
        };

        send({ type: 'fetch_models', apiBase, apiKey, modelsEndpoint: modelsEndpoint || undefined, templateName: tpl.name });
      });

      const closeModal = () => {
        _onFetchModelsResult = null;
        document.body.removeChild(modalOverlay);
      };
      modal.querySelector('#tpl-modal-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

      modal.querySelector('#tpl-ed-ok').addEventListener('click', () => {
        const newName = modal.querySelector('#tpl-ed-name').value.trim();
        if (newName && newName !== tpl.name) {
          if (modelEditingTemplates.find(t => t.name === newName && t !== tpl)) { alert('模板名称已存在'); return; }
          tpl.name = newName;
          modelActiveTemplate = newName;
        }
        tpl.apiKey = modal.querySelector('#tpl-ed-apikey').value.trim();
        tpl.apiBase = modal.querySelector('#tpl-ed-apibase').value.trim();
        tpl.defaultModel = modal.querySelector('#tpl-ed-default').value.trim();
        tpl.opusModel = modal.querySelector('#tpl-ed-opus').value.trim();
        tpl.sonnetModel = modal.querySelector('#tpl-ed-sonnet').value.trim();
        tpl.haikuModel = modal.querySelector('#tpl-ed-haiku').value.trim();
        closeModal();
        renderModelTemplateEditor();
      });
    }

    function saveTplFields() {
      // Fields are now saved via modal, no inline fields to read
    }

    modelModeSelect.addEventListener('change', renderModelCustomArea);

    modelSaveBtn.addEventListener('click', () => {
      if (modelModeSelect.value === 'custom') saveTplFields();
      const config = {
        mode: modelModeSelect.value,
        activeTemplate: modelActiveTemplate,
        templates: modelEditingTemplates,
      };
      send({ type: 'save_model_config', config });
      showModelStatus('已保存', 'success');
    });

    _onModelConfig = (config) => {
      modelCurrentConfig = config;
      modelEditingTemplates = (config.templates || []).map(t => Object.assign({}, t));
      modelActiveTemplate = config.activeTemplate || (modelEditingTemplates[0]?.name || '');
      modelModeSelect.value = config.mode || 'local';
      renderModelCustomArea();
    };

    // === Notify Config UI (moved to subpage) ===
    // notify config is handled by openNotifySubpage()

    const closeBtn = panel.querySelector('.settings-close');
    const pwOpenModalBtn = panel.querySelector('#pw-open-modal-btn');
    pwOpenModalBtn.addEventListener('click', openPasswordModal);

    // Check update button
    const checkUpdateBtn = panel.querySelector('#check-update-btn');
    const updateStatusEl = panel.querySelector('#update-status');
    let _onUpdateInfo = null;
    checkUpdateBtn.addEventListener('click', () => {
      updateStatusEl.textContent = '正在检查...';
      updateStatusEl.className = 'settings-status';
      _onUpdateInfo = (info) => {
        _onUpdateInfo = null;
        if (info.error) {
          updateStatusEl.textContent = '检查失败: ' + info.error;
          updateStatusEl.className = 'settings-status error';
          return;
        }
        if (info.hasUpdate) {
          updateStatusEl.innerHTML = `有新版本 <strong>v${escapeHtml(info.latestVersion)}</strong>（当前 v${escapeHtml(info.localVersion)}）&nbsp;<a href="${escapeHtml(info.releaseUrl)}" target="_blank" style="color:var(--accent)">查看更新</a>`;
          updateStatusEl.className = 'settings-status success';
        } else {
          updateStatusEl.textContent = `已是最新版本 v${info.localVersion}`;
          updateStatusEl.className = 'settings-status success';
        }
      };
      send({ type: 'check_update' });
    });

    // Wire _onUpdateInfo into WS handler via closure
    const _origOnUpdateInfo = window._ccOnUpdateInfo;
    window._ccOnUpdateInfo = (info) => { if (_onUpdateInfo) _onUpdateInfo(info); };

    closeBtn.addEventListener('click', hideSettingsPanel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) hideSettingsPanel(); });

    document.addEventListener('keydown', _settingsEscape);
  }

  function hideSettingsPanel() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay) overlay.remove();
    document.querySelectorAll('.settings-subpage-overlay').forEach((node) => node.remove());
    _onNotifyConfig = null;
    _onNotifyTestResult = null;
    _onModelConfig = null;
    _onCodexConfig = null;
    _onFetchModelsResult = null;
    window._ccOnUpdateInfo = null;
    document.removeEventListener('keydown', _settingsEscape);
  }

  function _settingsEscape(e) {
    if (e.key === 'Escape') hideSettingsPanel();
  }

  if (settingsBtn) {
    settingsBtn.addEventListener('click', showSettingsPanel);
  }

  // --- Force Change Password ---
  function showForceChangePassword() {
    const overlay = document.createElement('div');
    overlay.className = 'force-change-overlay';
    overlay.id = 'force-change-overlay';

    const panel = document.createElement('div');
    panel.className = 'force-change-panel';

    panel.innerHTML = `
      <div class="login-logo">CC</div>
      <h2>修改初始密码</h2>
      <p>首次登录需要设置新密码</p>
      <div class="force-change-form">
        <input type="password" id="fc-new-pw" placeholder="新密码" autocomplete="new-password">
        <div class="password-hint" id="fc-hint">至少 8 位，包含大写/小写/数字/特殊字符中的 2 种</div>
        <input type="password" id="fc-confirm-pw" placeholder="确认新密码" autocomplete="new-password">
        <button id="fc-submit-btn" class="fc-submit-btn" disabled>确认修改</button>
        <div class="fc-status" id="fc-status"></div>
      </div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const newPwInput = panel.querySelector('#fc-new-pw');
    const confirmPwInput = panel.querySelector('#fc-confirm-pw');
    const hintEl = panel.querySelector('#fc-hint');
    const submitBtn = panel.querySelector('#fc-submit-btn');
    const statusEl = panel.querySelector('#fc-status');

    function checkStrength() {
      const pw = newPwInput.value;
      const confirm = confirmPwInput.value;
      if (!pw) {
        hintEl.textContent = '至少 8 位，包含大写/小写/数字/特殊字符中的 2 种';
        hintEl.className = 'password-hint';
        submitBtn.disabled = true;
        return;
      }
      const result = clientValidatePassword(pw);
      if (!result.valid) {
        hintEl.textContent = result.message;
        hintEl.className = 'password-hint error';
        submitBtn.disabled = true;
        return;
      }
      hintEl.textContent = '密码强度符合要求';
      hintEl.className = 'password-hint success';
      submitBtn.disabled = !confirm || confirm !== pw;
    }

    newPwInput.addEventListener('input', checkStrength);
    confirmPwInput.addEventListener('input', checkStrength);

    submitBtn.addEventListener('click', () => {
      const newPw = newPwInput.value;
      const confirmPw = confirmPwInput.value;
      if (newPw !== confirmPw) {
        statusEl.textContent = '两次密码不一致';
        statusEl.className = 'fc-status error';
        return;
      }
      submitBtn.disabled = true;
      statusEl.textContent = '正在修改...';
      statusEl.className = 'fc-status';
      send({ type: 'change_password', currentPassword: loginPasswordValue || localStorage.getItem('cc-web-pw') || '', newPassword: newPw });
    });

    newPwInput.focus();
  }

  function hideForceChangePassword() {
    const overlay = document.getElementById('force-change-overlay');
    if (overlay) overlay.remove();
  }

  function clientValidatePassword(pw) {
    if (!pw || pw.length < 8) {
      return { valid: false, message: '密码长度至少 8 位' };
    }
    let types = 0;
    if (/[a-z]/.test(pw)) types++;
    if (/[A-Z]/.test(pw)) types++;
    if (/[0-9]/.test(pw)) types++;
    if (/[^a-zA-Z0-9]/.test(pw)) types++;
    if (types < 2) {
      return { valid: false, message: '需包含至少 2 种字符类型（大写/小写/数字/特殊字符）' };
    }
    return { valid: true, message: '' };
  }

  // --- Password Changed Handler ---
  let _onPasswordChanged = null;

  function handlePasswordChanged(msg) {
    if (msg.success) {
      // Update token
      authToken = msg.token;
      localStorage.setItem('cc-web-token', msg.token);
      // Update remembered password
      if (localStorage.getItem('cc-web-pw')) {
        // Clear old remembered password since it's changed
        localStorage.removeItem('cc-web-pw');
      }

      // If force-change overlay is open, close it and load sessions
      const fcOverlay = document.getElementById('force-change-overlay');
      if (fcOverlay) {
        hideForceChangePassword();
        syncViewForAgent(currentAgent, { preserveCurrent: false, loadLast: true });
        showToast('密码修改成功');
      }

      // If settings panel change password
      if (_onPasswordChanged) {
        _onPasswordChanged({ success: true, message: msg.message });
        _onPasswordChanged = null;
      }
    } else {
      // Force-change error
      const fcStatus = document.querySelector('#fc-status');
      if (fcStatus) {
        fcStatus.textContent = msg.message || '修改失败';
        fcStatus.className = 'fc-status error';
        const btn = document.querySelector('#fc-submit-btn');
        if (btn) btn.disabled = false;
      }

      // Settings panel error
      if (_onPasswordChanged) {
        _onPasswordChanged({ success: false, message: msg.message });
        _onPasswordChanged = null;
      }
    }
  }

  // --- New Session Modal ---
  let _onCwdSuggestions = null;

  function showNewSessionModal() {
    const targetAgent = currentAgent;
    const targetLabel = AGENT_LABELS[targetAgent] || AGENT_LABELS.claude;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'new-session-overlay';

    overlay.innerHTML = `
      <div class="modal-panel">
        <div class="modal-header">
          <span class="modal-title">新建 ${escapeHtml(targetLabel)} 会话</span>
          <button class="modal-close-btn" id="ns-close-btn">✕</button>
        </div>
        <div class="modal-body">
          ${buildAgentContextCard(targetAgent, `当前将在 ${targetLabel} 区创建会话`, `新会话会直接进入 ${targetLabel} 模块，并只出现在 ${targetLabel} 会话列表中。`)}
          <div class="modal-stack">
            <div>
              <label class="modal-field-label" for="ns-cwd-input">工作目录</label>
              <div class="modal-field-row">
                <input type="text" id="ns-cwd-input" class="modal-text-input" placeholder="例如 /home/user/project" list="ns-cwd-list" autocomplete="off">
                <datalist id="ns-cwd-list"></datalist>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn-secondary" id="ns-cancel-btn">取消</button>
          <button class="modal-btn-primary" id="ns-create-btn">创建</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const cwdInput = overlay.querySelector('#ns-cwd-input');
    const cwdList = overlay.querySelector('#ns-cwd-list');

    // Fetch suggestions on focus
    cwdInput.addEventListener('focus', () => {
      _onCwdSuggestions = (paths) => {
        cwdList.innerHTML = paths.map(p => `<option value="${escapeHtml(p)}"></option>`).join('');
      };
      send({ type: 'list_cwd_suggestions' });
    });

    function close() {
      overlay.remove();
      _onCwdSuggestions = null;
    }

    overlay.querySelector('#ns-close-btn').addEventListener('click', close);
    overlay.querySelector('#ns-cancel-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    overlay.querySelector('#ns-create-btn').addEventListener('click', () => {
      const cwd = cwdInput.value.trim() || null;
      close();
      send({ type: 'new_session', cwd, agent: targetAgent, mode: currentMode });
    });

    cwdInput.focus();
  }

  // --- Import Native Session Modal ---
  let _onNativeSessions = null;

  function showImportSessionModal() {
    if (currentAgent !== 'claude') return;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'import-session-overlay';

    overlay.innerHTML = `
      <div class="modal-panel modal-panel-wide">
        <div class="modal-header">
          <span class="modal-title">导入本地 CLI 会话</span>
          <button class="modal-close-btn" id="is-close-btn">✕</button>
        </div>
        <div class="modal-body" id="is-body">
          ${buildAgentContextCard('claude', '从 Claude 原生历史导入', '读取 ~/.claude/projects/ 下的会话文件，恢复对话文本与工具调用，并保留 Claude 侧续接上下文。')}
          <div class="modal-loading">正在加载…</div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
      _onNativeSessions = null;
    }

    overlay.querySelector('#is-close-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    _onNativeSessions = (groups) => {
      const body = overlay.querySelector('#is-body');
      if (!body) return;
      if (!groups || groups.length === 0) {
        body.innerHTML = `${buildAgentContextCard('claude', '从 Claude 原生历史导入', '读取 ~/.claude/projects/ 下的会话文件，恢复对话文本与工具调用，并保留 Claude 侧续接上下文。')}<div class="modal-empty">未找到本地 CLI 会话</div>`;
        return;
      }
      body.innerHTML = buildAgentContextCard('claude', '从 Claude 原生历史导入', '读取 ~/.claude/projects/ 下的会话文件，恢复对话文本与工具调用，并保留 Claude 侧续接上下文。');
      for (const group of groups) {
        const groupEl = document.createElement('div');
        groupEl.className = 'import-group';
        // Convert slug dir to readable path
        let readablePath = group.dir.replace(/-/g, '/');
        if (!readablePath.startsWith('/')) readablePath = '/' + readablePath;
        readablePath = readablePath.replace(/\/+/g, '/');
        const groupTitle = document.createElement('div');
        groupTitle.className = 'import-group-title';
        groupTitle.textContent = readablePath;
        groupEl.appendChild(groupTitle);
        for (const sess of group.sessions) {
          const item = document.createElement('div');
          item.className = 'import-item';
          const info = document.createElement('div');
          info.className = 'import-item-info';
          const titleEl = document.createElement('div');
          titleEl.className = 'import-item-title';
          titleEl.textContent = sess.title;
          const meta = document.createElement('div');
          meta.className = 'import-item-meta';
          const cwdText = sess.cwd ? sess.cwd : '';
          const timeText = sess.updatedAt ? timeAgo(sess.updatedAt) : '';
          meta.textContent = [cwdText, timeText].filter(Boolean).join(' · ');
          info.appendChild(titleEl);
          info.appendChild(meta);
          const btn = document.createElement('button');
          btn.className = 'import-item-btn';
          btn.textContent = sess.alreadyImported ? '重新导入' : '导入';
          btn.addEventListener('click', () => {
            if (sess.alreadyImported) {
              if (!confirm('已导入过此会话，重新导入将覆盖已有内容。确认继续？')) return;
            } else {
              if (!confirm('由于 cc-web 与本地 CLI 的逻辑不同，导入会话需要解析后方可展示，导入后将覆盖已有内容。确认继续？')) return;
            }
            close();
            send({ type: 'import_native_session', sessionId: sess.sessionId, projectDir: group.dir });
          });
          item.appendChild(info);
          item.appendChild(btn);
          groupEl.appendChild(item);
        }
        body.appendChild(groupEl);
      }
    };

    send({ type: 'list_native_sessions' });
  }

  function showImportCodexSessionModal() {
    if (currentAgent !== 'codex') return;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'import-codex-session-overlay';

    overlay.innerHTML = `
      <div class="modal-panel modal-panel-wide">
        <div class="modal-header">
          <span class="modal-title">导入本地 Codex 会话</span>
          <button class="modal-close-btn" id="ics-close-btn">✕</button>
        </div>
        <div class="modal-body" id="ics-body">
          ${buildAgentContextCard('codex', '从 Codex rollout 历史导入', '读取 ~/.codex/sessions/ 下的 rollout 文件，恢复用户消息、助手输出、函数调用和 token 统计。')}
          <div class="modal-loading">正在加载 Codex 本地历史…</div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
      _onCodexSessions = null;
    }

    overlay.querySelector('#ics-close-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    _onCodexSessions = (items) => {
      const body = overlay.querySelector('#ics-body');
      if (!body) return;
      if (!items || items.length === 0) {
        body.innerHTML = `${buildAgentContextCard('codex', '从 Codex rollout 历史导入', '读取 ~/.codex/sessions/ 下的 rollout 文件，恢复用户消息、助手输出、函数调用和 token 统计。')}<div class="modal-empty">未找到本地 Codex 会话</div>`;
        return;
      }

      body.innerHTML = buildAgentContextCard('codex', '从 Codex rollout 历史导入', '读取 ~/.codex/sessions/ 下的 rollout 文件，恢复用户消息、助手输出、函数调用和 token 统计。');
      items.forEach((sess) => {
        const item = document.createElement('div');
        item.className = 'import-item';

        const info = document.createElement('div');
        info.className = 'import-item-info';

        const titleEl = document.createElement('div');
        titleEl.className = 'import-item-title';
        titleEl.textContent = sess.title || sess.threadId;

        const meta = document.createElement('div');
        meta.className = 'import-item-meta';
        meta.textContent = [
          sess.cwd || '',
          sess.source ? `source:${sess.source}` : '',
          sess.updatedAt ? timeAgo(sess.updatedAt) : '',
        ].filter(Boolean).join(' · ');

        const tags = document.createElement('div');
        tags.className = 'import-item-tags';
        if (sess.cliVersion) {
          const ver = document.createElement('span');
          ver.className = 'import-item-tag';
          ver.textContent = `CLI ${sess.cliVersion}`;
          tags.appendChild(ver);
        }
        if (sess.source) {
          const source = document.createElement('span');
          source.className = 'import-item-tag';
          source.textContent = sess.source;
          tags.appendChild(source);
        }

        info.appendChild(titleEl);
        info.appendChild(meta);
        if (tags.children.length > 0) info.appendChild(tags);

        const btn = document.createElement('button');
        btn.className = 'import-item-btn';
        btn.textContent = sess.alreadyImported ? '重新导入' : '导入';
        btn.addEventListener('click', () => {
          const confirmed = sess.alreadyImported
            ? confirm('已导入过此 Codex 会话，重新导入将覆盖已有内容。确认继续？')
            : confirm('将解析本地 Codex rollout 历史并导入当前 Web 视图。确认继续？');
          if (!confirmed) return;
          close();
          send({ type: 'import_codex_session', threadId: sess.threadId, rolloutPath: sess.rolloutPath });
        });

        item.appendChild(info);
        item.appendChild(btn);
        body.appendChild(item);
      });
    };

    send({ type: 'list_codex_sessions' });
  }

  // --- Helpers ---
  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins}分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}天前`;
    return new Date(dateStr).toLocaleDateString('zh-CN');
  }

  // --- Init ---
  applyTheme(currentTheme);
  setCurrentAgent(currentAgent);
  renderSessionList();
  connect();
  window.addEventListener('resize', updateCwdBadge);

  // Register Service Worker for mobile push notifications
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Restore remembered password
  const savedPw = localStorage.getItem('cc-web-pw');
  if (savedPw) {
    loginPassword.value = savedPw;
    rememberPw.checked = true;
  }

  // Visibility change: re-sync state when user returns to tab (critical for mobile)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!ws || ws.readyState > 1) {
      // WS is dead, force reconnect
      connect();
    } else if (ws.readyState === 1 && currentSessionId) {
      // Preserve active streaming UI when returning to foreground.
      if (isGenerating || currentSessionRunning) {
        send({ type: 'load_session', sessionId: currentSessionId });
      } else {
        beginSessionSwitch(currentSessionId, { blocking: false, force: true });
      }
    }
  });

  if (!authToken) {
    loginOverlay.hidden = false;
    app.hidden = true;
  } else {
    loginOverlay.hidden = true;
    app.hidden = false;
  }
})();
