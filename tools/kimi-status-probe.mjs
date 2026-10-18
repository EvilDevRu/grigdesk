#!/usr/bin/env node
// Разовая диагностика: что реально отвечает локальная ACP-команда /status
// на установленном host CLI. Модель не вызывается, квота не тратится.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { createAcpClient, initializeKimiAcp } from '../server/src/lib/kimi/acpClient.ts';

const KIMI_BIN = process.env.GRIGDESK_KIMI_BIN || path.join(os.homedir(), '.kimi-code', 'bin', 'kimi');

function textOf(content) {
  if (!content) return '';
  if (content.type === 'content' && content.content?.type === 'text') return content.content.text || '';
  if (content.type === 'text') return content.text || '';
  return '';
}

const child = spawn(KIMI_BIN, ['acp'], {
  cwd: process.cwd(),
  env: { ...process.env, KIMI_DISABLE_CRON: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let statusText = '';
const kinds = {};
const client = createAcpClient(child, {
  onNotification(method, params) {
    if (method !== 'session/update') return;
    const update = params?.update;
    const kind = update?.sessionUpdate || 'unknown';
    kinds[kind] = (kinds[kind] || 0) + 1;
    if (kind === 'agent_message_chunk') statusText += textOf(update.content);
    else console.error('update:', JSON.stringify(update).slice(0, 400));
  },
  async onReverseRequest() { return { outcome: { outcome: 'cancelled' } }; },
});

try {
  const info = await initializeKimiAcp(client);
  console.error('agent:', JSON.stringify(info?.agentInfo));
  const created = await client.request('session/new', { cwd: process.cwd(), mcpServers: [] }, 30_000);
  const sessionId = String(created?.sessionId || '');
  console.error('session:', sessionId);
  for (const cmd of ['/status', '/usage']) {
    statusText = '';
    const res = await client.request('session/prompt', {
      sessionId, prompt: [{ type: 'text', text: cmd }],
    }, 15_000).catch((e) => ({ error: e?.message }));
    console.error(`${cmd} result:`, JSON.stringify(res));
    console.log(`===== ${cmd} TEXT =====`);
    console.log(JSON.stringify(statusText));
  }
  console.error('kinds:', JSON.stringify(kinds));
} finally {
  client.close();
  child.kill('SIGTERM');
}
