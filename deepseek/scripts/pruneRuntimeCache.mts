import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface GenerationGroup {
  buildId: string;
  dirs: string[];
  newestMs: number;
}

interface PruneOptions {
  cacheDir: string;
  keepBuilds: number;
  keepReleases: number;
}

/**
 * Разбирает аргументы без внешних вызовов: каталог кэша обязателен,
 * лимиты — положительные целые. Неизвестный флаг завершает чистку до эффектов.
 */
function parseArguments(argv: string[]): PruneOptions {
  const values = new Map<string, string>();
  const allowed = ['--cache-dir', '--keep-builds', '--keep-releases'];

  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];

    if (!name || !allowed.includes(name) || !value || values.has(name)) {
      throw new Error('Использование: pruneRuntimeCache.mts --cache-dir <каталог>'
        + ' [--keep-builds N] [--keep-releases N]');
    }

    values.set(name, value);
  }

  const cacheDir = values.get('--cache-dir')!;

  if (!path.isAbsolute(cacheDir)) {
    throw new Error('Каталог кэша должен быть абсолютным путём');
  }

  const keepBuilds = Number(values.get('--keep-builds') ?? 2);
  const keepReleases = Number(values.get('--keep-releases') ?? 2);

  if (!Number.isInteger(keepBuilds) || keepBuilds < 1
    || !Number.isInteger(keepReleases) || keepReleases < 1) {
    throw new Error('Лимиты чистки должны быть целыми числами не меньше одного');
  }

  return {
    cacheDir,
    keepBuilds,
    keepReleases,
  };
}

/**
 * Группы строятся по buildId: у одной поставки бывает несколько packageId.
 * Нечитаемое поколение не удаляется и не мешает остальным.
 */
async function collectGenerationGroups(packagesDir: string): Promise<GenerationGroup[]> {
  const groups = new Map<string, GenerationGroup>();

  for (const entry of await fs.readdir(packagesDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) {
      continue;
    }

    const dir = path.join(packagesDir, entry.name);

    try {
      const runtimeFile = path.join(dir, 'generation/runtime.json');
      const runtime = JSON.parse(await fs.readFile(runtimeFile, 'utf8')) as { buildId?: unknown };
      const buildId = typeof runtime.buildId === 'string' ? runtime.buildId : '';

      if (!buildId) {
        continue;
      }

      const { mtimeMs } = await fs.stat(runtimeFile);
      const group = groups.get(buildId) ?? {
        buildId,
        dirs: [],
        newestMs: 0,
      };

      group.dirs.push(dir);
      group.newestMs = Math.max(group.newestMs, mtimeMs);
      groups.set(buildId, group);
    } catch {
      // Битое или чужое поколение остаётся на месте: чистка только доказанно старых групп.
    }
  }

  return [...groups.values()].sort((left, right) => right.newestMs - left.newestMs);
}

/**
 * Резервы обрезаются по времени записи: свежие остаются для отката,
 * более старые удаляются целиком вместе с каталогом своего SHA.
 */
async function pruneReleases(releasesDir: string, keep: number): Promise<string[]> {
  const entries = await fs.readdir(releasesDir, { withFileTypes: true }).catch(() => []);
  const dirs: Array<{ dir: string; mtimeMs: number }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const dir = path.join(releasesDir, entry.name);

    try {
      const { mtimeMs } = await fs.stat(dir);

      dirs.push({ dir, mtimeMs });
    } catch {
      // Исчезнувший между listing и stat резерв не требует действий.
    }
  }

  dirs.sort((left, right) => right.mtimeMs - left.mtimeMs);

  const victims = dirs.slice(keep).map((item) => item.dir);

  for (const dir of victims) {
    await fs.rm(dir, { recursive: true, force: true });
  }

  return victims;
}

/**
 * Чистка кэша установленной поставки: остаются только свежие поколения поставок
 * и свежие резервные ELF. Живой ход читает файлы своего поколения, поэтому
 * лимит по умолчанию — две группы: новая поставка и предыдущая.
 */
async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const groups = await collectGenerationGroups(path.join(options.cacheDir, 'packages'));
  const victimGroups = groups.slice(options.keepBuilds);
  const removedDirs: string[] = [];

  for (const group of victimGroups) {
    for (const dir of group.dirs) {
      await fs.rm(dir, { recursive: true, force: true });
      removedDirs.push(dir);
    }
  }

  const removedReleases = await pruneReleases(
    path.join(options.cacheDir, 'releases'), options.keepReleases,
  );

  process.stdout.write(`${JSON.stringify({
    keptBuilds: groups.slice(0, options.keepBuilds).map((group) => group.buildId),
    removedDirs,
    removedReleases,
  })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
