import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { errorCode } from '../../../../shared/lib/errors.ts';

import { SshFailure } from './failure.ts';

export interface SshConnection {
  id: string;
  projectId: string;
  label: string;
  role: string;
  host: string;
  port: number;
  user: string;
}

// Вход формы: id приходит только при правке, а порт — из числового поля, где пусто
// означает «порт по умолчанию», а не ноль.
export interface SshConnectionInput {
  projectId?: unknown;
  label?: unknown;
  role?: unknown;
  host?: unknown;
  port?: unknown;
  user?: unknown;
}

export interface SshStoreOptions {
  dir?: string;
  file?: string;
  projects?: () => { id: unknown }[] | Promise<{ id: unknown }[]>;
}

export interface SshStore {
  create: (input: SshConnectionInput) => Promise<SshConnection>;
  update: (id: string, input: SshConnectionInput) => Promise<SshConnection>;
  remove: (id: string) => Promise<boolean>;
  delete: (id: string) => Promise<boolean>;
  list: () => SshConnection[];
  get: (id: string) => SshConnection | null;
}

/**
 * Файл на диске писал сам кокпит, поэтому его содержимое принимается как есть: и
 * голый список, и объект со списком читаются одинаково. Нормализовать записи заново
 * здесь нельзя — правка формы должна быть видна, а не тихо переписана при чтении.
 */
function storedConnections(parsed: unknown): SshConnection[] {
  const source = Array.isArray(parsed)
    ? parsed
    : (parsed as { connections?: unknown }).connections;

  return Array.isArray(source) ? source as SshConnection[] : [];
}

function cleanConnection(input: SshConnectionInput, id: string = randomUUID()): SshConnection {
  return {
    id,
    projectId: String(input.projectId || '').trim(),
    label: String(input.label || '').trim(),
    role: String(input.role || '').trim(),
    host: String(input.host || '').trim(),
    port: Math.max(1, Math.min(65_535, Number(input.port) || 22)),
    user: String(input.user || '').trim(),
  };
}

/** Атомарная запись не оставляет частично обновлённый список профилей после сбоя. */
async function writePrivate(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(file), 0o700);
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, file);
}

/**
 * Приватное хранилище содержит только описание соединения. Пароль намеренно
 * отбрасывается на границе нормализации и никогда не попадает в DTO или файл.
 */
export async function createSshStore(
  { dir = '', file = '', projects = () => [] }: SshStoreOptions = {},
): Promise<SshStore> {
  const target = file || path.join(dir, 'connections.json');
  let connections: SshConnection[] = [];
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(target, 'utf8'));
    connections = storedConnections(parsed);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }

  async function validate(candidate: SshConnection, exceptId = ''): Promise<void> {
    const knownProjects = await Promise.resolve(projects() || []);
    if (!knownProjects.some((project) => String(project.id) === candidate.projectId)) {
      throw new SshFailure('project_not_found', 'Проект SSH-соединения не существует');
    }
    if (!candidate.label || !candidate.role || !candidate.host || !candidate.user) {
      throw new SshFailure('invalid_connection', 'Метка, роль, адрес и пользователь обязательны');
    }
    const duplicate = connections.some((connection) => (
      connection.id !== exceptId
      && connection.projectId === candidate.projectId
      && connection.label === candidate.label
      && connection.role === candidate.role
    ));
    if (duplicate) {
      throw new SshFailure('duplicate_selector', 'Такая метка и роль уже есть в проекте');
    }
  }

  async function create(input: SshConnectionInput): Promise<SshConnection> {
    const candidate = cleanConnection(input);
    await validate(candidate);
    connections.push(candidate);
    await writePrivate(target, connections);
    return structuredClone(candidate);
  }

  async function update(idValue: string, input: SshConnectionInput): Promise<SshConnection> {
    const id = String(idValue || '');
    const index = connections.findIndex((connection) => connection.id === id);
    if (index < 0) {
      throw new SshFailure('not_found', 'SSH-соединение не найдено');
    }
    const candidate = cleanConnection({ ...connections[index], ...input }, id);
    await validate(candidate, id);
    connections[index] = candidate;
    await writePrivate(target, connections);
    return structuredClone(candidate);
  }

  async function remove(idValue: string): Promise<boolean> {
    const id = String(idValue || '');
    const before = connections.length;
    connections = connections.filter((connection) => connection.id !== id);
    if (connections.length === before) {
      return false;
    }
    await writePrivate(target, connections);
    return true;
  }

  return {
    create,
    update,
    remove,
    delete: remove,
    list: () => structuredClone(connections),
    get: (id: string) => structuredClone(
      connections.find((item) => item.id === String(id)) || null,
    ),
  };
}

export default createSshStore;
