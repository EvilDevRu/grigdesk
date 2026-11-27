import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { isChatSpeed, type ChatSpeed } from '../../../shared/chat/chatSpeed.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import { withPathLock } from './pathLock.ts';
import { loadRunnerConfig } from './runnerState.ts';

import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { PROFILE_RE } from './profiles.ts';

export type ProfileConfigFile = 'profile.sh' | 'dashboard.env';

export const PROFILE_EDITABLE_VARIABLES: Record<ProfileConfigFile, readonly string[]> = {
  'profile.sh': [
    'PROFILE_CTX', 'PROFILE_SERVICE_HOST', 'PROFILE_LOOP_MAX_ROUNDS',
    'PROFILE_TRIAGE_REPOS', 'PROFILE_TRIAGE_MARKERS', 'PROFILE_TRIAGE_ROUTES',
    'PROFILE_TRIAGE_RULES',
  ],
  'dashboard.env': [
    'FACTORY_STAND_URL', 'FACTORY_STAND_CONTAINER', 'FACTORY_STAND_FE_CONTAINER',
    'FACTORY_TASK_BASE_URL', 'FACTORY_TIMER_CMD',
  ],
};

export interface ProfileVariableValue {
  name: string;
  value: string | null;
  literal: boolean;
  editable: boolean;
  present: boolean;
  reason: string | null;
}

export interface ProfileConfigRuntime {
  profilesDir: string;
  factoryBin: string;
  factoryHome: string;
  stateDir: string;
  factoryControlDir: string;
  factoryConfigRoot: string;
  dataHome: string;
}

export class ProfileConfigError extends Error {
  readonly code: string;
  readonly status: number;
  readonly applied: number;
  readonly currentOperationUnknown: boolean;

  constructor(code: string, status: number, message = code,
    applied = 0, currentOperationUnknown = false) {
    super(message);
    this.code = code;
    this.status = status;
    this.applied = applied;
    this.currentOperationUnknown = currentOperationUnknown;
  }
}

interface SourceLine {
  start: number;
  end: number;
  body: string;
  ending: string;
}

interface ProfileSource {
  bytes: Buffer;
  text: string;
  stat: Stats;
}

interface MetadataScan {
  lines: SourceLine[];
  entries: ProfileVariableValue[];
  indices: Map<string, number>;
  insertAt: number;
  newline: string;
}

const MAX_SOURCE_BYTES = 256 * 1024;
const DECLARATION = /^[ \t]*(?:(?:export|local|readonly|declare)[ \t]+)?([A-Z][A-Z0-9_]*)[ \t]*=/;
const PREFIX_ASSIGNMENT = /^[ \t]*([A-Z][A-Z0-9_]*)=(.*)$/;

/**
 * Значение записывается одной строкой в двойных кавычках без экранирования.
 * Управляющие символы, исполнение, кавычки и обратная косая черта не поддержаны.
 */
function literalValueAllowed(value: string): boolean {
  return value.length <= 2000 && !/[\u0000-\u001f\u007f"'\\$`;]/u.test(value);
}

/**
 * Разбирает только полное однострочное присваивание префикса.
 * Непарная кавычка никогда не превращается в неквоченный литерал.
 */
function prefixValue(raw: string): string | null {
  const tail = raw.trimEnd();
  const quote = tail[0];

  if (quote === '"' || quote === "'") {
    if (tail.length < 2 || !tail.endsWith(quote)) {
      return null;
    }

    const value = tail.slice(1, -1);

    return literalValueAllowed(value) ? value : null;
  }

  return /^[A-Za-z0-9_./,:@%+=-]*$/.test(tail) && literalValueAllowed(tail)
    ? tail : null;
}

/**
 * Сохраняет точные границы строк, включая CRLF и отсутствие последнего LF.
 * Замена metadata не нормализует соседний shell-текст.
 */
function sourceLines(text: string): SourceLine[] {
  const result: SourceLine[] = [];
  const expression = /([^\r\n]*)(\r\n|\n|\r|$)/g;

  for (const match of text.matchAll(expression)) {
    if (!match[0].length) {
      continue;
    }

    result.push({
      start: match.index,
      end: match.index + match[0].length,
      body: match[1]!,
      ending: match[2]!,
    });
  }

  return result;
}

/**
 * Динамические writers закрывают редактирование metadata: их цель не доказана.
 * Это намеренно консервативный фильтр, а не интерпретатор и не поиск effective value.
 */
function hasOpaqueWriter(text: string): boolean {
  return /\b(?:eval|source|declare|typeset|local|read|readarray|mapfile)\b/.test(text)
    || /\b(?:unset|export|let|trap|builtin)\b/.test(text)
    || /(?:^|[;|&()])[ \t]*\.[ \t]+/m.test(text)
    || /\bprintf\b[^\n]*[ \t]-v(?:[ \t]|$)/.test(text)
    || /\$\{[^}\n]*:?=/.test(text)
    || /(?:^|[;|&()])[ \t]*["']?\$/.test(text);
}

/**
 * Выделяет только доказанный префикс literal metadata и проверяет весь остаток.
 * Любое повторное упоминание имени вне его строки делает поле readonly; даже
 * обычное чтение может дать консервативный отказ. Вложения и heredoc не редактируются.
 */
function scanMetadata(text: string, file: ProfileConfigFile): MetadataScan {
  const lines = sourceLines(text);
  const indices = new Map<string, number>();
  const values = new Map<string, string>();
  const names = new Set<string>(PROFILE_EDITABLE_VARIABLES[file]);
  let insertAt = 0;
  let prefixOpen = true;

  for (const [index, line] of lines.entries()) {
    const trimmed = line.body.trim();
    const declared = DECLARATION.exec(line.body);

    if (declared) {
      names.add(declared[1]!);
    }
    if (!prefixOpen) {
      continue;
    }
    if (!trimmed || trimmed.startsWith('#')) {
      insertAt = line.end;
      continue;
    }

    const assignment = PREFIX_ASSIGNMENT.exec(line.body);
    const value = assignment ? prefixValue(assignment[2]!) : null;

    if (!assignment || value === null || indices.has(assignment[1]!)) {
      prefixOpen = false;
      continue;
    }

    indices.set(assignment[1]!, index);
    values.set(assignment[1]!, value);
    insertAt = line.end;
  }

  const nonComments = lines.filter((line) => !line.body.trimStart().startsWith('#'));
  const opaque = hasOpaqueWriter(nonComments.filter((line) => line.start >= insertAt)
    .map((line) => line.body).join('\n'));
  const allowed = new Set(PROFILE_EDITABLE_VARIABLES[file]);
  const entries: ProfileVariableValue[] = [];

  for (const name of names) {
    const index = indices.get(name);
    const ownLine = index === undefined ? null : lines[index];
    const token = new RegExp(`(^|[^A-Za-z0-9_])${name}($|[^A-Za-z0-9_])`);
    const otherMention = nonComments.some((line) => line !== ownLine && token.test(line.body));
    const present = index !== undefined || nonComments.some((line) => token.test(line.body));
    const editable = allowed.has(name) && !opaque && !otherMention;
    const literal = editable && index !== undefined;

    entries.push({
      name,
      value: literal ? values.get(name)! : null,
      literal,
      editable,
      present,
      reason: !allowed.has(name) ? 'not_allowed'
        : !editable ? 'not_literal_metadata'
          : !present ? 'not_declared' : null,
    });
  }

  return {
    lines,
    entries,
    indices,
    insertAt,
    newline: text.includes('\r\n') ? '\r\n' : '\n'
  };
}

/**
 * Ключ блокировки и путь файла строятся только после проверки profile/file.
 * Корень разрешается канонически, отдельный профиль не может быть симлинком.
 */
async function profileTarget(profilesDir: string, profile: string,
  file: ProfileConfigFile): Promise<string> {
  if (!PROFILE_RE.test(profile) || !Object.hasOwn(PROFILE_EDITABLE_VARIABLES, file)) {
    throw new ProfileConfigError('bad_request', 400);
  }

  try {
    const root = await fs.realpath(profilesDir);
    const directory = path.join(root, profile);
    const stat = await fs.lstat(directory);

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ProfileConfigError('profile_not_found', 404);
    }

    return path.join(directory, file);
  } catch (error) {
    if (error instanceof ProfileConfigError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ProfileConfigError('profile_not_found', 404);
    }

    throw error;
  }
}

/**
 * Читает ограниченный обычный UTF-8 файл через один handle, без исполнения shell.
 * Проверка прав/формата не превращает повреждённый файл в пустую конфигурацию.
 */
async function readSource(target: string): Promise<ProfileSource> {
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const stat = await handle.stat();

    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) {
      throw new ProfileConfigError('profile_source_unsupported', 409);
    }

    const bytes = await handle.readFile();
    const text = bytes.toString('utf8');

    if (bytes.length > MAX_SOURCE_BYTES || !Buffer.from(text, 'utf8').equals(bytes)) {
      throw new ProfileConfigError('profile_source_unsupported', 409);
    }

    return {
      bytes,
      text,
      stat
    };
  } finally {
    await handle.close();
  }
}

/**
 * Возвращает исходные metadata и причины readonly, не выполняя профиль.
 * Отсутствующий dashboard представлен недоступными полями, profile.sh обязателен.
 */
export async function readProfileVariables(profilesDir: string, profile: string,
  file: ProfileConfigFile): Promise<ProfileVariableValue[]> {
  const target = await profileTarget(profilesDir, profile, file);

  try {
    return scanMetadata((await readSource(target)).text, file).entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    if (file === 'profile.sh') {
      throw new ProfileConfigError('profile_not_found', 404);
    }

    return PROFILE_EDITABLE_VARIABLES[file].map((name) => ({
      name,
      value: null,
      literal: false,
      editable: false,
      present: false,
      reason: 'file_missing',
    }));
  }
}

export interface ProfileVariableChange {
  name: string;
  from: string | null;
  to: string | null;
}

export type RunnerConfigOperation =
  | {
    kind: 'runner';
    role?: string;
    primary: string;
    failover?: string
  }
  | {
    kind: 'model';
    role: string;
    provider: string;
    family?: string;
    familyFailover?: string;
    version?: string;
    variant?: string;
    effort?: string;
    speed?: ChatSpeed | '';
    exact?: string;
  };

const MODEL_FIELDS = ['family', 'familyFailover', 'version', 'variant', 'effort', 'speed', 'exact'] as const;
const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const ROLE_ID = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Проверяет точный объект JSON, не доверяя TypeScript cast на сетевой границе.
 * Лишние поля отклоняются до первого файлового или process-эффекта.
 */
function exactRecord(value: unknown, required: string[], optional: readonly string[] = []):
  Record<string, unknown> {
  if (!isRecord(value) || required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new ProfileConfigError('bad_request', 400);
  }

  return value;
}

/**
 * Декодирует весь пакет переменных до эффекта и запрещает повтор одного target.
 * from — снимок metadata, to — безопасное строковое значение либо удаление.
 */
function variableChanges(file: ProfileConfigFile, input: unknown): ProfileVariableChange[] {
  if (!Object.hasOwn(PROFILE_EDITABLE_VARIABLES, file)
    || !Array.isArray(input) || input.length < 1 || input.length > 64) {
    throw new ProfileConfigError('bad_request', 400);
  }

  const seen = new Set<string>();

  return input.map((item) => {
    const value = exactRecord(item, ['name', 'from', 'to']);

    if (typeof value.name !== 'string' || seen.has(value.name)
      || !PROFILE_EDITABLE_VARIABLES[file].includes(value.name)
      || (value.from !== null && (typeof value.from !== 'string' || value.from.length > 2000))
      || (value.to !== null && (typeof value.to !== 'string' || !literalValueAllowed(value.to)))) {
      throw new ProfileConfigError('bad_request', 400);
    }

    seen.add(value.name);


    return {
      name: value.name,
      from: value.from,
      to: value.to
    } as ProfileVariableChange;
  });
}

/**
 * HTTP envelope проверяется отдельно от данных, но до обращения к профилю.
 * Возвращаемые изменения уже не содержат null-элементов и чужих ключей.
 */
export function decodeVariablePatch(input: unknown):
  { file: ProfileConfigFile; changes: ProfileVariableChange[] } {
  const value = exactRecord(input, ['file', 'changes']);

  if (value.file !== 'profile.sh' && value.file !== 'dashboard.env') {
    throw new ProfileConfigError('bad_request', 400);
  }

  return { file: value.file, changes: variableChanges(value.file, value.changes) };
}

/**
 * Проверяет полный runner batch до spawn, включая model fields и semantic targets.
 * Пропуск failover сохраняется в DTO отдельно от явной пустой строки.
 */
function runnerOperations(input: unknown): RunnerConfigOperation[] {
  if (!Array.isArray(input) || !input.length || input.length > 64) {
    throw new ProfileConfigError('bad_request', 400);
  }

  const seen = new Set<string>();

  return input.map((item) => {
    if (!isRecord(item) || (item.kind !== 'runner' && item.kind !== 'model')) {
      throw new ProfileConfigError('bad_request', 400);
    }

    const value = item.kind === 'runner'
      ? exactRecord(item, ['kind', 'primary'], ['role', 'failover'])
      : exactRecord(item, ['kind', 'role', 'provider'], MODEL_FIELDS);
    const role = value.role;

    if ((Object.hasOwn(value, 'role') && (typeof role !== 'string' || !ROLE_ID.test(role)))
      || (value.kind === 'model' && role === undefined)) {
      throw new ProfileConfigError('bad_request', 400);
    }

    let target: string;

    if (value.kind === 'runner') {
      if (typeof value.primary !== 'string' || !PROVIDER_ID.test(value.primary)
        || (Object.hasOwn(value, 'failover') && (typeof value.failover !== 'string'
          || value.failover.length > 1024
          || (value.failover !== '' && value.failover.split(',').some((id) => !PROVIDER_ID.test(id)))))) {
        throw new ProfileConfigError('bad_request', 400);
      }

      target = `runner:${role ?? ''}`;
    } else {
      const fields = MODEL_FIELDS.filter((field) => Object.hasOwn(value, field));

      if (typeof value.provider !== 'string' || !PROVIDER_ID.test(value.provider) || !fields.length
        || fields.some((field) => typeof value[field] !== 'string'
          || (value[field] as string).length > 512
          || !/^[A-Za-z0-9._,:/@=+-]*$/.test(value[field] as string))) {
        throw new ProfileConfigError('bad_request', 400);
      }

      // Режимы согласованы с SupportsSpeed в Go, PROFILE_SPEED_MODES и chatSpeed адаптеров.
      if (Object.hasOwn(value, 'speed') && value.speed !== ''
        && (typeof value.speed !== 'string' || !isChatSpeed(value.speed)
          || (value.provider !== 'codex' && value.provider !== 'claude')
          || (value.provider === 'claude' && value.speed === 'ultrafast'))) {
        throw new ProfileConfigError('bad_request', 400);
      }

      target = `model:${role}:${value.provider.toUpperCase().replace(/-/g, '_')}`;
    }

    if (seen.has(target)) {
      throw new ProfileConfigError('bad_request', 400);
    }

    seen.add(target);


    return { ...value } as RunnerConfigOperation;
  });
}

/**
 * Проверяет HTTP envelope runner-команды без permissive приведения массива.
 * После возврата допустимы только два известных вида операций.
 */
export function decodeRunnerPatch(input: unknown): RunnerConfigOperation[] {
  return runnerOperations(exactRecord(input, ['operations']).operations);
}

/**
 * Сравнивает весь прочитанный файл и identity, а не только меняемую переменную.
 * Чужое изменение комментария или замена inode тоже отменяет наш rename.
 */
function sameSource(before: ProfileSource, after: ProfileSource): boolean {
  return before.bytes.equals(after.bytes)
    && before.stat.dev === after.stat.dev && before.stat.ino === after.stat.ino
    && before.stat.mode === after.stat.mode && before.stat.mtimeMs === after.stat.mtimeMs
    && before.stat.ctimeMs === after.stat.ctimeMs;
}

/**
 * Готовит все замены после проверки всех CAS/readonly условий.
 * Вставка отсутствующих metadata идёт в конец доказанного префикса перед shell-хвостом.
 */
function changedSource(text: string, scan: MetadataScan, changes: ProfileVariableChange[]): string {
  const byName = new Map(scan.entries.map((item) => [item.name, item]));
  const replacements: Array<{
    start: number;
    end: number;
    text: string
  }> = [];
  const additions: string[] = [];

  for (const change of changes) {
    const current = byName.get(change.name)!;

    if (!current.editable) {
      throw new ProfileConfigError('variable_not_literal', 409, change.name);
    }
    if (current.value !== change.from) {
      throw new ProfileConfigError('variable_conflict', 409, change.name);
    }

    const index = scan.indices.get(change.name);

    if (index === undefined) {
      if (change.to === null) {
        throw new ProfileConfigError('variable_absent', 400, change.name);
      }

      additions.push(`${change.name}="${change.to}"${scan.newline}`);
      continue;
    }

    const line = scan.lines[index]!;

    replacements.push({
      start: line.start,
      end: line.end,
      text: change.to === null ? '' : `${change.name}="${change.to}"${line.ending}`,
    });
  }

  if (additions.length) {
    const delimiter = scan.insertAt > 0 && !/[\r\n]/.test(text[scan.insertAt - 1]!)
      ? scan.newline : '';

    replacements.push({
      start: scan.insertAt,
      end: scan.insertAt,
      text: delimiter + additions.join('')
    });
  }

  let result = text;

  for (const item of replacements.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, item.start) + item.text + result.slice(item.end);
  }

  return result;
}

/**
 * Сериализует собственные writers общим lock и сохраняет mode/соседние байты.
 * Recheck ловит внешний drift до rename; произвольный внешний редактор общий lock
 * не соблюдает, поэтому межпроцессная линейризуемость здесь не обещается.
 */
export async function applyProfileVariableChanges(profilesDir: string, profile: string,
  file: ProfileConfigFile, input: unknown,
  hooks: { beforeRecheck?: () => Promise<void> } = {}): Promise<ProfileVariableValue[]> {
  const changes = variableChanges(file, input);
  const target = await profileTarget(profilesDir, profile, file);

  return withPathLock(target, async () => {
    let before: ProfileSource;

    try {
      before = await readSource(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ProfileConfigError('profile_not_found', 404);
      }

      throw error;
    }

    const scan = scanMetadata(before.text, file);
    const output = changedSource(before.text, scan, changes);

    if (Buffer.byteLength(output, 'utf8') > MAX_SOURCE_BYTES) {
      throw new ProfileConfigError('profile_source_too_large', 400);
    }
    if (output === before.text) {
      return scan.entries;
    }

    const temporary = path.join(path.dirname(target), `.${file}.${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, 'wx', before.stat.mode & 0o7777);

    try {
      try {
        await handle.writeFile(output, 'utf8');
        await handle.chmod(before.stat.mode & 0o7777);
        await handle.sync();
      } finally {
        await handle.close();
      }

      await hooks.beforeRecheck?.();


      const current = await readSource(target).catch(() => null);

      if (!current || !sameSource(before, current)) {
        throw new ProfileConfigError('profile_file_conflict', 409);
      }

      await fs.rename(temporary, target);


      return scanMetadata(output, file).entries;
    } finally {
      await fs.rm(temporary, { force: true });
    }
  });
}

/**
 * Запускает выбранную поставку CLI с фиксированным argv, без shell и stdin.
 * Потоки ограничены, timeout завершает собственную группу потомков и ждёт close;
 * kill-таймер очищается при завершении, чтобы не попасть по переиспользованному PID.
 */
function runProfileCommand(config: ProfileConfigRuntime, args: string[], applied: number): Promise<void> {
  if (!path.isAbsolute(config.factoryBin) || !path.isAbsolute(config.factoryHome)) {
    throw new ProfileConfigError('profile_config_runtime', 503);
  }

  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(config.factoryBin, args, {
      cwd: config.factoryHome,
      shell: false,
      detached: grouped,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        HOME: process.env.HOME || '',
        LANG: process.env.LANG || 'C',
        LC_ALL: process.env.LC_ALL || 'C',
        GRIGDESK_HOME: config.dataHome,
        FACTORY_HOME: config.factoryHome,
        FACTORY_PROFILES_DIR: config.profilesDir,
        FACTORY_STATE: config.stateDir,
        STATE_DIR: config.stateDir,
        FACTORY_CONTROL_ROOT: config.factoryControlDir,
        FACTORY_CONFIG_ROOT: config.factoryConfigRoot,
      },
    });
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Завершает только созданную группу собственного CLI по таймауту.
     * Исчезновение процесса между close и сигналом не мешает очистке.
     */
    const terminate = (signal: NodeJS.Signals) => {
      try {
        if (grouped && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // Между close и сигналом собственный процесс мог уже завершиться.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      killTimer = setTimeout(() => terminate('SIGKILL'), 5000);
      killTimer.unref();
    }, 15000);

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (part: string) => {
      stderr = (stderr + part).slice(-4000);
    });

    /**
     * Однократно завершает Promise и снимает оба собственных таймера.
     * Поздний close после error не меняет подтверждённый результат.
     */
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);


      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    child.once('error', (error) => finish(new ProfileConfigError(
      'profile_config_cli', 502, error.message, applied, Boolean(child.pid),
    )));
    child.once('close', (code) => {
      if (timedOut || code !== 0) {
        finish(new ProfileConfigError('profile_config_cli', 502,
          timedOut ? 'Истёк срок factory profile' : stderr || `factory profile: ${code}`,
          applied, true));


        return;
      }

      finish();
    });
  });
}

/**
 * Декодирует целый batch, затем под process-lock последовательно вызывает engine.
 * Каждый runner set содержит полный failover: omission сохраняет snapshot своей пары,
 * а явная пустая строка очищает. Частичный отказ не изображается атомарным откатом.
 */
export async function applyRunnerOperations(config: ProfileConfigRuntime, profile: string,
  input: unknown): Promise<Record<string, string>> {
  const operations = runnerOperations(input);
  const profileFile = await profileTarget(config.profilesDir, profile, 'profile.sh');
  const runnersFile = path.join(path.dirname(profileFile), 'runners.env');

  await readSource(profileFile).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ProfileConfigError('profile_not_found', 404);
    }

    throw error;
  });

  return withPathLock(runnersFile, async () => {
    let applied = 0;

    for (const operation of operations) {
      const args = ['profile', profile];

      if (operation.kind === 'runner') {
        const current = loadRunnerConfig(config.profilesDir, profile);
        const key = operation.role ? `STAGE_${operation.role}_FAILOVER` : 'PROJECT_RUNNER_FAILOVER';
        const failover = operation.failover ?? current[key] ?? '';

        args.push('runner', 'set', ...(operation.role ? [operation.role] : []),
          operation.primary, '--failover', failover);
      } else {
        const fields = MODEL_FIELDS.filter((field) => Object.hasOwn(operation, field))
          .map((field) => `${field === 'familyFailover' ? 'family_failover' : field}=${operation[field]}`);

        args.push('model', 'set', operation.role, operation.provider, ...fields);
      }

      await runProfileCommand(config, args, applied);
      applied += 1;
    }

    return loadRunnerConfig(config.profilesDir, profile);
  });
}
