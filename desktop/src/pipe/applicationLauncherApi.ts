import type { IncomingMessage, ServerResponse } from 'node:http';

import { isRecord } from '../../../shared/lib/objects.ts';
import type { ApplicationLauncher } from '../applicationLauncher.ts';
import { json } from './pipeServer.ts';

/**
 * Оболочка изменяет только два boolean, никогда не принимая пути или команды renderer.
 * Отсутствующий native-порт оставляет маршрут недоступным на старых и мобильных клиентах.
 */
export async function applicationLauncherApi(
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
  launcher: ApplicationLauncher | undefined,
): Promise<void> {
  if (!launcher) {
    json(response, 404, { error: 'not_found' });

    return;
  }

  if (request.method === 'GET') {
    json(response, 200, await launcher.read());

    return;
  }

  if (request.method !== 'POST' || !isRecord(body) || Object.keys(body).length !== 1
    || typeof body.autostart !== 'boolean' && typeof body.shortcut !== 'boolean') {
    json(response, 400, { error: 'invalid_launcher_request' });

    return;
  }

  const state = typeof body.autostart === 'boolean'
    ? await launcher.setAutostart(body.autostart) : await launcher.setShortcut(body.shortcut as boolean);

  json(response, 200, state);
}
