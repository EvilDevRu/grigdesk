// Доверенные каталоги для локальных ИИ-исполнителей.
// В prefs храним только абсолютные пути; перед сохранением из UI дополнительно
// проверяем, что каждый путь существует, является каталогом и не раскрывает весь `/`.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_DIRECTORIES = 32;

export class TrustedDirectoryInputError extends Error {}

/**
 * Мягкая нормализация данных с диска: испорченный prefs.json не должен ломать
 * запуск Cockpit. Существование каталогов здесь не проверяем — подключённый диск
 * может временно отсутствовать; CLI сам вернёт понятную ошибку только при запуске.
 */
export function normalizeStoredTrustedDirectories(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) continue;
    const normalized = path.resolve(trimmed);
    if (normalized === path.parse(normalized).root || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= MAX_DIRECTORIES) break;
  }
  return result;
}

/**
 * Строгая проверка значения из API. realpath схлопывает `..` и симлинки, поэтому
 * один физический каталог не попадёт в список дважды и симлинком нельзя замаскировать `/`.
 */
export async function validateTrustedDirectories(value) {
  if (!Array.isArray(value)) {
    throw new TrustedDirectoryInputError('Каталоги должны быть переданы списком.');
  }
  if (value.length > MAX_DIRECTORIES) {
    throw new TrustedDirectoryInputError(`Можно указать не больше ${MAX_DIRECTORIES} каталогов.`);
  }

  const seen = new Set();
  const result = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new TrustedDirectoryInputError('Путь к каталогу не может быть пустым.');
    }
    const requested = raw.trim();
    if (!path.isAbsolute(requested)) {
      throw new TrustedDirectoryInputError(`Нужен абсолютный путь: ${requested}`);
    }

    let resolved;
    let stat;
    try {
      resolved = await fs.realpath(requested);
      stat = await fs.stat(resolved);
    } catch {
      throw new TrustedDirectoryInputError(`Каталог не найден или недоступен: ${requested}`);
    }
    if (!stat.isDirectory()) {
      throw new TrustedDirectoryInputError(`Это не каталог: ${requested}`);
    }
    if (resolved === path.parse(resolved).root) {
      throw new TrustedDirectoryInputError('Нельзя доверять корню файловой системы целиком.');
    }
    if (!seen.has(resolved)) {
      seen.add(resolved);
      result.push(resolved);
    }
  }
  return result;
}
