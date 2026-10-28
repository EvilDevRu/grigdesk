import type { FastifyInstance, FastifyReply } from 'fastify';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { ArbiterConversationService } from '../../lib/arbiterConversationService.ts';
import type { IntentKind } from '../../../../shared/pipeline/arbiterConversation.ts';
import { ArbiterConversationError } from '../../../../shared/pipeline/arbiterConversation.ts';

/**
 * Короткие HTTP-входы подтверждают только durable операцию сервиса.
 * Общий auth guard factory действует и здесь; disconnect не отменяет принадлежащий серверу job.
 */
export function registerArbiterConversationRoutes(
  app: FastifyInstance,
  service: ArbiterConversationService,
  journal?: { stateDir: string },
) {
  type Route = { Params: { id: string; conversationId: string }; Querystring: Record<string, string> };

  const root = '/api/tasks/:id/arbiter-conversations';
  const options = {
    errorHandler(error: Error, _request: unknown, reply: FastifyReply) {
      if (error instanceof ArbiterConversationError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }

      return reply.send(error);
    },
  };

  app.get<Route>(`${root}/current`, options, async (request) => service.current(request.params.id));
  app.get<Route>(`${root}/:conversationId/journal`, options, async (request, reply) => {
    const task = request.params.id;
    const doc = await service.store.read(task, request.params.conversationId);

    if (!doc || !journal) {
      throw new ArbiterConversationError('journal_unavailable', 'Журнал задачи недоступен.', 404);
    }

    try {
      const state = await fs.realpath(journal.stateDir);
      const logs = await fs.realpath(path.join(state, 'logs'));

      if (logs !== path.join(state, 'logs')) {
        throw new Error('Подмена папки журнала.');
      }

      const file = await fs.open(path.join(logs, `t${task}.stages.log`),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

      if (!(await file.stat()).isFile()) {
        await file.close();

        throw new Error('Журнал не является файлом.');
      }

      return reply.type('text/plain; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="t${task}.stages.log"`)
        .header('Cache-Control', 'no-store')
        .send(file.createReadStream());
    } catch {
      throw new ArbiterConversationError('journal_unavailable',
        'Полный журнал задачи недоступен. Подтверждённое сообщение этапа сохранено в диалоге.', 404);
    }
  });
  app.get<Route>(`${root}/:conversationId`, options, async (request) => {
    const query = request.query;
    const afterSequence = Number(query.afterSequence || 0);
    const knownRevision = Number(query.knownRevision || 0);

    if (Object.keys(query).some((key) => !['afterSequence', 'knownRevision'].includes(key))
      || !Number.isSafeInteger(afterSequence) || afterSequence < 0
      || !Number.isSafeInteger(knownRevision) || knownRevision < 0) {
      throw new ArbiterConversationError('invalid_request', 'Некорректная страница истории.');
    }

    return service.snapshot(
      request.params.id,
      request.params.conversationId,
      {
        afterSequence,
        knownRevision
      }
    );
  });

  for (const [suffix, kind] of Object.entries({
    '': 'start',
    '/:conversationId/messages': 'discuss',
    '/:conversationId/diagnose': 'diagnose',
    '/:conversationId/apply': 'apply',
    '/:conversationId/resume': 'resume',
  })) {
    app.post<Route>(`${root}${suffix}`, options, async (request, reply) => {
      const result = await service.submit(request.params.id, request.params.conversationId || null,
        kind as IntentKind, request.body);
      const { completion: _completion, ...ack } = result;

      return reply.code(202).send(ack);
    });
  }
}
