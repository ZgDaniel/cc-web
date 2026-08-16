/**
 * Claude 会话上下文水位估算与预防性压缩判定（P2 预防性水位压缩核心）。
 *
 * 设计约束（最高优先级）：
 *   - 纯函数、零副作用：只读 jsonl，不写任何状态，便于 regression 直接单测
 *   - 任何读取/解析失败一律返回 null / false（调用方静默走原流程，正常路径零改变）
 *
 * estimateClaudeContextUsage(jsonlPath)：
 *   读 Claude 原生 transcript jsonl（~/.claude/projects/<dir>/<sessionId>.jsonl），
 *   从文件末尾向前找最后一条含 usage 的 assistant 记录，返回
 *   input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 *   （≈ 下一次请求的上下文规模；cache 部分虽部分免费，但都计入请求体量）。
 *
 * shouldPreemptiveCompact(usageTokens, modelLabel, pctThreshold)：
 *   窗口大小 = /1m/i.test(modelLabel) ? 1,000,000 : 200,000；
 *   返回 usageTokens >= window * pct / 100。
 *
 * stream-json compact 事件形态（Claude CLI 2.1.145 实测，见 lib/agent-runtime.js P1 注释）：
 *   stdout stream-json 为 snake_case compact_metadata.{pre_tokens,post_tokens}；
 *   落盘 transcript jsonl 为 camelCase compactMetadata.{preTokens,postTokens}。
 */

const fs = require('fs');

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
 * 判断当前水位是否达到预防性压缩阈值。
 *
 * @param {number} usageTokens - estimateClaudeContextUsage 的返回值
 * @param {string} modelLabel - 模型标签，含 "[1m]" 视为 1M 窗口（如 claude-opus-4-6[1m]）
 * @param {number} pctThreshold - 阈值百分比（10-99，由调用方收敛）
 * @returns {boolean}
 */
function shouldPreemptiveCompact(usageTokens, modelLabel, pctThreshold) {
  const tokens = Number(usageTokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return false;
  const label = String(modelLabel || '');
  const windowTokens = /1m/i.test(label) ? 1_000_000 : 200_000;
  const pct = Number(pctThreshold);
  const pctValue = Number.isFinite(pct) ? pct : 80;
  return tokens >= (windowTokens * pctValue) / 100;
}

module.exports = { estimateClaudeContextUsage, shouldPreemptiveCompact };
