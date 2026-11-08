import { serverSession } from './serverSession.ts';
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
  const cookie = await serverSession(settings);

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
