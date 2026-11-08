/**
 * Claude 会话上下文水位估算、上下文窗口解析与预防性压缩判定（P2 预防性水位压缩核心）。
 *
 * 设计约束（最高优先级）：
 *   - 判定类函数纯函数、零副作用：只读传入内容，不写任何状态，便于 regression 直接单测
 *   - 任何读取/解析失败一律返回 null / false / 缺省值（调用方静默走原流程，正常路径零改变）
 *
 * estimateClaudeContextUsage(jsonlPath)：
 *   读 Claude 原生 transcript jsonl（~/.claude/projects/<dir>/<sessionId>.jsonl），
 *   从文件末尾向前找最后一条含 usage 的 assistant 记录，返回
 *   input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 *   （≈ 下一次请求的上下文规模；cache 部分虽部分免费，但都计入请求体量）。
 *
 * resolveClaudeContextWindow() / resolveCodexContextWindow()：
 *   上下文窗口大小的唯一尺子（v1.6.1 起废除按模型名 [1m] 后缀推断）。
 *   - Claude：读 ~/.claude/settings.json 的 .env.CLAUDE_CODE_MAX_CONTEXT_TOKENS，
 *     为正整数则用之，否则缺省 200000
 *   - Codex：读 ~/.codex/config.toml 顶层键 model_context_window（简单行级解析，
 *     只认第一个 [table] 段头之前出现的键，避免误匹配嵌套 table 内同名键），
 *     为正整数则用之，否则缺省 272000
 *   - 两函数各自模块级缓存（首次读取后记住，配置不热变）；路径参数仅测试注入用
 *
 * shouldPreemptiveCompact(usageTokens, windowTokens, pctThreshold)：
 *   窗口大小由调用方传 resolveClaudeContextWindow() 的结果；
 *   返回 usageTokens >= windowTokens * pct / 100。
 *
 * stream-json compact 事件形态（Claude CLI 2.1.145 实测，见 lib/agent-runtime.js P1 注释）：
 *   stdout stream-json 为 snake_case compact_metadata.{pre_tokens,post_tokens}；
 *   落盘 transcript jsonl 为 camelCase compactMetadata.{preTokens,postTokens}。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CLAUDE_CONTEXT_WINDOW = 200000;
const DEFAULT_CODEX_CONTEXT_WINDOW = 272000;

// 解析结果缓存：key 为 `${kind}:${路径}`，首次读取后记住（配置不热变）
const contextWindowCache = new Map();

/** 从 jsonl 行解析出的 usage 三项之和；行不合法返回 null */
function sumUsageTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = Number(usage.input_tokens);
  if (!Number.isFinite(input) || input < 0) return null;
  let total = input;
  for (const key of ['cache_read_input_tokens', 'cache_creation_input_tokens']) {
    const value = Number(usage[key]);
    if (Number.isFinite(value) && value > 0) total += value;
  }
  return total;
}

/**
 * 估算某 Claude 会话下一次请求的上下文规模（tokens）。
 *
 * @param {string} jsonlPath - Claude 原生 transcript jsonl 路径
 * @returns {number|null} - 无法确凿读到水位时返回 null（调用方跳过预防压缩）
 */
function estimateClaudeContextUsage(jsonlPath) {
  if (!jsonlPath || typeof jsonlPath !== 'string') return null;
  let content;
  try {
    content = fs.readFileSync(jsonlPath, 'utf8');
  } catch {
    return null;
  }
  // jsonl 通常 <20MB，整体读入后按行倒序找最后一条带 usage 的 assistant 记录即可
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    if (!entry || entry.type !== 'assistant') continue;
    const total = sumUsageTokens(entry.message?.usage);
    if (total === null) continue;
    return total;
  }
  return null;
}

/**
 * 读 ~/.claude/settings.json 的 .env.CLAUDE_CODE_MAX_CONTEXT_TOKENS。
 *
 * @param {string} settingsPath - settings.json 路径（默认 ~/.claude/settings.json，测试可注入）
 * @returns {number|null} - 配置为正整数则返回该值，否则 null（调用方走缺省）
 */
function readClaudeMaxContextConfig(settingsPath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return null;
  }
  const value = Number(raw?.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * 读 ~/.codex/config.toml 顶层键 model_context_window（行级解析，非完整 TOML 解析器）。
 *
 * 只认第一个 `[table]` 段头之前出现的键（TOML 语义：段头之后的键属于该 table），
 * 避免误匹配嵌套 table（如 [model_providers.xx]）内的同名键。
 *
 * @param {string} configPath - config.toml 路径（默认 ~/.codex/config.toml，测试可注入）
 * @returns {number|null} - 配置为正整数则返回该值，否则 null（调用方走缺省）
 */
function readCodexModelContextWindow(configPath) {
  let content;
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }
  let sawTableHeader = false;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      sawTableHeader = true;
      continue;
    }
    if (sawTableHeader) continue;
    // TOML 整数允许下划线分隔（1_000_000），一并兼容
    const match = line.match(/^model_context_window\s*=\s*([0-9][0-9_]*)\s*(?:#.*)?$/);
    if (match) {
      const value = Number(match[1].replace(/_/g, ''));
      if (Number.isInteger(value) && value > 0) return value;
    }
  }
  return null;
}

/**
 * Claude 会话上下文窗口大小（唯一尺子，模块级缓存）。
 *
 * @param {string} [settingsPath] - 测试注入用；生产调用不传参
 * @returns {number} - 配置的正整数值，缺省 200000
 */
function resolveClaudeContextWindow(settingsPath) {
  const resolvedPath = settingsPath || path.join(os.homedir(), '.claude', 'settings.json');
  const cacheKey = `claude:${resolvedPath}`;
  if (contextWindowCache.has(cacheKey)) return contextWindowCache.get(cacheKey);
  const value = readClaudeMaxContextConfig(resolvedPath) || DEFAULT_CLAUDE_CONTEXT_WINDOW;
  contextWindowCache.set(cacheKey, value);
  return value;
}

/**
 * Codex 会话上下文窗口大小（唯一尺子，模块级缓存）。
 *
 * @param {string} [configPath] - 测试注入用；生产调用不传参
 * @returns {number} - 配置的正整数值，缺省 272000
 */
function resolveCodexContextWindow(configPath) {
  const resolvedPath = configPath || path.join(os.homedir(), '.codex', 'config.toml');
  const cacheKey = `codex:${resolvedPath}`;
  if (contextWindowCache.has(cacheKey)) return contextWindowCache.get(cacheKey);
  const value = readCodexModelContextWindow(resolvedPath) || DEFAULT_CODEX_CONTEXT_WINDOW;
  contextWindowCache.set(cacheKey, value);
  return value;
}

/**
 * 判断当前水位是否达到预防性压缩阈值。
 *
 * @param {number} usageTokens - estimateClaudeContextUsage 的返回值
 * @param {number} windowTokens - 窗口大小（由调用方传 resolveClaudeContextWindow() 的结果）
 * @param {number} pctThreshold - 阈值百分比（10-99，由调用方收敛）
 * @returns {boolean}
 */
function shouldPreemptiveCompact(usageTokens, windowTokens, pctThreshold) {
  const tokens = Number(usageTokens);
  const window = Number(windowTokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return false;
  if (!Number.isFinite(window) || window <= 0) return false;
  const pct = Number(pctThreshold);
  const pctValue = Number.isFinite(pct) ? pct : 80;
  return tokens >= (window * pctValue) / 100;
}

module.exports = {
  estimateClaudeContextUsage,
  shouldPreemptiveCompact,
  resolveClaudeContextWindow,
  resolveCodexContextWindow,
  readCodexModelContextWindow,
};
