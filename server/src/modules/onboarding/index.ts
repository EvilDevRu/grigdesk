import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

import { createOnboardingService } from '../../lib/onboarding/service.ts';
import type { OnboardingOptions } from '../../lib/onboarding/service.ts';
import { inspectRepository } from '../../lib/onboarding/repositories.ts';
import { OnboardingError } from '../../../../shared/runtime/onboardingContracts.ts';

/**
 * Лишние поля отклоняются явно, без removeAdditional и изменения запроса Fastify.
 * Происхождение прохода и служебные поля доступны только серверным переходам.
 */
function bodyRecord(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !fields.includes(key))) {
    throw new OnboardingError('invalid_body');
  }

  return value as Record<string, unknown>;
}

/**
 * Вложенные ответы также закрыты whitelist, а типы и лимиты проверяет общий decoder.
 * Пустой путь в черновике разрешён до явного перехода к созданию паспорта.
 */
function draftBody(value: unknown): unknown {
  const draft = bodyRecord(value, ['title', 'repositories', 'workspace']);

  bodyRecord(draft.workspace, ['mode']);

  if (!Array.isArray(draft.repositories)) {
    throw new OnboardingError('invalid_draft');
  }

  for (const repo of draft.repositories) {
    bodyRecord(repo, ['name', 'source', 'baseBranch']);
  }

  return draft;
}

/**
 * Ручки наследуют общий auth до чтения диска и возвращают только свежие снимки.
 * HTTP не управляет паспортами напрямую: переходы остаются в сервисе мастера.
 */
async function onboardingModule(fastify: FastifyInstance, options: OnboardingOptions): Promise<void> {
  const service = createOnboardingService({
    ...options,
    broadcast: options.broadcast ?? ((event, data) => fastify.sse?.broadcast?.(event, data)),
  });

  for (const [method, suffix] of [
    ['GET', ''], ['POST', '/start'], ['PATCH', ''],
    ['POST', '/advance'], ['POST', '/back'], ['POST', '/dismiss'], ['POST', '/repository'],
  ] as const) {
    fastify.route({
      method,
      url: `/api/onboarding${suffix}`,
      handler: async (request, reply) => {
        reply.header('cache-control', 'no-store');

        try {
          if (method === 'GET') {
            return await service.getState();
          }

          if (suffix === '/repository') {
            const body = bodyRecord(request.body, ['dir']);

            if (typeof body.dir !== 'string' || body.dir.length > 1024 || body.dir.includes('\0')) {
              throw new OnboardingError('invalid_path');
            }

            return await inspectRepository(body.dir);
          }

          const fields = suffix === '/start' ? ['expectedRevision', 'mode']
            : ['expectedRevision', 'sessionId', ...(method === 'PATCH' ? ['draft'] : ['skipAi'])];
          const body = bodyRecord(request.body, fields);

          if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) {
            throw new OnboardingError('invalid_revision');
          }

          const revision = Number(body.expectedRevision);

          if (suffix === '/start') {
            if (body.mode !== 'auto' && body.mode !== 'manual') {
              throw new OnboardingError('invalid_mode');
            }

            return await service.start(revision, body.mode);
          }

          if (typeof body.sessionId !== 'string' || !body.sessionId) {
            throw new OnboardingError('invalid_session');
          }

          if (method === 'PATCH') {
            return await service.saveDraft(revision, body.sessionId, draftBody(body.draft));
          }

          if (suffix === '/dismiss' || suffix === '/back') {
            if ('skipAi' in body) {
              throw new OnboardingError('invalid_body');
            }

            return suffix === '/back' ? await service.back(revision, body.sessionId)
              : await service.dismiss(revision, body.sessionId);
          }

          if (body.skipAi !== undefined && typeof body.skipAi !== 'boolean') {
            throw new OnboardingError('invalid_skip');
          }

          return await service.advance(revision, body.sessionId, body.skipAi as boolean | undefined);
        } catch (error) {
          if (error instanceof OnboardingError) {
            const current = error.status === 409 ? await service.getState().catch(() => null) : null;

            return reply.code(error.status).send({
              error: error.code,
              message: error.message,
              current,
              currentRevision: current?.revision,
            });
          }

          throw error;
        }
      },
    });
  }
}

export default fp(onboardingModule);
