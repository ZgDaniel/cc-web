#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

(async function main() {
  const args = process.argv.slice(2);
  const resumeIndex = args.indexOf('--resume');
  const inputFormatIndex = args.indexOf('--input-format');
  const sessionId = resumeIndex >= 0 && args[resumeIndex + 1]
    ? args[resumeIndex + 1]
    : crypto.randomUUID();

  const input = (await readStdin()).trim();
  const usesStreamJson = inputFormatIndex >= 0 && args[inputFormatIndex + 1] === 'stream-json';

  process.stdout.write(`${JSON.stringify({ type: 'system', session_id: sessionId })}\n`);

  // Resolve effectiveInput so /goal detection works for both text stdin and stream-json input.
  let streamPayload = null;
  let effectiveInput = input;
  if (usesStreamJson) {
    try { streamPayload = JSON.parse(input.split('\n').find(Boolean) || '{}'); } catch {}
    const blocks = streamPayload?.message?.content || [];
    effectiveInput = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text || '')
      .join(' ')
      .trim();
  }

  // Per-session compact state: mirrors mock-codex.js so the P0 auto-compact retry
  // chain (fail once with a token-limit error -> /compact -> replay) can be exercised.
  const statePath = path.join(os.tmpdir(), `cc-web-mock-claude-${sessionId}.json`);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {}

  if (/^\/goal(?:\s|$)/i.test(effectiveInput)) {
    // Simulate two-turn goal: assistant -> synthetic user(Stop hook feedback) -> assistant -> result.
    process.stdout.write(`${JSON.stringify({
      type: 'assistant',
      session_id: sessionId,
      message: { content: [{ type: 'text', text: 'GOAL_TURN_1' }] },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'user',
      session_id: sessionId,
      isSynthetic: true,
      message: { role: 'user', content: [{ type: 'text', text: 'Stop hook feedback:\n[goal]: keep going' }] },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'assistant',
      session_id: sessionId,
      message: { content: [{ type: 'text', text: 'GOAL_TURN_2' }] },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'result',
      session_id: sessionId,
      total_cost_usd: 0,
    })}\n`);
    return;
  }

  // Token-limit error mode (P0 coverage): the first run of this prompt fails like the
  // real CLI does when the resumed transcript exceeds the model context window.
  // cc-web must detect it (isContextLimitError) and auto-inject /compact + replay.
  if (effectiveInput === 'trigger claude context limit' && !state.compacted) {
    process.stderr.write('API Error: Prompt is too long: 1048576 tokens > 1000000 maximum\n');
    process.exit(1);
  }

  if (effectiveInput === '/compact') {
    state.compacted = true;
    fs.writeFileSync(statePath, JSON.stringify(state));
    process.stdout.write(`${JSON.stringify({
      type: 'assistant',
      session_id: sessionId,
      message: { content: [{ type: 'text', text: 'Claude compact finished.' }] },
    })}\n`);
    // Compact boundary event exactly as emitted on stream-json stdout by Claude CLI
    // (snake_case compact_metadata; the on-disk transcript uses camelCase compactMetadata).
    process.stdout.write(`${JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 93158, post_tokens: 5762, duration_ms: 1234 },
      session_id: sessionId,
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'result',
      session_id: sessionId,
      total_cost_usd: 0,
    })}\n`);
    return;
  }

  if (effectiveInput === 'trigger claude context limit' && state.compacted) {
    try { fs.unlinkSync(statePath); } catch {}
  }

  let text = '';
  if (usesStreamJson) {
    const blocks = streamPayload?.message?.content || [];
    const imageCount = blocks.filter((block) => block.type === 'image').length;
    text = `Claude mock handled stream-json (${imageCount} image): ${effectiveInput || '[no text]'}`;
  } else {
    text = `Claude mock handled: ${input}`;
  }

  process.stdout.write(`${JSON.stringify({
    type: 'assistant',
    session_id: sessionId,
    message: { content: [{ type: 'text', text }] },
  })}\n`);

  process.stdout.write(`${JSON.stringify({
    type: 'result',
    session_id: sessionId,
    total_cost_usd: 0,
  })}\n`);
})();
