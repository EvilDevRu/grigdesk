import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';

/**
 * Mock слушает только loopback и записывает запросы собственного synthetic provider.
 * SSE соответствует реальному adapter/translate, внешний API здесь не нужен.
 */
export async function startDeepSeekLoopback(options: {
  respond?: (payload: Record<string, any>, index: number) => Promise<{
    deltas: Record<string, any>[];
    finishReason?: string;
  }>;
} = {}) {
  const payloads: Record<string, any>[] = [];
  const server = createServer(async (request, response) => {
    let body = '';

    for await (const chunk of request) {
      body += String(chunk);
    }

    if (request.url !== '/chat/completions') {
      response.writeHead(404).end();

      return;
    }

    const payload = JSON.parse(body);

    payloads.push(payload);

    const scripted = await options.respond?.(payload, payloads.length - 1);

    if (response.destroyed) {
      return;
    }

    response.writeHead(200, { 'content-type': 'text/event-stream' });

    for (const delta of scripted?.deltas ?? [{ role: 'assistant', content: 'loopback-ok' }]) {
      response.write(`data: ${JSON.stringify({
        id: 'mock-completion',
        model: 'deepseek-v4-flash',
        choices: [{
          index: 0,
          delta,
          finish_reason: null,
        }],
      })}\n\n`);
    }

    response.write(`data: ${JSON.stringify({
      choices: [{
        index: 0,
        delta: {},
        finish_reason: scripted?.finishReason || 'stop',
      }],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 3,
        total_tokens: 11,
      },
    })}\n\n`);
    response.end('data: [DONE]\n\n');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    payloads,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

/**
 * Host fixture запрещает fetch за пределы loopback и задаёт endpoint до первого prompt.
 * Restart namespace использует настоящий upstream provider, а owner захватывает значение один раз.
 */
export async function writeDeepSeekLoopbackOverlay(options: {
  root: string;
  artifact: string;
  endpoint: string;
  document: string;
  restartOwner?: string;
}) {
  const plugin = path.join(options.root, 'loopback-host.mjs');
  const schemaModule = pathToFileURL(path.join(options.artifact, 'vendor/schemastery/lib/index.mjs')).href;
  const source = [
    `import Schema from ${JSON.stringify(schemaModule)};`,
    'import { writeFileSync } from "node:fs";',
    'export const name = "cockpit-loopback-fixture";',
    'export const inject = ["settings"];',
    'export function apply(ctx) {',
    '  const original = globalThis.fetch;',
    '  globalThis.fetch = (input, ...args) => {',
    '    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));',
    '    if (url.hostname !== "127.0.0.1") {',
    '      throw new Error("Mock допускает только loopback fetch");',
    '    }',
    '    return original(input, ...args);',
    '  };',
    ...(options.restartOwner ? [
      '  const scope = ctx.settings.register("cockpit-restart-test",',
      '    Schema.object({ enabled: Schema.boolean().default(true) }), { applies: "restart" });',
      `  writeFileSync(${JSON.stringify(options.restartOwner)}, String(scope.get().enabled));`,
    ] : []),
    '}',
  ].join('\n');

  await fs.writeFile(plugin, source, { mode: 0o600 });

  const overlay = path.join(options.root, 'overlay.yml');

  await fs.writeFile(overlay, [
    '- id: settings',
    '  config:',
    `    path: ${JSON.stringify(options.document)}`,
    '- id: session-title-llm',
    '  disabled: true',
    '- id: llm-deepseek',
    '  config:',
    `    baseURL: ${JSON.stringify(options.endpoint)}`,
    '    retryPolicy:',
    '      mode: normal',
    '      maxRetries: 0',
    '- insert:',
    '    - id: cockpit-loopback-fixture',
    `      name: ${JSON.stringify(pathToFileURL(plugin).href)}`,
  ].join('\n') + '\n', { mode: 0o600 });

  return overlay;
}
