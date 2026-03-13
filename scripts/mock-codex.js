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
  const isResume = args[0] === 'exec' && args[1] === 'resume';
  const threadId = isResume && args[2] ? args[2] : `mock-${crypto.randomUUID()}`;
  const input = (await readStdin()).trim();
  const imageCount = args.filter((arg) => arg === '--image').length;

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

  process.stdout.write(`${JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_msg',
      type: 'agent_message',
      text: `Codex mock handled (${imageCount} image): ${input}`,
    },
  })}\n`);

  process.stdout.write(`${JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 },
  })}\n`);
})();
