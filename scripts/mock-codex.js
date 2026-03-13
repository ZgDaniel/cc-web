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
  const isResume = args[0] === 'exec' && args[1] === 'resume';
  const threadId = (() => {
    if (!isResume) return `mock-${crypto.randomUUID()}`;
    for (let i = args.length - 1; i >= 2; i--) {
      const arg = args[i];
      if (arg === '-' || String(arg).startsWith('-')) continue;
      return arg;
    }
    return `mock-${crypto.randomUUID()}`;
  })();
  const input = (await readStdin()).trim();
  const imageCount = args.filter((arg) => arg === '--image').length;
  const statePath = path.join(os.tmpdir(), `cc-web-mock-codex-${threadId}.json`);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {}

  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`);

  if (/pwd/i.test(input)) {
    process.stdout.write(`${JSON.stringify({
      type: 'item.started',
      item: {
        id: 'item_cmd',
        type: 'command_execution',
        command: '/bin/bash -lc pwd',
        aggregated_output: '',
        exit_code: null,
        status: 'in_progress',
      },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_cmd',
        type: 'command_execution',
        command: '/bin/bash -lc pwd',
        aggregated_output: '/tmp/mock-codex\n',
        exit_code: 0,
        status: 'completed',
      },
    })}\n`);
  }

  if (input === '/compact') {
    state.compacted = true;
    fs.writeFileSync(statePath, JSON.stringify(state));
  }

  if (input === 'trigger codex context limit' && !state.compacted) {
    process.stdout.write(`${JSON.stringify({
      type: 'turn.failed',
      error: { message: 'Context window exceeded. Please use /compact and retry.' },
    })}\n`);
    process.exit(1);
  }

  const responseText = input === '/compact'
    ? 'Codex compact finished.'
    : `Codex mock handled (${imageCount} image): ${input}`;

  process.stdout.write(`${JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_msg',
      type: 'agent_message',
      text: responseText,
    },
  })}\n`);

  if (input === 'trigger codex context limit' && state.compacted) {
    try { fs.unlinkSync(statePath); } catch {}
  }

  process.stdout.write(`${JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 },
  })}\n`);
})();
