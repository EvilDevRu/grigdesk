import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { vendorHash } from './deepseekVendorManifest.ts';
import type { WorkspacePackage } from './runtimeComposition.ts';

/**
 * Полный installed tree получает отдельный license inventory, включая native packages.
 * Исходные notices остаются в package tree, их копии входят в хеш payload generation.
 */
export async function writeDeepSeekLicenseInventory(
  root: string,
  packages: readonly WorkspacePackage[],
): Promise<void> {
  const directory = path.join(root, 'licenses');
  const records: Record<string, unknown>[] = [];
  const supplements = fileURLToPath(new URL('./deepseek-build/licenses/', import.meta.url));
  const sources = JSON.parse(await fs.readFile(path.join(supplements, 'sources.json'), 'utf8'));

  await fs.mkdir(directory);

  /**
   * License-файл сохраняется с оригинальными байтами и SHA-256.
   * Имена берутся из controlled package directory, без сетевого восстановления notice.
   */
  const recordPackage = async (relative: string, workspace: boolean): Promise<void> => {
    const absolute = path.join(root, relative);
    const manifest = JSON.parse(await fs.readFile(path.join(absolute, 'package.json'), 'utf8'));
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    const notices = entries.filter((entry) => entry.isFile()
      && /^(?:license|licence|copying|notice|third[-_]?party)/iu.test(entry.name));

    if (!manifest.license || typeof manifest.license !== 'string') {
      throw new Error(`Отсутствует license declaration: ${manifest.name}`);
    }

    const originals = notices.map((entry) => path.posix.join(relative, entry.name));

    if (originals.length === 0 && workspace) {
      originals.push(relative.startsWith('native/system/') ? 'native/system/LICENSE' : 'LICENSE');
    }

    if (originals.length === 0 && manifest.name.startsWith('@koromix/koffi-')) {
      const parent = JSON.parse(await fs.readFile(
        path.join(root, 'node_modules/koffi/package.json'), 'utf8',
      ));

      if (parent.version !== manifest.version || parent.license !== manifest.license) {
        throw new Error(`Несовместимый native Koffi notice: ${manifest.name}`);
      }

      originals.push('node_modules/koffi/LICENSE.txt');
    }

    if (originals.length === 0 && manifest.name.startsWith('@img/sharp-libvips-')) {
      const readme = await fs.readFile(path.join(absolute, 'README.md'), 'utf8');

      if (!readme.includes('## Licensing') || !readme.includes('LGPLv3')) {
        throw new Error(`Отсутствует native libvips notices: ${manifest.name}`);
      }

      originals.push(path.posix.join(relative, 'README.md'), 'supplement:LGPL-3.0.txt',
        'supplement:GPL-3.0.txt');
    }

    if (originals.length === 0 && manifest.name === '@xterm/headless' && manifest.version === '6.0.0') {
      if (manifest.commit !== 'f447274f430fd22513f6adbf9862d19524471c04') {
        throw new Error('Изменился provenance xterm license supplement');
      }

      originals.push('supplement:xterm-6.0.0-LICENSE.txt');
    }

    if (originals.length === 0) {
      throw new Error(`Отсутствует license/notice: ${manifest.name}@${manifest.version}`);
    }

    const files: {
      original: string;
      copy: string;
      sha256: string;
      source?: string;
    }[] = [];

    for (const original of originals) {
      const supplement = original.startsWith('supplement:')
        ? original.slice('supplement:'.length)
        : undefined;
      const source = supplement ? sources.files.find((entry: any) => entry.file === supplement) : undefined;
      const bytes = await fs.readFile(supplement
        ? path.join(supplements, supplement)
        : path.join(root, original));
      const digest = vendorHash(bytes);
      const copy = `${digest}-${path.basename(supplement ?? original)}`;

      if (supplement && (!source || source.sha256 !== digest)) {
        throw new Error(`Повреждён license supplement: ${supplement}`);
      }

      await fs.writeFile(path.join(directory, copy), bytes);
      files.push({
        original,
        copy,
        sha256: digest,
        ...(source ? { source: source.source } : {}),
      });
    }

    records.push({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      path: relative,
      workspace,
      files,
    });
  };

  for (const item of packages) {
    await recordPackage(item.root, true);
  }

  /**
   * Scoped, aliased и nested npm dependencies перечисляются отдельно.
   * Workspace links пропускаются: их license уже зарегистрирован по source root.
   */
  const visitModules = async (relative: string): Promise<void> => {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }

      const child = path.posix.join(relative, entry.name);

      if (entry.name.startsWith('@')) {
        await visitModules(child);
        continue;
      }

      if (!(await fs.access(path.join(root, child, 'package.json')).then(() => true, () => false))) {
        continue;
      }

      await recordPackage(child, false);

      if (await fs.access(path.join(root, child, 'node_modules')).then(() => true, () => false)) {
        await visitModules(path.posix.join(child, 'node_modules'));
      }
    }
  };

  await visitModules('node_modules');
  await fs.copyFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(directory, 'UPSTREAM_NOTICES.md'));
  await fs.writeFile(path.join(directory, 'index.json'), JSON.stringify({
    format: 1,
    packages: records,
  }, null, 2));
}
