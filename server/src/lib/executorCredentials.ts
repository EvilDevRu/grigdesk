// Ключи доступа исполнителей — склейка ДЕКЛАРАЦИИ адаптера и корневого `.env`.
// Какие переменные нужны, объявляет сам executor (поле `credentials`, контракт в
// lib/executors/index.ts); ядро вендоров не знает и служит почтальоном: принимает только
// объявленные имена, пишет их общим писателем `envFile.ts` и сразу переносит в окружение
// процесса, поэтому ключ начинает действовать без перезапуска службы.
// Значение секрета наружу не выходит никогда: карточка видит только «задан» и хвост ключа.
import type { ExecutorAdapter } from './executors/index.ts';
import {
  ENV_FILE_STATE_ERROR_CODES, EnvFileError, applyEnvChanges, isEnvName, readEnvFile, updateEnvFile,
} from './envFile.ts';

export type CredentialKind = 'secret' | 'choice';

// Вариант выбора для `kind: 'choice'`: значение пишется в .env, подпись и подсказку видит человек.
export interface CredentialOption {
  value: string;
  label: string;
  hint?: string;
}

// Условие показа: запись нужна, только пока выбор `env` равен `value` (ключ своего режима).
export interface CredentialCondition {
  env: string;
  value: string;
}

// Одна объявленная адаптером переменная окружения.
export interface CredentialDeclaration {
  env: string;
  kind: CredentialKind;
  label: string;
  hint?: string;
  options?: CredentialOption[];
  when?: CredentialCondition;
}

// Безопасная проекция для браузера: у секрета нет значения, только признак и хвост.
export interface CredentialView extends CredentialDeclaration {
  set: boolean;
  inFile: boolean | null;
  preview: string | null;
  value: string | null;
}

export type CredentialApplyResult =
  | { ok: true; changed: string[] }
  | CredentialRejection;

// Отказ с HTTP-статусом: 400 — ввод, 409 — состояние файла, которое правит человек.
export interface CredentialRejection {
  ok: false;
  status: number;
  error: string;
  message: string;
}

const OPTION_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const KINDS = new Set<CredentialKind>(['secret', 'choice']);
// Хвост показывается только у длинного ключа: у короткого четыре символа — заметная часть.
const PREVIEW_MIN_LENGTH = 16;

function boundedText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

/**
 * Приводит одну декларацию к контракту или отбрасывает её. Сломанная декларация
 * не должна открыть запись произвольной переменной окружения через общий маршрут.
 */
function normalizeDeclaration(raw: unknown): CredentialDeclaration | null {
  const item = raw as Partial<Record<keyof CredentialDeclaration, unknown>> | null;
  const env = typeof item?.env === 'string' ? item.env : '';
  const kind = item?.kind as CredentialKind;
  const label = boundedText(item?.label, 120);

  if (!isEnvName(env) || !KINDS.has(kind) || !label) {
    return null;
  }

  const hint = boundedText(item?.hint, 300);
  const when = item?.when as Partial<CredentialCondition> | undefined;
  const declaration: CredentialDeclaration = {
    env,
    kind,
    label,
    ...(hint ? { hint } : {}),
    ...(typeof when?.env === 'string' && typeof when.value === 'string'
      ? { when: { env: when.env, value: when.value } }
      : {}),
  };

  if (kind === 'secret') {
    return declaration;
  }

  const options = (Array.isArray(item?.options) ? item.options : [])
    .map((option: Partial<CredentialOption> | null) => {
      const optionHint = boundedText(option?.hint, 200);

      return {
        value: typeof option?.value === 'string' ? option.value : '',
        label: boundedText(option?.label, 120),
        ...(optionHint ? { hint: optionHint } : {}),
      };
    })
    .filter((option) => OPTION_RE.test(option.value) && option.label);

  return options.length ? { ...declaration, options } : null;
}

/**
 * Декларация ключей исполнителя: статичный массив либо async-функция (config) → массив.
 * Невалидные записи и повтор имени отбрасываются; падение функции даёт пустой список.
 */
export async function declaredCredentials(
  executor: ExecutorAdapter | null | undefined,
  config: unknown,
): Promise<CredentialDeclaration[]> {
  const declared = executor?.credentials;
  let list: unknown;

  try {
    list = typeof declared === 'function' ? await declared(config) : declared;
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const declarations = (Array.isArray(list) ? list : [])
    .map(normalizeDeclaration)
    .filter((item): item is CredentialDeclaration => {
      if (!item || seen.has(item.env)) {
        return false;
      }

      seen.add(item.env);

      return true;
    });

  return declarations.map((item) => withValidCondition(item, declarations));
}

/**
 * Условие показа держится, только если ссылается на объявленный выбор и его вариант.
 * Сломанное условие снимается, а не прячет поле: ключ без поля нельзя было бы задать.
 */
function withValidCondition(
  item: CredentialDeclaration,
  declarations: readonly CredentialDeclaration[],
): CredentialDeclaration {
  if (!item.when) {
    return item;
  }

  const target = declarations.find((other) => other.env === item.when?.env && other.kind === 'choice');

  if (target?.options?.some((option) => option.value === item.when?.value)) {
    return item;
  }

  const { when: _dropped, ...rest } = item;

  return rest;
}

/**
 * Имена переменных, заданных в env-файле, или null, если файл прочитать не удалось.
 * null честно означает «неизвестно»: карточка тогда не утверждает, откуда взят ключ.
 */
export async function envFileNames(envPath: string | undefined): Promise<Set<string> | null> {
  if (!envPath) {
    return null;
  }

  try {
    return new Set(Object.keys(await readEnvFile(envPath)));
  } catch {
    return null;
  }
}

/**
 * Состояние объявленных ключей для карточки. Источник истины — окружение процесса:
 * именно его видят исполнители. `inFile` говорит, можно ли удалить ключ из `.env`.
 */
export function credentialViews(
  declarations: readonly CredentialDeclaration[],
  env: NodeJS.ProcessEnv,
  fileNames: ReadonlySet<string> | null,
): CredentialView[] {
  return declarations.map((declaration) => {
    const current = env[declaration.env] || '';
    const secret = declaration.kind === 'secret';

    return {
      ...declaration,
      set: current.length > 0,
      inFile: fileNames ? fileNames.has(declaration.env) : null,
      preview: secret && current.length >= PREVIEW_MIN_LENGTH ? `…${current.slice(-4)}` : null,
      value: secret ? null : current || null,
    };
  });
}

function rejected(status: number, error: string, message: string): CredentialRejection {
  return {
    ok: false,
    status,
    error,
    message,
  };
}

/**
 * Сверяет ввод с декларацией: только объявленные имена, у выбора — только объявленные
 * варианты, у секрета — непустая строка. null означает удаление переменной из файла.
 */
function plannedChanges(
  declarations: readonly CredentialDeclaration[],
  input: unknown,
): { ok: true; changes: Record<string, string | null> } | CredentialRejection {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) {
    return rejected(400, 'credentials_invalid', 'Нужен объект values: имя переменной → значение или null.');
  }

  const byName = new Map(declarations.map((declaration) => [declaration.env, declaration]));
  const changes: Record<string, string | null> = {};

  for (const [name, raw] of Object.entries(input as Record<string, unknown>)) {
    const declaration = byName.get(name);

    if (!declaration) {
      return rejected(400, 'credential_unknown', `Исполнитель не объявлял переменную ${name}.`);
    }

    if (raw === null) {
      changes[name] = null;
      continue;
    }

    const value = typeof raw === 'string' ? raw.trim() : '';

    if (!value) {
      return rejected(400, 'credential_empty', `Пустое значение для «${declaration.label}».`);
    }

    if (declaration.kind === 'choice' && !declaration.options?.some((option) => option.value === value)) {
      return rejected(400, 'credential_option_unknown', `Недопустимый вариант для «${declaration.label}».`);
    }

    changes[name] = value;
  }

  return { ok: true, changes };
}

/**
 * Записывает объявленные ключи в env-файл и переносит их в окружение процесса.
 * Ошибка файла не меняет окружение. Удаление снимает переменную из памяти, только если
 * она была в файле: заданную вне `.env` правка файла убрать не может и не притворяется.
 */
export async function applyCredentialValues({
  declarations,
  input,
  envPath,
  env = process.env,
}: {
  declarations: readonly CredentialDeclaration[];
  input: unknown;
  envPath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CredentialApplyResult> {
  const planned = plannedChanges(declarations, input);

  if (!planned.ok) {
    return planned;
  }

  try {
    const { changed } = await updateEnvFile(envPath, planned.changes);
    const applied = Object.fromEntries(Object.entries(planned.changes)
      .filter(([name, value]) => value !== null || changed.includes(name)));

    applyEnvChanges(applied, env);

    return { ok: true, changed };
  } catch (error) {
    if (!(error instanceof EnvFileError)) {
      throw error;
    }

    return rejected(ENV_FILE_STATE_ERROR_CODES.has(error.code) ? 409 : 400, error.code, error.message);
  }
}
