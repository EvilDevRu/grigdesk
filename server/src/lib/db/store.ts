import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { errorCode } from '../../../../shared/lib/errors.ts';

// Профиль подключения: только описание. Пароля здесь нет и не появится — он
// спрашивается при входе, живёт в памяти процесса и стирается сразу.
export interface DbProfile {
  id: string;
  projectId: string;
  label: string;
  role: 'read' | 'write';
  engine: string;
  host: string;
  port: number;
  user: string;
  database: string;
  prod: boolean;
  via: 'direct' | 'ssh';
}

export interface DbProfileInput {
  projectId?: unknown;
  label?: unknown;
  role?: unknown;
  engine?: unknown;
  host?: unknown;
  port?: unknown;
  user?: unknown;
  database?: unknown;
  prod?: unknown;
  via?: unknown;
}

export interface DbStoreOptions {
  path?: string;
  file?: string;
  withReferences?: <T>(op: () => Promise<T>) => Promise<T>;
  isProjectDeleted?: (id: string) => boolean;
  projects?: () => { id?: unknown }[] | Promise<{ id?: unknown }[]>;
}

// Отказ хранилища с машинным кодом: HTTP-слой переводит его в статус ответа.
class DbStoreError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DbStoreError';
    this.code = code;
  }
}

function clean(input: DbProfileInput, id: string = randomUUID()): DbProfile {
  return {
    id,
    projectId: String(input.projectId || '').trim(),
    label: String(input.label || '').trim(),
    role: input.role === 'write' ? 'write' : 'read',
    engine: String(input.engine || '').trim(),
    host: String(input.host || '').trim(),
    port: Math.max(1, Math.min(65_535, Number(input.port) || 1)),
    user: String(input.user || '').trim(),
    database: String(input.database || '').trim(),
    prod: input.prod === true,
    via: input.via === 'ssh' ? 'ssh' : 'direct',
  };
}

async function writePrivate(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

/**
 * Профиль хранит только описание; неизвестные поля и пароль отбрасываются здесь.
 * Проверка ссылки и запись согласуются с удалением регистрации через её очередь.
 */
export async function createDbStore(
  {
    path: file, file: alternate, projects, withReferences = (op) => op(),
    isProjectDeleted = () => false,
  }: DbStoreOptions = {},
) {
  const target = String(file || alternate || '');
  let profiles: DbProfile[] = [];

  try {
    const value: unknown = JSON.parse(await fs.readFile(target, 'utf8'));

    profiles = Array.isArray(value)
      ? (value as DbProfileInput[]).map((item) => clean(item, String((item as {
        id?: unknown;
      }).id || '')))
      : [];
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }

  /**
   * Проверка регистрации выполняется до изменения профилей и внутри общей очереди.
   * Ошибка чтения настроек запрещает как новую связь, так и изменение существующей.
   */
  async function validate(profile: DbProfile, exceptId = ''): Promise<void> {
    if (isProjectDeleted(profile.projectId)) {
      throw new DbStoreError('project_not_found', 'Регистрация проекта профиля БД удалена');
    }

    if (!profile.projectId || !profile.label || !profile.engine || !profile.host || !profile.user) {
      throw new DbStoreError(
        'invalid_profile',
        'Проект, метка, движок, адрес и пользователь обязательны',
      );
    }
    if (typeof projects === 'function') {
      const known = await Promise.resolve(projects());
      if (!known.some((project) => String(project.id ?? project) === profile.projectId)) {
        throw new DbStoreError('project_not_found', 'Проект профиля БД не существует');
      }
    }
    if (profiles.some((item) => item.id !== exceptId
      && item.projectId === profile.projectId
      && item.label === profile.label
      && item.role === profile.role)) {
      throw new DbStoreError('duplicate_selector', 'Такая метка и роль уже есть в проекте');
    }
  }

  async function create(input: DbProfileInput): Promise<DbProfile> {
    return withReferences(async () => {
      const profile = clean(input);
      await validate(profile);
      profiles.push(profile);
      await writePrivate(target, profiles);
      return structuredClone(profile);
    });
  }

  async function update(idValue: string, input: DbProfileInput): Promise<DbProfile | null> {
    return withReferences(async () => {
      const id = String(idValue || '');
      const index = profiles.findIndex((profile) => profile.id === id);
      if (index < 0) return null;
      const profile = clean({ ...profiles[index], ...input }, id);
      await validate(profile, id);
      profiles[index] = profile;
      await writePrivate(target, profiles);
      return structuredClone(profile);
    });
  }

  async function remove(idValue: string): Promise<boolean> {
    const id = String(idValue || '');
    const next = profiles.filter((profile) => profile.id !== id);
    if (next.length === profiles.length) return false;
    profiles = next;
    await writePrivate(target, profiles);
    return true;
  }

  return {
    create,
    update,
    remove,
    delete: remove,
    get: (id: string) => structuredClone(
      profiles.find((profile) => profile.id === String(id)) || null,
    ),
    list: () => structuredClone(profiles),
  };
}

export const createProfileStore = createDbStore;
export default createDbStore;
