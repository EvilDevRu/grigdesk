// Действия профиля над поднятым стендом: манифест `profiles/<профиль>/actions.json`.
//
// ГРАНИЦА. Что можно запустить на стенде и как это называется, знает профиль — так же,
// как он объявляет up.sh и down.sh. Кокпит читает манифест, проверяет его форму и путь
// скрипта, а дальше только запускает `bash <скрипт> <номер стенда> <аргументы>` и
// показывает вывод. Ни команд контейнера, ни имён проектов в кокпите нет.
//
// Манифест — массив объявлений:
//   { id, label, description, script, args: [{ key, label, type, required, hint }], confirm }
// `script` — путь относительно каталога профиля, и выйти из него он не может.
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { isRecord } from '../../../../shared/lib/objects.ts';

import { PROFILE_RE } from '../profiles.ts';
import {
  parseSandboxActionDecl,
  SANDBOX_ACTION_ID_RE,
  SandboxContractError,
} from '../../../../shared/plugins/sandboxes/sandboxContracts.ts';
import type {
  SandboxActionArg,
  SandboxActionDecl,
} from '../../../../shared/plugins/sandboxes/sandboxContracts.ts';

export interface SandboxProfileAction extends SandboxActionDecl {
  // Абсолютный путь скрипта — остаётся на сервере, наружу уходит только объявление.
  script: string;
}

// Значение аргумента после проверки: строка, безопасная для argv скрипта.
export type SandboxActionArgs = Record<string, string>;

export class SandboxActionsManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxActionsManifestError';
  }
}

const TEXT_ARG_LIMIT = 200;
const NUMBER_ARG_RE = /^(?:0|[1-9][0-9]{0,17})$/;

/**
 * Путь скрипта разрешается внутри каталога профиля. Абсолютный путь и `..` наружу
 * отвергаются: манифест лежит рядом с кодом, но право запускать что угодно на машине
 * он от этого не получает.
 */
function resolveScript(profileDir: string, script: unknown, id: string): string {
  if (typeof script !== 'string' || !script || path.isAbsolute(script)) {
    throw new SandboxActionsManifestError(`действие ${id}: script должен быть относительным путём`);
  }

  const resolved = path.resolve(profileDir, script);
  const inside = resolved.startsWith(`${path.resolve(profileDir)}${path.sep}`);

  if (!inside) {
    throw new SandboxActionsManifestError(`действие ${id}: script выходит за каталог профиля`);
  }

  return resolved;
}

/** Одно объявление манифеста: форма контракта плюс серверные ограничения id и скрипта. */
function readDecl(profileDir: string, raw: unknown, index: number): SandboxProfileAction {
  if (!isRecord(raw)) {
    throw new SandboxActionsManifestError(`запись ${index} манифеста не объект`);
  }

  const { script, ...declaration } = raw;
  let decl: SandboxActionDecl;

  try {
    decl = parseSandboxActionDecl({ confirm: null, args: [], ...declaration }, `actions[${index}]`);
  } catch (error) {
    const reason = error instanceof SandboxContractError ? error.message : 'неверная форма';

    throw new SandboxActionsManifestError(`запись ${index} манифеста: ${reason}`);
  }

  if (!SANDBOX_ACTION_ID_RE.test(decl.id)) {
    throw new SandboxActionsManifestError(`запись ${index} манифеста: недопустимый id «${decl.id}»`);
  }

  for (const arg of decl.args) {
    if (!SANDBOX_ACTION_ID_RE.test(arg.key)) {
      throw new SandboxActionsManifestError(`действие ${decl.id}: недопустимый ключ аргумента «${arg.key}»`);
    }
  }

  const keys = new Set(decl.args.map((arg) => arg.key));

  if (keys.size !== decl.args.length) {
    throw new SandboxActionsManifestError(`действие ${decl.id}: ключи аргументов повторяются`);
  }

  return { ...decl, script: resolveScript(profileDir, script, decl.id) };
}

/**
 * Действия профиля. Профиль без манифеста действий не объявил — это обычное дело,
 * а не ошибка. Кривой манифест — ошибка: она видна в журнале сервера, а стенду
 * достаётся пустой список, чтобы одна опечатка не закрывала раздел целиком.
 */
export async function readProfileActions(
  profilesDir: string,
  profile: string,
): Promise<SandboxProfileAction[]> {
  if (!PROFILE_RE.test(profile)) {
    return [];
  }

  const profileDir = path.join(profilesDir, profile);
  let text = '';

  try {
    text = await fs.readFile(path.join(profileDir, 'actions.json'), 'utf8');
  } catch {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SandboxActionsManifestError('actions.json не разбирается как JSON');
  }

  if (!Array.isArray(parsed)) {
    throw new SandboxActionsManifestError('actions.json должен быть массивом действий');
  }

  const actions = parsed.map((raw, index) => readDecl(profileDir, raw, index));
  const ids = new Set(actions.map((action) => action.id));

  if (ids.size !== actions.length) {
    throw new SandboxActionsManifestError('id действий повторяются');
  }

  return actions;
}

/** Объявление без серверных полей — то, что видит карточка стенда. */
export function toActionDecl(action: SandboxProfileAction): SandboxActionDecl {
  const { script, ...decl } = action;

  return decl;
}

/**
 * Аргументы запуска по объявлению: обязательные присутствуют, число — целое без
 * знака, текст — одна строка ограниченной длины без управляющих символов. Лишние
 * ключи тела отбрасываются: в argv скрипта уходит только объявленное и в порядке
 * объявления.
 */
export function validateActionArgs(
  args: SandboxActionArg[],
  provided: unknown,
): { values: SandboxActionArgs; argv: string[]; error: string | null } {
  const source = isRecord(provided) ? provided : {};
  const values: SandboxActionArgs = {};
  const argv: string[] = [];

  for (const arg of args) {
    const raw = source[arg.key];
    const value = raw === undefined || raw === null ? '' : String(raw).trim();

    if (!value) {
      if (arg.required) {
        return { values, argv, error: `не задан аргумент «${arg.label}»` };
      }

      argv.push('');

      continue;
    }

    if (arg.type === 'number' && !NUMBER_ARG_RE.test(value)) {
      return { values, argv, error: `«${arg.label}» должен быть целым числом` };
    }

    if (arg.type === 'text' && (value.length > TEXT_ARG_LIMIT || /[\p{Cc}]/u.test(value))) {
      return { values, argv, error: `«${arg.label}»: одна строка до ${TEXT_ARG_LIMIT} символов` };
    }

    values[arg.key] = value;
    argv.push(value);
  }

  return { values, argv, error: null };
}
