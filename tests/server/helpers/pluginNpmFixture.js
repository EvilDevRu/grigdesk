import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { manifestV1, png } from '../../helpers/pluginV1.js';

/**
 * Lifecycle scripts только создают marker в своём temp root, никогда не запускаются при pack.
 * Настоящий npm получает tarballs по integrity из одноразового кеша без сети.
 */
export async function createOfflineNpmFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-offline-npm-'));
  const cwd = path.join(root, 'package');
  const cache = path.join(root, 'cache');
  const markers = path.join(root, 'markers');
  const npmPath = path.join(path.dirname(process.execPath), 'npm');
  const npmCli = await realpath(npmPath);
  const requireFromNpm = createRequire(npmCli);
  const cacache = requireFromNpm('cacache');
  const packages = {};
  const markerFiles = [];

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(cwd, { recursive: true });
  await mkdir(markers);

  for (const name of ['fixture-prod', 'fixture-transitive', 'fixture-dev']) {
    const packRoot = path.join(root, name);
    const packDir = path.join(packRoot, 'package');
    const scripts = lifecycleScripts(name, markers, markerFiles);
    const manifest = {
      name,
      version: '1.0.0',
      scripts,
      ...(name === 'fixture-prod' ? { dependencies: { 'fixture-transitive': '1.0.0' } } : {}),
    };

    await mkdir(packDir, { recursive: true });
    await writeFile(path.join(packDir, 'package.json'), JSON.stringify(manifest));
    await writeFile(path.join(packDir, 'index.js'), `export default ${JSON.stringify(name)};`);

    const tarball = path.join(root, `${name}.tgz`);

    execFileSync('/usr/bin/tar', ['-czf', tarball, '-C', packRoot, 'package']);

    const bytes = await readFile(tarball);
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const resolved = `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`;

    await cacache.put(path.join(cache, '_cacache'), `fixture:${resolved}`, bytes);

    packages[`node_modules/${name}`] = {
      version: '1.0.0',
      resolved,
      integrity,
      hasInstallScript: true,
      ...(name === 'fixture-dev' ? { dev: true } : {}),
      ...(name === 'fixture-prod' ? { dependencies: { 'fixture-transitive': '1.0.0' } } : {}),
    };
  }

  const manifest = {
    name: 'fixture-root',
    version: '1.0.0',
    dependencies: { 'fixture-prod': '1.0.0' },
    devDependencies: { 'fixture-dev': '1.0.0' },
    scripts: lifecycleScripts('root', markers, markerFiles),
  };
  const lock = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    packages: { '': manifest, ...packages },
  };

  await writeFile(path.join(cwd, 'package.json'), JSON.stringify(manifest));
  await writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify(lock));
  await mkdir(path.join(cwd, 'assets'));
  await writeFile(path.join(cwd, 'assets/icon.png'), png);
  await writeFile(path.join(cwd, 'plugin.json'),
    JSON.stringify(manifestV1({
      entrypoints: {},
      contributes: {},
      install: undefined,
    })));

  return {
    root,
    cwd,
    cache,
    markers,
    markerFiles,
    npmPath,
    npmCli,
  };
}

/**
 * Все стадии делают разные marker, чтобы test видел root и transitive execution.
 * Пути синтетические и принадлежат только temp fixture.
 */
function lifecycleScripts(name, directory, markerFiles) {
  const scripts = {};

  for (const stage of ['preinstall', 'install', 'postinstall', 'prepare']) {
    const file = path.join(directory, `${name}-${stage}`);
    const code = `require("node:fs").writeFileSync(${JSON.stringify(file)}, "executed")`;

    markerFiles.push(file);
    scripts[stage] = `node -e '${code}'`;
  }

  return scripts;
}
