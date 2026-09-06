import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

function clean(input, id = randomUUID()) {
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

async function writePrivate(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

/** Профиль хранит только описание; неизвестные поля и пароль отбрасываются здесь. */
export async function createDbStore({ path: file, file: alternate, projects } = {}) {
  const target = file || alternate;
  let profiles = [];
  try {
    const value = JSON.parse(await fs.readFile(target, 'utf8'));
    profiles = Array.isArray(value) ? value.map((item) => clean(item, item.id)) : [];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  async function validate(profile, exceptId = '') {
    if (!profile.projectId || !profile.label || !profile.engine || !profile.host || !profile.user) {
      const error = new Error('Проект, метка, движок, адрес и пользователь обязательны');
      error.code = 'invalid_profile';
      throw error;
    }
    if (typeof projects === 'function') {
      const known = await Promise.resolve(projects());
      if (!known.some((project) => String(project.id ?? project) === profile.projectId)) {
        const error = new Error('Проект профиля БД не существует');
        error.code = 'project_not_found';
        throw error;
      }
    }
    if (profiles.some((item) => item.id !== exceptId
      && item.projectId === profile.projectId
      && item.label === profile.label
      && item.role === profile.role)) {
      const error = new Error('Такая метка и роль уже есть в проекте');
      error.code = 'duplicate_selector';
      throw error;
    }
  }

  async function create(input) {
    const profile = clean(input);
    await validate(profile);
    profiles.push(profile);
    await writePrivate(target, profiles);
    return structuredClone(profile);
  }

  async function update(idValue, input) {
    const id = String(idValue || '');
    const index = profiles.findIndex((profile) => profile.id === id);
    if (index < 0) return null;
    const profile = clean({ ...profiles[index], ...input }, id);
    await validate(profile, id);
    profiles[index] = profile;
    await writePrivate(target, profiles);
    return structuredClone(profile);
  }

  async function remove(idValue) {
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
    get: (id) => structuredClone(profiles.find((profile) => profile.id === String(id)) || null),
    list: () => structuredClone(profiles),
  };
}

export const createProfileStore = createDbStore;
export default createDbStore;
