import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { isTrackerSettingsSchema } from '../../../../shared/trackers/validation.ts';
import { parseSemVer } from '../releaseCommon.ts';
import { installError } from '../pluginInstall/errors.ts';
import { assertRealPackageRoot, readPackageTree } from '../pluginInstall/packageTree.ts';
import type { InstallPackagePolicy } from '../pluginInstall/packagePolicy.ts';
import {
  boundedJson,
  PACKAGE_LIMITS,
  readPreparedPackageTree,
  validateGitControls,
  validateNpmDirs,
} from '../pluginInstall/validatePackage.ts';
import type { PackageExpectations, ValidatedPackage } from '../pluginInstall/validatePackage.ts';

const DRIVER_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const RESERVED_IDS = new Set(['own', 'b24-stock', 'constructor', 'prototype', '__proto__']);
const PLUGIN_FIELDS = ['api', 'nav', 'category', 'web', 'webModule', 'api-ext'];

/**
 * Манифест читается без исполнения пакета и переходов по символьным ссылкам.
 * Одинаковая проверка используется установкой, откатом и сканированием реестра.
 */
export async function readDriverManifest(directory: string): Promise<Record<string, unknown>> {
  await assertRealPackageRoot(directory);

  return boundedJson(path.join(directory, 'driver.json'), PACKAGE_LIMITS.maxManifestBytes);
}

/**
 * Драйвер имеет отдельную версию контракта и фиксированную точку входа.
 * Слоты плагинов здесь недопустимы, даже если пакет содержит рабочий серверный код.
 */
export async function validateDriverPackage(
  directory: string,
  expected: PackageExpectations,
  prepared = false,
): Promise<ValidatedPackage> {
  const manifest = await readDriverManifest(directory);
  const tree = prepared ? await readPreparedPackageTree(directory, manifest)
    : await readPackageTree(directory, PACKAGE_LIMITS);
  const { id, version } = manifest;

  if (typeof id !== 'string' || !DRIVER_ID.test(id) || id.length > 41) {
    throw installError('id_invalid');
  }

  if (RESERVED_IDS.has(id) || expected.reservedIds.has(id)) {
    throw installError('id_reserved');
  }

  if (expected.expectedId !== null && id !== expected.expectedId) {
    throw installError('id_mismatch');
  }

  if (manifest.contract !== 1) {
    throw installError('contract_unsupported');
  }

  if (typeof version !== 'string' || version.trim() !== version || !parseSemVer(version)) {
    throw installError('version_invalid');
  }

  if (version !== expected.version) {
    throw installError('version_mismatch');
  }

  if (typeof manifest.name !== 'string' || !manifest.name.trim()
    || !isTrackerSettingsSchema(manifest.settings)
    || PLUGIN_FIELDS.some((field) => Object.hasOwn(manifest, field))
    || tree.some((entry) => entry.relative === 'plugin.json')) {
    throw installError('manifest_invalid');
  }

  const entry = await lstat(path.join(directory, 'driver.ts')).catch(() => null);

  if (!entry?.isFile() || entry.isSymbolicLink()) {
    throw installError('manifest_invalid', 'Нужен обычный файл driver.ts');
  }

  await validateGitControls(directory, tree);

  return {
    id,
    name: manifest.name,
    version,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    hasServer: true,
    webDir: null,
    webModuleDir: null,
    npmDirs: await validateNpmDirs(directory, manifest),
  };
}

export const driverPackagePolicy: InstallPackagePolicy = {
  validate: (directory, expected) => validateDriverPackage(directory, expected),
  validatePrepared: (directory, expected) => validateDriverPackage(directory, expected, true),
  readManifest: readDriverManifest,
  installedModuleDir: async () => null,
  sensitiveFile: (file) => !/^docs?\//iu.test(file) && !/\.(md|txt|rst)$/iu.test(file),
  serverWarnings: ['Код драйвера выполняется с правами GrigDesk.'],
};
