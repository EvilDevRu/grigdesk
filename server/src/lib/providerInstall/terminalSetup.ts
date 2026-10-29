import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  ProviderInstallNotice,
  ProviderInstallTerminal,
} from '../../../../shared/chat/providerInstallContracts.ts';
import { parseVersion } from '../executors/_npmLatest.ts';
import {
  bashProbeEnvironment,
  probeBashEnvironment,
  runBashCommand,
} from './bashEnvironment.ts';
import { writeBashPathPlan, type BashPathPlan } from './bashPath.ts';
import type { InstallRoots } from './npmEnvironment.ts';

/**
 * Настройка терминала — отдельный честный этап после подключения CLI. Успех Bash
 * доказывается повторным независимым запуском: файл блока сам по себе ничего не значит.
 */
export interface TerminalSetupInput {
  plan: BashPathPlan;
  env: NodeJS.ProcessEnv;
  roots: InstallRoots;
  home: string;
  scratch: string;
  bash: string;
  cliName: string;
  expectedBin: string;
  expectedVersion: string;
  nonce: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const notice = (code: string, message: string): ProviderInstallNotice => ({ code, message });

const versionKey = (text: string): string | null => parseVersion(text)?.join('.') ?? null;

const terminal = (status: ProviderInstallTerminal['status'], reason: string | null,
  binDirectory: string): ProviderInstallTerminal => ({
  status,
  reason,
  binDirectory,
  shell: 'bash',
});

/**
 * Буквальный запуск имени в оболочке — единственная проверка, которую человек
 * повторит руками. Абсолютный путь и `command name` её не заменяют.
 */
async function launchName(input: TerminalSetupInput, mode: 'interactive' | 'login'):
  Promise<{ code: number | null; version: string | null }> {
  const result = await runBashCommand({
    bash: input.bash,
    mode,
    command: `${input.cliName} --version`,
    env: bashProbeEnvironment(input.env, input.bash),
    cwd: input.scratch,
    timeoutMs: input.timeoutMs ?? 15_000,
    signal: input.signal,
  });

  return {
    code: result.code,
    version: versionKey(result.stdout),
  };
}

const realpath = (file: string): Promise<string | null> => fs.realpath(file).catch(() => null);

/**
 * Порядок: снимки и запись блока, затем probe обеих форм, затем реальный запуск.
 * Несовпадение пути или alias/function — конфликт; таймаут, отказ writer и
 * ненайденная команда — needs_setup с причиной. Чужие настройки не затираются.
 */
export async function setupBashTerminal(input: TerminalSetupInput):
  Promise<{ terminal: ProviderInstallTerminal; warnings: ProviderInstallNotice[] }> {
  const binDirectory = path.dirname(input.expectedBin);

  if (input.plan.status === 'conflict') {
    return { terminal: terminal('conflict', 'terminal_command_conflict', binDirectory), warnings: [
      notice('terminal_command_conflict',
        'Управляемый блок PATH повреждён; файл настройки оставлен как есть'),
    ] };
  }
  if (input.plan.status === 'manual') {
    return { terminal: terminal('needs_setup', 'terminal_setup_required', binDirectory), warnings: [
      notice('terminal_setup_required',
        'Файл настройки Bash нельзя изменить автоматически; нужна ручная настройка PATH'),
    ] };
  }

  const written = await writeBashPathPlan(input.plan);

  if (written.status !== 'written' || written.written.length !== input.plan.changes.length) {
    return { terminal: terminal('needs_setup', 'terminal_setup_required', binDirectory), warnings: [
      notice('terminal_setup_required',
        'Файлы настройки Bash изменились или недоступны для записи; нужна ручная настройка PATH'),
    ] };
  }

  const report = await probeBashEnvironment({
    env: input.env,
    roots: input.roots,
    cliName: input.cliName,
    scratch: input.scratch,
    nonce: input.nonce,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });

  if (report.failed) {
    return { terminal: terminal('needs_setup', 'shell_probe_failed', binDirectory), warnings: [
      notice('shell_probe_failed',
        'Внешняя оболочка не ответила после настройки; установка CLI сохранена'),
    ] };
  }

  const expectedRealpath = await realpath(input.expectedBin);

  for (const mode of ['interactive', 'login'] as const) {
    const snapshot = report[mode];

    if (!snapshot || snapshot.cli.kind === 'missing') {
      return { terminal: terminal('needs_setup', 'terminal_setup_required', binDirectory), warnings: [
        notice('terminal_setup_required',
          'Команда не находится в обычном терминале: каталог установки нужно добавить в PATH'),
      ] };
    }
    if (snapshot.cli.kind !== 'file') {
      return { terminal: terminal('conflict', 'terminal_command_conflict', binDirectory), warnings: [
        notice('terminal_command_conflict',
          'Имя команды перехвачено alias или функцией оболочки; чужие настройки не изменены'),
      ] };
    }
    if (!expectedRealpath || await realpath(snapshot.cli.path) !== expectedRealpath) {
      return { terminal: terminal('conflict', 'terminal_command_conflict', binDirectory), warnings: [
        notice('terminal_command_conflict',
          'В оболочке команда указывает на другую копию; чужие настройки не изменены'),
      ] };
    }

    const launched = await launchName(input, mode);
    const expected = versionKey(input.expectedVersion);

    if (launched.code !== 0 || (expected !== null && launched.version !== expected)) {
      return { terminal: terminal('needs_setup', 'terminal_setup_required', binDirectory), warnings: [
        notice('terminal_setup_required',
          'Установленная команда не запускается по имени в обычном терминале'),
      ] };
    }
  }

  return { terminal: terminal('ready', null, binDirectory), warnings: [] };
}
