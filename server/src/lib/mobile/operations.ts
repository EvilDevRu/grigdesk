import type { FastifyInstance } from 'fastify';

import { MobileInputError } from './errors.ts';
import type { OperationJournal } from './idempotency.ts';
import type { Device } from './store.ts';
import { chatOperationProof } from './chatTurns.ts';

/**
 * Оборачивает все команды одним durable журналом до допуска внешнего эффекта.
 * Потерянный HTTP-ответ восстанавливается с тем же ключом; поздний отзыв закрывает выдачу результата.
 */
export function registerOperationGuard(
  app: FastifyInstance,
  options: {
    journal: OperationJournal;
    currentDevice?: (fingerprint: string) => Promise<Device | null>;
  },
) {
  const { journal } = options;

  app.addHook('onRoute', (route) => {
    if (route.method !== 'POST' || route.url === '/api/mobile/v1/pair') {
      return;
    }

    const original = route.handler;

    route.handler = async (request, reply) => {
      const key = request.headers['idempotency-key'];
      const rawDate = request.headers['x-cockpit-operation-created-at'];

      if (typeof key !== 'string' || typeof rawDate !== 'string' || !/^\d{1,16}$/.test(rawDate)) {
        throw new MobileInputError(
          'bad_operation',
          'Команда требует ключа и исходного времени операции.',
        );
      }

      const result = await journal.run(
        request.mobileDevice!.id,
        key,
        {
          method: request.method,
          path: request.url,
          body: request.body ?? null,
          createdAt: Number(rawDate),
          proof: chatOperationProof(request.mobileDevice!.id, request.url, request.body),
        },
        async () => {
          let status = 200;
          let body: unknown;
          let captured = false;
          const capture = new Proxy(reply, {
            /**
             * Captured send/code сохраняет ответ внутри durable эффекта, не отправляя сокет раньше fsync.
             * Thenable исключён, чтобы Promise обработчика не ждал будущего внешнего send.
             */
            get(target, field) {
              // FastifyReply — thenable; сохранённый send ещё не отвечает наружу.
              // Capture не ждёт реального ответа, иначе журнал зависнет до таймаута.
              if (field === 'then') {
                return undefined;
              }

              if (field === 'send') {
                return (value: unknown) => {
                  body = value;
                  captured = true;

                  return capture;
                };
              }

              if (field === 'code' || field === 'status') {
                return (value: number) => {
                  status = value;

                  return capture;
                };
              }

              if (field === 'statusCode') {
                return status;
              }

              const value = Reflect.get(target, field);

              return typeof value === 'function' ? value.bind(target) : value;
            },
          });

          try {
            const returned = await original.call(app, request, capture);

            return {
              status,
              body: captured ? body : (returned ?? null),
            };
          } catch (error) {
            if (error instanceof MobileInputError && error.status < 500) {
              return {
                status: error.status,
                body: {
                  error: error.code,
                  message: error.message,
                },
              };
            }

            throw error;
          }
        },
      );
      const current = options.currentDevice
        ? await options.currentDevice(request.mobileFingerprint)
        : request.mobileDevice;

      if (!current || current.revokedAt !== null) {
        throw new MobileInputError('device_revoked', 'Телефон отозван в кокпите.', 403);
      }

      return reply.code(result.status).send(result.body);
    };
  });
}
