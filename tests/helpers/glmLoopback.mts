import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface GlmStreamScenario {
  kind: 'stream';
  deltas: Record<string, unknown>[];
  finishReason?: string;
  usage?: Record<string, number>;
}

export interface GlmErrorScenario {
  kind: 'http-error';
  status: number;
  code: string;
  message: string;
}

export interface GlmDisconnectScenario {
  kind: 'disconnect';
  deltas?: Record<string, unknown>[];
}

export type GlmScenario = GlmStreamScenario | GlmErrorScenario | GlmDisconnectScenario;

export interface GlmRequestRecord {
  path: string;
  model: unknown;
  thinking: unknown;
  tool_stream: unknown;
  authorizationMatches: boolean;
  userAgent: string;
  headerNames: string[];
  payload: Record<string, unknown>;
}

export interface GlmLoopbackOptions {
  prefix?: string;
  expectedKey?: string;
  scenarios?: readonly GlmScenario[];
  respond?: (payload: Record<string, unknown>, index: number) => GlmScenario | Promise<GlmScenario>;
}

/**
 * Фейк принимает запросы только на локальном интерфейсе.
 * Каждый тест задаёт свой сценарий, реальные провайдеры здесь не вызываются.
 */
export async function startGlmLoopback(options: GlmLoopbackOptions = {}) {
  const requests: GlmRequestRecord[] = [];
  const prefix = options.prefix ?? '/api/paas/v4';
  const violations: string[] = [];
  let count = 0;

  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== `${prefix}/chat/completions`) {
      violations.push('Неожиданный путь или метод запроса Z.ai');
      response.writeHead(500).end();

      return;
    }

    let body = '';

    for await (const chunk of request) {
      body += String(chunk);
    }

    let payload: Record<string, unknown>;
    let scenario: GlmScenario | undefined;

    try {
      payload = JSON.parse(body) as Record<string, unknown>;

      if (payload === null || Array.isArray(payload) || typeof payload !== 'object') {
        throw new Error('Тело запроса должно быть JSON-объектом');
      }

      const index = count++;

      scenario = await options.respond?.(payload, index) ?? options.scenarios?.[index];
    } catch {
      violations.push('Невалидный запрос или ошибка сценария Z.ai');
      response.writeHead(500).end();

      return;
    }

    if (!scenario) {
      violations.push('Запрос Z.ai вне сценария');
      response.writeHead(500).end();

      return;
    }

    requests.push({
      path: request.url ?? '',
      model: payload.model,
      thinking: payload.thinking,
      tool_stream: payload.tool_stream,
      authorizationMatches: options.expectedKey !== undefined
        && request.headers.authorization === `Bearer ${options.expectedKey}`,
      userAgent: String(request.headers['user-agent'] ?? ''),
      headerNames: Object.keys(request.headers).sort(),
      payload,
    });

    if (scenario?.kind === 'http-error') {
      response.writeHead(scenario.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: {
          code: scenario.code,
          message: scenario.message,
          type: scenario.code,
        },
      }));

      return;
    }

    response.writeHead(200, { 'content-type': 'text/event-stream' });

    if (scenario?.kind === 'disconnect') {
      response.write(`data: ${JSON.stringify({
        choices: [{
          index: 0,
          delta: scenario.deltas?.[0] ?? {},
          finish_reason: null,
        }],
      })}\n\n`);

      setTimeout(() => response.destroy(), 10);

      return;
    }

    if (scenario?.kind === 'stream') {
      for (const delta of scenario.deltas) {
        response.write(`data: ${JSON.stringify({
          id: 'synthetic-glm-completion',
          object: 'chat.completion.chunk',
          created: 1,
          model: payload.model,
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
          finish_reason: scenario.finishReason ?? 'stop',
        }],
        usage: scenario.usage,
      })}\n\n`);
    }

    response.end('data: [DONE]\n\n');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  /**
   * Ошибки стенда проверяются после закрытия порта и не остаются тихим HTTP-ответом.
   * Неполный сценарий также означает, что тест не доказал ожидаемое поведение.
   */
  const assertComplete = (): void => {
    if (violations.length > 0) {
      throw new Error(violations.join('\n'));
    }

    if (!options.respond && count !== (options.scenarios?.length ?? 0)) {
      throw new Error('Сценарий Z.ai выполнен не полностью');
    }
  };

  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}${prefix}`,
    requests,
    assertComplete,
    stop: async () => {
      if (server.listening) {
        server.closeAllConnections();

        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }

      assertComplete();
    },
  };
}
