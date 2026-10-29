import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const marker = process.argv[2];
const toolName = process.argv[3];

appendFileSync(`${marker}.started`, 'started\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);

  if (request.id === undefined) {
    return;
  }

  let result = {};

  if (request.method === 'initialize') {
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'permission-fixture', version: '1' },
    };
  } else if (request.method === 'tools/list') {
    result = { tools: [{
      name: toolName,
      description: 'Синтетический MCP для проверки границы dispatch',
      inputSchema: { type: 'object', properties: { action: { type: 'string' } } },
    }] };
  } else if (request.method === 'tools/call') {
    appendFileSync(marker, `${JSON.stringify(request.params.arguments)}\n`);
    result = { content: [{ type: 'text', text: 'fixture-result' }] };
  }

  const response = {
    jsonrpc: '2.0',
    id: request.id,
    result,
  };

  process.stdout.write(`${JSON.stringify(response)}\n`);
});
