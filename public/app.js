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

  const MODEL_OPTIONS = [
    { value: 'opus', label: 'Opus', desc: '最强大，适合复杂任务' },
    { value: 'sonnet', label: 'Sonnet', desc: '平衡性能与速度' },
    { value: 'haiku', label: 'Haiku', desc: '最快速，适合简单任务' },
  ];

  const MODE_PICKER_OPTIONS = [
    { value: 'yolo', label: 'YOLO', desc: '跳过所有权限检查' },
    { value: 'plan', label: 'Plan', desc: '执行前需确认计划' },
    { value: 'default', label: '默认', desc: '标准权限审批' },
  ];

  // --- State ---
  let ws = null;
  let authToken = localStorage.getItem('cc-web-token');
  let currentSessionId = null;
  let sessions = [];
  let isGenerating = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let pendingText = '';
  let renderTimer = null;
  let activeToolCalls = new Map();
  let cmdMenuIndex = -1;
  let currentMode = localStorage.getItem('cc-web-mode') || 'yolo';
  let currentModel = 'opus';
  let loginPasswordValue = ''; // store login password for force-change flow

  // --- DOM ---
  const $ = (sel) => document.querySelector(sel);
  const loginOverlay = $('#login-overlay');
  const loginForm = $('#login-form');
  const loginPassword = $('#login-password');
  const loginError = $('#login-error');
  const rememberPw = $('#remember-pw');
  const app = $('#app');
  const sidebar = $('#sidebar');
  const sidebarOverlay = $('#sidebar-overlay');
  const menuBtn = $('#menu-btn');
  const newChatBtn = $('#new-chat-btn');
  const sessionList = $('#session-list');
  const chatTitle = $('#chat-title');
  const costDisplay = $('#cost-display');
  const messagesDiv = $('#messages');
  const msgInput = $('#msg-input');
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

  // --- marked config ---
  const renderer = new marked.Renderer();
  renderer.code = function (code, language) {
    const lang = language || 'plaintext';
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
    return `<div class="code-block-wrapper">
      <div class="code-block-header">
        <span>${escapeHtml(lang)}</span>
        <button class="code-copy-btn" onclick="ccCopyCode(this)">Copy</button>
      </div>
      <pre><code class="hljs language-${escapeHtml(lang)}">${highlighted}</code></pre>
    </div>`;
  };
  marked.setOptions({ renderer, breaks: true, gfm: true });

  window.ccCopyCode = function (btn) {
    const code = btn.closest('.code-block-wrapper').querySelector('code').textContent;
    navigator.clipboard.writeText(code).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    });
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

    ws.onclose = () => scheduleReconnect();
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
          loginOverlay.hidden = true;
          app.hidden = false;
          // Check if must change password
          if (msg.mustChangePassword) {
            showForceChangePassword();
          } else {
            // Auto-load last viewed session
            const lastSession = localStorage.getItem('cc-web-session');
            if (lastSession) {
              send({ type: 'load_session', sessionId: lastSession });
            }
          }
        } else {
          authToken = null;
          localStorage.removeItem('cc-web-token');
          loginOverlay.hidden = false;
          app.hidden = true;
          loginError.hidden = false;
        }
        break;

      case 'session_list':
        sessions = msg.sessions || [];
        renderSessionList();
        break;

      case 'session_info':
        // Reset generating state (will be re-set by resume_generating if process is active)
        if (isGenerating) {
          isGenerating = false;
          sendBtn.hidden = false;
          abortBtn.hidden = true;
          pendingText = '';
          activeToolCalls.clear();
        }
        currentSessionId = msg.sessionId;
        localStorage.setItem('cc-web-session', currentSessionId);
        chatTitle.textContent = msg.title || '新会话';
        // 同步 session 的 mode（如有）
        if (msg.mode && MODE_LABELS[msg.mode]) {
          currentMode = msg.mode;
          modeSelect.value = currentMode;
          localStorage.setItem('cc-web-mode', currentMode);
        }
        // 同步 session 的 model（如有）
        if (msg.model) {
          currentModel = msg.model;
        }
        renderMessages(msg.messages || []);
        highlightActiveSession();
        closeSidebar();
        // Show notification for sessions completed in background
        if (msg.hasUnread) {
          showToast('后台任务已完成', msg.sessionId);
        }
        break;

      case 'session_renamed':
        if (msg.sessionId === currentSessionId) {
          chatTitle.textContent = msg.title;
        }
        break;

      case 'text_delta':
        if (!isGenerating) startGenerating();
        pendingText += msg.text;
        scheduleRender();
        break;

      case 'tool_start':
        if (!isGenerating) startGenerating();
        activeToolCalls.set(msg.toolUseId, { name: msg.name, input: msg.input, done: false });
        appendToolCall(msg.toolUseId, msg.name, msg.input, false);
        break;

      case 'tool_end':
        if (activeToolCalls.has(msg.toolUseId)) {
          activeToolCalls.get(msg.toolUseId).done = true;
        }
        updateToolCall(msg.toolUseId, msg.result);
        break;

      case 'cost':
        costDisplay.textContent = `$${msg.costUsd.toFixed(4)}`;
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
          localStorage.setItem('cc-web-mode', currentMode);
        }
        break;

      case 'model_changed':
        if (msg.model) {
          currentModel = msg.model;
        }
        break;

      case 'resume_generating':
        // Server has an active process for this session — resume streaming
        startGenerating();
        pendingText = msg.text || '';
        if (pendingText) flushRender();
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            activeToolCalls.set(tc.id, { name: tc.name, done: tc.done });
            appendToolCall(tc.id, tc.name, tc.input, tc.done);
            if (tc.done && tc.result) {
              updateToolCall(tc.id, tc.result);
            }
          }
        }
        break;

      case 'error':
        appendError(msg.message);
        if (isGenerating) finishGenerating();
        break;

      case 'notify_config':
        if (typeof _onNotifyConfig === 'function') _onNotifyConfig(msg.config);
        break;

      case 'notify_test_result':
        if (typeof _onNotifyTestResult === 'function') _onNotifyTestResult(msg);
        break;

      case 'model_config':
        if (typeof _onModelConfig === 'function') _onModelConfig(msg.config);
        break;

      case 'background_done':
        // A background task completed (browser was disconnected or viewing another session)
        showToast(`「${msg.title}」任务完成`, msg.sessionId);
        showBrowserNotification(msg.title);
        if (msg.sessionId === currentSessionId) {
          // Reload current session to show completed response
          send({ type: 'load_session', sessionId: msg.sessionId });
        } else {
          send({ type: 'list_sessions' });
        }
        break;

      case 'password_changed':
        handlePasswordChanged(msg);
        break;
    }
  }

  // --- Generating State ---
  function startGenerating() {
    isGenerating = true;
    pendingText = '';
    activeToolCalls.clear();
    sendBtn.hidden = true;
    abortBtn.hidden = false;
    // 不禁用输入框，允许用户继续输入（但无法发送）

    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();

    const msgEl = createMsgElement('assistant', '');
    msgEl.id = 'streaming-msg';
    messagesDiv.appendChild(msgEl);
    scrollToBottom();
  }

  function finishGenerating(sessionId) {
    isGenerating = false;
    sendBtn.hidden = false;
    abortBtn.hidden = true;
    msgInput.focus();

    if (pendingText) flushRender();

    const typing = document.querySelector('.typing-indicator');
    if (typing) typing.remove();

    const streamEl = document.getElementById('streaming-msg');
    if (streamEl) streamEl.removeAttribute('id');

    if (sessionId) currentSessionId = sessionId;
    pendingText = '';
    activeToolCalls.clear();
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
    bubble.innerHTML = renderMarkdown(pendingText);
    scrollToBottom();
  }

  function renderMarkdown(text) {
    if (!text) return '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    try { return marked.parse(text); }
    catch { return escapeHtml(text); }
  }

  function createMsgElement(role, content) {
    const div = document.createElement('div');
    div.className = `msg ${role}`;

    if (role === 'system') {
      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';
      bubble.textContent = content;
      div.appendChild(bubble);
      return div;
    }

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = role === 'user' ? 'U' : 'C';

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    if (role === 'user') {
      bubble.textContent = content;
    } else {
      bubble.innerHTML = content ? renderMarkdown(content) : '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    }

    div.appendChild(avatar);
    div.appendChild(bubble);
    return div;
  }

  function renderMessages(messages) {
    messagesDiv.innerHTML = '';
    if (messages.length === 0) {
      messagesDiv.innerHTML = '<div class="welcome-msg"><div class="welcome-icon">✿</div><h3>欢迎使用 CC-Web</h3><p>开始与 Claude Code 对话</p></div>';
      return;
    }
    for (const m of messages) {
      const el = createMsgElement(m.role, m.content);
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        const bubble = el.querySelector('.msg-bubble');
        for (const tc of m.toolCalls) {
          const details = document.createElement('details');
          details.className = 'tool-call';
          details.dataset.toolName = tc.name || '';
          if (tc.name === 'AskUserQuestion') details.open = true;

          const summary = document.createElement('summary');
          summary.innerHTML = `<span class="tool-call-icon done"></span> ${escapeHtml(tc.name)}`;
          details.appendChild(summary);

          const displayInput = tc.name === 'AskUserQuestion' ? tc.input : (tc.result || tc.input);
          details.appendChild(buildToolContentElement(tc.name, displayInput));

          bubble.insertBefore(details, bubble.firstChild);
        }
      }
      messagesDiv.appendChild(el);
    }
    scrollToBottom();
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
        const opts = document.createElement('div');
        opts.className = 'ask-question-options';
        q.options.forEach((opt, i) => {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'ask-option-item';
          item.addEventListener('click', () => appendAskOptionToInput(q, opt));

          const title = document.createElement('div');
          title.className = 'ask-option-label';
          title.textContent = `${i + 1}. ${opt.label || ''}`;
          item.appendChild(title);

          if (opt.description) {
            const desc = document.createElement('div');
            desc.className = 'ask-option-desc';
            desc.textContent = opt.description;
            item.appendChild(desc);
          }

          opts.appendChild(item);
        });
        card.appendChild(opts);
      }

      wrapper.appendChild(card);
    });

    return wrapper;
  }

  function buildToolContentElement(name, input) {
    if (name === 'AskUserQuestion') {
      const questions = extractAskUserQuestions(input);
      if (questions.length > 0) {
        return createAskUserQuestionView(questions);
      }
    }
    const inputStr = typeof input === 'string' ? input : (input ? JSON.stringify(input, null, 2) : '');
    const content = document.createElement('div');
    content.className = 'tool-call-content';
    content.textContent = inputStr;
    return content;
  }

  function appendToolCall(toolUseId, name, input, done) {
    const streamEl = document.getElementById('streaming-msg');
    if (!streamEl) return;
    const bubble = streamEl.querySelector('.msg-bubble');
    if (!bubble) return;

    const details = document.createElement('details');
    details.className = 'tool-call';
    details.id = `tool-${toolUseId}`;
    details.dataset.toolName = name || '';
    if (name === 'AskUserQuestion') details.open = true;

    const summary = document.createElement('summary');
    summary.innerHTML = `<span class="tool-call-icon ${done ? 'done' : 'running'}"></span> ${escapeHtml(name)}`;
    details.appendChild(summary);
    details.appendChild(buildToolContentElement(name, input));

    bubble.appendChild(details);
    scrollToBottom();
  }

  function updateToolCall(toolUseId, result) {
    const el = document.getElementById(`tool-${toolUseId}`);
    if (!el) return;
    const icon = el.querySelector('.tool-call-icon');
    if (icon) { icon.classList.remove('running'); icon.classList.add('done'); }
    if (result) {
      if (el.dataset.toolName === 'AskUserQuestion') {
        return;
      }
      const content = el.querySelector('.tool-call-content');
      if (content) content.textContent = result;
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
    });
  }

  // --- Session List ---
  function renderSessionList() {
    sessionList.innerHTML = '';
    for (const s of sessions) {
      const item = document.createElement('div');
      item.className = `session-item${s.id === currentSessionId ? ' active' : ''}`;
      item.dataset.id = s.id;
      item.innerHTML = `
        <span class="session-item-title">${escapeHtml(s.title || 'Untitled')}</span>
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
          if (confirm('删除此会话？')) {
            send({ type: 'delete_session', sessionId: s.id });
            if (s.id === currentSessionId) {
              currentSessionId = null;
              messagesDiv.innerHTML = '<div class="welcome-msg"><div class="welcome-icon">✿</div><h3>欢迎使用 CC-Web</h3><p>开始与 Claude Code 对话</p></div>';
              chatTitle.textContent = '新会话';
              costDisplay.textContent = '';
            }
          }
          return;
        }
        if (target.classList.contains('edit')) {
          e.stopPropagation();
          startEditSessionTitle(item, s);
          return;
        }
        send({ type: 'load_session', sessionId: s.id });
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
    showOptionPicker('选择模型', MODEL_OPTIONS, currentModel, (value) => {
      send({ type: 'message', text: `/model ${value}`, sessionId: currentSessionId, mode: currentMode });
    });
  }

  function showModePicker() {
    showOptionPicker('选择权限模式', MODE_PICKER_OPTIONS, currentMode, (value) => {
      currentMode = value;
      modeSelect.value = currentMode;
      localStorage.setItem('cc-web-mode', currentMode);
      if (currentSessionId) {
        send({ type: 'set_mode', sessionId: currentSessionId, mode: currentMode });
      }
    });
  }

  // --- Send Message ---
  function sendMessage() {
    const text = msgInput.value.trim();
    if (!text || isGenerating) return;
    hideCmdMenu();
    hideOptionPicker();

    // Slash commands: don't show as user bubble
    if (text.startsWith('/')) {
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
      send({ type: 'message', text, sessionId: currentSessionId, mode: currentMode });
      msgInput.value = '';
      autoResize();
      return;
    }

    // Regular message
    const welcome = messagesDiv.querySelector('.welcome-msg');
    if (welcome) welcome.remove();
    messagesDiv.appendChild(createMsgElement('user', text));
    scrollToBottom();

    send({ type: 'message', text, sessionId: currentSessionId, mode: currentMode });
    msgInput.value = '';
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
  newChatBtn.addEventListener('click', () => send({ type: 'new_session' }));
  sendBtn.addEventListener('click', sendMessage);
  abortBtn.addEventListener('click', () => send({ type: 'abort' }));

  // Mode selector
  modeSelect.value = currentMode;
  modeSelect.addEventListener('change', () => {
    currentMode = modeSelect.value;
    localStorage.setItem('cc-web-mode', currentMode);
    if (currentSessionId) {
      send({ type: 'set_mode', sessionId: currentSessionId, mode: currentMode });
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
        send({ type: 'load_session', sessionId });
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

  const settingsBtn = $('#settings-btn');

  const PROVIDER_OPTIONS = [
    { value: 'off', label: '关闭' },
    { value: 'pushplus', label: 'PushPlus' },
    { value: 'telegram', label: 'Telegram' },
    { value: 'serverchan', label: 'Server酱' },
    { value: 'feishu', label: '飞书机器人' },
    { value: 'qqbot', label: 'QQ（Qmsg）' },
  ];

  function showSettingsPanel() {
    // Request current configs
    send({ type: 'get_notify_config' });
    send({ type: 'get_model_config' });

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

      <div class="settings-section-title">模型配置</div>
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

      <div class="settings-section-title">通知设置</div>
      <div class="settings-field">
        <label>通知方式</label>
        <select class="settings-select" id="notify-provider">
          ${PROVIDER_OPTIONS.map(o => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join('')}
        </select>
      </div>
      <div id="notify-fields"></div>
      <div class="settings-actions">
        <button class="btn-test" id="notify-test-btn">测试</button>
        <button class="btn-save" id="notify-save-btn">保存</button>
      </div>
      <div class="settings-status" id="notify-status"></div>

      <div class="settings-divider"></div>

      <div class="settings-section-title">修改密码</div>
      <div class="settings-field">
        <label>当前密码</label>
        <input type="password" id="settings-current-pw" placeholder="当前密码" autocomplete="current-password">
      </div>
      <div class="settings-field">
        <label>新密码</label>
        <input type="password" id="settings-new-pw" placeholder="新密码" autocomplete="new-password">
        <div class="password-hint" id="settings-pw-hint">至少 8 位，包含大写/小写/数字/特殊字符中的 2 种</div>
      </div>
      <div class="settings-field">
        <label>确认新密码</label>
        <input type="password" id="settings-confirm-pw" placeholder="确认新密码" autocomplete="new-password">
      </div>
      <div class="settings-actions">
        <button class="btn-save" id="pw-change-btn" disabled>修改密码</button>
      </div>
      <div class="settings-status" id="pw-status"></div>
    `;

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

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
        modelCustomArea.innerHTML = `<div class="settings-field" style="color:var(--text-secondary);font-size:0.85em">读取 ~/.claude.json 中的 ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL 字段覆盖模型名称。</div>`;
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
            <button class="btn-test" id="model-tpl-del" title="删除" style="padding:4px 8px">删除</button>
          </div>
        </div>
        ${tpl ? `
        <div class="settings-field">
          <label>模板名称</label>
          <input type="text" id="model-tpl-name" placeholder="模板名称" value="${escapeHtml(tpl.name)}">
        </div>
        <div class="settings-field">
          <label>API Key</label>
          <input type="text" id="model-tpl-apikey" placeholder="sk-ant-..." value="${escapeHtml(tpl.apiKey || '')}">
        </div>
        <div class="settings-field">
          <label>API Base URL</label>
          <input type="text" id="model-tpl-apibase" placeholder="https://api.anthropic.com" value="${escapeHtml(tpl.apiBase || '')}">
        </div>
        <div class="settings-field">
          <label>默认模型 (ANTHROPIC_MODEL)</label>
          <input type="text" id="model-tpl-default" placeholder="claude-opus-4-6" value="${escapeHtml(tpl.defaultModel || '')}">
        </div>
        <div class="settings-field">
          <label>Opus 模型名</label>
          <input type="text" id="model-tpl-opus" placeholder="claude-opus-4-6" value="${escapeHtml(tpl.opusModel || '')}">
        </div>
        <div class="settings-field">
          <label>Sonnet 模型名</label>
          <input type="text" id="model-tpl-sonnet" placeholder="claude-sonnet-4-6" value="${escapeHtml(tpl.sonnetModel || '')}">
        </div>
        <div class="settings-field">
          <label>Haiku 模型名</label>
          <input type="text" id="model-tpl-haiku" placeholder="claude-haiku-4-5-20251001" value="${escapeHtml(tpl.haikuModel || '')}">
        </div>
        ` : ''}
      `;

      panel.querySelector('#model-tpl-select').addEventListener('change', (e) => {
        if (e.target.value === '__new__') {
          const newName = prompt('输入新模板名称:');
          if (!newName || !newName.trim()) { e.target.value = modelActiveTemplate; return; }
          const n = newName.trim();
          if (modelEditingTemplates.find(t => t.name === n)) { alert('模板名称已存在'); e.target.value = modelActiveTemplate; return; }
          modelEditingTemplates.push({ name: n, apiKey: '', apiBase: '', defaultModel: '', opusModel: '', sonnetModel: '', haikuModel: '' });
          modelActiveTemplate = n;
        } else {
          saveTplFields();
          modelActiveTemplate = e.target.value;
        }
        renderModelTemplateEditor();
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

    function saveTplFields() {
      const tpl = modelEditingTemplates.find(t => t.name === modelActiveTemplate);
      if (!tpl) return;
      const nameEl = panel.querySelector('#model-tpl-name');
      const apikeyEl = panel.querySelector('#model-tpl-apikey');
      const apibaseEl = panel.querySelector('#model-tpl-apibase');
      const defaultEl = panel.querySelector('#model-tpl-default');
      const opusEl = panel.querySelector('#model-tpl-opus');
      const sonnetEl = panel.querySelector('#model-tpl-sonnet');
      const haikuEl = panel.querySelector('#model-tpl-haiku');
      if (nameEl && nameEl.value.trim()) tpl.name = nameEl.value.trim();
      if (apikeyEl) tpl.apiKey = apikeyEl.value.trim();
      if (apibaseEl) tpl.apiBase = apibaseEl.value.trim();
      if (defaultEl) tpl.defaultModel = defaultEl.value.trim();
      if (opusEl) tpl.opusModel = opusEl.value.trim();
      if (sonnetEl) tpl.sonnetModel = sonnetEl.value.trim();
      if (haikuEl) tpl.haikuModel = haikuEl.value.trim();
      modelActiveTemplate = tpl.name;
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

    // === Notify Config UI ===
    const providerSelect = panel.querySelector('#notify-provider');
    const fieldsDiv = panel.querySelector('#notify-fields');
    const statusDiv = panel.querySelector('#notify-status');
    const closeBtn = panel.querySelector('.settings-close');
    const testBtn = panel.querySelector('#notify-test-btn');
    const saveBtn = panel.querySelector('#notify-save-btn');

    let currentConfig = null;

    function renderFields(provider) {
      fieldsDiv.innerHTML = '';
      if (provider === 'pushplus') {
        fieldsDiv.innerHTML = `
          <div class="settings-field">
            <label>Token</label>
            <input type="text" id="notify-pushplus-token" placeholder="PushPlus Token" value="${escapeHtml(currentConfig?.pushplus?.token || '')}">
          </div>
        `;
      } else if (provider === 'telegram') {
        fieldsDiv.innerHTML = `
          <div class="settings-field">
            <label>Bot Token</label>
            <input type="text" id="notify-tg-bottoken" placeholder="123456:ABC-DEF..." value="${escapeHtml(currentConfig?.telegram?.botToken || '')}">
          </div>
          <div class="settings-field">
            <label>Chat ID</label>
            <input type="text" id="notify-tg-chatid" placeholder="Chat ID" value="${escapeHtml(currentConfig?.telegram?.chatId || '')}">
          </div>
        `;
      } else if (provider === 'serverchan') {
        fieldsDiv.innerHTML = `
          <div class="settings-field">
            <label>SendKey</label>
            <input type="text" id="notify-sc-sendkey" placeholder="Server酱 SendKey" value="${escapeHtml(currentConfig?.serverchan?.sendKey || '')}">
          </div>
        `;
      } else if (provider === 'feishu') {
        fieldsDiv.innerHTML = `
          <div class="settings-field">
            <label>Webhook 地址</label>
            <input type="text" id="notify-feishu-webhook" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxx" value="${escapeHtml(currentConfig?.feishu?.webhook || '')}">
          </div>
        `;
      } else if (provider === 'qqbot') {
        fieldsDiv.innerHTML = `
          <div class="settings-field">
            <label>Qmsg Key</label>
            <input type="text" id="notify-qmsg-key" placeholder="Qmsg 推送 Key" value="${escapeHtml(currentConfig?.qqbot?.qmsgKey || '')}">
          </div>
        `;
      }
    }

    providerSelect.addEventListener('change', () => renderFields(providerSelect.value));

    function collectConfig() {
      const provider = providerSelect.value;
      const config = { provider };
      const pp = panel.querySelector('#notify-pushplus-token');
      const tgBot = panel.querySelector('#notify-tg-bottoken');
      const tgChat = panel.querySelector('#notify-tg-chatid');
      const sc = panel.querySelector('#notify-sc-sendkey');
      const feishuWh = panel.querySelector('#notify-feishu-webhook');
      const qmsgKey = panel.querySelector('#notify-qmsg-key');
      config.pushplus = { token: pp ? pp.value.trim() : (currentConfig?.pushplus?.token || '') };
      config.telegram = { botToken: tgBot ? tgBot.value.trim() : (currentConfig?.telegram?.botToken || ''), chatId: tgChat ? tgChat.value.trim() : (currentConfig?.telegram?.chatId || '') };
      config.serverchan = { sendKey: sc ? sc.value.trim() : (currentConfig?.serverchan?.sendKey || '') };
      config.feishu = { webhook: feishuWh ? feishuWh.value.trim() : (currentConfig?.feishu?.webhook || '') };
      config.qqbot = { qmsgKey: qmsgKey ? qmsgKey.value.trim() : (currentConfig?.qqbot?.qmsgKey || '') };
      return config;
    }

    function showStatus(msg, type) {
      statusDiv.textContent = msg;
      statusDiv.className = 'settings-status ' + type;
    }

    _onNotifyConfig = (config) => {
      currentConfig = config;
      providerSelect.value = config.provider || 'off';
      renderFields(config.provider || 'off');
    };

    _onNotifyTestResult = (msg) => {
      showStatus(msg.message, msg.success ? 'success' : 'error');
    };

    closeBtn.addEventListener('click', hideSettingsPanel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) hideSettingsPanel(); });

    testBtn.addEventListener('click', () => {
      // Save first then test
      const config = collectConfig();
      send({ type: 'save_notify_config', config });
      showStatus('正在发送测试消息...', '');
      send({ type: 'test_notify' });
    });

    saveBtn.addEventListener('click', () => {
      const config = collectConfig();
      send({ type: 'save_notify_config', config });
      showStatus('已保存', 'success');
    });

    // Password change in settings
    const settingsCurrentPw = panel.querySelector('#settings-current-pw');
    const settingsNewPw = panel.querySelector('#settings-new-pw');
    const settingsConfirmPw = panel.querySelector('#settings-confirm-pw');
    const pwHint = panel.querySelector('#settings-pw-hint');
    const pwChangeBtn = panel.querySelector('#pw-change-btn');
    const pwStatus = panel.querySelector('#pw-status');

    function checkSettingsPw() {
      const newPw = settingsNewPw.value;
      const confirmPw = settingsConfirmPw.value;
      const currentPw = settingsCurrentPw.value;
      if (!newPw) {
        pwHint.textContent = '至少 8 位，包含大写/小写/数字/特殊字符中的 2 种';
        pwHint.className = 'password-hint';
        pwChangeBtn.disabled = true;
        return;
      }
      const result = clientValidatePassword(newPw);
      if (!result.valid) {
        pwHint.textContent = result.message;
        pwHint.className = 'password-hint error';
        pwChangeBtn.disabled = true;
        return;
      }
      pwHint.textContent = '密码强度符合要求';
      pwHint.className = 'password-hint success';
      pwChangeBtn.disabled = !currentPw || !confirmPw || confirmPw !== newPw;
    }

    settingsCurrentPw.addEventListener('input', checkSettingsPw);
    settingsNewPw.addEventListener('input', checkSettingsPw);
    settingsConfirmPw.addEventListener('input', checkSettingsPw);

    pwChangeBtn.addEventListener('click', () => {
      const currentPw = settingsCurrentPw.value;
      const newPw = settingsNewPw.value;
      const confirmPw = settingsConfirmPw.value;
      if (newPw !== confirmPw) {
        pwStatus.textContent = '两次密码不一致';
        pwStatus.className = 'settings-status error';
        return;
      }
      pwChangeBtn.disabled = true;
      pwStatus.textContent = '正在修改...';
      pwStatus.className = 'settings-status';
      _onPasswordChanged = (result) => {
        if (result.success) {
          pwStatus.textContent = result.message || '密码修改成功';
          pwStatus.className = 'settings-status success';
          settingsCurrentPw.value = '';
          settingsNewPw.value = '';
          settingsConfirmPw.value = '';
          pwHint.textContent = '至少 8 位，包含大写/小写/数字/特殊字符中的 2 种';
          pwHint.className = 'password-hint';
        } else {
          pwStatus.textContent = result.message || '修改失败';
          pwStatus.className = 'settings-status error';
          pwChangeBtn.disabled = false;
        }
      };
      send({ type: 'change_password', currentPassword: currentPw, newPassword: newPw });
    });

    document.addEventListener('keydown', _settingsEscape);
  }

  function hideSettingsPanel() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay) overlay.remove();
    _onNotifyConfig = null;
    _onNotifyTestResult = null;
    _onModelConfig = null;
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
        const lastSession = localStorage.getItem('cc-web-session');
        if (lastSession) {
          send({ type: 'load_session', sessionId: lastSession });
        }
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
  connect();

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
      // WS alive, re-check session state to sync UI (fixes stuck stop button)
      send({ type: 'load_session', sessionId: currentSessionId });
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
