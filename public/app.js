/**
 * cc-web 前端客户端（约 5175 行，单文件 IIFE）。
 *
 * 顶层组织（区间为近似值，随重构漂移）：
 *   1-141     常量 + 全局状态 + DOM 缓存
 *   160-634   主题 / 通知子页 / Dev 子页（GitHub repos + SSH hosts）
 *   636-798   session LRU 缓存
 *   799-1043  附件与图片上传
 *   1044-1448 agent/session 视图切换 + marked/hljs 配置
 *   1449-1870 socket 通信 + handleServerMessage（30 case 无 default）
 *   1870-2500 流式渲染（flushRender / renderMarkdown / createMsgElement）
 *             + tool 渲染（command_execution/reasoning/file_change/mcp_tool_call/AskUserQuestion 分流）
 *   2500-2700 Goal 状态机 + 系统消息 + 错误
 *   2700-2960 session 列表 + 侧栏手势
 *   2960-3140 斜杠菜单 + Model/Mode picker
 *   3140-3220 sendMessage
 *   3691-4453 设置面板（含模板编辑 / Codex Profile / Claude 本地配置 modal）
 *   4659-5100 新建会话 modal + Native/Codex 导入 modal
 *
 * 协议契约：服务端→客户端 30 个 type 在 handleServerMessage 处理；
 * 客户端→服务端消息见 server.js switch + auth 分支（共 31 type）。
 * 详见 docs/PROTOCOL.md。
 *
 * 安全注意：renderMarkdown 经 DOMPurify sanitize + decorateCodeBlocks DOM API 注入受信任 UI。
 * 详细架构与契约见 docs/。
 */
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
    { cmd: '/init', desc: '生成/更新 Agent 指南文件' },
    { cmd: '/goal', desc: '建立并持续维护目标' },
    { cmd: '/loop', desc: '定期执行提示（如 /loop 10m 检查状态）' },
    { cmd: '/github', desc: 'GitHub 操作（读取开发者配置后执行）' },
    { cmd: '/ssh', desc: 'SSH 远程操作（读取开发者配置后执行）' },
    { cmd: '/cf', desc: 'Cloudflare API 操作（读取开发者配置后执行）' },
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
    { value: 'opus', label: 'Opus', desc: '最强大，1M 上下文' },
    { value: 'sonnet', label: 'Sonnet', desc: '平衡性能，1M 上下文' },
    { value: 'haiku', label: 'Haiku', desc: '最快速，适合简单任务' },
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
  let groups = []; // [{ id, name }] 分组列表（服务端 group_list 同步）
  // 收起的分组（含 ''=未分组）：localStorage 记忆，点击组头切换
  const COLLAPSED_GROUPS_KEY = 'cc-web-collapsed-groups';
  let collapsedGroups = new Set(JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) || '[]'));
  function toggleGroupCollapse(groupKey) {
    if (collapsedGroups.has(groupKey)) collapsedGroups.delete(groupKey);
    else collapsedGroups.add(groupKey);
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...collapsedGroups]));
    renderSessionList();
  }
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
  // /goal awareness (B+)
  const sessionGoalState = new Map(); // sessionId -> { active, turns, lastFeedback }
  const SESSION_GOAL_STATE_CAP = 100;
  let pendingGoalForNewSession = null;
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
  // 区分首次 auth 成功 vs WS 重连后的 auth 成功：
  // 仅首次才触发整区会话加载 + scrollToBottom，避免重连打断用户阅读
  let hasInitialAuthCompleted = false;

  // --- DOM ---
  const $ = (sel) => document.querySelector(sel);
  const loginOverlay = $('#login-overlay');
  const loginForm = $('#login-form');
  const loginPassword = $('#login-password');
  const loginError = $('#login-error');
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
  const addGroupBtn = $('#add-group-btn');
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

  function openDevSettingsSubpage() {
    send({ type: 'get_dev_config' });
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay settings-subpage-overlay';
    overlay.id = 'dev-settings-subpage';
    const panel = document.createElement('div');
    panel.className = 'settings-panel';
    panel.innerHTML = `
      <div class="settings-header">
        <h3>开发者设置</h3>
        <button class="settings-close" id="dev-close">&times;</button>
      </div>
      <div class="settings-section-title">GitHub</div>
      <div class="settings-field">
        <label>Token</label>
        <input type="text" id="dev-github-token" placeholder="ghp_..." value="">
      </div>
      <div id="dev-github-repos"></div>
      <div class="settings-actions" style="margin-top:0;gap:8px">
        <button class="btn-test" id="dev-repo-add" style="padding:4px 12px">+ 添加仓库</button>
      </div>
      <div class="settings-divider"></div>
      <div class="settings-section-title">SSH 主机</div>
      <div id="dev-ssh-hosts"></div>
      <div class="settings-actions" style="margin-top:0;gap:8px">
        <button class="btn-test" id="dev-host-add" style="padding:4px 12px">+ 添加主机</button>
      </div>
      <div class="settings-divider"></div>
      <div class="settings-section-title">Cloudflare</div>
      <div class="settings-field">
        <label>API Token</label>
        <input type="password" id="dev-cf-token" placeholder="已保存的 Token（输入新值以覆盖）" value="">
      </div>
      <div id="dev-cf-zones"></div>
      <div class="settings-actions" style="margin-top:0;gap:8px">
        <button class="btn-test" id="dev-zone-add" style="padding:4px 12px">+ 添加域名</button>
      </div>
      <div class="settings-divider"></div>
      <div class="settings-actions">
        <button class="btn-save" id="dev-save-btn">保存开发者配置</button>
      </div>
      <div class="settings-status" id="dev-status"></div>
    `;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    const closeBtn = panel.querySelector('#dev-close');
    closeBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    let editingRepos = [];
    let editingHosts = [];
    let editingZones = [];

    function renderRepos() {
      const container = panel.querySelector('#dev-github-repos');
      if (editingRepos.length === 0) {
        container.innerHTML = '<div class="settings-inline-note">暂无仓库</div>';
        return;
      }
      container.innerHTML = editingRepos.map((repo, i) => `
        <div class="settings-field" style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>${escapeHtml(repo.name || '未命名')}</strong>
            <div style="display:flex;gap:4px">
              <button class="btn-test" data-repo-edit="${i}" style="padding:2px 8px">编辑</button>
              <button class="btn-test" data-repo-del="${i}" style="padding:2px 8px">删除</button>
            </div>
          </div>
          <div style="font-size:0.85em;color:var(--text-secondary);margin-top:4px">${escapeHtml(repo.url || '')} · ${escapeHtml(repo.branch || 'main')}${repo.notes ? ' · ' + escapeHtml(repo.notes) : ''}</div>
        </div>
      `).join('');
      container.querySelectorAll('[data-repo-edit]').forEach(btn => {
        btn.addEventListener('click', () => openRepoEditModal(parseInt(btn.dataset.repoEdit)));
      });
      container.querySelectorAll('[data-repo-del]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.repoDel);
          editingRepos.splice(idx, 1);
          renderRepos();
        });
      });
    }

    function openRepoEditModal(index = -1) {
      const existing = index >= 0 ? editingRepos[index] : null;
      const draft = existing || { id: '', name: '', url: '', branch: 'main', notes: '' };
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10002';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '440px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>${existing ? '编辑仓库' : '添加仓库'}</h3>
          <button class="settings-close" id="repo-modal-close">&times;</button>
        </div>
        <div class="settings-field"><label>名称</label><input type="text" id="repo-name" placeholder="cc-web" value="${escapeHtml(draft.name)}"></div>
        <div class="settings-field"><label>URL</label><input type="text" id="repo-url" placeholder="https://github.com/user/repo" value="${escapeHtml(draft.url)}"></div>
        <div class="settings-field"><label>分支</label><input type="text" id="repo-branch" placeholder="main" value="${escapeHtml(draft.branch || 'main')}"></div>
        <div class="settings-field"><label>备注</label><input type="text" id="repo-notes" placeholder="说明" value="${escapeHtml(draft.notes || '')}"></div>
        <div class="settings-actions"><button class="btn-save" id="repo-modal-ok">确定</button></div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#repo-modal-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#repo-modal-ok').addEventListener('click', () => {
        const name = modal.querySelector('#repo-name').value.trim();
        const url = modal.querySelector('#repo-url').value.trim();
        if (!name || !url) { alert('请填写名称和 URL'); return; }
        const data = {
          id: draft.id || '',
          name,
          url,
          branch: modal.querySelector('#repo-branch').value.trim() || 'main',
          notes: modal.querySelector('#repo-notes').value.trim(),
        };
        if (existing) {
          editingRepos[index] = data;
        } else {
          editingRepos.push(data);
        }
        closeModal();
        renderRepos();
      });
    }

    function renderHosts() {
      const container = panel.querySelector('#dev-ssh-hosts');
      if (editingHosts.length === 0) {
        container.innerHTML = '<div class="settings-inline-note">暂无 SSH 主机</div>';
        return;
      }
      container.innerHTML = editingHosts.map((host, i) => `
        <div class="settings-field" style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>${escapeHtml(host.name || '未命名')}</strong>
            <div style="display:flex;gap:4px">
              <button class="btn-test" data-host-edit="${i}" style="padding:2px 8px">编辑</button>
              <button class="btn-test" data-host-del="${i}" style="padding:2px 8px">删除</button>
            </div>
          </div>
          <div style="font-size:0.85em;color:var(--text-secondary);margin-top:4px">${escapeHtml(host.user || '')}@${escapeHtml(host.host || '')}:${host.port || 22} · ${(host.authType || 'key') === 'password' ? '密码认证' : '密钥认证'}${host.description ? ' · ' + escapeHtml(host.description) : ''}</div>
        </div>
      `).join('');
      container.querySelectorAll('[data-host-edit]').forEach(btn => {
        btn.addEventListener('click', () => openHostEditModal(parseInt(btn.dataset.hostEdit)));
      });
      container.querySelectorAll('[data-host-del]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.hostDel);
          editingHosts.splice(idx, 1);
          renderHosts();
        });
      });
    }

    function openHostEditModal(index = -1) {
      const existing = index >= 0 ? editingHosts[index] : null;
      const draft = existing || { id: '', name: '', host: '', port: 22, user: '', authType: 'key', identityFile: '', password: '', description: '' };
      const isKey = (draft.authType || 'key') === 'key';
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10002';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '440px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>${existing ? '编辑主机' : '添加主机'}</h3>
          <button class="settings-close" id="host-modal-close">&times;</button>
        </div>
        <div class="settings-field"><label>名称</label><input type="text" id="host-name" placeholder="主机01" value="${escapeHtml(draft.name)}"></div>
        <div class="settings-field"><label>地址</label><input type="text" id="host-host" placeholder="192.168.1.100" value="${escapeHtml(draft.host)}"></div>
        <div class="settings-field"><label>端口</label><input type="number" id="host-port" placeholder="22" value="${draft.port || 22}"></div>
        <div class="settings-field"><label>用户</label><input type="text" id="host-user" placeholder="root" value="${escapeHtml(draft.user)}"></div>
        <div class="settings-field">
          <label>认证方式</label>
          <div style="display:flex;gap:12px">
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer"><input type="radio" name="host-auth-type" value="key" ${isKey ? 'checked' : ''}> 密钥</label>
            <label style="display:flex;align-items:center;gap:4px;cursor:pointer"><input type="radio" name="host-auth-type" value="password" ${!isKey ? 'checked' : ''}> 密码</label>
          </div>
        </div>
        <div id="host-auth-key-field" class="settings-field" style="${isKey ? '' : 'display:none'}">
          <label>密钥路径</label><input type="text" id="host-identity" placeholder="~/.ssh/id_ed25519" value="${escapeHtml(draft.identityFile)}">
        </div>
        <div id="host-auth-pw-field" class="settings-field" style="${!isKey ? '' : 'display:none'}">
          <label>密码</label><input type="password" id="host-password" placeholder="SSH 登录密码" value="${escapeHtml(draft.password || '')}">
        </div>
        <div class="settings-field"><label>说明</label><input type="text" id="host-desc" placeholder="测试服务器" value="${escapeHtml(draft.description || '')}"></div>
        <div class="settings-actions"><button class="btn-save" id="host-modal-ok">确定</button></div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);

      // Toggle auth fields
      const keyField = modal.querySelector('#host-auth-key-field');
      const pwField = modal.querySelector('#host-auth-pw-field');
      modal.querySelectorAll('input[name="host-auth-type"]').forEach(radio => {
        radio.addEventListener('change', () => {
          const isKeyMode = radio.value === 'key' && radio.checked;
          keyField.style.display = isKeyMode ? '' : 'none';
          pwField.style.display = isKeyMode ? 'none' : '';
        });
      });

      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#host-modal-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#host-modal-ok').addEventListener('click', () => {
        const name = modal.querySelector('#host-name').value.trim();
        const host = modal.querySelector('#host-host').value.trim();
        if (!name || !host) { alert('请填写名称和地址'); return; }
        const authType = modal.querySelector('input[name="host-auth-type"]:checked')?.value || 'key';
        const data = {
          id: draft.id || '',
          name,
          host,
          port: parseInt(modal.querySelector('#host-port').value) || 22,
          user: modal.querySelector('#host-user').value.trim(),
          authType,
          identityFile: authType === 'key' ? modal.querySelector('#host-identity').value.trim() : '',
          password: authType === 'password' ? modal.querySelector('#host-password').value : '',
          description: modal.querySelector('#host-desc').value.trim(),
        };
        if (existing) {
          editingHosts[index] = data;
        } else {
          editingHosts.push(data);
        }
        closeModal();
        renderHosts();
      });
    }

    function renderZones() {
      const container = panel.querySelector('#dev-cf-zones');
      if (editingZones.length === 0) {
        container.innerHTML = '<div class="settings-inline-note">暂无域名</div>';
        return;
      }
      container.innerHTML = editingZones.map((zone, i) => `
        <div class="settings-field" style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>${escapeHtml(zone.name || '未命名')}</strong>
            <div style="display:flex;gap:4px">
              <button class="btn-test" data-zone-edit="${i}" style="padding:2px 8px">编辑</button>
              <button class="btn-test" data-zone-del="${i}" style="padding:2px 8px">删除</button>
            </div>
          </div>
          ${zone.notes ? `<div style="font-size:0.85em;color:var(--text-secondary);margin-top:4px">${escapeHtml(zone.notes)}</div>` : ''}
        </div>
      `).join('');
      container.querySelectorAll('[data-zone-edit]').forEach(btn => {
        btn.addEventListener('click', () => openZoneEditModal(parseInt(btn.dataset.zoneEdit)));
      });
      container.querySelectorAll('[data-zone-del]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.zoneDel);
          editingZones.splice(idx, 1);
          renderZones();
        });
      });
    }

    function openZoneEditModal(index = -1) {
      const existing = index >= 0 ? editingZones[index] : null;
      const draft = existing || { id: '', name: '', notes: '' };
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10002';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '440px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>${existing ? '编辑域名' : '添加域名'}</h3>
          <button class="settings-close" id="zone-modal-close">&times;</button>
        </div>
        <div class="settings-field"><label>域名</label><input type="text" id="zone-name" placeholder="example.com" value="${escapeHtml(draft.name)}"></div>
        <div class="settings-field"><label>备注</label><input type="text" id="zone-notes" placeholder="说明" value="${escapeHtml(draft.notes || '')}"></div>
        <div class="settings-actions"><button class="btn-save" id="zone-modal-ok">确定</button></div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#zone-modal-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#zone-modal-ok').addEventListener('click', () => {
        const name = modal.querySelector('#zone-name').value.trim();
        if (!name) { alert('请填写域名'); return; }
        const data = {
          id: draft.id || '',
          name,
          notes: modal.querySelector('#zone-notes').value.trim(),
        };
        if (existing) {
          editingZones[index] = data;
        } else {
          editingZones.push(data);
        }
        closeModal();
        renderZones();
      });
    }

    panel.querySelector('#dev-repo-add').addEventListener('click', () => openRepoEditModal());
    panel.querySelector('#dev-host-add').addEventListener('click', () => openHostEditModal());
    panel.querySelector('#dev-zone-add').addEventListener('click', () => openZoneEditModal());

    panel.querySelector('#dev-save-btn').addEventListener('click', () => {
      const token = panel.querySelector('#dev-github-token').value.trim();
      const cfToken = panel.querySelector('#dev-cf-token').value.trim();
      send({
        type: 'save_dev_config',
        config: {
          github: { token, repos: editingRepos },
          ssh: { hosts: editingHosts },
          cloudflare: { apiToken: cfToken, zones: editingZones },
        },
      });
      panel.querySelector('#dev-status').textContent = '已保存';
      panel.querySelector('#dev-status').className = 'settings-status success';
    });

    _onDevConfig = (config) => {
      panel.querySelector('#dev-github-token').value = config.github?.token || '';
      const cfTokenInput = panel.querySelector('#dev-cf-token');
      cfTokenInput.value = config.cloudflare?.apiToken || '';
      cfTokenInput.placeholder = config.cloudflare?.apiToken ? `已保存: ${config.cloudflare.apiToken}（保持不变请勿修改）` : '填写 Cloudflare API Token';
      editingRepos = (config.github?.repos || []).map(r => ({ ...r }));
      editingHosts = (config.ssh?.hosts || []).map(h => ({ ...h }));
      editingZones = (config.cloudflare?.zones || []).map(z => ({ ...z }));
      renderRepos();
      renderHosts();
      renderZones();
    };
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
      // 运行中会话的实时全量输出（仅服务端 session_info 携带；断线补齐守卫消费，见 case 'session_info'）
      activeOutput: typeof payload.activeOutput === 'string' ? payload.activeOutput : undefined,
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
      // 仅依赖持久 token：无 token 直接拒绝，不再用密码重登
      const savedToken = localStorage.getItem('cc-web-token');
      if (!savedToken) {
        reject(new Error('登录已过期，请重新登录后再上传图片。'));
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
        reject(new Error('登录已过期，请重新登录后再上传图片。'));
      };
      document.addEventListener('cc-web-auth-restored', onRestored);
      document.addEventListener('cc-web-auth-failed', onFailed);

      // WS 断开 → 重连（connect 内部会用持久 token 重新鉴权）
      if (!ws || ws.readyState > 1) {
        connect();
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

	  function _splitCodexThinkingModel(model) {
	    const raw = String(model || '').trim();
	    if (!raw) return { base: '', level: '' };
	    const m = raw.match(/^(.*)\(([^()]+)\)\s*$/);
	    if (!m) return { base: raw, level: '' };
	    return { base: (m[1] || '').trim(), level: (m[2] || '').trim().toLowerCase() };
	  }

	  function _parseCodexModelListText(text) {
	    const seen = new Set();
	    const models = [];
	    String(text || '')
	      .split(/\r?\n|,/)
	      .map((item) => item.trim())
	      .filter(Boolean)
	      .forEach((item) => {
	        if (seen.has(item)) return;
	        seen.add(item);
	        models.push(item);
	      });
	    return models;
	  }

	  function normalizeCodexProfile(profile) {
	    const normalized = {
	      name: String(profile?.name || '').trim(),
	      apiKey: String(profile?.apiKey || ''),
	      apiBase: String(profile?.apiBase || '').trim(),
	      model: String(profile?.model || '').trim(),
	      models: [],
	    };
	    const seen = new Set();
	    function addModel(value) {
	      const model = String(value || '').trim();
	      if (!model || seen.has(model)) return;
	      seen.add(model);
	      normalized.models.push(model);
	    }
	    if (Array.isArray(profile?.models)) profile.models.forEach(addModel);
	    addModel(normalized.model);
	    return normalized;
	  }

	  function getActiveCodexProfileConfig() {
	    const config = codexConfigCache || null;
	    if (!config || config.mode !== 'custom' || !config.activeProfile) return null;
	    const profile = (config.profiles || []).find((item) => item.name === config.activeProfile) || null;
	    return profile ? normalizeCodexProfile(profile) : null;
	  }

	  function getCodexBaseModelOptions() {
	    const seen = new Set();
	    const options = [];

	    function addOption(value, label, desc) {
	      const v = (value || '').trim();
	      if (!v || seen.has(v)) return;
	      seen.add(v);
	      options.push({ value: v, label: label || v, desc: desc || 'Codex 模型' });
	    }

	    function addBaseOption(value, label, desc) {
	      const { base } = _splitCodexThinkingModel(value);
	      addOption(base, label || base, desc);
	    }

	    const activeProfile = getActiveCodexProfileConfig();
	    const configuredModels = Array.isArray(activeProfile?.models) ? activeProfile.models : [];
	    configuredModels.forEach((model) => addBaseOption(model, model, 'Profile 已配置模型'));

	    return options;
	  }

  // --- marked config ---
  const PREVIEW_LANGS = new Set(['html', 'svg']);

  // 简化 renderer.code：仅输出纯 <pre><code>，按钮/iframe 由 decorateCodeBlocks 在
  // DOMPurify sanitize 之后通过 DOM API 注入（受信任代码不经过 sanitize）。
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
    return `<pre><code class="hljs language-${escapeHtml(lang)}" data-lang="${escapeHtml(lang)}">${highlighted}</code></pre>`;
  };
  marked.setOptions({ renderer, breaks: true, gfm: true });

  // 在 sanitize 之后通过 DOM API 装饰代码块：Copy/Preview 按钮 + 预览 iframe。
  // 幂等：每个 pre.ccweb-decorated 跳过，避免流式刷新重复装饰导致 iframe 状态丢失。
  // 闭包捕获当前 code 文本，不再用全局 cid Map（避免流式刷新产生废弃条目）。
  function decorateCodeBlocks(container) {
    if (!container) return;
    const nodes = container.querySelectorAll('pre > code.hljs:not([data-cc-decorated])');
    nodes.forEach((codeEl) => {
      codeEl.dataset.ccDecorated = '1';
      const pre = codeEl.parentElement;
      const lang = codeEl.dataset.lang || 'plaintext';
      const rawCode = codeEl.textContent;

      const wrapper = document.createElement('div');
      wrapper.className = 'code-block-wrapper';
      const canPreview = PREVIEW_LANGS.has(lang);
      if (canPreview) wrapper.classList.add('has-preview');

      const header = document.createElement('div');
      header.className = 'code-block-header';
      const langLabel = document.createElement('span');
      langLabel.textContent = lang;
      const actions = document.createElement('div');
      actions.className = 'code-block-actions';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'code-copy-btn';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(rawCode).then(() => {
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        });
      });
      actions.appendChild(copyBtn);

      let previewPane = null;
      let iframe = null;
      if (canPreview) {
        const previewBtn = document.createElement('button');
        previewBtn.type = 'button';
        previewBtn.className = 'code-preview-btn';
        previewBtn.textContent = 'Preview';
        previewBtn.addEventListener('click', () => {
          const inPreview = wrapper.classList.contains('preview-mode');
          if (inPreview) {
            wrapper.classList.remove('preview-mode');
            previewBtn.textContent = 'Preview';
          } else {
            if (iframe && !iframe.dataset.loaded) {
              iframe.srcdoc = rawCode;
              iframe.dataset.loaded = '1';
            }
            wrapper.classList.add('preview-mode');
            previewBtn.textContent = 'Source';
          }
        });
        actions.appendChild(previewBtn);

        previewPane = document.createElement('div');
        previewPane.className = 'code-preview-pane';
        iframe = document.createElement('iframe');
        iframe.className = 'code-preview-iframe';
        iframe.setAttribute('sandbox', 'allow-scripts');
        iframe.setAttribute('loading', 'lazy');
        previewPane.appendChild(iframe);
      }

      header.appendChild(langLabel);
      header.appendChild(actions);

      pre.parentElement.insertBefore(wrapper, pre);
      wrapper.appendChild(header);
      if (previewPane) wrapper.appendChild(previewPane);
      wrapper.appendChild(pre);
    });
  }

  // --- WebSocket ---
  function connect() {
    if (ws && ws.readyState <= 1) return;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      reconnectAttempts = 0;
      if (authToken) send({ type: 'auth', token: authToken });
      // B+: On (re)connect, drop optimistic /goal flags. Initial connect has empty state (no-op);
      // on reconnect this lets subsequent isRunning=false snapshots clear stale UI from before
      // we missed the pre-active → active session_list pair. Also clear any pending state for a
      // new session that may have been orphaned across the disconnect.
      for (const gs of sessionGoalState.values()) gs.optimistic = false;
      pendingGoalForNewSession = null;
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleServerMessage(msg);
    };

    ws.onclose = () => {
      clearSessionLoading();
      scheduleReconnect();
      showConnBanner();
    };
    ws.onerror = () => {};
  }

  function send(data) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
  }

  // 仅 OPEN 状态视为已连接（send() 对非 OPEN 静默丢弃，调用方需先守卫）
  function isWsConnected() {
    return !!(ws && ws.readyState === 1);
  }

  // 断线状态条（#conn-banner）：DOM 缺失时安全返回
  function showConnBanner() {
    const banner = document.getElementById('conn-banner');
    if (banner) banner.hidden = false;
  }

  function hideConnBanner() {
    const banner = document.getElementById('conn-banner');
    if (banner) banner.hidden = true;
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
  /**
   * 服务端→客户端消息分发（30 个 case，无 default）。
   *
   * 职责混合：鉴权 / 会话同步 / 流式渲染 / 配置同步 / Goal 状态机。
   * 完整 type 清单与契约见 docs/PROTOCOL.md "服务端 → 客户端"。
   *
   * @param {object} msg - { type, ...payload }
   */
  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'auth_result':
        if (msg.success) {
          hideConnBanner();  // 认证成功 = 连接可用
          authToken = msg.token;
          localStorage.setItem('cc-web-token', msg.token);
          document.dispatchEvent(new CustomEvent('cc-web-auth-restored'));
          loginOverlay.hidden = true;
          app.hidden = false;
          send({ type: 'get_codex_config' });
          // Check if must change password
          if (msg.mustChangePassword) {
            showForceChangePassword();
          } else if (!hasInitialAuthCompleted) {
            // 仅首次 auth 成功才触发整区会话加载；WS 重连不触发，保留用户滚动位置
            hasInitialAuthCompleted = true;
            pendingInitialSessionLoad = true;
          } else if (currentSessionId && (isGenerating || currentSessionRunning || document.getElementById('streaming-msg'))) {
            // WS 重连兜底：若当前会话仍有流式状态，主动 load_session 重新 attach entry.ws，
            // 确保后续 done/background_done 能正确送达（避免 entry.ws=null 导致状态卡死）
            send({ type: 'load_session', sessionId: currentSessionId });
          }
        } else {
          hideConnBanner();  // 认证失败：登录遮罩出现，状态条无意义
          authToken = null;
          localStorage.removeItem('cc-web-token');
          hasInitialAuthCompleted = false;  // auth 失败：重置首次加载状态，下次登录重新触发
          document.dispatchEvent(new CustomEvent('cc-web-auth-failed'));
          loginOverlay.hidden = false;
          app.hidden = true;
          if (msg.banned) {
            loginError.textContent = '该 IP 已被永久封禁';
            loginError.hidden = false;
            loginPassword.disabled = true;
            loginForm.querySelector('button[type="submit"]').disabled = true;
          } else {
            const reason = msg.reason;
            if (reason === 'invalid_password') {
              loginError.textContent = '密码错误';
            } else if (reason === 'session_expired') {
              loginError.textContent = '登录已过期，请重新登录';
            } else {
              loginError.textContent = '登录失败，请重新登录';
            }
            loginError.hidden = false;
          }
        }
        break;

      case 'session_list': {
        // 检测当前会话 isRunning 从 true→false 的转换（任务完成的兜底信号）
        const previousMeta = currentSessionId ? getSessionMeta(currentSessionId) : null;
        const wasServerRunning = !!previousMeta?.isRunning;
        const hadStreamingUi = !!(isGenerating || currentSessionRunning || document.getElementById('streaming-msg'));
        sessions = msg.sessions || [];
        reconcileSessionCacheWithSessions();
        renderSessionList();
        // B+: clear stale goal active flag for any session no longer running.
        // Skip optimistic states (still in "kicked off but not yet confirmed" window) so the
        // pre-activeProcesses.set session_list snapshot does not wipe a freshly-set goal.
        // Sessions seen as isRunning=true here are confirmed, so we drop optimistic for those —
        // this lets a later isRunning=false (after WS reconnect / task done while offline) clear them.
        for (const s of sessions) {
          if (!s) continue;
          const gs = sessionGoalState.get(s.id);
          if (!gs) continue;
          if (s.isRunning) gs.optimistic = false;
          else if (!gs.optimistic) gs.active = false;
        }
        if (currentSessionId) {
          const currentMeta = getSessionMeta(currentSessionId);
          const isServerRunning = !!currentMeta?.isRunning;
          setCurrentSessionRunningState(isServerRunning);
          // 兜底：服务端确认 isRunning 从 true→false 且前端仍在生成态，
          // 说明 done/background_done 因 WS detach 漏掉了。清除生成态并重新加载会话拿到完整输出。
          if (currentMeta && wasServerRunning && !isServerRunning && hadStreamingUi) {
            finishGenerating(currentSessionId);
            beginSessionSwitch(currentSessionId, { blocking: false, force: true });
          }
        }
        updateGoalBar();
        if (pendingInitialSessionLoad) {
          pendingInitialSessionLoad = false;
          syncViewForAgent(currentAgent, { preserveCurrent: false, loadLast: true });
        } else if (currentSessionId && !getSessionMeta(currentSessionId)) {
          resetChatView(currentAgent);
        }
        break;
      }

      case 'session_info':
        const snapshot = normalizeSessionSnapshot(msg);
        // 断线补齐前置判定：applySessionSnapshot 会改写 currentSessionId / isGenerating / pendingText，
        // 先按调用前状态捕获「本次快照是否保留流式」（条件与 applySessionSnapshot 内 preserveStreaming 同源）
        const snapshotKeepsStreaming = !!(msg.sessionId === currentSessionId && msg.isRunning && isGenerating);
        if (activeSessionLoad?.sessionId === msg.sessionId) {
          activeSessionLoad.snapshot = snapshot;
        }
        applySessionSnapshot(snapshot, {
          immediate: isBlockingSessionLoad(msg.sessionId),
          suppressUnreadToast: false,
          preserveStreaming: msg.sessionId === currentSessionId && msg.isRunning,
        });
        // 断线补齐：断线期间 text_delta 丢失会让流式气泡停留在残缺状态（黑洞）。
        // 服务端对运行中会话在 session_info 附带实时全量输出（activeOutput），
        // 仅当服务端内容比前端流式缓冲更长时整体覆盖（text_delta 为追加语义，
        // 覆盖后后续 delta 继续追加），绝不倒退前端已渲染内容。
        // 只在保留流式（重连/兜底补齐）场景生效，切会话等路径由 resume_generating 负责
        if (snapshotKeepsStreaming && typeof snapshot.activeOutput === 'string'
            && snapshot.activeOutput.length > (pendingText || '').length) {
          pendingText = snapshot.activeOutput;
          scheduleRender();
        }
        if (!msg.historyPending) {
          if (activeSessionLoad?.sessionId === msg.sessionId) {
            finalizeLoadedSession(msg.sessionId);
          } else {
            cacheSessionSnapshot(snapshot);
            finishSessionSwitch(msg.sessionId);
          }
        }
        // B+: transfer any pending /goal state to the freshly created session (via LRU helper)
        if (pendingGoalForNewSession && msg.sessionId) {
          setGoalState(msg.sessionId, pendingGoalForNewSession);
          pendingGoalForNewSession = null;
        }
        // B+: server confirms session is now running — drop optimistic flag so any future
        // isRunning=false snapshot (e.g. after a WS reconnect) can safely clear the bar.
        if (msg.isRunning === true) {
          const gs = sessionGoalState.get(msg.sessionId);
          if (gs) gs.optimistic = false;
        }
        // B+: if session is not running, clear stale goal active — but never clobber an optimistic
        // state that the user just kicked off (session_list may arrive before activeProcesses.set).
        if (msg.isRunning === false) {
          const gs = sessionGoalState.get(msg.sessionId);
          if (gs && !gs.optimistic) gs.active = false;
        }
        updateGoalBar();
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

      case 'group_list':
        groups = Array.isArray(msg.groups) ? msg.groups.filter((g) => g && g.id && g.name) : [];
        renderSessionList();
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
        if (!isGenerating || !document.getElementById('streaming-msg')) startGenerating();
        pendingText += msg.text;
        scheduleRender();
        break;

      case 'tool_start':
        if (!isGenerating || !document.getElementById('streaming-msg')) startGenerating();
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

      case 'system_message': {
        if (msg.kind === 'goal_feedback') {
          // Close the current streaming bubble so feedback appears between turns,
          // and let the next text_delta open a fresh assistant bubble.
          flushRender();
          const streamingMsg = document.getElementById('streaming-msg');
          if (streamingMsg) {
            streamingMsg.removeAttribute('id');
            streamingMsg.querySelectorAll('.typing-indicator').forEach((el) => el.remove());
          }
          const cleaned = (msg.message || '').replace(/^Stop hook feedback:\s*\n?/, '');
          appendSystemMessage(`◎ Goal · ${cleaned}`);
          if (currentSessionId) {
            const gs = getGoalState(currentSessionId);
            gs.active = true;
            gs.turns += 1;
            gs.lastFeedback = cleaned.slice(0, 200);
            gs.optimistic = false; // server-confirmed, no longer at risk of premature clear
            updateGoalBar();
          }
        } else {
          appendSystemMessage(msg.message);
        }
        break;
      }

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
        // B+: server-side reject (e.g. expired attachment) — drop any pending optimistic /goal state
        if (pendingGoalForNewSession) {
          pendingGoalForNewSession = null;
          updateGoalBar();
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

      case 'claude_local_config':
        if (typeof _onClaudeLocalConfig === 'function') _onClaudeLocalConfig(msg);
        break;

      case 'codex_local_config':
        if (typeof _onCodexLocalConfig === 'function') _onCodexLocalConfig(msg);
        break;

      case 'dev_config':
        if (typeof _onDevConfig === 'function') _onDevConfig(msg.config);
        break;

      case 'fetch_models_result':
        if (typeof _onFetchModelsResult === 'function') _onFetchModelsResult(msg);
        break;

      case 'background_done':
        // A background task completed (browser was disconnected or viewing another session)
        showToast(`「${msg.title}」任务完成`, msg.sessionId);
        showBrowserNotification(msg.title);
        // B+: process exited; done is authoritative — clear optimism too
        {
          const gs = sessionGoalState.get(msg.sessionId);
          if (gs) { gs.active = false; gs.optimistic = false; }
        }
        if (msg.sessionId === currentSessionId) {
          // Task completed for current session — clear generating state without reloading
          // (reloading would trigger scrollToBottom and interrupt user reading)
          finishGenerating(msg.sessionId);
        } else {
          // Task completed for background session — update cache + refresh session list
          updateCachedSession(msg.sessionId, (snapshot) => { snapshot.isRunning = false; });
          send({ type: 'list_sessions' });
        }
        updateGoalBar();
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
    // /goal: process exited, mark goal inactive (B+); done is authoritative — clear optimism too
    const goalSid = sessionId || currentSessionId;
    const goalState = goalSid ? sessionGoalState.get(goalSid) : null;
    if (goalState) {
      goalState.active = false;
      goalState.optimistic = false;
    }
    updateGoalBar();
  }

  // --- Rendering ---
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      flushRender();
    }, RENDER_DEBOUNCE);
  }

  // 不变量：操作 #streaming-msg 元素渲染流式输出，无元素时立即返回。
  function flushRender() {
    const streamEl = document.getElementById('streaming-msg');
    if (!streamEl) return;
    const bubble = streamEl.querySelector('.msg-bubble');
    if (!bubble) return;
    let textDiv = bubble.querySelector('.msg-text');
    if (!textDiv) { textDiv = bubble; }
    textDiv.innerHTML = renderMarkdown(pendingText);
    decorateCodeBlocks(textDiv);
    scrollToBottom();
  }

  // 不变量：marked.parse 输出经 DOMPurify sanitize 后返回。Copy/Preview 按钮 + 预览
  // iframe 由 decorateCodeBlocks 在 sanitize 之后通过 DOM API 注入（受信任代码）。
  // assistant 文本与 reasoning 均走此路径，输出进主文档（非沙箱 iframe）。
  // Fail-closed：DOMPurify 加载失败时降级为纯文本 escape，绝不输出未 sanitize 的 HTML。
  function renderMarkdown(text) {
    if (!text) return '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    try {
      const raw = marked.parse(text);
      if (typeof DOMPurify === 'undefined') {
        return `<pre>${escapeHtml(text)}</pre>`;
      }
      return DOMPurify.sanitize(raw, {
        FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'base', 'form', 'input', 'button', 'svg', 'math'],
        FORBID_ATTR: ['style'],
      });
    } catch {
      return escapeHtml(text);
    }
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
      avatar.innerHTML = `<img src="/codex.png" width="24" height="24" style="display:block;" alt="Codex">`;
    } else {
      avatar.innerHTML = `<img src="/claude.png" width="24" height="24" style="display:block;" alt="Claude">`;
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
      if (content) decorateCodeBlocks(bubble);
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
	      const FOLD_AT = 3;
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
      if (text) decorateCodeBlocks(content);
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
    // Default expansion policy:
    // - Always open AskUserQuestion (it is an actionable UI).
    // - For non-Codex sessions, auto-open in-flight command execution so users can watch output.
    // - For Codex sessions, keep everything collapsed by default (less noise), including in-flight commands.
    const agent = normalizeAgent(currentAgent);
    const kind = toolKind(tool);
    if (tool.name === 'AskUserQuestion') {
      details.open = true;
    } else if (agent !== 'codex' && !done && kind === 'command_execution') {
      details.open = true;
    }

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
    // 散落的 .tool-call 直接子节点达到3个时，将它们全部移入父节点；之后继续散落，再达3个再移入
    const FOLD_AT = 3;
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

  // --- /goal state helpers (B+) ---
  function getGoalState(sid) {
    if (!sid) return null;
    let s = sessionGoalState.get(sid);
    if (!s) {
      s = { active: false, turns: 0, lastFeedback: '', optimistic: false };
      setGoalState(sid, s);
    }
    return s;
  }

  function setGoalState(sid, state) {
    if (!sid) return;
    // LRU-style: re-insert moves entry to the end, so oldest is always at front.
    if (sessionGoalState.has(sid)) sessionGoalState.delete(sid);
    sessionGoalState.set(sid, state);
    while (sessionGoalState.size > SESSION_GOAL_STATE_CAP) {
      const oldest = sessionGoalState.keys().next().value;
      sessionGoalState.delete(oldest);
    }
  }

  function classifyGoalCommand(rawText) {
    const text = (rawText || '').trim();
    if (!/^\/goal(?:\s|$)/i.test(text)) return null;
    const rest = text.replace(/^\/goal\s*/i, '').trim();
    if (!rest) return 'status';
    if (/^(clear|stop|off|reset|none|cancel)$/i.test(rest)) return 'clear';
    return 'set';
  }

  function updateGoalBar() {
    const bar = document.getElementById('goal-status-bar');
    if (!bar) return;
    const s = currentSessionId ? sessionGoalState.get(currentSessionId) : null;
    const active = !!(s && s.active);
    bar.hidden = !active;
    if (active) {
      const turnsEl = document.getElementById('goal-status-turns');
      const fbEl = document.getElementById('goal-status-feedback');
      if (turnsEl) turnsEl.textContent = `评估 ${s.turns}`;
      if (fbEl) fbEl.textContent = s.lastFeedback || '等待首次评估…';
    }
    if (typeof abortBtn !== 'undefined' && abortBtn) {
      abortBtn.title = active ? '停止 Goal 任务' : '停止';
    }
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


  function buildSessionItem(s) {
    const item = document.createElement('div');
    item.className = `session-item${s.id === currentSessionId ? ' active' : ''}`;
    item.dataset.id = s.id;
    item.draggable = true;
    item.innerHTML = `
      <div class="session-item-main">
        <span class="session-item-title">${escapeHtml(s.title || 'Untitled')}</span>
        ${s.isRunning ? '<span class="session-item-status">运行中</span>' : ''}
      </div>
      ${s.hasUnread ? '<span class="session-unread-dot"></span>' : ''}
      <span class="session-item-time">${timeAgo(s.updated)}</span>
      <div class="session-item-actions">
        <button class="session-item-btn edit" title="重命名">✎</button>
        <button class="session-item-btn group" title="归组">⧉</button>
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
          sessionGoalState.delete(s.id);
          send({ type: 'delete_session', sessionId: s.id });
          if (s.id === currentSessionId) {
            resetChatView(currentAgent);
          }
          updateGoalBar();
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
      if (target.classList.contains('group')) {
        e.stopPropagation();
        showGroupPicker(s);
        return;
      }
      openSession(s.id);
    });

    // 桌面拖拽归组：dragstart 携带 sessionId，drop 目标为分组头
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', s.id);
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));

    return item;
  }

  function buildGroupHeader(group, count) {
    const header = document.createElement('div');
    header.className = 'session-group-header';
    const groupId = group ? group.id : '';
    const groupKey = groupId || '';
    const collapsed = collapsedGroups.has(groupKey);
    if (groupId) header.dataset.groupId = groupId;
    header.innerHTML = `
      <span class="session-group-toggle" aria-hidden="true">${collapsed ? '▸' : '▾'}</span>
      <span class="session-group-name">${escapeHtml(group ? group.name : '未分组')}</span>
      <span class="session-group-count">${count}</span>
      ${group ? `
      <div class="session-group-actions">
        <button class="session-item-btn edit" title="重命名分组">✎</button>
        <button class="session-item-btn delete" title="删除分组">×</button>
      </div>` : ''}
    `;
    header.addEventListener('click', (e) => {
      const target = e.target;
      if (group && target.classList.contains('delete')) {
        e.stopPropagation();
        showGroupDeleteConfirm(group, count);
        return;
      }
      if (group && target.classList.contains('edit')) {
        e.stopPropagation();
        startEditGroupName(header, group);
        return;
      }
      // 点击组头其余区域（名称/箭头/空白）：收起/展开（编辑仅走 ✎ 按钮）
      toggleGroupCollapse(groupKey);
    });
    // 未分组段头也接受拖入（groupId='' 即移出分组）
    header.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      header.classList.add('drop-target');
    });
    header.addEventListener('dragleave', () => header.classList.remove('drop-target'));
    header.addEventListener('drop', (e) => {
      e.preventDefault();
      header.classList.remove('drop-target');
      const sessionId = e.dataTransfer.getData('text/plain');
      if (sessionId) moveSessionToGroup(sessionId, groupId);
    });
    return header;
  }

  function moveSessionToGroup(sessionId, groupId) {
    const current = sessions.find((s) => s.id === sessionId);
    if (!current || (current.group || '') === groupId) return;
    // 乐观更新本地缓存，等 session_list 到达后由服务端数据校正
    sessions = sessions.map((s) => s.id === sessionId ? { ...s, group: groupId } : s);
    renderSessionList();
    send({ type: 'session_move', sessionId, groupId });
  }

  function startEditGroupName(headerEl, group) {
    const nameEl = headerEl.querySelector('.session-group-name');
    const currentName = group.name || '';
    const input = document.createElement('input');
    input.className = 'session-group-edit-input';
    input.value = currentName;
    input.maxLength = 50;

    nameEl.replaceWith(input);
    input.focus();
    input.select();

    const actions = headerEl.querySelector('.session-group-actions');
    if (actions) actions.style.display = 'none';

    function save() {
      const newName = input.value.trim() || currentName;
      if (newName !== currentName) {
        send({ type: 'group_rename', groupId: group.id, name: newName });
        group.name = newName; // 乐观更新，group_list 到达后校正
      }
      renderSessionList();
    }

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = currentName; input.blur(); }
    });
  }

  function showGroupPicker(session) {
    if (groups.length === 0 && !session.group) {
      showToast('暂无分组，请先点击左侧「+ 分组」新建');
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.style.zIndex = '10002';

    const box = document.createElement('div');
    box.className = 'settings-panel group-picker-panel';
    const optionsHtml = groups.map((g) => `
      <button class="group-picker-option${(session.group || '') === g.id ? ' current' : ''}" data-group-id="${escapeHtml(g.id)}">${escapeHtml(g.name)}</button>
    `).join('');
    box.innerHTML = `
      <div class="group-picker-title">将会话移入分组</div>
      <div class="group-picker-list">
        ${optionsHtml}
        ${session.group ? '<button class="group-picker-option group-picker-remove" data-group-id="">移出分组</button>' : ''}
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = () => document.body.removeChild(overlay);
    box.querySelectorAll('.group-picker-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        const groupId = btn.dataset.groupId || '';
        close();
        moveSessionToGroup(session.id, groupId);
      });
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  }

  function showGroupDeleteConfirm(group, count) {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.style.zIndex = '10002';

    const box = document.createElement('div');
    box.className = 'settings-panel';
    box.innerHTML = `
      <div style="font-size:0.9em;color:var(--text-primary);margin-bottom:20px;line-height:1.7">删除分组“${escapeHtml(group.name)}”将同时删除组内 ${count} 个会话且不可恢复，确定？</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button id="group-del-confirm-ok" style="width:100%;padding:10px;border:none;border-radius:10px;background:var(--danger);color:#fff;font-size:0.95em;font-weight:600;cursor:pointer;font-family:inherit">确认删除</button>
        <button id="group-del-confirm-cancel" style="width:100%;padding:9px;border:none;border-radius:10px;background:transparent;color:var(--text-muted);font-size:0.85em;cursor:pointer;font-family:inherit">取消</button>
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const close = () => document.body.removeChild(overlay);
    box.querySelector('#group-del-confirm-ok').addEventListener('click', () => {
      close();
      send({ type: 'group_delete', groupId: group.id });
    });
    box.querySelector('#group-del-confirm-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  }

  if (addGroupBtn) {
    addGroupBtn.addEventListener('click', () => {
      // 直接以 分组1/分组2… 默认命名创建（跳过浏览器原生 prompt）；名称可点击组头修改
      let n = groups.length + 1;
      while (groups.some((g) => g.name === `分组${n}`)) n++;
      send({ type: 'group_create', name: `分组${n}` });
    });
  }

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

    // 按 groups 顺序归桶（组内只含当前 agent 的会话，agent 过滤在 getVisibleSessions 完成）
    const buckets = new Map();
    for (const g of groups) buckets.set(g.id, []);
    const ungrouped = [];
    for (const s of visibleSessions) {
      const gid = s.group || '';
      if (gid && buckets.has(gid)) buckets.get(gid).push(s);
      else ungrouped.push(s);
    }

    for (const g of groups) {
      const list = buckets.get(g.id);
      // 空分组也渲染组头：新建组必然为空，组头既是建组反馈也是拖拽/归组目标（隐藏会死锁）
      sessionList.appendChild(buildGroupHeader(g, list.length));
      if (!collapsedGroups.has(g.id)) {
        for (const s of list) sessionList.appendChild(buildSessionItem(s));
      }
    }
    if (ungrouped.length > 0) {
      sessionList.appendChild(buildGroupHeader(null, ungrouped.length));
      if (!collapsedGroups.has('')) {
        for (const s of ungrouped) sessionList.appendChild(buildSessionItem(s));
      }
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
	        // Close current picker first so onSelect can safely open a nested picker.
	        const v = el.dataset.value;
	        hideOptionPicker();
	        onSelect(v);
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
	      const current = _splitCodexThinkingModel(currentModel || '');
	      const baseOptions = getCodexBaseModelOptions();
	      if (baseOptions.length === 0) {
	        appendSystemMessage('当前 Codex Profile 未配置 /model 候选列表。请先在设置 -> Codex API 配置中填写模型列表，或直接输入 /model <模型名>。');
	        return;
	      }
	      showOptionPicker('选择 Codex 模型', baseOptions, current.base || '', (baseValue) => {
	        const base = String(baseValue || '').trim();
	        const thinkingOptions = [
	          { value: '', label: '无 (默认)', desc: '不附加 (medium/high/xhigh) 后缀' },
	          { value: 'medium', label: 'medium', desc: '中等 thinking' },
	          { value: 'high', label: 'high', desc: '更强 thinking' },
	          { value: 'xhigh', label: 'xhigh', desc: '最强 thinking' },
	        ];
	        showOptionPicker('选择 Thinking 强度', thinkingOptions, current.level || '', (lvl) => {
	          const level = String(lvl || '').trim().toLowerCase();
	          const full = level ? `${base}(${level})` : base;
	          send({ type: 'message', text: `/model ${full}`, sessionId: currentSessionId, mode: currentMode, agent: currentAgent });
	        });
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
  // 不变量：空文本+无附件、生成中、会话加载阻塞时立即返回；
  // 未连接时立即返回并显示断线状态条（不清空输入框、不渲染气泡、不进入生成态，
  // 避免 WS 断线窗口内发送被静默丢弃、重连快照又冲掉本地气泡）。
  // /goal 在此走普通消息路径；Codex 会由服务端转换为目标提示。
  function sendMessage() {
    const text = msgInput.value.trim();
    if ((!text && pendingAttachments.length === 0) || isGenerating || isBlockingSessionLoad()) return;
    if (!isWsConnected()) {
      showConnBanner();
      return;
    }
    hideCmdMenu();
    hideOptionPicker();

    // B+: /goal awareness (set/clear/status) + /clear resets goal state for this session
    const goalCmd = classifyGoalCommand(text);
    if (goalCmd === 'set') {
      const newState = { active: true, turns: 0, lastFeedback: '等待首次评估…', optimistic: true };
      if (currentSessionId) {
        setGoalState(currentSessionId, newState);
      } else {
        pendingGoalForNewSession = newState;
      }
      updateGoalBar();
    } else if (goalCmd === 'clear' && currentSessionId) {
      const gs = sessionGoalState.get(currentSessionId);
      if (gs) {
        gs.lastFeedback = '清除中…';
        updateGoalBar();
      }
    }
    if (/^\/clear\s*$/i.test(text) && currentSessionId && pendingAttachments.length === 0) {
      sessionGoalState.delete(currentSessionId);
      pendingGoalForNewSession = null;
      updateGoalBar();
    }

    // Slash commands: don't show as user bubble.
    // /goal carries the user's real intent and falls through to the normal message path.
    // Claude receives its native command; Codex receives a compatible goal-creation prompt.
    if (text.startsWith('/') && !/^\/goal(?:\s|$)/i.test(text)) {
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
  // B+: goal status bar's own stop button — same semantics as abort, but also nudges UI
  const goalStopBtn = document.getElementById('goal-status-stop');
  if (goalStopBtn) {
    goalStopBtn.addEventListener('click', () => {
      if (currentSessionId) {
        const gs = sessionGoalState.get(currentSessionId);
        if (gs) {
          gs.lastFeedback = '停止中…';
          updateGoalBar();
        }
      }
      send({ type: 'abort' });
    });
  }
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
  let _onClaudeLocalConfig = null;
  let _onCodexLocalConfig = null;
  let _onDevConfig = null;

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
        <div class="agent-context-kicker">${escapeHtml(label)}</div>
        ${title ? `<div class="agent-context-title">${escapeHtml(title)}</div>` : ''}
        ${copy ? `<div class="agent-context-copy">${escapeHtml(copy)}</div>` : ''}
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

  function showSettingsPanel() {
    send({ type: 'get_model_config' });
    send({ type: 'get_codex_config' });
    send({ type: 'get_notify_config' });

    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.id = 'settings-overlay';

    const panel = document.createElement('div');
    panel.className = 'settings-panel';

    panel.innerHTML = `
      <h3>
        ⚙ 设置
        <button class="settings-close" title="关闭">&times;</button>
      </h3>

      <div class="settings-section-title">Claude API 配置</div>
      <div id="claude-config-area"></div>
      <div class="settings-actions">
        <button class="btn-save" id="model-save-btn">保存 Claude 配置</button>
      </div>
      <div class="settings-status" id="model-status"></div>

      <div class="settings-divider"></div>

      <div class="settings-section-title">Codex API 配置</div>
      <div id="codex-config-area"></div>
      <div class="settings-actions">
        <button class="btn-save" id="codex-save-btn">保存 Codex 配置</button>
      </div>
      <div class="settings-status" id="codex-status"></div>

      <div class="settings-divider"></div>

      ${buildThemeEntryHtml()}

      <div class="settings-divider"></div>

      ${buildNotifyEntryHtml(null)}

      <div class="settings-divider"></div>

      <div class="settings-section-title">开发者</div>
      <button class="settings-nav-card" type="button" data-open-dev-page>
        <span class="settings-nav-card-main">
          <span class="settings-nav-card-title">开发者设置</span>
          <span class="settings-nav-card-meta">GitHub / SSH / Cloudflare 配置</span>
        </span>
        <span class="settings-nav-card-arrow" aria-hidden="true">›</span>
      </button>

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
    const devPageBtn = panel.querySelector('[data-open-dev-page]');
    if (devPageBtn) devPageBtn.addEventListener('click', openDevSettingsSubpage);

    // === Claude Config UI ===
    const claudeConfigArea = panel.querySelector('#claude-config-area');
    const modelStatusDiv = panel.querySelector('#model-status');
    const modelSaveBtn = panel.querySelector('#model-save-btn');

    let modelCurrentConfig = null;
    let modelEditingTemplates = [];
    let modelActiveTemplate = '';

    function showModelStatus(msg, type) {
      modelStatusDiv.textContent = msg;
      modelStatusDiv.className = 'settings-status ' + (type || '');
    }

    function renderClaudeConfigArea() {
      const isLocal = modelActiveTemplate === '';
      const tplOptions = modelEditingTemplates.map(t =>
        `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`
      ).join('');

      if (isLocal) {
        const hasSnapshot = modelCurrentConfig?.localSnapshot && Object.keys(modelCurrentConfig.localSnapshot).length > 0
          && (modelCurrentConfig.localSnapshot.apiKey || modelCurrentConfig.localSnapshot.apiBase);
        claudeConfigArea.innerHTML = `
          <div class="settings-field">
            <label>激活模板</label>
            <div style="display:flex;gap:6px;align-items:center">
              <select class="settings-select" id="claude-tpl-select" style="flex:1">
                <option value="__local__" selected>本地配置</option>
                ${tplOptions}
                <option value="__new__">+ 新建模板</option>
              </select>
              <button class="btn-test" id="claude-info-btn" style="padding:4px 10px">说明</button>
              <button class="btn-test" id="claude-read-local-btn" style="padding:4px 10px">读取当前配置</button>
              ${hasSnapshot ? '<button class="btn-test" id="claude-restore-btn" style="padding:4px 10px">恢复快照</button>' : ''}
            </div>
          </div>
          <div class="settings-inline-note">
            Agent 直接使用本机 <code>~/.claude/settings.json</code> 中的 API 信息，不会覆盖或修改本机配置。
          </div>
        `;
        panel.querySelector('#claude-tpl-select').addEventListener('change', (e) => {
          if (e.target.value === '__new__') {
            // 对齐 Codex Profile：跳过浏览器原生 prompt，默认命名直接打开编辑模态框（首字段即模板名称，可改）
            let n = 1;
            while (modelEditingTemplates.find(t => t.name === `模板${n}`)) n++;
            const newName = `模板${n}`;
            modelEditingTemplates.push({ name: newName, apiKey: '', apiBase: '', defaultModel: '', opusModel: '', sonnetModel: '', haikuModel: '' });
            modelActiveTemplate = newName;
            renderClaudeConfigArea();
            openTplEditModal();
          } else {
            modelActiveTemplate = e.target.value;
            renderClaudeConfigArea();
          }
        });
        panel.querySelector('#claude-info-btn').addEventListener('click', showClaudeLocalInfoModal);
        panel.querySelector('#claude-read-local-btn').addEventListener('click', () => send({ type: 'read_claude_local_config' }));
        const restoreBtn = panel.querySelector('#claude-restore-btn');
        if (restoreBtn) restoreBtn.addEventListener('click', () => send({ type: 'restore_claude_local_snapshot' }));
        return;
      }

      // Custom template selected
      const tpl = modelEditingTemplates.find(t => t.name === modelActiveTemplate);
      const summary = tpl ? `API Key: <code>${tpl.apiKey ? '已设置' : '未设置'}</code> · Base: <code>${escapeHtml(tpl.apiBase || '默认')}</code>` : '';
      claudeConfigArea.innerHTML = `
        <div class="settings-field">
          <label>激活模板</label>
          <div style="display:flex;gap:6px;align-items:center">
            <select class="settings-select" id="claude-tpl-select" style="flex:1">
              <option value="__local__">本地配置</option>
              ${tplOptions}
              <option value="__new__">+ 新建模板</option>
            </select>
            <button class="btn-test" id="model-tpl-edit" style="padding:4px 10px">编辑</button>
            <button class="btn-test" id="model-tpl-del" title="删除" style="padding:4px 8px">删除</button>
          </div>
        </div>
        <div class="settings-inline-note">${summary}</div>
      `;

      panel.querySelector('#claude-tpl-select').addEventListener('change', (e) => {
        if (e.target.value === '__new__') {
          // 对齐 Codex Profile：跳过浏览器原生 prompt，默认命名直接打开编辑模态框（首字段即模板名称，可改）
          let n = 1;
          while (modelEditingTemplates.find(t => t.name === `模板${n}`)) n++;
          const newName = `模板${n}`;
          modelEditingTemplates.push({ name: newName, apiKey: '', apiBase: '', defaultModel: '', opusModel: '', sonnetModel: '', haikuModel: '' });
          modelActiveTemplate = newName;
          renderClaudeConfigArea();
          openTplEditModal();
        } else if (e.target.value === '__local__') {
          modelActiveTemplate = '';
          renderClaudeConfigArea();
        } else {
          modelActiveTemplate = e.target.value;
          renderClaudeConfigArea();
        }
      });
      panel.querySelector('#model-tpl-edit').addEventListener('click', () => openTplEditModal());
      const delBtn = panel.querySelector('#model-tpl-del');
      if (delBtn) {
        delBtn.addEventListener('click', () => {
          if (!modelActiveTemplate) return;
          if (!confirm(`确认删除模板「${modelActiveTemplate}」?`)) return;
          modelEditingTemplates = modelEditingTemplates.filter(t => t.name !== modelActiveTemplate);
          modelActiveTemplate = modelEditingTemplates[0]?.name || '';
          renderClaudeConfigArea();
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
          <label style="display:flex;align-items:center;gap:8px;font-weight:600">获取上游模型列表</label>
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
      const customEndpointCb = modal.querySelector('#tpl-ed-custom-endpoint');
      const endpointInput = modal.querySelector('#tpl-ed-models-endpoint');
      customEndpointCb.addEventListener('change', () => {
        endpointInput.style.display = customEndpointCb.checked ? '' : 'none';
      });
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
        renderClaudeConfigArea();
      });
    }

    function showClaudeLocalInfoModal() {
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      modal.innerHTML = `
        <div class="settings-header">
          <h3>本地配置说明</h3>
          <button class="settings-close" id="claude-info-close">&times;</button>
        </div>
        <div class="settings-inline-note">
          选中"本地配置"时，Agent 直接使用本机原生配置文件中的 API 信息，不会覆盖或修改本机配置。
          <br><br>
          <strong>• Claude：</strong>切换到自定义模板时，本机 ~/.claude/settings.json 中的 API 配置会被替换为模板值。再次切回"本地配置"时，可一键恢复之前保存的快照到 settings.json。
          <br><br>
          <strong>• Codex：</strong>自定义模板不会修改本机 ~/.codex/，切回"本地配置"时自动恢复本机直通，无需恢复操作。
        </div>
        <div class="settings-actions">
          <button class="btn-save" id="claude-info-ok">确定</button>
        </div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#claude-info-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#claude-info-ok').addEventListener('click', closeModal);
    }

    modelSaveBtn.addEventListener('click', () => {
      const isLocal = modelActiveTemplate === '';
      const config = {
        mode: isLocal ? 'local' : 'custom',
        activeTemplate: isLocal ? '' : modelActiveTemplate,
        templates: modelEditingTemplates,
        localSnapshot: modelCurrentConfig?.localSnapshot || {},
      };
      send({ type: 'save_model_config', config });
      showModelStatus('已保存', 'success');
    });

    _onModelConfig = (config) => {
      modelCurrentConfig = config;
      modelEditingTemplates = (config.templates || []).map(t => Object.assign({}, t));
      if (config.mode === 'local') {
        modelActiveTemplate = '';
      } else {
        modelActiveTemplate = config.activeTemplate || (modelEditingTemplates[0]?.name || '');
      }
      renderClaudeConfigArea();
    };

    _onClaudeLocalConfig = (msg) => {
      const config = msg.config || {};
      const hasData = config.apiKey || config.apiBase;
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      const fields = [
        ['API Key', config.apiKey || '(空)'],
        ['API Base URL', config.apiBase || '(空)'],
        ['默认模型', config.defaultModel || '(空)'],
        ['Opus 模型', config.opusModel || '(空)'],
        ['Sonnet 模型', config.sonnetModel || '(空)'],
        ['Haiku 模型', config.haikuModel || '(空)'],
      ];
      modal.innerHTML = `
        <div class="settings-header">
          <h3>当前 Claude 本地配置</h3>
          <button class="settings-close" id="read-local-close">&times;</button>
        </div>
        ${msg.sourceFound ? '' : '<div class="settings-inline-note" style="color:var(--text-warning, #e8a838)">未找到 ~/.claude/settings.json，以下为空值。</div>'}
        ${fields.map(([label, val]) => `
          <div class="settings-field">
            <label>${label}</label>
            <div style="font-size:0.9em;word-break:break-all;color:var(--text-secondary)">${escapeHtml(val)}</div>
          </div>
        `).join('')}
        ${hasData ? '<div class="settings-actions"><button class="btn-save" id="save-snapshot-btn">保存为快照</button></div>' : ''}
        <div class="settings-actions"><button class="btn-save" id="read-local-ok">关闭</button></div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#read-local-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#read-local-ok').addEventListener('click', closeModal);
      const saveBtn = modal.querySelector('#save-snapshot-btn');
      if (saveBtn) {
        saveBtn.addEventListener('click', () => {
          send({ type: 'save_local_snapshot', snapshot: config });
          closeModal();
        });
      }
    };

    // === Codex Config UI ===
    const codexConfigArea = panel.querySelector('#codex-config-area');
    const codexStatus = panel.querySelector('#codex-status');
    const codexSaveBtn = panel.querySelector('#codex-save-btn');

    let currentCodexConfig = null;
    let codexEditingProfiles = [];
    let codexActiveProfile = '';

    function showCodexStatus(msg, type) {
      codexStatus.textContent = msg;
      codexStatus.className = 'settings-status ' + (type || '');
    }

    function renderCodexConfigArea() {
      const isLocal = codexActiveProfile === '';
      const profileOptions = codexEditingProfiles.map((profile) =>
        `<option value="${escapeHtml(profile.name)}"${profile.name === codexActiveProfile ? ' selected' : ''}>${escapeHtml(profile.name)}</option>`
      ).join('');

      if (isLocal) {
        codexConfigArea.innerHTML = `
          <div class="settings-field">
            <label>激活 Profile</label>
            <div style="display:flex;gap:6px;align-items:center">
              <select class="settings-select" id="codex-profile-select" style="flex:1">
                <option value="__local__" selected>本地配置</option>
                ${profileOptions}
                <option value="__new__">+ 新建 Profile</option>
              </select>
              <button class="btn-test" id="codex-info-btn" style="padding:4px 10px">说明</button>
              <button class="btn-test" id="codex-read-local-btn" style="padding:4px 10px">读取当前配置</button>
            </div>
          </div>
          <div class="settings-inline-note">
            直接复用本机 <code>codex</code> 的登录态与 <code>~/.codex/config.toml</code>。
          </div>
        `;
        panel.querySelector('#codex-profile-select').addEventListener('change', (e) => {
          if (e.target.value === '__new__') {
            openCodexProfileModal();
          } else if (e.target.value === '__local__') {
            codexActiveProfile = '';
            renderCodexConfigArea();
          } else {
            codexActiveProfile = e.target.value;
            renderCodexConfigArea();
          }
        });
        panel.querySelector('#codex-info-btn').addEventListener('click', showClaudeLocalInfoModal);
        panel.querySelector('#codex-read-local-btn').addEventListener('click', () => send({ type: 'read_codex_local_config' }));
        return;
      }

      // Custom profile selected
      const currentProfileRaw = codexEditingProfiles.find((profile) => profile.name === codexActiveProfile);
      const currentProfile = currentProfileRaw ? normalizeCodexProfile(currentProfileRaw) : null;
      const summaryBase = currentProfile?.apiBase ? escapeHtml(currentProfile.apiBase) : '默认';
      const summaryModel = currentProfile?.model ? escapeHtml(currentProfile.model) : '未设置';
      const summaryModelsCount = Array.isArray(currentProfile?.models) ? currentProfile.models.length : 0;

      codexConfigArea.innerHTML = `
        <div class="settings-field">
          <label>激活 Profile</label>
          <div style="display:flex;gap:6px;align-items:center">
            <select class="settings-select" id="codex-profile-select" style="flex:1">
              <option value="__local__">本地配置</option>
              ${profileOptions}
              <option value="__new__">+ 新建 Profile</option>
            </select>
            <button class="btn-test" id="codex-profile-edit" style="padding:4px 10px">编辑</button>
            <button class="btn-test" id="codex-profile-del" title="删除" style="padding:4px 8px">删除</button>
          </div>
        </div>
        <div class="settings-inline-note">
          当前 Profile：<strong>${escapeHtml(currentProfile?.name || '未选择')}</strong> · API Base：<code>${summaryBase}</code> · 默认模型：<code>${summaryModel}</code> · /model 候选：<code>${summaryModelsCount}</code> 项
        </div>
      `;

      panel.querySelector('#codex-profile-select').addEventListener('change', (e) => {
        if (e.target.value === '__new__') {
          openCodexProfileModal();
        } else if (e.target.value === '__local__') {
          codexActiveProfile = '';
          renderCodexConfigArea();
        } else {
          codexActiveProfile = e.target.value;
          renderCodexConfigArea();
        }
      });
      panel.querySelector('#codex-profile-edit').addEventListener('click', () => {
        openCodexProfileModal(codexActiveProfile);
      });
      panel.querySelector('#codex-profile-del').addEventListener('click', () => {
        if (!codexActiveProfile) return;
        if (!confirm(`确认删除 Codex Profile「${codexActiveProfile}」?`)) return;
        codexEditingProfiles = codexEditingProfiles.filter((profile) => profile.name !== codexActiveProfile);
        codexActiveProfile = codexEditingProfiles[0]?.name || '';
        renderCodexConfigArea();
      });
    }

    function openCodexProfileModal(profileName = '') {
      const current = profileName
        ? codexEditingProfiles.find((profile) => profile.name === profileName)
        : null;
      const draft = current ? normalizeCodexProfile(current) : { name: '', apiKey: '', apiBase: '', model: '', models: [] };
      const initialModelListText = Array.isArray(draft.models) ? draft.models.join('\n') : '';
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
        <div class="settings-divider" style="margin:12px 0"></div>
        <div class="settings-field">
          <label style="display:flex;align-items:center;gap:8px;font-weight:600">获取上游模型列表</label>
          <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
            <label style="font-size:0.85em;display:flex;align-items:center;gap:4px;cursor:pointer">
              <input type="checkbox" id="codex-profile-custom-endpoint"> 端点
            </label>
            <input type="text" id="codex-profile-models-endpoint" placeholder="/v1/models" style="flex:1;display:none" value="">
          </div>
          <div style="display:flex;gap:6px;margin-top:6px;align-items:center">
            <button class="btn-test" id="codex-profile-fetch-models" style="padding:4px 12px;white-space:nowrap">获取模型</button>
            <span id="codex-profile-fetch-status" style="font-size:0.85em;color:var(--text-secondary)"></span>
          </div>
        </div>
        <div class="settings-divider" style="margin:12px 0"></div>
        <div class="settings-field">
          <label>默认模型</label>
          <input type="text" id="codex-profile-model" list="codex-profile-dl-models" placeholder="gpt-5.5" value="${escapeHtml(draft.model || '')}" autocomplete="off">
        </div>
        <datalist id="codex-profile-dl-models"></datalist>
        <div class="settings-field">
          <label>/model 候选列表</label>
          <textarea id="codex-profile-model-list" rows="7" placeholder="每行一个模型，例如&#10;gpt-5.5&#10;gpt-5.4&#10;gpt-5.3-codex" style="resize:vertical">${escapeHtml(initialModelListText)}</textarea>
        </div>
        <div class="settings-inline-note">
          默认模型会用于新会话；<code>/model</code> 弹出的候选项只来自这里配置的列表。
        </div>
        <div class="settings-actions">
          <button class="btn-save" id="codex-profile-ok">确定</button>
        </div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const customEndpointCb = modal.querySelector('#codex-profile-custom-endpoint');
      const endpointInput = modal.querySelector('#codex-profile-models-endpoint');
      const fetchBtn = modal.querySelector('#codex-profile-fetch-models');
      const fetchStatus = modal.querySelector('#codex-profile-fetch-status');
      const datalist = modal.querySelector('#codex-profile-dl-models');
      const defaultModelInput = modal.querySelector('#codex-profile-model');
      const modelListTextarea = modal.querySelector('#codex-profile-model-list');
      customEndpointCb.addEventListener('change', () => {
        endpointInput.style.display = customEndpointCb.checked ? '' : 'none';
      });
      fetchBtn.addEventListener('click', () => {
        const apiBase = modal.querySelector('#codex-profile-apibase').value.trim();
        const apiKey = modal.querySelector('#codex-profile-apikey').value.trim();
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
            datalist.innerHTML = result.models.map((m) => `<option value="${escapeHtml(m)}">`).join('');
            const fetchedText = result.models.join('\n');
            const currentText = modelListTextarea.value.trim();
            if (!currentText) {
              modelListTextarea.value = fetchedText;
            } else if (currentText !== fetchedText && confirm('是否使用拉取结果覆盖当前 /model 候选列表？')) {
              modelListTextarea.value = fetchedText;
            }
            if (!defaultModelInput.value.trim() && result.models[0]) {
              defaultModelInput.value = result.models[0];
            }
            fetchStatus.textContent = `获取到 ${result.models.length} 个模型`;
            fetchStatus.style.color = 'var(--text-success, #5dbe5d)';
          } else {
            fetchStatus.textContent = result.message || '获取失败';
            fetchStatus.style.color = 'var(--text-error, #e85d5d)';
          }
        };
        send({
          type: 'fetch_models',
          apiBase,
          apiKey,
          modelsEndpoint: modelsEndpoint || undefined,
          profileName: current?.name || modal.querySelector('#codex-profile-name').value.trim(),
        });
      });
      const closeModal = () => {
        _onFetchModelsResult = null;
        document.body.removeChild(modalOverlay);
      };
      modal.querySelector('#codex-profile-modal-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#codex-profile-ok').addEventListener('click', () => {
        const name = modal.querySelector('#codex-profile-name').value.trim();
        const apiKey = modal.querySelector('#codex-profile-apikey').value.trim();
        const apiBase = modal.querySelector('#codex-profile-apibase').value.trim();
        const model = defaultModelInput.value.trim();
        const models = _parseCodexModelListText(modelListTextarea.value);
        if (!name) { alert('请填写 Profile 名称'); return; }
        if (!apiKey) { alert('请填写 API Key'); return; }
        if (!apiBase) { alert('请填写 API Base URL'); return; }
        if (!model) { alert('请填写模型'); return; }
        if (!models.length) { alert('请至少填写一个 /model 候选模型'); return; }
        if (!models.includes(model)) models.unshift(model);
        const existing = codexEditingProfiles.find((profile) => profile.name === name);
        if (existing && existing !== current) { alert('Profile 名称已存在'); return; }
        if (current) {
          current.name = name;
          current.apiKey = apiKey;
          current.apiBase = apiBase;
          current.model = model;
          current.models = models;
        } else {
          codexEditingProfiles.push({ name, apiKey, apiBase, model, models });
        }
        codexActiveProfile = name;
        closeModal();
        renderCodexConfigArea();
      });
    }

    _onCodexConfig = (config) => {
      currentCodexConfig = config || {};
      codexEditingProfiles = (currentCodexConfig.profiles || []).map((profile) => normalizeCodexProfile(profile));
      if (currentCodexConfig.mode === 'local') {
        codexActiveProfile = '';
      } else {
        codexActiveProfile = currentCodexConfig.activeProfile || (codexEditingProfiles[0]?.name || '');
      }
      renderCodexConfigArea();
    };

    codexSaveBtn.addEventListener('click', () => {
      const isLocal = codexActiveProfile === '';
      if (!isLocal && codexEditingProfiles.length === 0) {
        showCodexStatus('自定义模式至少需要一个 Codex Profile', 'error');
        return;
      }
      const config = {
        mode: isLocal ? 'local' : 'custom',
        activeProfile: isLocal ? '' : codexActiveProfile,
        profiles: codexEditingProfiles,
        enableSearch: false,
        localSnapshot: currentCodexConfig?.localSnapshot || {},
      };
      send({ type: 'save_codex_config', config });
      showCodexStatus('已保存', 'success');
    });

    _onCodexLocalConfig = (msg) => {
      const config = msg.config || {};
      const modalOverlay = document.createElement('div');
      modalOverlay.className = 'settings-overlay';
      modalOverlay.style.zIndex = '10001';
      const modal = document.createElement('div');
      modal.className = 'settings-panel';
      modal.style.maxWidth = '460px';
      const fields = [
        ['API Key', config.apiKey || '(空)'],
        ['API Base URL', config.apiBase || '(空)'],
        ['模型', config.model || '(空)'],
      ];
      modal.innerHTML = `
        <div class="settings-header">
          <h3>当前 Codex 本地配置</h3>
          <button class="settings-close" id="read-codex-local-close">&times;</button>
        </div>
        ${msg.warning ? `<div class="settings-inline-note" style="color:var(--text-warning, #e8a838)">${escapeHtml(msg.warning)}</div>` : ''}
        ${!msg.sourceFound ? '<div class="settings-inline-note" style="color:var(--text-warning, #e8a838)">未找到 ~/.codex/ 配置文件。</div>' : ''}
        ${fields.map(([label, val]) => `
          <div class="settings-field">
            <label>${label}</label>
            <div style="font-size:0.9em;word-break:break-all;color:var(--text-secondary)">${escapeHtml(val)}</div>
          </div>
        `).join('')}
        <div class="settings-actions"><button class="btn-save" id="read-codex-local-ok">关闭</button></div>
      `;
      modalOverlay.appendChild(modal);
      document.body.appendChild(modalOverlay);
      const closeModal = () => document.body.removeChild(modalOverlay);
      modal.querySelector('#read-codex-local-close').addEventListener('click', closeModal);
      modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
      modal.querySelector('#read-codex-local-ok').addEventListener('click', closeModal);
    };

    // === System UI ===
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
    _onClaudeLocalConfig = null;
    _onCodexLocalConfig = null;
    _onDevConfig = null;
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
      send({ type: 'change_password', currentPassword: loginPasswordValue, newPassword: newPw });
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
      // 清理旧版可能残留的明文密码缓存
      localStorage.removeItem('cc-web-pw');

      // If force-change overlay is open, close it and load sessions
      const fcOverlay = document.getElementById('force-change-overlay');
      if (fcOverlay) {
        hideForceChangePassword();
        hasInitialAuthCompleted = true;  // 强制改密完成后视为已完成首次 auth（之前的 auth 因 mustChange=true 没有触发）
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

  // --- Recent CWD memory (localStorage) ---
  const RECENT_CWD_KEY = 'cc-web-recent-cwds';
  const RECENT_CWD_MAX = 5;

  function getRecentCwds() {
    try {
      const raw = localStorage.getItem(RECENT_CWD_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function saveRecentCwd(cwd) {
    if (!cwd) return;
    let list = getRecentCwds().filter(p => p !== cwd);
    list.unshift(cwd);
    if (list.length > RECENT_CWD_MAX) list = list.slice(0, RECENT_CWD_MAX);
    try { localStorage.setItem(RECENT_CWD_KEY, JSON.stringify(list)); } catch {}
  }

  // --- Pinned CWD helpers ---
  function getPinnedCwds(agent) {
    try {
      const raw = localStorage.getItem('cc-web-pinned-cwds-' + agent);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function savePinnedCwd(agent, cwd) {
    if (!cwd) return;
    let list = getPinnedCwds(agent);
    if (list.includes(cwd)) return;
    list.unshift(cwd);
    if (list.length > 5) list = list.slice(0, 5);
    try { localStorage.setItem('cc-web-pinned-cwds-' + agent, JSON.stringify(list)); } catch {}
  }

  function removePinnedCwd(agent, cwd) {
    let list = getPinnedCwds(agent).filter(p => p !== cwd);
    try { localStorage.setItem('cc-web-pinned-cwds-' + agent, JSON.stringify(list)); } catch {}
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
          <div class="agent-context-card" style="margin-bottom:12px">
            <div class="agent-context-kicker" id="ns-task-label">${escapeHtml(targetLabel)} · 本地任务</div>
          </div>
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <button class="btn-test ns-task-tab active" id="ns-tab-local" style="flex:1;padding:6px 12px">本地任务</button>
            <button class="btn-test ns-task-tab" id="ns-tab-remote" style="flex:1;padding:6px 12px">远程任务</button>
          </div>
          <div id="ns-local-view"></div>
          <div id="ns-remote-view" style="display:none"></div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn-secondary" id="ns-cancel-btn">取消</button>
          <button class="modal-btn-primary" id="ns-create-btn">创建</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    let currentTab = 'local';
    let selectedHostId = '';
    const tabLocal = overlay.querySelector('#ns-tab-local');
    const tabRemote = overlay.querySelector('#ns-tab-remote');
    const localView = overlay.querySelector('#ns-local-view');
    const remoteView = overlay.querySelector('#ns-remote-view');
    const taskLabel = overlay.querySelector('#ns-task-label');

    function switchTab(tab) {
      currentTab = tab;
      tabLocal.classList.toggle('active', tab === 'local');
      tabRemote.classList.toggle('active', tab === 'remote');
      tabLocal.style.opacity = tab === 'local' ? '1' : '0.6';
      tabRemote.style.opacity = tab === 'remote' ? '1' : '0.6';
      localView.style.display = tab === 'local' ? '' : 'none';
      remoteView.style.display = tab === 'remote' ? '' : 'none';
      taskLabel.textContent = targetLabel + (tab === 'local' ? ' · 本地任务' : ' · 远程任务');
    }
    tabLocal.addEventListener('click', () => switchTab('local'));
    tabRemote.addEventListener('click', () => switchTab('remote'));
    switchTab('local');

    // --- Local task view ---
    const pinned = getPinnedCwds(targetAgent);
    const recent = getRecentCwds().filter(p => !pinned.includes(p));
    const dirs = [...pinned, ...recent].slice(0, 5);

    let selectedLocalIndex = 0;

    function renderLocalView() {
      const currentPinned = getPinnedCwds(targetAgent);
      const currentRecent = getRecentCwds().filter(p => !currentPinned.includes(p));
      const filledDirs = [...currentPinned, ...currentRecent].slice(0, 4);
      const maxIndex = filledDirs.length;
      if (selectedLocalIndex > maxIndex) selectedLocalIndex = maxIndex;

      localView.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:6px">
          ${filledDirs.map((dir, i) => {
            const isPinned = currentPinned.includes(dir);
            const isSelected = selectedLocalIndex === i;
            return `
              <div class="ns-cwd-row" data-local-row="${i}" style="display:flex;gap:6px;align-items:center;padding:4px 6px;border:1px solid ${isSelected ? 'var(--accent)' : 'transparent'};border-radius:8px;background:${isSelected ? 'var(--accent-dim,rgba(100,150,255,0.08))' : 'transparent'};cursor:pointer">
                <input type="radio" name="ns-local-cwd" class="ns-cwd-radio" data-local-radio="${i}" ${isSelected ? 'checked' : ''}>
                <input type="text" class="modal-text-input ns-cwd-item" value="${escapeHtml(dir)}" data-idx="${i}" style="flex:1;${isPinned ? '' : 'opacity:0.6'}">
                <button class="btn-test ns-pin-btn" data-idx="${i}" data-cwd="${escapeHtml(dir)}" style="padding:2px 6px;font-size:0.9em;${isPinned ? 'color:var(--accent)' : ''}" title="${isPinned ? '取消固定' : '固定'}">${isPinned ? '★' : '☆'}</button>
                <button class="btn-test ns-del-dir-btn" data-idx="${i}" data-cwd="${escapeHtml(dir)}" style="padding:2px 6px;font-size:0.9em" title="移除">✕</button>
              </div>
            `;
          }).join('')}
          <div class="ns-cwd-row" data-local-row="${filledDirs.length}" style="display:flex;gap:6px;align-items:center;padding:4px 6px;border:1px solid ${selectedLocalIndex === filledDirs.length ? 'var(--accent)' : 'transparent'};border-radius:8px;background:${selectedLocalIndex === filledDirs.length ? 'var(--accent-dim,rgba(100,150,255,0.08))' : 'transparent'};cursor:pointer">
            <input type="radio" name="ns-local-cwd" class="ns-cwd-radio" data-local-radio="${filledDirs.length}" ${selectedLocalIndex === filledDirs.length ? 'checked' : ''}>
            <input type="text" id="ns-cwd-custom" class="modal-text-input" placeholder="输入自定义目录" style="flex:1">
          </div>
        </div>
      `;

      localView.querySelectorAll('[data-local-row]').forEach(row => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('.ns-pin-btn') || e.target.closest('.ns-del-dir-btn')) return;
          selectedLocalIndex = Number(row.dataset.localRow);
          renderLocalView();
        });
      });

      localView.querySelectorAll('.ns-cwd-item, #ns-cwd-custom').forEach(input => {
        input.addEventListener('focus', () => {
          const row = input.closest('[data-local-row]');
          if (!row) return;
          selectedLocalIndex = Number(row.dataset.localRow);
          renderLocalView();
          const freshInput = localView.querySelector(row.dataset.localRow === String(filledDirs.length) ? '#ns-cwd-custom' : `.ns-cwd-item[data-idx="${row.dataset.localRow}"]`);
          if (freshInput) {
            const val = freshInput.value;
            freshInput.focus();
            if (typeof freshInput.setSelectionRange === 'function') freshInput.setSelectionRange(val.length, val.length);
          }
        });
      });

      localView.querySelectorAll('.ns-pin-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const rowInput = btn.closest('[data-local-row]')?.querySelector('.ns-cwd-item');
          const cwd = rowInput?.value?.trim() || btn.dataset.cwd;
          if (!cwd) return;
          const currentPinned2 = getPinnedCwds(targetAgent);
          if (currentPinned2.includes(cwd)) {
            removePinnedCwd(targetAgent, cwd);
          } else {
            savePinnedCwd(targetAgent, cwd);
          }
          selectedLocalIndex = Number(btn.dataset.idx || 0);
          renderLocalView();
        });
      });

      localView.querySelectorAll('.ns-del-dir-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const rowInput = btn.closest('[data-local-row]')?.querySelector('.ns-cwd-item');
          const cwd = rowInput?.value?.trim() || btn.dataset.cwd;
          if (!cwd) return;
          removePinnedCwd(targetAgent, cwd);
          let recents = getRecentCwds().filter(p => p !== cwd);
          try { localStorage.setItem(RECENT_CWD_KEY, JSON.stringify(recents)); } catch {}
          if (selectedLocalIndex > 0) selectedLocalIndex -= 1;
          renderLocalView();
        });
      });
    }

    renderLocalView();

    // --- Remote task view ---
    // Fetch dev config for SSH hosts
    let sshHosts = [];
    const prevOnDevConfig = _onDevConfig;
    send({ type: 'get_dev_config' });
    _onDevConfig = (config) => {
      sshHosts = config.ssh?.hosts || [];
      renderRemoteView();
    };

    function renderRemoteView() {
      if (sshHosts.length === 0) {
        remoteView.innerHTML = '<div class="settings-inline-note" style="text-align:center">请先在 设置 > 开发者设置 中添加 SSH 主机</div>';
        return;
      }
      remoteView.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:6px">
          ${sshHosts.map((host) => `
            <div style="display:flex;gap:8px;align-items:center;padding:8px;border:1px solid var(--border);border-radius:6px;cursor:pointer;${selectedHostId === host.id ? 'border-color:var(--accent);background:var(--accent-dim,rgba(100,150,255,0.08))' : ''}" data-host-select="${host.id}">
              <input type="radio" name="ns-ssh-host" value="${escapeHtml(host.id)}" ${selectedHostId === host.id ? 'checked' : ''} style="margin:0">
              <div style="flex:1">
                <div style="font-weight:600">${escapeHtml(host.name || '未命名')}</div>
                <div style="font-size:0.85em;color:var(--text-secondary)">${escapeHtml(host.user || '')}@${escapeHtml(host.host || '')}:${host.port || 22}${host.description ? ' · ' + escapeHtml(host.description) : ''}</div>
              </div>
            </div>
          `).join('')}
          ${selectedHostId ? `
            <div style="margin-top:8px">
              <label class="modal-field-label" style="margin-bottom:4px">远端工作目录（可选）</label>
              <input type="text" id="ns-remote-cwd" class="modal-text-input" placeholder="留空使用 SSH 默认目录">
            </div>
          ` : ''}
        </div>
      `;

      remoteView.querySelectorAll('[data-host-select]').forEach(el => {
        el.addEventListener('click', () => {
          selectedHostId = el.dataset.hostSelect;
          renderRemoteView();
        });
      });
    }
    renderRemoteView();

    function close() {
      overlay.remove();
      _onCwdSuggestions = null;
      _onDevConfig = prevOnDevConfig;
    }

    overlay.querySelector('#ns-close-btn').addEventListener('click', close);
    overlay.querySelector('#ns-cancel-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    overlay.querySelector('#ns-create-btn').addEventListener('click', () => {
      if (currentTab === 'local') {
        const customInput = localView.querySelector('#ns-cwd-custom');
        const editedItems = Array.from(localView.querySelectorAll('.ns-cwd-item')).map(input => input.value.trim());
        let cwd = null;
        if (selectedLocalIndex === editedItems.length) {
          cwd = customInput?.value?.trim() || null;
        } else {
          cwd = editedItems[selectedLocalIndex] || null;
        }
        if (!cwd) {
          alert('请选择或输入工作目录');
          return;
        }
        close();
        saveRecentCwd(cwd);
        send({ type: 'new_session', cwd, agent: targetAgent, mode: currentMode, taskMode: 'local' });
      } else {
        // Remote task
        if (!selectedHostId) {
          alert('请选择一个 SSH 主机');
          return;
        }
        const remoteCwd = remoteView.querySelector('#ns-remote-cwd')?.value?.trim() || '';
        close();
        send({ type: 'new_session', agent: targetAgent, mode: currentMode, taskMode: 'remote', sshHostId: selectedHostId, remoteCwd });
      }
    });
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

  // 清理旧版密码缓存（已不再持久化明文密码）
  localStorage.removeItem('cc-web-pw');

  // Visibility change: re-sync state when user returns to tab (critical for mobile)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!ws || ws.readyState > 1) {
      // WS is dead, force reconnect
      connect();
    } else if (ws.readyState === 1 && currentSessionId) {
      // 仅在有流式状态时才主动 load_session 重新 attach；
      // 无任务时只刷新会话列表，避免触发 applySessionSnapshot → scrollToBottom 打断阅读
      if (isGenerating || currentSessionRunning || document.getElementById('streaming-msg')) {
        send({ type: 'load_session', sessionId: currentSessionId });
      } else {
        send({ type: 'list_sessions' });
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
