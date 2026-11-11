import { readFile } from 'node:fs/promises';

import { windowKeyPath } from '../shared/desktop/windowKeyPath.ts';
import type { Settings } from '../shared/runtime/runtimeSettings.ts';
import { cliTranslator } from './i18n.ts';

/**
 * Короткая сессия выдаётся только локальному владельцу ключа запущенного сервера.
 * Общий обмен не использует CLI bearer и не сохраняет cookie на диск.
 */
export async function serverSession(settings: Settings): Promise<string> {
  const file = windowKeyPath({
    env: { ...process.env,
      ...(settings.windowKeyPath ? { GRIGDESK_WINDOW_KEY_PATH: settings.windowKeyPath } : {}) },
    uid: process.getuid?.(),
    port: settings.port,
  });
  const key = file ? await readFile(file, 'utf8').catch(() => null) : null;

  if (!key) {
    throw new Error(cliTranslator().t('remote.sessionUnavailable'));
  }

  const response = await fetch(settings.origin + '/api/auth/window-session?short=1', {
    method: 'POST',
    headers: { 'x-grigdesk-window-key': key.trim() },
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  });
  const cookie = response.headers.get('set-cookie')?.split(';')[0];

  await response.body?.cancel();

  if (!response.ok || !cookie) {
    throw new Error(cliTranslator().t('remote.sessionUnavailable'));
  }

  return cookie;
}
