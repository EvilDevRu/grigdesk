import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2]!;
const packageFile = path.join(root, 'server/package.json');
const manifest = JSON.parse(await readFile(packageFile, 'utf8'));
const require = createRequire(packageFile);
const packages: Record<string, string> = {};
const native: string[] = [];

require.resolve('playwright-core/package.json');

for (const name of Object.keys(manifest.dependencies).sort()) {
  await import(pathToFileURL(require.resolve(name)).href);

  const file = path.join(root, 'server/node_modules', name, 'package.json');

  packages[name] = JSON.parse(await readFile(file, 'utf8')).version;
}

/**
 * Каждый binding проверяется в новом процессе того же Node: NAN-модуль может
 * отказать при повторной регистрации копии из obj.target в уже занятом процессе.
 */
async function inspect(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await inspect(file);
    } else if (entry.isFile() && entry.name.endsWith('.node')) {
      const probe = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', file], {
        env: { PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
        timeout: 10000,
      });

      if (probe.error || probe.status !== 0) {
        throw new Error(`Native binding не загрузился: ${file}: ${probe.error?.message ?? probe.stderr}`);
      }

      native.push(path.relative(root, file));
    }
  }
}

await inspect(path.join(root, 'server/node_modules'));
console.log(JSON.stringify({
  node: process.versions.node,
  abi: process.versions.modules,
  packages,
  native,
}));
