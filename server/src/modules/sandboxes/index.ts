// Модуль «Песочницы»: обзор стендов, подъём и снос.
//
// Доступ: общий auth guard закрывает весь /api, а здесь добавлено ещё одно условие —
// СЕССИЯ человека. CLI-токен агента сюда не пускается намеренно: подъём стенда занимает
// слот и десяток минут, и такое решение принимает человек. Агенту остаётся обычный Bash
// со своими правилами подтверждения — тем же путём, которым он поднимает стенд сегодня.
import fp from 'fastify-plugin';
import type { FastifyReply } from 'fastify';

import { PROFILE_RE } from '../../lib/profiles.ts';
import { SANDBOX_TASK_RE } from '../../../../shared/sandboxContracts.ts';
import type { SandboxService } from '../../lib/sandboxes/service.ts';

interface SandboxesModuleOptions {
  service: SandboxService;
}

interface RaiseRoute {
  Body: {
    profile?: unknown;
    task?: unknown;
  };
}

interface DismantleRoute {
  Body: {
    force?: unknown;
  };
  Params: {
    task: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Объявленный отказ службы несёт свой код, статус и текст для человека. Исключение
 * без кода — чужое: оно получает общий ответ, и его текст наружу не уходит.
 */
function sendError(reply: FastifyReply, error: unknown) {
  const source = isRecord(error) ? error : {};
  const code = typeof source.code === 'string' && source.code ? source.code : '';
  const message = typeof source.message === 'string' ? source.message : '';

  if (!code) {
    return reply.code(500).send({ error: 'sandbox_error' });
  }

  return reply.code(Number(source.status) || 500).send({ error: code, message });
}

export default fp<SandboxesModuleOptions>(async function sandboxesModule(fastify, { service }) {
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/sandboxes')) {
      return;
    }

    if (request.authKind !== 'session') {
      return reply.code(403).send({ error: 'session_required' });
    }
  });

  fastify.get('/api/sandboxes', async (request, reply) => {
    try {
      return await service.overview();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<RaiseRoute>('/api/sandboxes', async (request, reply) => {
    const profile = String(request.body?.profile ?? '');
    const raw = request.body?.task;
    const task = raw === undefined || raw === null || raw === '' ? null : String(raw);

    if (!PROFILE_RE.test(profile)) {
      return reply.code(400).send({ error: 'bad_profile' });
    }

    if (task !== null && !SANDBOX_TASK_RE.test(task)) {
      return reply.code(400).send({ error: 'bad_task' });
    }

    try {
      return await service.raise({ profile, task });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.post<DismantleRoute>('/api/sandboxes/:task/down', async (request, reply) => {
    const task = String(request.params.task);

    if (!SANDBOX_TASK_RE.test(task)) {
      return reply.code(400).send({ error: 'bad_task' });
    }

    try {
      return await service.dismantle({ task, force: request.body?.force === true });
    } catch (error) {
      return sendError(reply, error);
    }
  });
});
