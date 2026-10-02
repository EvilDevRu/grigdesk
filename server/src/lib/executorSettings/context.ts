// Контекст задаётся серверной конфигурацией; браузер не выбирает cwd или профиль.
// Адаптер может уточнить transport и профиль, сохраняя общий формат кэша.

import fs from 'node:fs';
import path from 'node:path';
import type { ExecutorAdapter } from '../executors/index.ts';
import type { NativeSettingsContext } from './types.ts';
import type { SettingsConsumer } from '../../../../shared/providerSettingsContracts.ts';

/**
 * Базовая карточка и запуск строят одинаковую идентичность источника.
 * Недоступный бинарь имеет отдельную идентичность и не наследует готовность прежнего.
 */
export async function nativeSettingsContext(
  adapter: Pick<ExecutorAdapter, 'id' | 'nativeSettings'> & Partial<Pick<ExecutorAdapter, 'bin'>>,
  config: unknown,
  cwd = String((config as { rootDir?: unknown } | null)?.rootDir ?? process.cwd()),
  consumer: SettingsConsumer = 'chat',
): Promise<NativeSettingsContext> {
  if (adapter.nativeSettings?.context) {
    const context = await adapter.nativeSettings.context(config, cwd, consumer);

    context.consumer = consumer;

    return context;
  }

  const configured = String(adapter.bin?.(config) ?? adapter.id);
  const binary = configured.includes(path.sep)
    ? configured
    : ((process.env.PATH ?? '')
        .split(path.delimiter)
        .map((directory) => path.join(directory, configured))
        .find((file) => {
          try {
            fs.accessSync(file, fs.constants.X_OK);

            return true;
          } catch {
            return false;
          }
        }) ?? configured);
  let binaryIdentity = `${binary}:unavailable`;

  try {
    const stat = fs.statSync(binary);

    binaryIdentity = `${fs.realpathSync(binary)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
  } catch {
    // Источник сам сообщит о недоступности; сырой текст файловой ошибки не публикуется.
  }

  return {
    providerId: adapter.id,
    binaryIdentity,
    profileFingerprint: 'default',
    transport: 'default',
    mode: 'default',
    cwdRealpath: fs.realpathSync(cwd),
    consumer,
  };
}
