import { readFile } from 'node:fs/promises';

import { windowKeyPath } from '../shared/desktop/windowKeyPath.ts';
import type { CliArgs } from './args.ts';
import type { Settings } from './commands.ts';
import { renderTerminalQr } from './terminalQr.ts';
import { plainOutput } from './output.ts';
import type { CliOutput } from './output.ts';

interface PairingResponse {
  text: string;
  qr: { rows: string[] };
}

interface DeviceList {
  devices: { id: string; name: string; scope: string; revokedAt: number | null }[];
}

/**
 * Управление устройствами обменивает локальный ключ окна на короткую сессию.
 * CLI-токен и секреты устройств не попадают ни в запросы команды, ни в её вывод.
 */
export async function deviceCommand(
  args: CliArgs, settings: Settings, output: CliOutput = plainOutput,
): Promise<number> {
  const keyPath = windowKeyPath({
    env: {
      ...process.env,
      ...(settings.windowKeyPath ? { GRIGDESK_WINDOW_KEY_PATH: settings.windowKeyPath } : {}),
    },
    uid: process.getuid?.(),
    port: settings.port,
  });
  const key = keyPath ? await readFile(keyPath, 'utf8').catch(() => null) : null;

  if (!key) {
    throw new Error('Нет ключа окна: команда работает на машине с запущенным сервером');
  }

  const exchanged = await fetch(`${settings.origin}/api/auth/window-session?short=1`, {
    method: 'POST',
    headers: { 'x-grigdesk-window-key': key.trim() },
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  });
  const cookie = exchanged.headers.get('set-cookie')?.split(';')[0];

  await exchanged.body?.cancel();

  if (!exchanged.ok || !cookie) {
    throw new Error('Не удалось войти по ключу окна. Проверьте запущенный сервер.');
  }

  const url = args.deviceAction === 'add' ? '/api/devices/pairing'
    : args.deviceAction === 'revoke' ? `/api/devices/${encodeURIComponent(args.deviceValue!)}/revoke`
      : '/api/devices';
  const response = await fetch(settings.origin + url, {
    method: args.deviceAction === 'list' ? 'GET' : 'POST',
    headers: {
      cookie,
      ...(args.deviceAction === 'add' ? { 'content-type': 'application/json' } : {}),
    },
    ...(args.deviceAction === 'add' ? { body: JSON.stringify({
      name: args.deviceValue,
      ...(args.address ? { address: args.address } : {}),
    }) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json() as PairingResponse & DeviceList & { error?: string; message?: string };

  if (!response.ok) {
    throw new Error(body.error === 'client_listener_off'
      ? 'Откройте «Доступ к серверу» и включите прямой доступ; '
        + 'администратор также может задать GRIGDESK_CLIENT_LISTEN.'
      : body.message ?? 'Команда устройства не выполнена.');
  }

  if (args.json) {
    output.write(JSON.stringify(body) + '\n');
  } else if (args.deviceAction === 'add' && output.pairing) {
    output.pairing(body);
  } else if (args.deviceAction === 'list' && output.devices) {
    output.devices(body.devices);
  } else if (args.deviceAction === 'add') {
    const color = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);

    output.write(renderTerminalQr(body.qr.rows, color));
    output.write(`${body.text}\nДействует 10 минут, один раз\n`);
  } else if (args.deviceAction === 'list') {
    for (const device of body.devices) {
      const suffix = device.revokedAt ? '\tотозвано' : '';

      output.write(`${device.id}\t${device.name}\t${device.scope}${suffix}\n`);
    }
  } else {
    output.write('Устройство отозвано.\n');
  }

  return 0;
}
