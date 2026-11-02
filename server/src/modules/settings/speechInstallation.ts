import type { FastifyInstance } from 'fastify';

import {
  SPEECH_INSTALL_OPERATIONS,
  type SpeechInstallOperation,
} from '../../../../shared/media/speechInstallation.ts';
import { SpeechInstallError, type SpeechInstallationService } from '../../lib/speech/installation.ts';
import { ModelJobError } from '../../lib/speech/modelJobs.ts';
import { SpeechRuntimeError } from '../../lib/speech/errors.ts';
import { SPEECH_MODEL_IDS } from '../../lib/speech/catalog.ts';

/**
 * Роуты установки принимают закрытые операции, модель allowlist и выбор CUDA.
 * Пути, команды и окружение определяет сервер; общий auth guard закрывает весь API.
 */
export function registerSpeechInstallation(
  fastify: FastifyInstance,
  service: SpeechInstallationService,
): void {
  fastify.get('/api/settings/speech/installation', () => service.current());
  fastify.post<{
    Params: { operation: SpeechInstallOperation };
    Body: { cuda?: boolean; modelId?: string };
  }>('/api/settings/speech/installation/:operation', {
    schema: {
      params: {
        type: 'object',
        required: ['operation'],
        properties: { operation: { enum: [...SPEECH_INSTALL_OPERATIONS] } },
      },
      body: {
        type: 'object',
        propertyNames: { enum: ['cuda', 'modelId'] },
        properties: {
          cuda: { type: 'boolean' },
          modelId: { enum: [...SPEECH_MODEL_IDS] },
        },
      },
    },
  }, async (request, reply) => {
    try {
      return reply.code(202).send(await service.start(
        request.params.operation, request.body?.cuda, request.body?.modelId,
      ));
    } catch (error) {
      if (error instanceof SpeechInstallError || error instanceof ModelJobError
        || error instanceof SpeechRuntimeError) {
        const status = error instanceof SpeechRuntimeError ? 409 : error.statusCode;

        return reply.code(status).send({ error: 'speech_install_unavailable', message: error.message });
      }

      throw error;
    }
  });
}
