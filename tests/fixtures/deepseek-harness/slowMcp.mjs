import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [logFile] = process.argv.slice(2);
const log = (type) => appendFileSync(logFile, JSON.stringify({ at: Date.now(), type }) + '\n');
const reply = (id, result) => process.stdout.write(JSON.stringify({
  jsonrpc: '2.0',
  id,
  result,
}) + '\n');

// Сервер держит незавершённый tools/call и задерживает выход дольше host deadline.
// EOF и TERM записываются, поэтому отказ относится к реальному stdio teardown MCP.
setInterval(() => {}, 1000);
process.on('SIGTERM', () => log('sigterm'));

const lines = createInterface({ input: process.stdin });

lines.on('line', (line) => {
  const request = JSON.parse(line);

  if (request.method === 'initialize') {
    reply(request.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1' },
    });
  } else if (request.method === 'tools/list') {
    reply(request.id, { tools: [{
      name: 'hold',
      description: 'Проверка незавершённого MCP вызова',
      inputSchema: { type: 'object', properties: {} },
    }] });
  } else if (request.method === 'tools/call') {
    log('tool-start');
  } else if (request.id !== undefined) {
    reply(request.id, {});
  }
});
lines.on('close', () => {
  log('stdin-eof');
  setTimeout(() => {
    log('exit');
    process.exit(0);
  }, 5000);
});
