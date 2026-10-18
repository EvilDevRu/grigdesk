// Автозапуск и ярлык GrigDesk для «Настройки → Сервер».
//
// Автозапуск — это состояние юнита systemd (deploy/grigdesk-server.service) плюс linger:
// enable без linger поднимает сервер только при входе в сессию, с linger — при включении
// машины, до входа. Ярлык GrigDesk на рабочем столе и в меню делает deploy/shortcut.sh:
// одна реализация с установщиком, здесь только вызов и разбор его status-строк.
import os from 'node:os';
import path from 'node:path';
import { type CommandRunner, defaultCommandRunner } from './grigDeskRelease.ts';

import type {
  AutostartUnitState, AutostartState, ShortcutState, LauncherState,
} from '../../../shared/runtime/launcherContracts.ts';

export type {
  AutostartUnitState, AutostartState, ShortcutState, LauncherState,
} from '../../../shared/runtime/launcherContracts.ts';

// Отказ с кодом для интерфейса: маршрут переводит его в HTTP-статус.
export class LauncherError extends Error {
  readonly code: string;

  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 500) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface LauncherServiceOptions {
  rootDir: string;
  unitName?: string;
  runner?: CommandRunner;
  userName?: string;
}

export class LauncherService {
  private readonly rootDir: string;

  private readonly unitName: string;

  private readonly runner: CommandRunner;

  private readonly userName: string;

  constructor({
    rootDir,
    unitName = 'grigdesk-server.service',
    runner = defaultCommandRunner,
    userName = os.userInfo().username,
  }: LauncherServiceOptions) {
    this.rootDir = rootDir;
    this.unitName = unitName;
    this.runner = runner;
    this.userName = userName;
  }

  async readState(): Promise<LauncherState> {
    const [autostart, shortcut] = await Promise.all([this.readAutostart(), this.readShortcut()]);

    return { autostart, shortcut };
  }

  /**
   * Состояние автозапуска из трёх независимых ответов. `is-enabled` отвечает словом в
   * stdout и кодом 1 и для disabled, и для отсутствующего юнита — их различает только
   * пустой stdout. Linger читается у logind; его отсутствие не ломает остальное.
   */
  async readAutostart(): Promise<AutostartState> {
    const [enabled, active, linger] = await Promise.all([
      this.runner('systemctl', ['--user', 'is-enabled', this.unitName]),
      this.runner('systemctl', ['--user', 'is-active', this.unitName]),
      this.runner('loginctl', ['show-user', this.userName, '-p', 'Linger', '--value']),
    ]);
    const enabledWord = enabled.stdout.trim();
    const unit: AutostartUnitState = enabledWord === 'enabled'
      ? 'enabled'
      : enabledWord ? 'disabled' : 'missing';
    const lingerWord = linger.code === 0 ? linger.stdout.trim() : '';
    const lingerState = lingerWord === 'yes' ? true : lingerWord === 'no' ? false : null;

    return {
      unit,
      active: active.stdout.trim() === 'active',
      linger: lingerState,
      mode: autostartMode(unit, lingerState),
    };
  }

  /**
   * Переключает автозапуск, не трогая живой процесс: enable/disable без `--now`.
   * Включение добивается linger, но только если его ещё нет: у сервиса без сессии
   * polkit может отказать, и тогда автозапуск честно остаётся «при входе в систему» —
   * подсказку даёт интерфейс по полю linger, а не отказ всей операции.
   */
  async setAutostart(enabled: boolean): Promise<AutostartState> {
    const before = await this.readAutostart();

    if (before.unit === 'missing') {
      throw new LauncherError(
        'unit_missing',
        'Юнит systemd не установлен — выполни deploy/install.sh.',
        409,
      );
    }

    const toggle = await this.runner('systemctl', ['--user', enabled ? 'enable' : 'disable', this.unitName]);

    if (toggle.code !== 0) {
      throw new LauncherError(
        'autostart_failed',
        `systemctl не смог ${enabled ? 'включить' : 'выключить'} автозапуск.\n${tail(toggle.stderr)}`,
      );
    }
    if (enabled && before.linger !== true) {
      await this.runner('loginctl', ['enable-linger', this.userName]);
    }

    return this.readAutostart();
  }

  async readShortcut(): Promise<ShortcutState> {
    const result = await this.runShortcut('status');

    if (result.code !== 0) {
      return { desktopDir: null, desktop: false, menu: false };
    }

    return parseShortcutStatus(result.stdout);
  }

  async installShortcut(): Promise<ShortcutState> {
    const result = await this.runShortcut('install');

    if (result.code !== 0) {
      throw new LauncherError('shortcut_failed', `Ярлык не создан.\n${tail(result.stderr)}`);
    }

    return this.readShortcut();
  }

  async removeShortcut(): Promise<ShortcutState> {
    const result = await this.runShortcut('remove');

    if (result.code !== 0) {
      throw new LauncherError('shortcut_failed', `Ярлык не убран.\n${tail(result.stderr)}`);
    }

    return this.readShortcut();
  }

  private runShortcut(action: 'status' | 'install' | 'remove') {
    return this.runner('bash', [path.join(this.rootDir, 'deploy', 'shortcut.sh'), action], {
      cwd: this.rootDir,
      timeout: 15_000,
    });
  }
}

/**
 * Режим одним словом для интерфейса: enabled с linger — при включении машины, без linger —
 * при входе в сессию; неизвестный linger режим не гадает.
 */
function autostartMode(unit: AutostartUnitState, linger: boolean | null): AutostartState['mode'] {
  if (unit === 'missing') return 'unavailable';
  if (unit === 'disabled') return 'off';
  if (linger === null) return 'unavailable';

  return linger ? 'boot' : 'login';
}

// Строки «ключ<TAB>значение» скрипта; лишние ключи пропускаются, пропущенные — по умолчанию.
export function parseShortcutStatus(stdout: string): ShortcutState {
  const fields = new Map<string, string>();

  for (const line of stdout.split('\n')) {
    const index = line.indexOf('\t');

    if (index > 0) {
      fields.set(line.slice(0, index), line.slice(index + 1).trim());
    }
  }

  return {
    desktopDir: fields.get('desktop_dir') || null,
    desktop: fields.get('desktop') === '1',
    menu: fields.get('menu') === '1',
  };
}

// Хвост stderr для сообщения: причина отказа обычно в последних строках.
function tail(text: string): string {
  return String(text || '').split('\n').map((line) => line.trimEnd()).filter(Boolean)
    .slice(-4).join('\n').slice(-400);
}
