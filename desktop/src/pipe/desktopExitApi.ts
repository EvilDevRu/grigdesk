import type { ServerResponse } from 'node:http';

import type { ShellState } from '../../../shared/client/clientShell.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import type { DesktopExitPreference } from '../desktopExitPreference.ts';
import { json } from './pipeServer.ts';

/**
 * Локальная команда сохраняет только строгое boolean, без побочных настроек.
 * Старый runtime без desktop-порта не объявляет поддержку этой команды.
 */
export async function desktopExitApi(
  response: ServerResponse,
  body: unknown,
  preference: DesktopExitPreference | undefined,
  state: () => ShellState,
): Promise<void> {
  if (!preference) {
    json(response, 404, { error: 'not_found' });

    return;
  }

  if (!isRecord(body) || Object.keys(body).length !== 1
    || typeof body.skipConfirmation !== 'boolean') {
    json(response, 400, { error: 'invalid_exit_preference' });

    return;
  }

  await preference.set(body.skipConfirmation);
  json(response, 200, state());
}
