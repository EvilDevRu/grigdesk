import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

function cleanConnection(input, id = randomUUID()) {
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
async function writePrivate(file, value) {
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
export async function createSshStore({ dir, file, projects = () => [] } = {}) {
  const target = file || path.join(dir, 'connections.json');
  let connections = [];
  try {
    const parsed = JSON.parse(await fs.readFile(target, 'utf8'));
    connections = Array.isArray(parsed) ? parsed : parsed.connections || [];
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  async function validate(candidate, exceptId = '') {
    const knownProjects = await Promise.resolve(projects() || []);
    if (!knownProjects.some((project) => String(project.id) === candidate.projectId)) {
      const error = new Error('Проект SSH-соединения не существует');
      error.code = 'project_not_found';
      throw error;
    }
    if (!candidate.label || !candidate.role || !candidate.host || !candidate.user) {
      const error = new Error('Метка, роль, адрес и пользователь обязательны');
      error.code = 'invalid_connection';
      throw error;
    }
    const duplicate = connections.some((connection) => (
      connection.id !== exceptId
      && connection.projectId === candidate.projectId
      && connection.label === candidate.label
      && connection.role === candidate.role
    ));
    if (duplicate) {
      const error = new Error('Такая метка и роль уже есть в проекте');
      error.code = 'duplicate_selector';
      throw error;
    }
  }

  async function create(input) {
    const candidate = cleanConnection(input);
    await validate(candidate);
    connections.push(candidate);
    await writePrivate(target, connections);
    return structuredClone(candidate);
  }

  async function update(idValue, input) {
    const id = String(idValue || '');
    const index = connections.findIndex((connection) => connection.id === id);
    if (index < 0) {
      const error = new Error('SSH-соединение не найдено');
      error.code = 'not_found';
      throw error;
    }
    const candidate = cleanConnection({ ...connections[index], ...input }, id);
    await validate(candidate, id);
    connections[index] = candidate;
    await writePrivate(target, connections);
    return structuredClone(candidate);
  }

  async function remove(idValue) {
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
    get: (id) => structuredClone(connections.find((item) => item.id === String(id)) || null),
  };
}

export default createSshStore;
