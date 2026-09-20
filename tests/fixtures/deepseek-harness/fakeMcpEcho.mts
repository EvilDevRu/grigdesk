import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: {
    name?: unknown;
    arguments?: unknown;
  };
}

function response(message: JsonRpcRequest) {
  const base = { jsonrpc: '2.0', id: message.id ?? null };

  if (message.method === 'initialize') {
    return {
      ...base,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'deepseek-p0-echo', version: '1.0.0' },
      },
    };
  }

  if (message.method === 'tools/list') {
    return {
      ...base,
      result: {
        tools: [{
          name: 'echo',
          description: 'Возвращает переданный текст для P0-проверки MCP.',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
        }],
      },
    };
  }

  if (message.method === 'tools/call' && message.params?.name === 'echo') {
    return {
      ...base,
      result: {
        content: [{
          type: 'text',
          text: JSON.stringify(message.params.arguments || {}),
        }],
        isError: false,
      },
    };
  }

  return {
    ...base,
    error: { code: -32601, message: `Метод ${message.method || '?'} не поддерживается` },
  };
}

/**
 * Фикстура пишет только специально выданную canary-переменную: весь process.env
 * сохранять нельзя, иначе тестовый артефакт способен унести секреты машины.
 */
async function recordEnvironment() {
  const outputDir = process.env.FAKE_MCP_OUTPUT_DIR;

  if (!outputDir) {
    return;
  }

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'mcp-env.json'), `${JSON.stringify({
    canary: process.env.FAKE_MCP_CANARY || null,
  }, null, 2)}\n`, { mode: 0o600 });
}

await recordEnvironment();

const lines = createInterface({ input: process.stdin });

for await (const line of lines) {
  if (!line.trim()) {
    continue;
  }

  try {
    const message = JSON.parse(line) as JsonRpcRequest;

    if (!Object.hasOwn(message, 'id')) {
      continue;
    }

    process.stdout.write(`${JSON.stringify(response(message))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: String((error as Error)?.message || error) },
    })}\n`);
  }
}
