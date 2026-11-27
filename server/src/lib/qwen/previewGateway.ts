import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';

import { isRecord, recordOrNull } from '../../../../shared/lib/objects.ts';

import { qwenPreviewProvider } from './previewModels.ts';
import type { QwenSnapshot } from './settings.ts';

const AUTH_HEADERS = new Map([
  ['bearer', 'authorization'],
  ['api-key', 'x-api-key'],
  ['google-api-key', 'x-goog-api-key'],
]);
const API_PATHS = new Map([
  ['openai', /^\/chat\/completions$/u],
  ['anthropic', /^\/(?:v1\/)?messages$/u],
  ['gemini', /^\/(?:v1beta\/)?models\/[a-z\d._-]+:(?:streamGenerateContent|generateContent)$/iu],
]);
const REQUEST_MAX_BYTES = 48 * 1024 * 1024;

type Provider = NonNullable<ReturnType<typeof qwenPreviewProvider>> & {
  credential: string;
  models: Set<string>;
};

/**
 * OpenAI, Anthropic и Gemini помещают имена MCP в разные поля объявлений.
 * Сверяем только имена инструментов, выданных в первом запросе конкретного процесса.
 */
function advertisesWorkMcp(payload: unknown): boolean {
  const tools = recordOrNull(payload)?.tools;

  if (!Array.isArray(tools)) {
    return false;
  }

  const hasWorkPrefix = (value: unknown) => typeof value === 'string'
    && value.startsWith('mcp__grigdesk-work__');

  return tools.map(recordOrNull).some((tool) => hasWorkPrefix(tool?.name)
    || hasWorkPrefix(recordOrNull(tool?.function)?.name)
    || (Array.isArray(tool?.functionDeclarations) && tool.functionDeclarations.map(recordOrNull)
      .some((declaration) => hasWorkPrefix(declaration?.name))));
}

/**
 * Служебный токен действует только на маршрутах каталога этого запуска.
 * CLI выбирает операцию модели, но не адрес и не заголовок с ключом сервиса.
 */
function requestTarget(request: IncomingMessage, providers: ReadonlyMap<string, Provider>, token: string) {
  const relative = /^\/(?<id>grigdesk-[a-f\d]{24})(?<api>\/[^?#]+)(?:\?alt=sse)?$/u.exec(request.url || '');
  const provider = providers.get(relative?.groups?.id || '');
  const api = relative?.groups?.api || '';
  const authHeader = AUTH_HEADERS.get(provider?.authType || '');
  const credential = provider?.credential;
  const auth = authHeader === 'authorization' ? `Bearer ${token}` : token;

  if (request.method !== 'POST' || !provider || !credential || !authHeader
    || request.headers[authHeader] !== auth || !API_PATHS.get(provider.protocol)?.test(api)) {
    return null;
  }

  const url = new URL(provider.baseUrl);

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    return null;
  }

  url.pathname = url.pathname.replace(/\/$/u, '') + api;

  if (provider.protocol === 'gemini' && request.url?.endsWith('?alt=sse')) {
    url.searchParams.set('alt', 'sse');
  }

  const headers = new Headers({ 'content-type': 'application/json' });

  for (const header of ['accept', 'anthropic-version', 'anthropic-beta']) {
    const value = request.headers[header];

    if (typeof value === 'string') {
      headers.set(header, value);
    }
  }

  headers.set(authHeader, authHeader === 'authorization' ? `Bearer ${credential}` : credential);

  return {
    url,
    headers,
    models: provider.models,
    protocol: provider.protocol,
    api,
  };
}

/**
 * Тело ограничено до отправки провайдеру. Отмена ACP закрывает входящий сокет,
 * а его закрытие прерывает исходящий HTTP и поток ответа модели.
 */
async function forward(request: IncomingMessage, response: ServerResponse,
  target: NonNullable<ReturnType<typeof requestTarget>>, allow: (payload: unknown) => boolean) {
  const abort = new AbortController();

  response.once('close', () => abort.abort());

  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of request) {
    const data = Buffer.from(chunk);

    bytes += data.length;

    if (bytes > REQUEST_MAX_BYTES) {
      response.writeHead(413).end();

      return;
    }

    chunks.push(data);
  }

  const body = Buffer.concat(chunks, bytes);
  const payload: unknown = JSON.parse(body.toString('utf8'));
  const model = target.protocol === 'gemini' ? /\/models\/([^/:]+):/u.exec(target.api)?.[1]
    : isRecord(payload) ? payload.model : null;

  if (typeof model !== 'string' || !target.models.has(model)) {
    response.writeHead(403).end();

    return;
  }

  if (!allow(payload)) {
    response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
      error: {
        code: 'grigdesk_work_mcp_unavailable',
        message: 'GrigDesk work MCP unavailable',
      },
    }));

    return;
  }

  const upstream = await fetch(target.url, {
    method: 'POST',
    headers: target.headers,
    body,
    redirect: 'error',
    signal: abort.signal,
  });
  const headers: Record<string, string> = {};

  for (const name of ['content-type', 'retry-after']) {
    const value = upstream.headers.get(name);

    if (value) {
      headers[name] = value;
    }
  }

  response.writeHead(upstream.status, headers);

  if (!upstream.body) {
    response.end();

    return;
  }

  await pipeline(Readable.fromWeb(upstream.body as ReadableStream<Uint8Array>), response,
    { signal: abort.signal });
}

/**
 * Preview.2 не разрешил переменную в поле apiKey при реальном ACP-запуске.
 * В песочницу уходит одноразовый токен, а ключ модели остаётся на стороне сервера.
 */
export async function openQwenPreviewGateway(snapshot: QwenSnapshot, requireWorkMcp = false) {
  const token = randomBytes(32).toString('hex');
  const providers = new Map<string, Provider>();
  let workMcp = requireWorkMcp ? 'pending' : 'ready';

  for (const model of snapshot.models) {
    const provider = qwenPreviewProvider(model);

    const credential = provider && process.env[provider.envKey];

    if (provider && credential) {
      const existing = providers.get(provider.id);
      const id = String(model.entry.id);

      if (existing) {
        existing.models.add(id);
      } else {
        providers.set(provider.id, {
          ...provider,
          credential,
          models: new Set([id]),
        });
      }
    }
  }

  const server = createServer((request, response) => {
    let target: ReturnType<typeof requestTarget> = null;

    try {
      target = requestTarget(request, providers, token);
    } catch {
      response.writeHead(400).end();

      return;
    }

    if (!target) {
      response.writeHead(403).end();

      return;
    }

    void forward(request, response, target, (payload) => {
      if (workMcp === 'pending') {
        workMcp = advertisesWorkMcp(payload) ? 'ready' : 'unavailable';
      }

      return workMcp === 'ready';
    }).catch(() => {
      if (!response.headersSent) {
        response.writeHead(502).end();
      } else {
        response.destroy();
      }
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();

  if (!address || typeof address === 'string') {
    server.close();

    throw new Error('Qwen Preview.2: локальный шлюз моделей не запустился.');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    token,
    workMcpUnavailable: () => workMcp === 'unavailable',
    close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));

      server.closeAllConnections();

      return closed;
    },
  };
}
