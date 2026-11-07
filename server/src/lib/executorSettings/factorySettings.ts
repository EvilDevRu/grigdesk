// Каждый новый узел читает канонический файл; busy launch удерживает прежний снимок.
// Native container остаётся приватным и не входит в обычные настройки адаптера.

import path from 'node:path';

import type { ExecutorAdapter } from '../executors/index.ts';
import type { PreparedExecutorRuntime } from './types.ts';
import { PrefsStore } from '../prefsStore.ts';
import { prepareNativeSettings } from './launch.ts';

/**
 * Только PrefsStore.readStored решает отсутствие файла; ошибки чтения не скрываются defaults.
 * Consumer pipeline требует явной capability и подтверждённого канала до prompt.
 * Чатовые тумблеры адаптера (прямой SSH/БД) узлу не передаются: в автономном узле
 * approval `never`, и прямой SSH остаётся заблокированным дефолтом адаптера.
 */
export async function prepareFactoryNativeSettings({
  adapter,
  config,
  prefsPath,
  cwd,
  mode,
  preparedRuntime,
}: {
  adapter: ExecutorAdapter;
  config: unknown;
  prefsPath: string;
  cwd: string;
  mode?: string;
  preparedRuntime?: PreparedExecutorRuntime;
}) {
  if (!prefsPath || !path.isAbsolute(prefsPath) || prefsPath.includes('\0')) {
    throw new Error('Factory требует абсолютный host-owned prefs path');
  }

  const saved = new PrefsStore({ prefsPath }).readStored().providerSettings;
  const nativeSettings = await prepareNativeSettings(adapter, config, cwd, saved, {
    consumer: 'pipeline',
    mode,
    preparedRuntime,
  });

  return { nativeSettings };
}
