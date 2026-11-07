import { realpathSync } from 'node:fs';
import path from 'node:path';

import type { RuntimeBuildContext } from '../lib/runtimeBuildContext.ts';

type PayloadContext = Extract<RuntimeBuildContext, { mode: 'payload' }>;

let configured: PayloadContext | undefined;

/**
 * Контекст задаёт host-owned entry до ленивого импорта приложения и конфигурации.
 * Повтор допускается только для тех же физических путей; окружение режим не выбирает.
 */
export function configurePayloadContext(input: PayloadContext): void {
  if (!path.isAbsolute(input.bundleFile) || !path.isAbsolute(input.binary)) {
    throw Object.assign(new Error('Payload требует абсолютные пути bundleFile и binary'), {
      code: 'server_payload_context_invalid',
    });
  }

  const context: PayloadContext = {
    mode: 'payload',
    bundleFile: realpathSync(input.bundleFile),
    binary: realpathSync(input.binary),
  };

  if (configured && (configured.bundleFile !== context.bundleFile || configured.binary !== context.binary)) {
    throw Object.assign(new Error('Контекст серверного payload уже закреплён'), {
      code: 'server_payload_context_changed',
    });
  }

  configured ??= context;
}

/**
 * Доступ к packaged-путям до явной настройки запрещён именованной ошибкой.
 * Возвращается копия, чтобы потребитель не мог изменить закреплённые пути процесса.
 */
export function runtimeBuildContext(): PayloadContext {
  if (!configured) {
    throw Object.assign(new Error('Контекст серверного payload ещё не настроен'), {
      code: 'server_payload_context_missing',
    });
  }

  return { ...configured };
}
