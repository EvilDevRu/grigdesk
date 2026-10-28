import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

import { isRecord } from '../../../../shared/lib/objects.ts';
import type {
  ExternalCliInstallation,
  ExternalCliInventory,
  ExternalCliInventoryInput,
} from './inventoryTypes.ts';

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inside = (file: string, root: string): boolean => file === root || file.startsWith(root + path.sep);

/**
 * Ограниченное чтение manifest не следует ссылке и не исполняет содержимое пакета.
 * Неверные или слишком большие метаданные оставляют кандидата неизвестным.
 */
async function manifestOf(root: string): Promise<Record<string, unknown> | null> {
  const file = await fs.open(path.join(root, 'package.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch(() => null);

  if (!file) {
    return null;
  }

  try {
    if (!(await file.stat()).isFile()) {
      return null;
    }

    const buffer = Buffer.alloc(128 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);

    if (bytesRead === buffer.length) {
      return null;
    }

    const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));

    return isRecord(value) ? value : null;
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

/**
 * Npm-происхождение требует имени, declared bin и физического global package root.
 * Файл с подходящим именем или ссылка за пределы package tree доказательством не является.
 */
async function npmAt(root: string, physical: string | null, input: ExternalCliInventoryInput) {
  const suffix = path.join('lib', 'node_modules', input.definition.packageId);

  if (!root.endsWith(path.sep + suffix) || await fs.realpath(root).catch(() => null) !== root) {
    return null;
  }

  const manifest = await manifestOf(root);

  if (!manifest || manifest.name !== input.definition.packageId) {
    return null;
  }

  const bin = typeof manifest.bin === 'string' ? manifest.bin
    : isRecord(manifest.bin) ? manifest.bin[input.definition.binName] : null;

  if (typeof bin !== 'string' || path.isAbsolute(bin)) {
    return null;
  }

  const declared = path.resolve(root, bin);
  const resolved = await fs.realpath(declared).catch(() => null);

  if (!inside(declared, root) || resolved && (!inside(resolved, root) || physical && physical !== resolved)) {
    return null;
  }
  if (physical && !resolved) {
    return null;
  }

  const version = typeof manifest.version === 'string'
    && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/u.test(manifest.version) ? manifest.version : null;

  return {
    root,
    prefix: root.slice(0, -(suffix.length + 1)) || path.sep,
    version,
    manifest,
  };
}

/**
 * Поиск npm идёт только вверх от кандидата и по ожидаемому root рядом с его bin.
 * Второй путь распознаёт повреждённый пакет, чей исполняемый entry уже отсутствует.
 */
async function npmOf(candidate: string, physical: string | null, input: ExternalCliInventoryInput) {
  let current = physical ? path.dirname(physical) : path.dirname(candidate);

  for (let depth = 0; depth < 12; depth += 1) {
    const found = await npmAt(current, physical, input);

    if (found) {
      return found;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      break;
    }

    current = parent;
  }

  if (path.basename(path.dirname(candidate)) !== 'bin') {
    return null;
  }

  const root = path.join(path.dirname(path.dirname(candidate)), 'lib/node_modules',
    input.definition.packageId);

  return npmAt(root, physical, input);
}

/**
 * Native-кандидат допускается только в объявленном адаптером root и с ELF-заголовком.
 * Версия пока не запускается: inventory не исполняет найденные произвольные wrappers.
 */
async function nativeRoot(physical: string | null, input: ExternalCliInventoryInput): Promise<string | null> {
  if (!physical) {
    return null;
  }

  for (const declared of input.definition.native || []) {
    const root = await fs.realpath(declared.root).catch(() => null);
    const entry = await fs.realpath(declared.entry).catch(() => null);

    if (!root || entry !== physical || !inside(physical, root)) {
      continue;
    }

    const file = await fs.open(physical, 'r').catch(() => null);

    if (!file) {
      continue;
    }

    try {
      const bytes = Buffer.alloc(4);

      await file.read(bytes, 0, 4, 0);

      if (bytes.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
        return root;
      }
    } finally {
      await file.close();
    }
  }

  return null;
}

/**
 * Снимок identity отделён от стабильного ресурса: замена inode меняет только CAS id.
 * Отсутствующие кандидаты PATH пропускаются, явно настроенный missing bin остаётся видимым.
 */
async function inspect(candidate: string, input: ExternalCliInventoryInput):
  Promise<ExternalCliInstallation | null> {
  const held = await fs.lstat(candidate).catch(() => null);
  const physical = await fs.realpath(candidate).catch(() => null);
  const stat = physical ? await fs.stat(physical).catch(() => null) : null;
  const executable = stat?.isFile() === true
    && await fs.access(candidate, constants.X_OK).then(() => true, () => false);
  const npm = await npmOf(candidate, physical, input);
  const native = npm ? null : await nativeRoot(stat?.isFile() ? physical : null, input);

  if (!held && !npm && candidate !== input.configuredBin) {
    return null;
  }

  const source = npm ? 'npm' : native ? 'native' : 'unknown';
  const root = npm?.root || native;
  const resourceKey = digest([input.providerId, source, root || physical || candidate,
    input.definition.packageId]);
  const identity = stat ? [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs] : null;
  const origin = root && input.legacyRoots?.some((legacy) => inside(root, path.resolve(legacy)))
    ? 'grigdesk' : 'user';

  return {
    installationId: digest([resourceKey, identity, npm?.manifest || null]),
    resourceKey,
    source,
    state: npm ? executable ? 'ready' : 'broken' : held ? 'unverified' : 'missing',
    path: candidate,
    realpath: physical,
    root: root || null,
    prefix: npm?.prefix || null,
    version: npm?.version || null,
    aliases: [candidate],
    origin,
  };
}

/**
 * Кандидаты ограничены PATH, явной настройкой, штатными native entries и одним уровнем nvm.
 * Пользовательские проекты, история и произвольные подкаталоги HOME не сканируются.
 */
async function candidatesOf(input: ExternalCliInventoryInput): Promise<string[]> {
  const candidates = (input.env.PATH || '').split(path.delimiter).filter(path.isAbsolute)
    .map((directory) => path.join(directory, input.definition.binName));

  if (path.isAbsolute(input.configuredBin)) {
    candidates.push(input.configuredBin);
  }

  candidates.push(...(input.definition.native || []).map((item) => item.entry));

  const nvm = input.env.NVM_DIR && path.isAbsolute(input.env.NVM_DIR)
    ? input.env.NVM_DIR : path.join(input.home, '.nvm');
  const versions = path.join(nvm, 'versions/node');
  const dirs = await fs.readdir(versions, { withFileTypes: true }).catch(() => []);

  for (const dir of dirs) {
    if (dir.isDirectory() && /^v\d+\.\d+\.\d+$/u.test(dir.name)) {
      candidates.push(path.join(versions, dir.name, 'bin', input.definition.binName));
    }
  }

  return [...new Set(candidates.filter(path.isAbsolute).map((item) => path.resolve(item)))];
}

/**
 * Снимок установок собирается только чтением файлов и не меняет выбранную программу.
 * Отдельные aliases одной физической установки не создают независимых целей удаления.
 */
export async function discoverExternalCli(input: ExternalCliInventoryInput): Promise<ExternalCliInventory> {
  const installations = new Map<string, ExternalCliInstallation>();
  const aliases = new Map<string, ExternalCliInstallation>();

  for (const candidate of await candidatesOf(input)) {
    const found = await inspect(candidate, input);

    if (!found) {
      continue;
    }

    const existing = installations.get(found.resourceKey);

    if (existing) {
      const combinedAliases = [...existing.aliases, candidate];

      if (!existing.realpath && found.realpath) {
        Object.assign(existing, found);
      }

      existing.aliases = combinedAliases;
      aliases.set(candidate, existing);
    } else {
      installations.set(found.resourceKey, found);
      aliases.set(candidate, found);
    }
  }

  let terminal: ExternalCliInstallation | undefined;

  for (const directory of (input.env.PATH || '').split(path.delimiter).filter(path.isAbsolute)) {
    const candidate = path.join(directory, input.definition.binName);
    const item = aliases.get(candidate);
    const usable = await fs.stat(candidate).then((stat) => stat.isFile(), () => false)
      && await fs.access(candidate, constants.X_OK).then(() => true, () => false);

    if (item && usable) {
      terminal = item;
      break;
    }
  }

  const selected = path.isAbsolute(input.configuredBin) ? aliases.get(input.configuredBin) : terminal;

  return {
    installations: [...installations.values()],
    selectedId: selected?.installationId || null,
    terminalId: terminal?.installationId || null,
    conflict: selected?.installationId !== terminal?.installationId,
  };
}
