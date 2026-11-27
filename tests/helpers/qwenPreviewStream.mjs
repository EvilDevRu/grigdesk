import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

import { runQwenTurn } from '../../server/src/lib/qwen/runtime.ts';
import { qwenFixture, runInput } from './qwenFixture.mjs';

/**
 * Воспроизводит кадры ACP на границе реального runtime. Проверка бинарника,
 * процесс и wire отдельно проверяются сценариями с настоящим Preview.2.
 */
export async function runQwenPreviewStream(t, updates, input = {}, failure) {
  const fixture = await qwenFixture(t, { prepareFake: false });
  const sessionId = 'synthetic-preview-session';

  return runQwenTurn(runInput(fixture, 'shared-model(openai)', input), {
    async openTransport(_config, _snapshot, options, handlers) {
      await mkdir(options.home, { recursive: true });

      return {
        images: true,
        stderr: () => '',
        close: async () => {},
        client: {
          /**
           * Объявляет текущую модель при создании сессии и выдаёт кадры только после
           * prompt. Граница ошибки после последнего кадра соответствует ACP RPC.
           */
          async request(method, params) {
            if (method === 'session/new') {
              return {
                sessionId,
                configOptions: [{
                  id: 'model',
                  type: 'select',
                  currentValue: options.nativeModelId,
                }],
              };
            }

            assert.equal(method, 'session/prompt');
            assert.equal(params.sessionId, sessionId);

            for (const update of updates) {
              await handlers.onNotification('session/update', { sessionId, update });
            }

            if (failure) {
              throw failure;
            }

            return { stopReason: 'end_turn' };
          },
        },
      };
    },
  });
}
