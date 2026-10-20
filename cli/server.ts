import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

import { runtimeInstallationRoot, runtimeRoot } from '../server/src/lib/runtimePaths.ts';

import { dataHome, dataPath } from '../shared/runtime/dataHome.ts';

import { probeGrigDesk } from '../shared/runtime/grigDeskReadiness.ts';
import type { GrigDeskProbe } from '../shared/runtime/grigDeskReadiness.ts';
import type { CliArgs } from './args.ts';
import type { Settings } from './commands.ts';
import { printable, renderText } from './status.ts';
import { run, runAttached } from './system.ts';

export interface UnitInfo {
  load: string;
  active: string;
  sub: string;
  result: string;
  workingDirectory: string;
}

export type ServerStateName = 'ready' | 'starting' | 'stopping' | 'not_responding' | 'stopped'
  | 'failed' | 'conflict' | 'not_installed' | 'mismatch' | 'unknown';

export interface ServerState {
  state: ServerStateName;
  managed: boolean | null;
  reason: string | null;
}

export const UNIT = 'grigdesk-server.service';
const PROPERTIES = 'LoadState,ActiveState,SubState,Result,WorkingDirectory';

/**
 * Внешний ELF работает из I; прежний комплект и source используют корень server.
 * Контекст сборки сохраняет прежнюю раскладку независимо от env исходного CLI.
 */
function serverWorkingDirectory(root: string): string {
  return runtimeRoot() === runtimeInstallationRoot() ? path.join(root, 'server') : root;
}

function serverState(state: ServerStateName, managed: boolean | null, reason: string | null): ServerState {
  return {
    state,
    managed,
    reason,
  };
}

/**
 * Свойства systemd разбираются по ключу, независимо от порядка show.
 * Пустые и отсутствующие значения сохраняются как пустые строки.
 */
export function parseShow(text: string): UnitInfo {
  const fields = Object.fromEntries(text.split('\n').map((line) => {
    const separator = line.indexOf('=');

    return [line.slice(0, separator), separator < 0 ? '' : line.slice(separator + 1)];
  }));

  return {
    load: fields.LoadState ?? '',
    active: fields.ActiveState ?? '',
    sub: fields.SubState ?? '',
    result: fields.Result ?? '',
    workingDirectory: fields.WorkingDirectory ?? '',
  };
}

/**
 * Первая подходящая строка таблицы определяет состояние и владельца запуска.
 * Само состояние systemd никогда не доказывает готовность HTTP-сервера.
 */
export function deriveServerState(input: {
  unit: UnitInfo | null;
  probe: GrigDeskProbe;
  expectedDirectory: string;
  gate: string | null;
}): ServerState {
  const { unit, probe, expectedDirectory, gate } = input;
  const ready = probe === 'grigdesk';
  const refused = probe === 'refused';

  if (!unit) {
    return {
      state: ready ? 'ready' : 'unknown',
      managed: null,
      reason: ready ? 'systemd недоступен — служба не проверена' : 'systemd недоступен',
    };
  }

  if (unit.load === 'not-found') {
    return {
      state: ready ? 'ready' : refused ? 'not_installed' : 'conflict',
      managed: false,
      reason: ready ? 'работает вне службы' : refused
        ? 'служба не установлена: deploy/install.sh --no-autostart' : 'порт занят другой программой',
    };
  }

  if (unit.load !== 'loaded') {
    return serverState('mismatch', null, `служба в состоянии ${unit.load}`);
  }

  if (unit.workingDirectory !== expectedDirectory) {
    return {
      state: 'mismatch',
      managed: false,
      reason: `служба указывает на другую копию: ${unit.workingDirectory}`,
    };
  }

  if (unit.active === 'active') {
    if (ready) {
      return serverState('ready', true, null);
    }

    if (refused) {
      return serverState('starting', true, 'процесс запущен, порт ещё не открыт');
    }

    return {
      state: probe === 'no_answer' ? 'not_responding' : 'conflict',
      managed: true,
      reason: probe === 'no_answer' ? 'не отвечает на проверку' : 'порт занят другой программой',
    };
  }

  if (['activating', 'reloading'].includes(unit.active)) {
    return {
      state: ready ? 'conflict' : 'starting',
      managed: !ready,
      reason: ready ? 'порт держит ручной запуск, служба не может стартовать'
        : gate ? `ждёт VPN: ${gate}` : null,
    };
  }

  if (unit.active === 'deactivating') {
    return serverState('stopping', true, null);
  }

  if (['inactive', 'failed'].includes(unit.active)) {
    if (ready) {
      return serverState('ready', false, 'работает вне службы, служба остановлена');
    }

    if (refused) {
      return {
        state: unit.active === 'failed' ? 'failed' : 'stopped',
        managed: true,
        reason: unit.active === 'failed' ? `служба упала: ${unit.result}` : null,
      };
    }

    return serverState('conflict', false, 'порт занят другой программой');
  }

  return serverState('unknown', null, `неизвестное состояние ${unit.active}`);
}

/**
 * Последняя строка ворот заменяет все предыдущие причины отказа.
 * Успешные ворота и посторонний журнал не оставляют устаревшую причину VPN.
 */
export function gateReason(journal: string): string | null {
  const prefix = 'VPN-ворота: ';
  const suffix = ' — запуск запрещён';
  const last = journal.split('\n').filter((line) => line.startsWith(prefix)).at(-1);

  return last?.endsWith(suffix) ? last.slice(prefix.length, -suffix.length) : null;
}

/**
 * Читает службу и HTTP параллельно, затем журнал только при activating.
 * Результат содержит лишь контракт статуса, без вывода внутреннего журнала или ключей.
 */
export async function readServer(root: string, settings: Settings): Promise<ServerState & { url: string }> {
  const [show, probe] = await Promise.all([
    run('systemctl', ['--user', 'show', UNIT, `--property=${PROPERTIES}`], 5000),
    probeGrigDesk(settings.origin),
  ]);
  const unit = show.code === 0 ? parseShow(show.stdout) : null;
  let gate: string | null = null;

  if (unit?.active === 'activating') {
    const journal = await run('journalctl', [
      '--user', '-u', UNIT, '-n', '50', '-o', 'cat', '--no-pager',
    ], 10000);

    gate = journal.code === 0 ? gateReason(journal.stdout) : null;
  }

  return {
    ...deriveServerState({
      unit,
      probe,
      expectedDirectory: serverWorkingDirectory(root),
      gate,
    }),
    url: settings.origin + '/',
  };
}

/**
 * Ожидает подтверждённый ответ схемы, сохраняя последнее состояние для диагностики срока.
 * Срок проверяется после каждого снимка; падение службы даёт отдельный отказ.
 */
async function waitForServer(root: string, settings: Settings): Promise<number> {
  const seconds = Number(process.env.GRIGDESK_WAIT_SEC) || 90;
  const deadline = Date.now() + seconds * 1000;
  let state = await readServer(root, settings);

  while (true) {
    if (state.state === 'ready') {
      console.log('Сервер работает');

      return 0;
    }

    if (state.state === 'failed') {
      console.error(printable(state.reason ?? 'Служба упала'));

      return 1;
    }

    if (Date.now() >= deadline) {
      const last = renderText({ server: state }, { color: false }).trim();

      console.error(`Сервер не ответил за ${seconds} с. ${last}`);

      return 3;
    }

    await pause(500);
    state = await readServer(root, settings);
  }
}

/**
 * Управляет только проверенной службой этой копии и не трогает владельца HTTP-порта.
 * Сторож вызывается уровнем команд до чтения состояния и любых внешних эффектов.
 */
export async function serverCommand(args: CliArgs, root: string, settings: Settings): Promise<number> {
  const action = args.action;

  if (action === 'logs') {
    const show = await run('systemctl', ['--user', 'show', UNIT, `--property=${PROPERTIES}`], 5000);
    const unit = show.code === 0 ? parseShow(show.stdout) : null;

    if (unit?.load === 'not-found') {
      console.error('Служба сервера не установлена; журнал ручного запуска: ' + (process.env.GRIGDESK_LOG
        || dataPath(dataHome({ env: process.env, home: process.env.HOME || os.homedir() }), 'log')));

      return 1;
    }

    const state = deriveServerState({
      unit,
      probe: 'refused',
      expectedDirectory: serverWorkingDirectory(root),
      gate: null,
    });

    if (!unit || unit.load !== 'loaded' || state.state === 'mismatch') {
      console.error(printable(state.reason ?? 'systemd недоступен'));

      return 1;
    }

    return runAttached('journalctl', [
      '--user', '-u', UNIT, '-n', String(args.lines), '--no-pager', ...(args.follow ? ['-f'] : []),
    ]);
  }

  const state = await readServer(root, settings);

  if (action === 'start' && state.state === 'ready') {
    console.log('Сервер уже работает');

    return 0;
  }

  if (action === 'start' && state.state === 'starting') {
    console.log('Сервер уже запускается');

    return args.wait ? waitForServer(root, settings) : 0;
  }

  // Вне службы порт держит сервер приложения GrigDesk или ручной запуск: systemd им не владеет.
  if (state.state === 'ready' && state.managed === false) {
    console.error('Сервер работает вне службы (приложение GrigDesk или ручной запуск); '
      + 'systemd им не управляет');

    return 1;
  }

  if (state.state === 'not_responding' && action === 'start') {
    console.error('Сервер не отвечает: grigdesk-ctl server restart');

    return 1;
  }

  if (['conflict', 'not_installed', 'mismatch', 'unknown'].includes(state.state) ||
    state.managed !== true) {
    console.error(printable(state.reason ?? 'Служба сервера недоступна для управления'));

    return 1;
  }

  if (action === 'stop' && state.state === 'stopped') {
    console.log('Сервер уже остановлен');

    return 0;
  }

  // Слив ходов уже идёт: повторный stop ничего не добавит, а start и restart systemd поставит
  // в очередь за остановкой.
  if (action === 'stop' && state.state === 'stopping') {
    console.log('Сервер уже останавливается');

    return 0;
  }

  if (action === 'stop' || action === 'restart') {
    const verb = action === 'stop' ? 'Останавливаю' : 'Перезапускаю';

    console.error(`${verb} сервер: идущим ходам агентов дают закончить (до 45 с)…`);
  }

  const argv = action === 'start' ? ['--user', 'start', '--no-block', UNIT] : ['--user', action!, UNIT];
  const result = await run('systemctl', argv, action === 'start' ? 10000 : 120000);

  if (result.code !== 0) {
    console.error(printable(result.stderr.trim() || 'systemd отказал в выполнении команды'));

    return 1;
  }

  console.log(action === 'start' ? 'Запуск сервера запрошен'
    : action === 'stop' ? 'Сервер остановлен' : 'Сервер перезапущен');

  return args.wait ? waitForServer(root, settings) : 0;
}
