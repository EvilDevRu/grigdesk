// Native control-plane GitHub: provider connect/disconnect, repository allowlist
// и публичный raw webhook ingress. Общая очередь и её activation живут в /api/inbox.
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { isPlainRecord } from '../../../../shared/lib/objects.ts';

import { normalizeGitHubRepositoryId } from '../../lib/github/accountBindings.ts';
import { GITHUB_WEBHOOK_BODY_LIMIT } from '../../lib/github/webhook.ts';

const PUBLIC_MESSAGES = Object.freeze({
  github_repository_invalid: 'Укажи корректные owner и repository GitHub.',
  github_token_invalid: 'GitHub PAT имеет неверный формат.',
  github_callback_unconfigured: 'Публичный HTTPS callback GitHub не настроен.',
  github_callback_invalid: 'Публичный callback GitHub настроен неверно.',
  github_already_configured: 'GitHub repository уже подключается или подключён.',
  github_cleanup_pending: 'Локальный ingress закрыт, но remote hook ещё требует удаления.',
  github_not_connected: 'GitHub repository не подключён.',
  github_issues_disabled: 'В выбранном repository выключены Issues.',
  github_account_changed: 'Подключённый GitHub repository изменился.',
  github_hook_changed: 'Управляемый GitHub webhook изменился.',
  github_hook_ambiguous: 'Для callback найдено несколько GitHub hooks.',
  github_hooks_truncated: 'Нельзя безопасно проверить полный список GitHub hooks.',
  github_forbidden: 'GitHub не разрешил операцию. Проверь PAT и его доступ к repository hooks.',
  github_not_found: 'GitHub repository или webhook не найден.',
  github_rejected: 'GitHub отклонил операцию.',
  github_timeout: 'GitHub не ответил вовремя.',
  github_unreachable: 'До GitHub сейчас не достучаться.',
  github_force_forget_confirmation: 'Нужно явно подтвердить возможный orphan GitHub hook.',
  github_rules_invalid: 'Правило GitHub не соответствует контракту.',
  github_rules_owner_mismatch: 'Правило относится к другому repository.',
  github_rules_stale_policy: 'Правило GitHub изменилось. Обнови форму и повтори действие.',
  github_ingress_gone: 'Этот GitHub webhook ingress больше не действует.',
  github_ingress_not_ready: 'GitHub channel ещё не завершил подключение.',
  github_signature_invalid: 'Подпись GitHub webhook не совпала.',
  github_raw_body_required: 'GitHub webhook должен содержать исходное тело.',
  github_body_too_large: 'GitHub webhook превышает допустимый размер.',
  github_json_invalid: 'GitHub webhook содержит некорректный JSON.',
  github_header_missing: 'GitHub webhook не содержит обязательный заголовок.',
  github_header_ambiguous: 'Заголовки GitHub webhook неоднозначны.',
  github_delivery_invalid: 'GitHub webhook содержит некорректный delivery id.',
  github_hook_mismatch: 'GitHub webhook пришёл не от текущего hook.',
  github_target_mismatch: 'GitHub webhook адресован неверному типу target.',
  github_target_invalid: 'GitHub webhook содержит неверный target id.',
  github_repository_mismatch: 'GitHub webhook относится к другому repository.',
  github_event_mismatch: 'GitHub webhook содержит неожиданное событие.',
  github_failed: 'Операция GitHub временно не выполнена.',
});
const POLICY_FINGERPRINT_RE = /^ghpol1:[0-9a-f]{64}$/u;

type Payload = Record<string, unknown>;

// Аренда namespace одного подключённого репозитория. Пока она текущая, правила
// принадлежат именно ему — сменившийся аккаунт обязан оборвать запись.
interface InboxLease {
  context: {
    repositoryId: string;
    rules: {
      readPolicy: () => Promise<Payload>;
      write: (rules: unknown, options: { projects: unknown }) => Promise<unknown>;
      setAgentSearch: (input: {
        enabled: boolean;
        expectedPolicyFingerprint: string;
      }) => Promise<Payload>;
    };
  };
  isCurrent: () => boolean;
  release: () => void;
}

// Подключение, каким его видит HTTP-слой: статус, четыре управляющие операции,
// приём webhook и выдача аренды. Больше модулю знать не нужно.
export interface GitHubConnectionPort {
  status: () => Promise<unknown>;
  connect: (input: { owner: unknown; repo: unknown; token: unknown }) => Promise<unknown>;
  disconnect: () => Promise<unknown>;
  recheck: () => Promise<unknown>;
  forceForget: (input: Payload) => Promise<unknown>;
  handleWebhook: (
    ingressRef: string,
    rawBody: unknown,
    headers: unknown,
  ) => Promise<unknown>;
  acquireInboxLease: () => InboxLease;
}

export interface GitHubModuleOptions {
  withReferences?: <T>(op: () => Promise<T>) => Promise<T>;
  isProjectDeleted?: (id: string) => boolean;
  connection?: GitHubConnectionPort;
  listProjects?: () => Promise<unknown>;
}

interface IngressRoute {
  Params: {
    ingressRef: string;
  };
}

function exactBody(value: unknown, keys: string[]): Payload | null {
  const body = value ?? {};
  if (!isPlainRecord(body)) return null;
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return null;
  }
  return body;
}

// Наружу уходит только объявленный машинный код и его готовый текст. Сообщение
// самой ошибки не публикуется: в нём бывает и адрес, и ответ провайдера.
function publicFailure(
  reply: FastifyReply,
  source: unknown,
  { webhook = false }: { webhook?: boolean } = {},
) {
  const error = (source ?? {}) as Payload;
  const rawCode = typeof error.code === 'string' ? error.code : 'github_failed';
  const code = Object.hasOwn(PUBLIC_MESSAGES, rawCode) ? rawCode : 'github_failed';
  let status = Number.isInteger(error.statusCode) ? error.statusCode as number : 500;
  if (['github_signature_invalid'].includes(code)) status = 401;
  else if (['github_ingress_gone', 'github_hook_mismatch', 'github_repository_mismatch'].includes(code)) {
    status = 410;
  } else if (webhook && status === 500 && code !== 'github_failed') status = 400;
  if (status < 400 || status > 599) status = 500;
  return reply.code(status).send({
    error: code,
    message: (PUBLIC_MESSAGES as Record<string, string>)[code],
  });
}

async function githubModule(fastify: FastifyInstance, opts: GitHubModuleOptions): Promise<void> {
  const {
    connection,
    listProjects = async () => [],
  } = opts;
  if (!connection || typeof connection.status !== 'function'
      || typeof connection.connect !== 'function'
      || typeof connection.disconnect !== 'function'
      || typeof connection.recheck !== 'function'
      || typeof connection.handleWebhook !== 'function'
      || typeof connection.acquireInboxLease !== 'function') {
    throw new Error('module-github: connection обязателен');
  }
  if (typeof listProjects !== 'function') {
    throw new Error('module-github: listProjects должен быть функцией');
  }

  const enabled = () => fastify.pluginEnabled('github');
  const gate = (reply: FastifyReply) => (enabled() ? null : reply.code(404).send({
    error: 'plugin_disabled',
    message: 'Плагин GitHub выключен.',
  }));
  const changed = (status: string) => fastify.sse?.broadcast?.('inbox-changed', {
    itemRef: null,
    channel: 'github',
    status,
    taskId: null,
  });
  const accountChanged = () => Object.assign(new Error('GitHub generation changed.'), {
    code: 'github_account_changed',
    statusCode: 409,
  });
  const requireWritableRules = async (
    lease: InboxLease,
    expectedRepositoryId: string,
    reply: FastifyReply,
  ): Promise<boolean> => {
    if (!lease.isCurrent()
        || lease.context.repositoryId !== expectedRepositoryId) throw accountChanged();
    const provider = (await connection.status() ?? {}) as Payload;
    if (!lease.isCurrent()) throw accountChanged();
    if (provider.connection !== 'connected') {
      reply.code(409).send({
        error: 'github_not_connected',
        message: PUBLIC_MESSAGES.github_not_connected,
      });
      return true;
    }
    let liveRepositoryId: string | null = null;
    try {
      liveRepositoryId = normalizeGitHubRepositoryId(provider.repositoryId);
    } catch { /* Устаревшая или повреждённая публичная проекция. */ }
    if (liveRepositoryId !== expectedRepositoryId) throw accountChanged();
    return false;
  };

  const run = (
    operation: (request: FastifyRequest, reply: FastifyReply) => unknown,
  ) => async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    if (gate(reply)) return reply;
    try {
      return await operation(request, reply);
    } catch (error) {
      request.log?.error?.(
        { code: (error as Payload)?.code },
        'github: control operation failed',
      );
      return publicFailure(reply, error);
    }
  };

  fastify.get('/api/github/status', run(() => connection.status()));

  fastify.post('/api/github/connect', run(async (request, reply) => {
    const body = exactBody(request.body, ['owner', 'repo', 'token']);
    if (!body) return reply.code(400).send({
      error: 'invalid_request',
      message: 'Ожидались ровно owner, repo и token.',
    });
    const result = await connection.connect({ owner: body.owner, repo: body.repo, token: body.token });
    changed('provider_connecting');
    return result;
  }));

  fastify.post('/api/github/recheck', run(async (request, reply) => {
    if (!exactBody(request.body, [])) {
      return reply.code(400).send({ error: 'invalid_request', message: 'Тело recheck должно быть пустым.' });
    }
    const result = await connection.recheck();
    changed('provider_rechecked');
    return result;
  }));

  fastify.post('/api/github/disconnect', run(async (request, reply) => {
    if (!exactBody(request.body, [])) {
      return reply.code(400).send({ error: 'invalid_request', message: 'Тело disconnect должно быть пустым.' });
    }
    const result = await connection.disconnect();
    changed('provider_disconnected');
    return result;
  }));

  fastify.post('/api/github/force-forget', run(async (request, reply) => {
    const body = exactBody(request.body, ['confirmOrphanHook']);
    if (!body || body.confirmOrphanHook !== true) {
      return reply.code(400).send({
        error: 'github_force_forget_confirmation',
        message: PUBLIC_MESSAGES.github_force_forget_confirmation,
      });
    }
    const result = await connection.forceForget(body);
    changed('provider_force_forgotten');
    return result;
  }));

  fastify.get('/api/github/rules', run(async () => {
    let lease: InboxLease | undefined;
    try {
      lease = connection.acquireInboxLease();
      const policy = await lease.context.rules.readPolicy();
      if (!lease.isCurrent()) throw accountChanged();
      return policy;
    } catch (error) {
      if ((error as Payload)?.code !== 'channel_disconnected') throw error;

      return { rules: [], policyFingerprint: null };
    } finally {
      lease?.release();
    }
  }));

  fastify.put('/api/github/rules', run(async (request, reply) => (
    opts.withReferences ?? ((op) => op())
  )(async () => {
    const body = exactBody(request.body, ['repositoryId', 'rules']);
    let expectedRepositoryId: string | null = null;
    try {
      if (typeof body?.repositoryId === 'string') {
        expectedRepositoryId = normalizeGitHubRepositoryId(body.repositoryId);
      }
    } catch { /* Некорректный клиентский CAS. */ }
    if (!body || expectedRepositoryId === null) return reply.code(400).send({
      error: 'invalid_request',
      message: 'Ожидались ровно canonical repositoryId и rules.',
    });
    if (Array.isArray(body.rules) && (body.rules as unknown[]).some((rule) => (
      isPlainRecord(rule) && Object.hasOwn(rule, 'agentSearch')
    ))) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'agentSearch меняется только отдельной CAS-ручкой.',
      });
    }
    let lease: InboxLease;
    try {
      lease = connection.acquireInboxLease();
    } catch (error) {
      if ((error as Payload)?.code !== 'channel_disconnected') throw error;

      return reply.code(409).send({
        error: 'github_not_connected',
        message: PUBLIC_MESSAGES.github_not_connected,
      });
    }
    try {
      // Provider id приходит только как optimistic CAS: namespace всегда берём
      // из immutable lease, а не из тела. Поэтому старая вкладка не сможет
      // очистить rules уже подключённого другого repository даже пустым массивом.
      const rejected = await requireWritableRules(lease, expectedRepositoryId, reply);
      if (rejected) return rejected;
      const projects = await listProjects();

      for (const row of Array.isArray(body.rules) ? body.rules : []) {
        const id = isPlainRecord(row) && typeof row.project === 'string' ? row.project : '';

        if (id && opts.isProjectDeleted?.(id)) {
          return reply.code(409).send({
            error: 'tombstoned', message: `Регистрация проекта «${id}» удалена.`,
          });
        }
      }

      if (!lease.isCurrent()) throw accountChanged();
      const rules = await lease.context.rules.write(body.rules, { projects });
      if (!lease.isCurrent()) throw accountChanged();
      changed('rules');
      return { ok: true, rules };
    } finally {
      lease.release();
    }
  })));

  fastify.put('/api/github/rules/agent-search', run(async (request, reply) => {
    const body = exactBody(request.body, [
      'repositoryId', 'expectedPolicyFingerprint', 'enabled',
    ]);
    let expectedRepositoryId: string | null = null;
    try {
      if (typeof body?.repositoryId === 'string') {
        expectedRepositoryId = normalizeGitHubRepositoryId(body.repositoryId);
      }
    } catch { /* Некорректный клиентский CAS. */ }
    if (!body || expectedRepositoryId === null
        || typeof body.enabled !== 'boolean'
        || typeof body.expectedPolicyFingerprint !== 'string'
        || !POLICY_FINGERPRINT_RE.test(body.expectedPolicyFingerprint)) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'Ожидались exact repositoryId, expectedPolicyFingerprint и boolean enabled.',
      });
    }

    let lease: InboxLease;
    try {
      lease = connection.acquireInboxLease();
    } catch (error) {
      if ((error as Payload)?.code !== 'channel_disconnected') throw error;

      return reply.code(409).send({
        error: 'github_not_connected',
        message: PUBLIC_MESSAGES.github_not_connected,
      });
    }
    try {
      const rejected = await requireWritableRules(lease, expectedRepositoryId, reply);
      if (rejected) return rejected;
      const policy = await lease.context.rules.setAgentSearch({
        enabled: body.enabled as boolean,
        expectedPolicyFingerprint: body.expectedPolicyFingerprint as string,
      });
      if (!lease.isCurrent()) throw accountChanged();
      changed('agent_search');
      return { ok: true, ...policy };
    } finally {
      lease.release();
    }
  }));

  // Encapsulation сохраняет обычный JSON parser для control-plane /api routes.
  // В ingress JSON нельзя парсить до HMAC: подпись относится к точным raw bytes.
  await fastify.register(async function githubIngressScope(scope: FastifyInstance) {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', {
      parseAs: 'buffer',
      bodyLimit: GITHUB_WEBHOOK_BODY_LIMIT,
    }, (request, body, done) => done(null, body));

    scope.post<IngressRoute>('/hooks/github/:ingressRef', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!enabled()) {
        return reply.code(410).send({ error: 'github_ingress_gone' });
      }
      try {
        const result = await connection.handleWebhook(
          String(request.params.ingressRef || ''),
          request.body,
          request.headers,
        );
        return reply.code(202).send(result);
      } catch (error) {
        request.log?.warn?.({ code: (error as Payload)?.code }, 'github: webhook rejected');
        return publicFailure(reply, error, { webhook: true });
      }
    });
  });
}

export default fp(githubModule, { name: 'module-github' });
