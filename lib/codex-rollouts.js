const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createCodexRolloutStore(deps) {
  const { codexSessionsDir, sessionsDir, normalizeSession, sanitizeToolInput } = deps;

  function extractCodexMessageText(content) {
    if (!Array.isArray(content)) return '';
    return content
      .filter((item) => item && (item.type === 'input_text' || item.type === 'output_text'))
      .map((item) => item.text || '')
      .join('');
  }

  function appendAssistantContent(turn, text) {
    if (!turn || !text || !text.trim()) return;
    turn.content = turn.content ? `${turn.content}\n\n${text}` : text;
  }

  function parseCodexRolloutLines(lines) {
    const messages = [];
    const pendingToolCalls = new Map();
    const meta = { threadId: null, cwd: null, title: '', updatedAt: null, cliVersion: null, source: null };
    const totalUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    let currentAssistant = null;
    let sawRealUserMessage = false;
    const fallbackUserMessages = [];

    function ensureAssistant(ts) {
      if (!currentAssistant) {
        currentAssistant = { role: 'assistant', content: '', toolCalls: [], timestamp: ts || null };
      } else if (!currentAssistant.timestamp && ts) {
        currentAssistant.timestamp = ts;
      }
      return currentAssistant;
    }

    function flushAssistant() {
      if (!currentAssistant) return;
      if ((currentAssistant.content || '').trim() || currentAssistant.toolCalls.length > 0) {
        messages.push(currentAssistant);
      }
      currentAssistant = null;
      pendingToolCalls.clear();
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      const ts = entry.timestamp || null;
      if (ts) meta.updatedAt = ts;

      if (entry.type === 'session_meta') {
        meta.threadId = entry.payload?.id || meta.threadId;
        meta.cwd = entry.payload?.cwd || meta.cwd;
        meta.cliVersion = entry.payload?.cli_version || meta.cliVersion;
        meta.source = entry.payload?.source || meta.source;
        continue;
      }

      if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
        const total = entry.payload?.info?.total_token_usage || null;
        const usage = entry.payload?.info?.last_token_usage || null;
        if (total) {
          totalUsage.inputTokens = Math.max(totalUsage.inputTokens, total.input_tokens || 0);
          totalUsage.cachedInputTokens = Math.max(totalUsage.cachedInputTokens, total.cached_input_tokens || 0);
          totalUsage.outputTokens = Math.max(totalUsage.outputTokens, total.output_tokens || 0);
        } else if (usage) {
          totalUsage.inputTokens += usage.input_tokens || 0;
          totalUsage.cachedInputTokens += usage.cached_input_tokens || 0;
          totalUsage.outputTokens += usage.output_tokens || 0;
        }
        continue;
      }

      if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
        const text = String(entry.payload?.message || '').trim();
        if (text) {
          sawRealUserMessage = true;
          flushAssistant();
          if (!meta.title) meta.title = text.slice(0, 80).replace(/\n/g, ' ');
          messages.push({ role: 'user', content: text, timestamp: ts });
        }
        continue;
      }

      if (entry.type !== 'response_item') continue;

      const payload = entry.payload || {};
      switch (payload.type) {
      case 'message': {
        if (payload.role === 'assistant') {
          const text = extractCodexMessageText(payload.content);
          if (text.trim()) {
            if (currentAssistant && ((currentAssistant.content || '').trim() || currentAssistant.toolCalls.length > 0)) {
              flushAssistant();
            }
            appendAssistantContent(ensureAssistant(ts), text);
          }
        } else if (payload.role === 'user' && !sawRealUserMessage) {
          const text = extractCodexMessageText(payload.content);
          if (text.trim()) {
              fallbackUserMessages.push({ role: 'user', content: text, timestamp: ts });
          }
        }
        break;
      }
        case 'function_call': {
          const assistant = ensureAssistant(ts);
          const toolUseId = payload.call_id || payload.id || crypto.randomUUID();
          const tc = {
            name: payload.name || 'FunctionCall',
            id: toolUseId,
            input: sanitizeToolInput(payload.name || 'FunctionCall', payload.arguments || ''),
            done: false,
          };
          assistant.toolCalls.push(tc);
          pendingToolCalls.set(toolUseId, tc);
          break;
        }
        case 'function_call_output': {
          const assistant = ensureAssistant(ts);
          const toolUseId = payload.call_id || crypto.randomUUID();
          let tc = pendingToolCalls.get(toolUseId);
          if (!tc) {
            tc = { name: 'FunctionCall', id: toolUseId, input: null, done: false };
            assistant.toolCalls.push(tc);
            pendingToolCalls.set(toolUseId, tc);
          }
          tc.done = true;
          tc.result = (typeof payload.output === 'string'
            ? payload.output
            : JSON.stringify(payload.output || '')).slice(0, 2000);
          break;
        }
        default:
          break;
      }
    }

    flushAssistant();
    if (!sawRealUserMessage && fallbackUserMessages.length > 0) {
      const fallback = fallbackUserMessages[0];
      if (!meta.title) meta.title = fallback.content.trim().slice(0, 80).replace(/\n/g, ' ');
      return { meta, messages: fallbackUserMessages.concat(messages), totalUsage };
    }
    return { meta, messages, totalUsage };
  }

  function walkFiles(dir, files = []) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return files;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walkFiles(fullPath, files);
      else if (entry.isFile()) files.push(fullPath);
    }
    return files;
  }

  function getCodexRolloutFiles() {
    if (!fs.existsSync(codexSessionsDir)) return [];
    return walkFiles(codexSessionsDir, []).filter((filePath) => filePath.endsWith('.jsonl')).sort().reverse();
  }

  function getImportedCodexThreadIds() {
    const imported = new Set();
    try {
      for (const f of fs.readdirSync(sessionsDir).filter((name) => name.endsWith('.json'))) {
        try {
          const session = normalizeSession(JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')));
          if (session.codexThreadId) imported.add(session.codexThreadId);
        } catch {}
      }
    } catch {}
    return imported;
  }

  function parseCodexRolloutFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = parseCodexRolloutLines(content.split('\n'));
      parsed.filePath = filePath;
      return parsed;
    } catch {
      return null;
    }
  }

  return {
    parseCodexRolloutLines,
    getCodexRolloutFiles,
    getImportedCodexThreadIds,
    parseCodexRolloutFile,
  };
}

module.exports = { createCodexRolloutStore };
