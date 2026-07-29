// HTTP-контур раздела «Ревью». Вся предметная логика и серверные ворота живут
// в ReviewService; модуль только валидирует форму запроса и стабильно отображает
// ошибки в HTTP. Скрытая кнопка во фронте никогда не считается защитой.
import fp from 'fastify-plugin';

const NOT_FOUND = new Set([
  'PULL_NOT_FOUND',
  'REMARK_NOT_FOUND',
  'RUN_NOT_FOUND',
  'REPOSITORY_NOT_FOUND',
]);
const CONFLICT = new Set([
  'ACCEPTANCE_REQUIRED',
  'ACCEPTANCE_STALE',
  'ACTIVE_RUN_EXISTS',
  'ACTIVE_RUN_UNKNOWN',
  'AMBIGUOUS_REPOSITORY_BINDING',
  'ABANDON_STATE_INVALID',
  'BUILD_STATE_INVALID',
  'CANDIDATE_CHANGED',
  'CLEANUP_BRANCH_MISMATCH',
  'CLEANUP_PATH_MISMATCH',
  'CLEANUP_STATE_INVALID',
  'CLEANUP_WORKTREE_DIRTY',
  'GITHUB_SYNC_BUSY',
  'LEASE_BUSY',
  'PR_CLOSED',
  'SCOPE_APPROVAL_REQUIRED',
  'SCOPE_APPROVAL_STALE',
  'SCOPE_DECISION_REQUIRED',
  'SNAPSHOT_STALE',
  'REPOSITORY_RUN_ACTIVE',
  'REPOSITORY_RUN_UNKNOWN',
  'ROUTE_NOT_CONFIGURED',
  'VERIFY_REQUIRED',
]);
const UNAVAILABLE = new Set([
  'GITHUB_UNAVAILABLE',
  'MODEL_UNAVAILABLE',
  'REVIEW_CONTROL_LOCK_LOST',
  'REVIEW_CONTROL_LOCK_TIMEOUT',
  'REVIEW_CONTROL_LOCK_UNAVAILABLE',
  'REVIEW_STORE_LOCK_LOST',
  'REVIEW_STORE_LOCK_TIMEOUT',
  'REVIEW_STORE_LOCK_UNAVAILABLE',
  'REVIEW_SUBSYSTEM_UNAVAILABLE',
  'REVIEW_EXECUTOR_UNAVAILABLE',
  'STATE_LOCK_LOST',
  'STATE_LOCK_TIMEOUT',
  'STATE_LOCK_UNAVAILABLE',
]);

function statusFor(error) {
  if (NOT_FOUND.has(error?.code)) return 404;
  if (CONFLICT.has(error?.code)) return 409;
  if (error?.code === 'RATE_LIMITED') return 429;
  if (UNAVAILABLE.has(error?.code)) return 503;
  if (/^(BAD_|INVALID_|SCOPE_|VERIFY_COMMAND_)/.test(error?.code || '')
      || /_INVALID$/.test(error?.code || '')) return 400;
  return Number.isInteger(error?.statusCode) ? error.statusCode : 500;
}

function publicError(error) {
  const statusCode = statusFor(error);
  return {
    statusCode,
    body: {
      error: error?.code || 'review_failed',
      message: statusCode >= 500
        ? 'Операция ревью не выполнена. Подробности сохранены в журнале Cockpit.'
        : String(error?.message || 'Операция ревью не выполнена').slice(0, 2_000),
      ...(error?.details && statusCode < 500 ? { details: error.details } : {}),
    },
  };
}

async function call(reply, log, operation) {
  try {
    return await operation();
  } catch (error) {
    const mapped = publicError(error);
    if (mapped.statusCode >= 500) {
      log?.error({ code: error?.code, err: error?.message }, 'review API: операция упала');
    }
    return reply.code(mapped.statusCode).send(mapped.body);
  }
}

async function reviewsModule(fastify, opts) {
  const { reviews } = opts;
  if (!reviews) throw new Error('module-reviews требует ReviewService');

  // Здесь ходят исходные приватные комментарии и model output. Даже успешный GET
  // не должен осесть в browser/proxy cache.
  fastify.addHook('onSend', async (request, reply, payload) => {
    if ((request.routeOptions?.url || '').startsWith('/api/reviews')) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
    }
    return payload;
  });

  // Cookie-auth мутации требуют JSON. Обычная cross-site HTML-форма не умеет
  // поставить application/json, а fetch со стенда потребует CORS preflight.
  // CLI/internal-token запросы без cookie остаются совместимыми.
  fastify.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions?.url || '';
    if (!route.startsWith('/api/reviews')
        || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
        || !/(?:^|;\s*)cockpit_sid=/.test(String(request.headers.cookie || ''))) {
      return;
    }
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return reply.code(403).send({
        error: 'csrf_json_required',
        message: 'Для изменения ревью нужен JSON-запрос из Cockpit.',
      });
    }
  });

  fastify.get('/api/reviews', async (_request, reply) => (
    call(reply, fastify.log, () => reviews.snapshot())
  ));

  fastify.get('/api/reviews/summary', async (_request, reply) => (
    call(reply, fastify.log, () => reviews.summary())
  ));

  fastify.post('/api/reviews/sync', async (request, reply) => (
    call(reply, fastify.log, () => reviews.sync({
      projectId: request.body?.projectId,
      repoKey: request.body?.repoKey,
      manual: true,
    }))
  ));

  fastify.post('/api/reviews/pulls/:id/read', async (request, reply) => (
    call(reply, fastify.log, () => reviews.markRead(String(request.params.id)))
  ));

  fastify.post('/api/reviews/pulls/:id/analyze', async (request, reply) => (
    call(reply, fastify.log, () => reviews.analyze(String(request.params.id), {
      manual: true,
      remarkId: request.body?.remarkId ?? null,
    }))
  ));

  fastify.put('/api/reviews/pulls/:id/scope', async (request, reply) => (
    call(reply, fastify.log, () => reviews.setScope(
      String(request.params.id),
      Array.isArray(request.body?.items) ? request.body.items : null,
    ))
  ));

  fastify.post('/api/reviews/pulls/:id/run', async (request, reply) => (
    call(reply, fastify.log, async () => {
      const result = await reviews.run(String(request.params.id));
      return reply.code(202).send(result);
    })
  ));

  fastify.get('/api/reviews/runs/:id', async (request, reply) => (
    call(reply, fastify.log, () => reviews.getRun(String(request.params.id)))
  ));

  fastify.post('/api/reviews/runs/:id/accept', async (request, reply) => (
    call(reply, fastify.log, () => reviews.accept(String(request.params.id), {
      actor: 'cockpit-user',
      acknowledgeUnchecked: request.body?.acknowledgeUnchecked === true,
    }))
  ));

  fastify.post('/api/reviews/runs/:id/publish', async (request, reply) => (
    call(reply, fastify.log, () => reviews.publish(String(request.params.id), {
      actor: 'cockpit-user',
      operationId: request.body?.operationId,
      retryUnknown: request.body?.retryUnknown === true,
    }))
  ));

  fastify.post('/api/reviews/runs/:id/abandon', async (request, reply) => (
    call(reply, fastify.log, () => reviews.abandon(String(request.params.id), {
      actor: 'cockpit-user',
    }))
  ));

  fastify.delete('/api/reviews/runs/:id/environment', async (request, reply) => (
    call(reply, fastify.log, () => reviews.cleanup(String(request.params.id)))
  ));
}

export { publicError as reviewPublicError };
export default fp(reviewsModule, { name: 'module-reviews' });
