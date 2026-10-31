import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createNpmRunner } from '../../server/src/lib/packageInstall/npm.ts';
import { profilesDirFor } from '../../server/src/lib/runtimeLayout.ts';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/**
 * Временная папка одного сценария; уборка удаляет только её.
 * Права read-only R возвращаются до удаления, иначе rm не сможет пройти.
 */
async function scratch(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-writable-'));

  t.after(() => rm(root, {
    recursive: true,
    force: true
  }));

  return root;
}

test('SEA-WP-01: умолчания профилей зависят от режима, override важнее', () => {
  const source = {
    kind: 'source',
    rootDir: '/tree',
    dataHome: '/data',
    env: {}
  };

  assert.equal(profilesDirFor(source), '/tree/profiles');
  assert.equal(profilesDirFor({
    ...source,
    kind: 'packaged'
  }), '/data/profiles');
  assert.equal(profilesDirFor({
    ...source,
    env: { FACTORY_PROFILES_DIR: '/external/profiles' }
  }), '/external/profiles');
  assert.equal(profilesDirFor({
    ...source,
    kind: 'packaged',
    env: { FACTORY_PROFILES_DIR: '/external/profiles' }
  }), '/external/profiles');
  assert.equal(profilesDirFor({
    ...source,
    env: { FACTORY_PROFILES_DIR: '' }
  }), '/tree/profiles');
});

test('SEA-WP-02: конфигурация source сохраняет прежние умолчания', async (t) => {
  const home = await scratch(t);
  const previousHome = process.env.GRIGDESK_HOME;
  const previousProfiles = process.env.FACTORY_PROFILES_DIR;

  process.env.GRIGDESK_HOME = home;
  delete process.env.FACTORY_PROFILES_DIR;
  t.after(() => {
    if (previousHome === undefined) {
      delete process.env.GRIGDESK_HOME;
    } else {
      process.env.GRIGDESK_HOME = previousHome;
    }

    if (previousProfiles === undefined) {
      delete process.env.FACTORY_PROFILES_DIR;
    } else {
      process.env.FACTORY_PROFILES_DIR = previousProfiles;
    }
  });

  const { config } = await import(`../../server/src/config.ts?source=${Date.now()}`);

  assert.equal(config.rootDir, ROOT);
  assert.equal(config.profilesDir, path.join(ROOT, 'profiles'));
  assert.equal('webDist' in config, false);
  assert.equal('uiReleasesDir' in config, false);
  assert.ok(!config.routesDir.startsWith(`${ROOT}${path.sep}`));
});

test('SEA-WP-03: профиль и маршрут создаются вне read-only R', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-writable-ro-'));
  const R = path.join(base, 'R with space');
  const dataHome = path.join(await scratch(t), 'data home');

  await mkdir(path.join(R, 'server'), {
    recursive: true
  });
  await mkdir(dataHome, {
    recursive: true
  });
  await writeFile(path.join(R, 'server/marker'), 'комплект');
  await chmod(path.join(R, 'server'), 0o555);
  await chmod(R, 0o555);
  t.after(async () => {
    await chmod(path.join(R, 'server'), 0o755);
    await chmod(R, 0o755);
    await rm(base, {
      recursive: true,
      force: true
    });
  });

  const profiles = profilesDirFor({
    kind: 'packaged',
    rootDir: R,
    dataHome,
    env: {},
  });
  const profile = path.join(profiles, 'sample');

  assert.equal(profiles, path.join(dataHome, 'profiles'));
  assert.ok(!profiles.startsWith(`${R}${path.sep}`));

  await mkdir(profile, {
    recursive: true
  });
  await writeFile(path.join(profile, 'graph.json'), '{}\n');

  const routes = path.join(dataHome, 'routes');
  const route = path.join(routes, 'sample');

  await mkdir(route, {
    recursive: true
  });
  await writeFile(path.join(route, 'route.json'), '{}\n');

  assert.equal(await readFile(path.join(profile, 'graph.json'), 'utf8'), '{}\n');
  assert.equal(await readFile(path.join(route, 'route.json'), 'utf8'), '{}\n');
  await assert.rejects(
    writeFile(path.join(R, 'server', 'новый'), 'x'),
    (error) => error.code === 'EACCES' || error.code === 'EROFS',
  );
  assert.deepEqual(await readdir(R), ['server']);
});

test('SEA-WP-04: npm cache и prefix не указывают внутрь R', async (t) => {
  const workspace = path.join(await scratch(t), 'plugin');
  const cache = path.join(await scratch(t), 'npm cache');
  const calls = [];

  await mkdir(workspace, {
    recursive: true
  });
  await writeFile(path.join(workspace, 'package.json'), JSON.stringify({
    name: 'plugin-fixture',
    version: '1.0.0',
  }));
  await writeFile(path.join(workspace, 'package-lock.json'), JSON.stringify({
    name: 'plugin-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'plugin-fixture',
        version: '1.0.0',
      }
    },
  }));

  const npm = createNpmRunner(async (cwd, args, options) => {
    calls.push({
      cwd,
      args,
      options
    });

    return {
      code: 0,
      stdout: '',
      stderr: ''
    };
  }, {
    cacheRoot: cache
  });

  await npm(workspace);

  const [{ args }] = calls;

  assert.ok(args.includes(`--cache=${cache}`));
  assert.ok(args.includes(`--prefix=${workspace}`));
  assert.ok(args.includes('--ignore-scripts'));
  assert.ok(!args.some((value) => value.includes('R with space')));
  assert.ok(!calls[0].options.env.PATH.includes(ROOT));
});
