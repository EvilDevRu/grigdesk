import type { FastifyReply, FastifyRequest } from 'fastify';

import type { B24ReadOptions } from './readOperations.ts';

/**
 * Подписка принадлежит незавершённому HTTP-ответу, а не уже прочитанному телу запроса.
 * Отключение снимает одного потребителя общего чтения, остальные продолжают ждать.
 */
export async function withB24RequestRead<Value>(request: FastifyRequest, reply: FastifyReply,
  operation: (options: B24ReadOptions) => Promise<Value>): Promise<Value> {
  const controller = new AbortController();
  const aborted = () => controller.abort(new DOMException('Клиент отключился.', 'AbortError'));
  const closed = () => {
    if (!reply.raw.writableEnded) {
      aborted();
    }
  };

  request.raw.once('aborted', aborted);
  reply.raw.once('close', closed);

  if (request.raw.aborted || reply.raw.destroyed) {
    aborted();
  }

  try {
    return await operation({ signal: controller.signal });
  } finally {
    request.raw.removeListener('aborted', aborted);
    reply.raw.removeListener('close', closed);
  }
}
