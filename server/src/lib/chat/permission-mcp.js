#!/usr/bin/env node
// Мини-MCP-сервер (stdio) для всплывашки разрешений чата GrigDesk.
// Запускается самим `claude` (--mcp-config) и указывается в --permission-prompt-tool:
// когда агенту нужно разрешение на инструмент, claude вызывает tools/call `approve`,
// мы пробрасываем запрос HTTP'ом в GrigDesk (тот показывает всплывашку в браузере)
// и возвращаем решение пользователя в формате PermissionResult.
//
// Протокол — newline-delimited JSON-RPC 2.0 (MCP stdio). Реализован вручную:
// три метода, тянуть SDK ради этого незачем.
import readline from 'node:readline';

const PERM_URL = process.env.GRIGDESK_PERM_URL || '';
const CHAT_KEY = process.env.GRIGDESK_CHAT_KEY || '';
// Секрет процесса-сервера: вход в GrigDesk закрывает весь /api, а этот MCP живёт в дочернем
// процессе claude — сессионной cookie у него нет и быть не может. Секрет держится только
// в памяти сервера и меняется с каждым запуском (см. internalToken в app.js).
const INTERNAL = process.env.GRIGDESK_INTERNAL || '';

const TOOL = {
  name: 'approve',
  description: 'Спросить у пользователя GrigDesk разрешение на выполнение инструмента',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input'],
  },
};

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'grigdesk-perm', version: '1.0.0' },
      },
    });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } });
  } else if (method === 'tools/call') {
    // Долгий запрос: GrigDesk держит его, пока пользователь не ответит (или таймаут → deny).
    let decision = { behavior: 'deny', message: 'GrigDesk недоступен — действие отклонено' };
    try {
      const r = await fetch(PERM_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Прежний X-GrigDesk-Token убран вместе с самим GRIGDESK_TOKEN.
          ...(INTERNAL ? { 'X-GrigDesk-Internal': INTERNAL } : {}),
        },
        body: JSON.stringify({ ...(params?.arguments || {}), chatKey: CHAT_KEY }),
      });
      if (r.ok) decision = await r.json();
    } catch { /* GrigDesk упал — остаётся deny */ }
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
  } else if (id !== undefined) {
    // ping и прочие неизвестные запросы — пустой успех, чтобы не ронять клиента
    send({ jsonrpc: '2.0', id, result: {} });
  }
});
