import { execFile } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Публичное происхождение upstream допустимо только там, где оно является частью release UX.
const PUBLIC_UPSTREAM = ['Evil', 'DevRu'].join('');
const PUBLIC_UPSTREAM_FILES = new Set([
  'README.md',
  // Публичный источник встроенных ярлыков драйверов, а не подключённый личный профиль.
  'docs/grigdesk/b24/driver-sources.md',
  'tests/server/grigdesk-release.test.js',
]);

// Эти значения выбраны как очевидно синтетические и используются общими Telegram fixtures.
// Новый id сначала добавляется сюда с объяснимым synthetic pattern, а не копируется из runtime.
const SYNTHETIC_TELEGRAM_CHAT_IDS = new Set([
  '-1001000000042',
  '-1001234567890',
  '-1009876543210',
  '-1009999999999',
]);
const SYNTHETIC_HOME_USERS = new Set(['kimi', 'private', 'test', 'u', 'user']);
const SYNTHETIC_PROFILE_DIRS = new Set(['demo', 'demo-profile', 'fixture', 'sample-profile',
  // Искусственные имена отрицательных fixtures, соседние значения всё ещё запрещены.
  'private.json', 'sentinel', 's27-sentinel']);
const TELEGRAM_CONTROL_PATHS = new Set(['addstickers', 'c', 'joinchat', 'share']);

/**
 * Отличает искусственные идентификаторы соседних fixtures от runtime UUID.
 * Список сохранён из исходного сторожа без ослабления правила в этапе TESTS.
 */
function isSyntheticUuid(value) {
  const lower = value.toLowerCase();

  if (/^00000000-0000-4000-8000-0000000000[0-9a-f]{2}$/.test(lower)) {
    return true;
  }

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-7000-8000-0000000000[0-9a-f]{2}$/.test(lower)) {
    return true;
  }

  if (/^([0-9a-f])\1{7}-\1{4}-[47]\1{3}-[89ab]\1{3}-\1{12}$/.test(lower)) {
    return true;
  }

  return new Set([
    '01234567-89ab-4def-8abc-0123456789ab',
    '12345678-1234-5678-9abc-123456789abc',
    '12345678-1234-4234-8234-123456789abc',
    '11111111-2222-4333-8444-555555555555',
  ]).has(lower);
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * Сканирует один публичный текст generic-правилами исходного сторожа.
 * Новые проверки обхода и образца вызывают именно эту функцию, без копии detector в тесте.
 */
export function scanText(file, source) {
  const hits = [];
  const lower = source.toLocaleLowerCase('ru-RU');

  const upstreamIndex = lower.indexOf(PUBLIC_UPSTREAM.toLowerCase());

  if (upstreamIndex !== -1 && !PUBLIC_UPSTREAM_FILES.has(file)) {
    hits.push(`${file}:${lineAt(source, upstreamIndex)}: upstream identity outside provenance allowlist`);
  }

  for (const match of source.matchAll(/-100\d{10}\b/g)) {
    if (!SYNTHETIC_TELEGRAM_CHAT_IDS.has(match[0])) {
      hits.push(`${file}:${lineAt(source, match.index)}: non-synthetic Telegram chat id`);
    }
  }

  for (const match of source.matchAll(/\/home\/([A-Za-z0-9._-]+)(?=\/|\b)/g)) {
    if (!SYNTHETIC_HOME_USERS.has(match[1])) {
      hits.push(`${file}:${lineAt(source, match.index)}: non-synthetic home path`);
    }
  }

  const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;

  for (const match of source.matchAll(uuidPattern)) {
    if (!isSyntheticUuid(match[0])) {
      hits.push(`${file}:${lineAt(source, match.index)}: UUID fixture is not visibly synthetic`);
    }
  }

  for (const match of source.matchAll(/(?:^|[^A-Za-z0-9_$<])profiles\/([A-Za-z][A-Za-z0-9._-]*)/gu)) {
    if (!SYNTHETIC_PROFILE_DIRS.has(match[1].toLowerCase())) {
      hits.push(`${file}:${lineAt(source, match.index)}: concrete profile directory in shared repository`);
    }
  }

  if (file.startsWith('server/seed/pipeline-sample/')) {
    const profileName = /профил[ья]\s+([a-z][a-z0-9._-]*)/giu;

    for (const match of source.matchAll(profileName)) {
      if (!SYNTHETIC_PROFILE_DIRS.has(match[1].toLowerCase())) {
        hits.push(`${file}:${lineAt(source, match.index)}: concrete sample profile name`);
      }
    }

    for (const match of source.matchAll(/https?:\/\/([a-z0-9.-]+)(?=[:/\s'"`]|$)/giu)) {
      const host = match[1];

      if (!/^(?:localhost|127\.0\.0\.1|example\.(?:com|org|net))$/.test(host)
          && !/\.(?:test|invalid)$/.test(host)) {
        hits.push(`${file}:${lineAt(source, match.index)}: concrete sample host`);
      }
    }
  }

  if (file.startsWith('tests/')) {
    for (const match of source.matchAll(/https?:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{2,})/g)) {
      const name = match[1].toLowerCase();

      if (!name.startsWith('example_') && !TELEGRAM_CONTROL_PATHS.has(name)) {
        hits.push(`${file}:${lineAt(source, match.index)}: Telegram URL fixture is not visibly synthetic`);
      }
    }
  }

  return hits;
}

/**
 * Сохраняет охват индекса и новых файлов, не следуя ссылкам.
 * Нулевой разделитель поддерживает имена файлов без разбиения по строкам.
 */
async function trackedTextFiles(root) {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    },
  );

  return stdout.split('\0').filter(Boolean);
}

/**
 * Обходит индекс и untracked-файлы заданного синтетического checkout.
 * Ссылки не читаются: внешний каталог и приватные данные не принадлежат checkout.
 */
export async function scanRepository(root, excluded = []) {
  const hits = [];

  for (const file of await trackedTextFiles(root)) {
    if (excluded.includes(file)) {
      continue;
    }

    const absolute = path.join(root, file);
    let source;

    try {
      const info = await lstat(absolute);

      if (!info.isFile() || info.size > 4 * 1024 * 1024) {
        continue;
      }

      source = await readFile(absolute, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        continue;
      }

      throw error;
    }

    if (!source.includes('\0')) {
      hits.push(...scanText(file, source));
    }
  }

  return hits;
}
