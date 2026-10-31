import { selectPluginServerEntry } from '../pluginServerEntry.ts';
import { resolvePluginWebModule } from '../pluginWebModule.ts';
import { lstat, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from '../../../../shared/lib/objects.ts';

import {
  PLUGIN_ID_RE,
  decodeUserPluginManifest,
  normalizePluginPackagePath,
} from '../pluginsRegistry.ts';
import { compareSemVer, parseSemVer } from '../releaseCommon.ts';
import { PluginInstallError, installError } from './errors.ts';
import { assertRealPackageRoot, readPackageTree } from './packageTree.ts';
import type { PackageEntry } from './packageTree.ts';
import { validateNpmDeclarations, validateNpmLock } from './npmPolicy.ts';

export interface PackageLimits {
  maxFiles: number;
  maxBytes: number;
  maxManifestBytes: number;
}

export const PACKAGE_LIMITS: PackageLimits = {
  maxFiles: 5000,
  maxBytes: 50 * 1024 * 1024,
  maxManifestBytes: 64 * 1024,
};

export interface PackageExpectations {
  version: string;
  expectedId: string | null;
  reservedIds: ReadonlySet<string>;
  grigDeskVersion: string;
}

export interface ValidatedPackage {
  id: string;
  name: string;
  version: string;
  description: string;
  hasServer: boolean;
  webDir: string | null;
  webModuleDir: string | null;
  npmDirs: string[];
}

/**
 * Пакет получает только проверенные поля перед подготовкой зависимостей.
 * Сначала контракт фиксируется тестом обычного manifest.
 */
export async function validatePluginPackage(
  dir: string,
  expected: PackageExpectations,
  limits: PackageLimits = PACKAGE_LIMITS,
): Promise<ValidatedPackage> {
  const tree = await readPackageTree(dir, limits);

  return validatePackageTree(dir, expected, limits, tree);
}

/**
 * Повторная проверка после npm допускает generated только в manifest selection.
 * Нормализация выполняется до обхода; содержимое выбранных папок читается лишь после него.
 */
export async function validatePreparedPluginPackage(
  dir: string,
  expected: PackageExpectations,
): Promise<ValidatedPackage> {
  const manifest = await readPluginManifest(dir);
  const tree = await readPreparedPackageTree(dir, manifest);

  return validatePackageTree(dir, expected, PACKAGE_LIMITS, tree);
}

/**
 * Сгенерированные зависимости имеют общую файловую политику для всех пакетов.
 * Их исключение из исходного дерева не ослабляет проверку ссылок и пределов payload.
 */
export async function readPreparedPackageTree(
  dir: string,
  manifest: Record<string, unknown>,
): Promise<PackageEntry[]> {
  const selection = isRecord(manifest.install) ? manifest.install.npm : undefined;
  const lockInfo = await lstat(path.join(dir, 'package-lock.json')).catch(() => null);
  const rawDirs = selection ?? (lockInfo ? ['.'] : []);

  if (!Array.isArray(rawDirs)) {
    throw installError('npm_dir_invalid');
  }

  const generatedDirs: string[] = [];

  for (const raw of rawDirs) {
    const relative = normalizePluginPackagePath(raw, true);

    if (relative === null) {
      throw installError('npm_dir_invalid');
    }

    generatedDirs.push(relative);
  }

  const tree = await readPackageTree(dir, {
    generatedDirs,
    webDir: normalizePluginPackagePath(manifest.web, false),
  });
  const generated = generatedDirs.map((dir) => path.posix.join(dir, 'node_modules'));
  const original = tree.filter((entry) => !generated.some((root) => entry.relative === root
    || entry.relative.startsWith(`${root}/`)));

  return original;
}

/**
 * Manifest и npm declarations имеют одинаковую проверку до и после dependencies.
 * Переданная tree уже исключила спецфайлы и недопустимые переходы по ссылкам.
 */
async function validatePackageTree(
  dir: string,
  expected: PackageExpectations,
  limits: PackageLimits,
  tree: PackageEntry[],
): Promise<ValidatedPackage> {
  const info = await lstat(path.join(dir, 'plugin.json')).catch(() => null);

  if (!info?.isFile()) {
    throw installError('manifest_missing');
  }

  const manifest = await boundedJson(path.join(dir, 'plugin.json'), limits.maxManifestBytes);
  const id = manifest.id;

  if (typeof id !== 'string' || !PLUGIN_ID_RE.test(id)
    || ['constructor', 'prototype', '__proto__'].includes(id)) {
    throw installError('id_invalid');
  }

  if (expected.reservedIds.has(id)) {
    throw installError('id_reserved');
  }

  if (expected.expectedId !== null && id !== expected.expectedId) {
    throw installError('id_mismatch');
  }

  if (Object.hasOwn(manifest, 'api') && manifest.api !== 1 && manifest.api !== 2) {
    throw installError('api_unsupported');
  }

  const version = manifest.version;

  if (typeof version !== 'string' || version.trim() !== version || !parseSemVer(version)) {
    throw installError('version_invalid');
  }

  if (version !== expected.version) {
    throw installError('version_mismatch');
  }

  if (Object.hasOwn(manifest, 'minGrigDeskVersion')) {
    const minimum = manifest.minGrigDeskVersion;

    if (typeof minimum !== 'string' || minimum.trim() !== minimum || !parseSemVer(minimum)) {
      throw installError('manifest_invalid', 'minGrigDeskVersion должен быть вида X.Y.Z');
    }

    if (compareSemVer(minimum, expected.grigDeskVersion) > 0) {
      throw installError('grigdesk_too_old', `нужна ${minimum}, установлена ${expected.grigDeskVersion}`);
    }
  }

  const fields = decodeUserPluginManifest(manifest);
  const webDir = await validateWeb(dir, manifest.web);
  const npmDirs = await validateNpmDirs(dir, manifest);
  const webModule = manifest.api === 2
    ? resolvePluginWebModule(dir, id, manifest.webModule, normalizeModulePath, (message) => {
      const reason = message.replace(/^webModule пропущен: /u, '');

      throw new PluginInstallError('manifest_invalid', `Некорректный webModule: ${reason}`, 422);
    }) : null;

  await validateGitControls(dir, tree);

  const [js, ts] = await Promise.all(['server.js', 'server.ts'].map((entry) =>
    lstat(path.join(dir, entry)).catch(() => null)));
  const server = selectPluginServerEntry(js?.isFile() ?? false, ts?.isFile() ?? false);

  if (server.serverError) {
    throw new PluginInstallError('manifest_invalid', server.serverError, 422);
  }

  return {
    id,
    name: fields.name,
    version,
    description: fields.description,
    hasServer: server.hasServer,
    webDir,
    webModuleDir: webModule ? path.relative(dir, webModule.dir).split(path.sep).join('/') : null,
    npmDirs,
  };
}

/**
 * Исполняемые ресурсы принадлежат самому пакету, а не установленным npm-зависимостям.
 * Остальные ограничения путей и файлов остаются в общем валидаторе модуля.
 */
function normalizeModulePath(raw: unknown, rootAllowed: boolean): string | null {
  const relative = normalizePluginPackagePath(raw, rootAllowed);

  if (relative?.split('/').includes('node_modules')) {
    throw new Error('ресурс модуля не может находиться в node_modules');
  }

  return relative;
}

/**
 * Повторная проверка manifest ограничена ordinary no-link root и размером JSON.
 * Caller уже знает npmDirs установленного snapshot и не исполняет код пакета.
 */
export async function readPluginManifest(directory: string): Promise<Record<string, unknown>> {
  await assertRealPackageRoot(directory);

  return boundedJson(path.join(directory, 'plugin.json'), PACKAGE_LIMITS.maxManifestBytes);
}

const MAX_NPM_JSON_BYTES = 2 * 1024 * 1024;

/**
 * Самостоятельный npm runner повторяет файловую и graph-политику перед spawn.
 * Это не требует manifest ожиданий, уже проверенных installer до dependencies.
 */
export async function validateNpmDirectory(directory: string): Promise<void> {
  await readPackageTree(directory);

  const packageFile = path.join(directory, 'package.json');
  const lockFile = path.join(directory, 'package-lock.json');

  if (!(await lstat(packageFile).catch(() => null))?.isFile()) {
    throw installError('npm_dir_invalid');
  }

  if (!(await lstat(lockFile).catch(() => null))?.isFile()) {
    throw installError('lockfile_missing');
  }

  validateNpmDeclarations(await boundedJson(packageFile, MAX_NPM_JSON_BYTES));
  validateNpmLock(await boundedJson(lockFile, MAX_NPM_JSON_BYTES));
}

/**
 * Lock в корне требует парный package.json, runtime declarations требуют lock.
 * Пустой package.json без runtime зависимостей не запускает npm.
 */
export async function validateNpmDirs(dir: string, manifest: Record<string, unknown>): Promise<string[]> {
  const packageFile = path.join(dir, 'package.json');
  const lockFile = path.join(dir, 'package-lock.json');
  const packageInfo = await lstat(packageFile).catch(() => null);
  const lockInfo = await lstat(lockFile).catch(() => null);

  if (lockInfo && !packageInfo?.isFile()) {
    throw installError('npm_dir_invalid', '.');
  }

  const declarations = packageInfo ? await boundedJson(packageFile, MAX_NPM_JSON_BYTES) : null;

  if (declarations) {
    validateNpmDeclarations(declarations);
  }

  if (Object.hasOwn(manifest, 'install') && !isRecord(manifest.install)) {
    throw installError('manifest_invalid');
  }

  const selection = isRecord(manifest.install) && Object.hasOwn(manifest.install, 'npm')
    ? manifest.install.npm : undefined;
  let chosen: string[] = [];

  if (selection !== undefined) {
    if (!Array.isArray(selection)) {
      throw installError('npm_dir_invalid');
    }

    for (const raw of selection) {
      const relative = normalizePluginPackagePath(raw, true);

      if (relative === null) {
        throw installError('npm_dir_invalid');
      }

      if (!chosen.includes(relative)) {
        chosen.push(relative);
      }
    }
  } else if (lockInfo) {
    chosen = ['.'];
  }

  if (declarations && hasRuntimeDependencies(declarations) && !chosen.includes('.')) {
    throw installError('lockfile_missing', '.');
  }

  for (const relative of chosen) {
    const packagePath = path.join(dir, relative, 'package.json');
    const lockPath = path.join(dir, relative, 'package-lock.json');

    if (!(await lstat(packagePath).catch(() => null))?.isFile()) {
      throw installError('npm_dir_invalid', relative);
    }

    if (!(await lstat(lockPath).catch(() => null))?.isFile()) {
      throw installError('lockfile_missing', relative);
    }

    const packageJson = await boundedJson(packagePath, MAX_NPM_JSON_BYTES);
    const lock = await boundedJson(lockPath, MAX_NPM_JSON_BYTES);

    validateNpmDeclarations(packageJson);
    validateNpmLock(lock);
  }

  return chosen;
}

/**
 * Git-фильтры и LFS pointers не переносятся в устанавливаемый payload.
 * Все пути уже проверены обходом; префикс обычного blob читается ограниченно.
 */
export async function validateGitControls(dir: string, tree: PackageEntry[]): Promise<void> {
  for (const entry of tree) {
    if (!entry.info.isFile()) {
      continue;
    }

    const file = path.join(dir, entry.relative);

    if (path.posix.basename(entry.relative) === '.gitattributes') {
      const attributes = await readFile(file, 'utf8');

      if (/(?:^|\s)(?:[+-]?filter(?:=|\s|$)|working-tree-encoding(?:=|\s|$))/mu.test(attributes)) {
        throw installError('package_unsupported', entry.relative);
      }
    }

    const handle = await open(file, 'r');

    try {
      const bytes = Buffer.alloc(1024);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);

      const prefix = bytes.subarray(0, bytesRead).toString('utf8');

      if (prefix.startsWith('version https://git-lfs.github.com/spec/v1')) {
        throw installError('package_unsupported', entry.relative);
      }
    } finally {
      await handle.close();
    }
  }
}

/**
 * Пользовательская страница обязана жить в отдельной подпапке с обычным index.
 * Единая нормализация пути позже используется и для npmDirs.
 */
async function validateWeb(dir: string, raw: unknown): Promise<string | null> {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }

  const relative = normalizePluginPackagePath(raw, false);

  if (relative === null) {
    throw installError('web_invalid');
  }

  const info = await lstat(path.join(dir, relative, 'index.html')).catch(() => null);

  if (!info?.isFile() || info.isSymbolicLink()) {
    throw installError('web_invalid');
  }

  return relative;
}

/**
 * Размер обычного файла проверяется до чтения, JSON обязан быть объектом.
 * Ошибки парсинга скрываются за стабильным безопасным кодом.
 */
export async function boundedJson(file: string, maximum: number): Promise<Record<string, unknown>> {
  try {
    const info = await lstat(file);

    if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) {
      throw installError('manifest_invalid');
    }

    const value: unknown = JSON.parse(await readFile(file, 'utf8'));

    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw installError('manifest_invalid');
    }

    return value as Record<string, unknown>;
  } catch {
    throw installError('manifest_invalid');
  }
}

/**
 * Runtime declarations включают optional и peer, даже без dependencies.
 * Явный пустой выбор npm не отменяет необходимость подготовить эти зависимости.
 */
function hasRuntimeDependencies(value: Record<string, unknown>): boolean {
  return ['dependencies', 'optionalDependencies', 'peerDependencies'].some((field) => {
    const declarations = value[field];

    return isRecord(declarations) && Object.keys(declarations).length > 0;
  });
}
