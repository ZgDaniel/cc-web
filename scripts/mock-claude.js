#!/usr/bin/env node

const crypto = require('crypto');

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

  let text = '';
  if (usesStreamJson) {
    const blocks = streamPayload?.message?.content || [];
    const imageCount = blocks.filter((block) => block.type === 'image').length;
    text = `Claude mock handled stream-json (${imageCount} image): ${effectiveInput || '[no text]'}`;
  } else if (input === '/compact') {
    text = 'Claude compact finished.';
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
