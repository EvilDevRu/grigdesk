// Adapter к engine-owned debug settings. Формат файлов здесь намеренно неизвестен:
// Cockpit вызывает только `factory ... debug`, чтобы не заводить второго writer-а.
import { config as runtimeConfig } from '../config.ts';

import { execFile } from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';

// Куда применяется настройка: вся машина, профиль или одна задача.
export interface DebugTarget {
  scope: string;
  profile?: string | number | null;
  task?: string | number | null;
}

// Ответ `factory ... debug show`: что записано и что из этого действует.
export interface FactoryDebugView {
  scope: string;
  configured: string;
  configuredExpiresAt: number;
  effective: string;
  source: string;
  expiresAt: number;
}

// Потоки завершённой команды: отказ приходит reject-ом, а не полем результата.
export interface DebugRunResult {
  stdout: string;
  stderr: string;
}

// Запуск CLI движка. Подменяется в тестах, поэтому объявлен отдельным типом.
export type DebugRunner = (
  file: string,
  args: string[],
  options: ExecFileOptions,
) => Promise<DebugRunResult>;

const ACTIVE_LEVELS = new Set(['off', 'errors', 'decisions', 'verbose']);
const CONFIGURED_LEVELS = new Set(['inherit', ...ACTIVE_LEVELS]);
const SCOPES = new Set(['global', 'profile', 'task']);
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TASK_RE = /^[0-9]+$/;
const DURATION_RE = /^[1-9][0-9]*[smhd]$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;

export class FactoryDebugInputError extends Error {}
export class FactoryDebugCommandError extends Error {}

const defaultRun: DebugRunner = (file, args, options) => {
  return new Promise<DebugRunResult>((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(new FactoryDebugCommandError(
          String(stderr || error.message || 'factory debug command failed').trim().slice(-1000),
        ));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
};

function numeric(value: string | undefined, name: string): number {
  if (!UINT_RE.test(String(value))) throw new Error(`Некорректный ответ factory debug: ${name}`);
  return Number(value);
}

function durationValid(value: unknown): boolean {
  const text = String(value || '');
  const match = DURATION_RE.exec(text);
  if (!match) return false;
  const unit = text.at(-1);
  const amountText = text.slice(0, -1);
  if (amountText.length > 8) return false;
  const amount = Number(amountText);
  const multiplier: Record<string, number | undefined> = {
    s: 1, m: 60, h: 3600, d: 86400,
  };
  return Number.isSafeInteger(amount) && amount * (multiplier[String(unit)] ?? 0) <= 31_536_000;
}

export function parseFactoryDebugView(text: string | null | undefined): FactoryDebugView {
  const raw: Record<string, string> = {};
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const at = line.indexOf(':');
    if (at < 1) throw new Error('Некорректный ответ factory debug');
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key in raw) throw new Error(`Некорректный ответ factory debug: duplicate ${key}`);
    raw[key] = value;
  }
  const required = [
    'scope', 'configured', 'configured_expires_at', 'effective', 'source', 'expires_at',
  ];
  if (required.some((key) => !(key in raw))) {
    throw new Error('Некорректный ответ factory debug: неполный view');
  }
  if (!SCOPES.has(String(raw.scope)) || !CONFIGURED_LEVELS.has(String(raw.configured))
      || !ACTIVE_LEVELS.has(String(raw.effective)) || !/^[a-z_]+$/.test(String(raw.source))) {
    throw new Error('Некорректный ответ factory debug: неизвестное значение');
  }
  return {
    scope: String(raw.scope),
    configured: String(raw.configured),
    configuredExpiresAt: numeric(raw.configured_expires_at, 'configured_expires_at'),
    effective: String(raw.effective),
    source: String(raw.source),
    expiresAt: numeric(raw.expires_at, 'expires_at'),
  };
}

function validateTarget({ scope, profile, task }: DebugTarget): void {
  if (!SCOPES.has(scope)) throw new FactoryDebugInputError('Неизвестная область debug.');
  if (scope === 'profile' && !PROFILE_RE.test(String(profile || ''))) {
    throw new FactoryDebugInputError('Некорректное имя профиля.');
  }
  if (scope === 'task' && !TASK_RE.test(String(task || ''))) {
    throw new FactoryDebugInputError('Некорректный номер задачи.');
  }
}

function targetArgs({ scope, profile, task }: DebugTarget): string[] {
  validateTarget({ scope, profile, task });
  if (scope === 'global') return ['settings', 'debug'];
  if (scope === 'profile') return ['profile', String(profile), 'debug'];
  return [String(task), 'debug'];
}

export class FactoryDebugSettings {
  readonly factoryBin: string;

  readonly stateDir: string;

  readonly configRoot: string;

  readonly profilesDir: string;

  readonly run: DebugRunner;

  constructor({
    factoryBin, stateDir, configRoot, profilesDir = '', run = defaultRun,
  }: {
    factoryBin: string;
    stateDir: string;
    configRoot: string;
    profilesDir?: string;
    run?: DebugRunner;
  }) {
    if (!factoryBin || !stateDir || !configRoot) {
      throw new Error('FactoryDebugSettings: factoryBin/stateDir/configRoot are required');
    }
    this.factoryBin = factoryBin;
    this.stateDir = stateDir;
    this.configRoot = configRoot;
    this.profilesDir = profilesDir;
    this.run = run;
  }

  async command(args: string[]): Promise<DebugRunResult> {
    const env = {
      COCKPIT_HOME: runtimeConfig.dataHome,
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: process.env.HOME || '',
      LANG: process.env.LANG || 'C',
      LC_ALL: process.env.LC_ALL || 'C',
      FACTORY_STATE: this.stateDir,
      STATE_DIR: this.stateDir,
      FACTORY_CONFIG_ROOT: this.configRoot,
      ...(this.profilesDir ? { FACTORY_PROFILES_DIR: this.profilesDir } : {}),
    };
    return this.run(this.factoryBin, args, {
      shell: false,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      env,
    });
  }

  async show(target: DebugTarget): Promise<FactoryDebugView> {
    const { stdout } = await this.command([...targetArgs(target), 'show']);
    return parseFactoryDebugView(stdout);
  }

  async set({ scope, profile, task, level, duration }: DebugTarget & {
    level: string;
    duration?: unknown;
  }): Promise<FactoryDebugView> {
    validateTarget({ scope, profile, task });
    if (!ACTIVE_LEVELS.has(level)) {
      throw new FactoryDebugInputError('Неизвестный уровень debug.');
    }
    if (duration !== undefined && !durationValid(duration)) {
      throw new FactoryDebugInputError('Некорректный срок debug.');
    }
    const args = [...targetArgs({ scope, profile, task }), 'set', level];
    if (duration !== undefined) args.push('--for', String(duration));
    const { stdout } = await this.command(args);
    return stdout.trim()
      ? parseFactoryDebugView(stdout)
      : this.show({ scope, profile, task });
  }

  async clear({ scope, profile, task }: DebugTarget): Promise<FactoryDebugView> {
    const target = { scope, profile, task };
    const { stdout } = await this.command([...targetArgs(target), 'clear']);
    return stdout.trim() ? parseFactoryDebugView(stdout) : this.show(target);
  }
}
