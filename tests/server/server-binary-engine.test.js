import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bundlePayloadServer } from '../../server/scripts/sea/bundle.mts';
import { copyResources } from '../../server/scripts/sea/resources.mts';
import { factoryProfilesRoot, factoryRuntimePaths } from '../../server/src/lib/factoryRuntime.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PROFILE = 'demo-profile';

test('SB09: packaged default игнорирует прежний source engine override', () => {
  const value = factoryRuntimePaths({
    kind: 'packaged',
    root: '/R',
    env: {
      GRIGDESK_FACTORY_BIN: '/old/source/engine/bin/factory',
      FACTORY_HOME: '/old/source/engine',
    },
  });

  assert.equal(value.home, '/R/engine');
  assert.equal(value.bin, '/R/engine/bin/factory');
});

test('SB09: source прежний, bundled называет только имена старых overrides', () => {
  const overrides = {
    GRIGDESK_FACTORY_BIN: '/old/source/engine/bin/factory',
    FACTORY_HOME: '/old/source/engine',
  };

  assert.deepEqual(factoryRuntimePaths({
    kind: 'source',
    root: '/checkout',
    env: overrides,
  }), {
    mode: 'source',
    home: '/old/source/engine',
    bin: '/old/source/engine/bin/factory',
    ignored: [],
  });
  assert.deepEqual(factoryRuntimePaths({
    kind: 'source',
    root: '/checkout',
    env: {},
  }), {
    mode: 'source',
    home: '/checkout/engine',
    bin: '/checkout/engine/bin/factory',
    ignored: [],
  });
  assert.deepEqual(factoryRuntimePaths({
    kind: 'packaged',
    root: '/R',
    env: overrides,
  }).ignored, ['FACTORY_HOME', 'GRIGDESK_FACTORY_BIN']);
  assert.deepEqual(factoryRuntimePaths({
    kind: 'packaged',
    root: '/R',
    env: {},
  }).ignored, []);
});

test('SB09: external только явным режимом с абсолютными путями, неизвестный режим отказ', () => {
  assert.deepEqual(factoryRuntimePaths({
    kind: 'packaged',
    root: '/R',
    env: {
      GRIGDESK_ENGINE_MODE: 'external',
      FACTORY_HOME: '/admin/engine',
    },
  }), {
    mode: 'external',
    home: '/admin/engine',
    bin: '/admin/engine/bin/factory',
    ignored: [],
  });
  assert.equal(factoryRuntimePaths({
    kind: 'packaged',
    root: '/R',
    env: {
      GRIGDESK_ENGINE_MODE: 'external',
      FACTORY_HOME: '/admin/engine',
      GRIGDESK_FACTORY_BIN: '/admin/factory',
    },
  }).bin, '/admin/factory');

  for (const env of [
    { GRIGDESK_ENGINE_MODE: 'external' },
    { GRIGDESK_ENGINE_MODE: 'external', FACTORY_HOME: 'relative/engine' },
    {
      GRIGDESK_ENGINE_MODE: 'external',
      FACTORY_HOME: '/admin/engine',
      GRIGDESK_FACTORY_BIN: 'factory',
    },
  ]) {
    assert.throws(() => factoryRuntimePaths({
      kind: 'packaged',
      root: '/R',
      env,
    }), { code: 'factory_engine_external_invalid' });
  }

  for (const kind of ['packaged', 'source']) {
    assert.throws(() => factoryRuntimePaths({
      kind,
      root: '/R',
      env: { GRIGDESK_ENGINE_MODE: 'checkout' },
    }), { code: 'factory_engine_mode_unsupported' });
  }
});

/**
 * Одноразовые D/I: настоящий D за symlink-ссылкой и внешний каталог профилей.
 * Каталоги машины и настоящие профили в проверку не попадают.
 */
async function profilesFixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'server-binary-engine-')));
  const data = path.join(base, 'data/D');
  const linkedData = path.join(base, 'D-link');

  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(data, 'profiles'), { recursive: true });
  await symlink(data, linkedData);

  return {
    base,
    data,
    linkedData,
  };
}

test('SB09: профили payload физические, symlink-предок отвергается с физической подсказкой', async (t) => {
  const fixture = await profilesFixture(t);
  const external = path.join(fixture.base, 'external profiles');
  const linkedExternal = path.join(fixture.base, 'profiles-link');

  await mkdir(external);
  await symlink(external, linkedExternal);

  assert.equal(factoryProfilesRoot({
    kind: 'packaged',
    rootDir: '/R',
    dataHome: fixture.linkedData,
    env: {},
  }), path.join(fixture.data, 'profiles'));
  assert.equal(factoryProfilesRoot({
    kind: 'packaged',
    rootDir: '/R',
    dataHome: fixture.linkedData,
    env: { FACTORY_PROFILES_DIR: external },
  }), external);
  assert.equal(factoryProfilesRoot({
    kind: 'source',
    rootDir: '/checkout',
    dataHome: fixture.linkedData,
    env: {},
  }), '/checkout/profiles');

  for (const [value, physical] of [
    [path.join(fixture.linkedData, 'profiles'), path.join(fixture.data, 'profiles')],
    [linkedExternal, external],
    [path.join(linkedExternal, 'новые'), path.join(external, 'новые')],
    [`${external}/`, external],
  ]) {
    assert.throws(() => factoryProfilesRoot({
      kind: 'packaged',
      rootDir: '/R',
      dataHome: fixture.data,
      env: { FACTORY_PROFILES_DIR: value },
    }), (error) => error.code === 'factory_profiles_not_physical' && error.message.includes(physical));
  }

  const linkedProfiles = path.join(fixture.base, 'D2');

  await mkdir(linkedProfiles);
  await symlink(external, path.join(linkedProfiles, 'profiles'));
  assert.throws(() => factoryProfilesRoot({
    kind: 'packaged',
    rootDir: '/R',
    dataHome: linkedProfiles,
    env: {},
  }), (error) => error.code === 'factory_profiles_not_physical' && error.message.includes(external));
});

/**
 * Исполняет команду движка с изолированным окружением тестов движка.
 * PATH содержит только fake-провайдеры и системные утилиты, модель не вызывается.
 */
function engine(command, args, env) {
  return new Promise((resolve) => {
    const options = {
      env: {
        PATH: `${path.join(ROOT, 'tests/engine/fakes/bin')}:/usr/bin:/bin`,
        LC_ALL: 'C',
        FACTORY_TESTING: '1',
        FACTORY_FORBID_LIVE: '1',
        ...env,
      },
      timeout: 60_000,
    };

    execFile(command, args, options, (error, stdout, stderr) => {
      resolve({
        code: error ? (error.code ?? 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

/**
 * Минимальный собственный профиль route-v2 и опубликованный каталог маршрутов фикстуры.
 * Профиль лежит в физическом D/profiles; каталог публикует общий fixture движка.
 */
async function ownProfile(profiles, routes) {
  const directory = path.join(profiles, PROFILE);

  await mkdir(directory, { recursive: true });
  await mkdir(routes, { recursive: true });
  await writeFile(path.join(directory, 'profile.sh'), `PROFILE_NAME=${PROFILE}\n`);
  await writeFile(path.join(directory, 'runners.env'), [
    'RUNNERS_SCHEMA=1',
    'CONFIG_REVISION=1',
    'RUNNERS_COVERAGE=required',
    'PROJECT_RUNNER_PRIMARY=alpha',
    'PROJECT_RUNNER_FAILOVER=',
    'MODEL_DEFAULT_ALPHA_FAMILY=fixture',
    'MODEL_DEFAULT_ALPHA_VERSION=latest',
    '',
  ].join('\n'));
  await writeFile(path.join(directory, 'graph.json'), '{"capabilities":["route-v2"]}\n');

  const published = await engine(process.execPath,
    [path.join(ROOT, 'tests/engine/fixtures/routes-catalog-publish.mjs'), routes, 'null'], {});

  assert.equal(published.code, 0, published.stderr);
}

test('SB09: перенесённый R проходит настоящий factory check по физическим профилям', async (t) => {
  const fixture = await profilesFixture(t);
  const root = path.join(fixture.data, 'runtimes/server/packages', 'a'.repeat(64));
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'server/build/resources.json'), 'utf8'));
  const routes = path.join(fixture.base, 'routes');
  const state = path.join(fixture.base, 'state');

  await copyResources(ROOT, root, manifest);

  const runtime = factoryRuntimePaths({
    kind: 'packaged',
    root,
    env: {
      FACTORY_HOME: path.join(ROOT, 'engine'),
      GRIGDESK_FACTORY_BIN: path.join(ROOT, 'engine/bin/factory'),
    },
  });

  assert.equal(runtime.bin, path.join(root, 'engine/bin/factory'));

  for (const library of ['attempt-lifecycle-state.sh', 'provider-lineage-state.sh']) {
    const schema = await engine('/bin/bash', ['-c',
      'source "$FACTORY_HOME/lib/$1" && { _attempt_lifecycle_schema_path 2>/dev/null'
        + ' || _provider_lineage_schema_path; }', 'schema', library], { FACTORY_HOME: runtime.home });

    assert.equal(schema.code, 0, `${library}: ${schema.stderr}`);
    assert.ok(schema.stdout.startsWith(path.join(root, 'schemas/analytics/')), schema.stdout);
  }

  const profiles = factoryProfilesRoot({
    kind: 'packaged',
    rootDir: root,
    dataHome: fixture.linkedData,
    env: {},
  });
  const common = {
    HOME: fixture.base,
    FACTORY_PROFILES_DIR: profiles,
    FACTORY_CONFIG_ROOT: path.join(fixture.base, 'config'),
    FACTORY_STATE: state,
    STATE_DIR: state,
  };
  const args = ['check', '--profile', PROFILE, '--route', 'feature', '--routes-dir', routes];

  await ownProfile(profiles, routes);

  const checked = await engine(runtime.bin, args, common);

  assert.equal(checked.code, 0, checked.stderr);
  assert.match(checked.stdout, /^OK profile=demo-profile .*route=feature/u);

  const viaLink = await engine(runtime.bin, args, {
    ...common,
    FACTORY_PROFILES_DIR: path.join(fixture.linkedData, 'profiles'),
  });

  assert.equal(viaLink.code, 78);
  assert.match(viaLink.stderr, /symlink-компоненты запрещены/u);
});

test('SB09: config payload выбирает движок R и физические D/profiles при старом .env', async (t) => {
  const fixture = await profilesFixture(t);
  const root = path.join(fixture.data, 'runtimes/server/packages', 'b'.repeat(64));
  const outfile = path.join(root, 'server/payload.cjs');
  const binary = path.join(fixture.base, 'installation/bin/grigdesk-server');
  const home = path.join(fixture.base, 'home');

  await mkdir(path.dirname(binary), { recursive: true });
  await mkdir(home);
  await writeFile(binary, 'ELF');

  const result = await bundlePayloadServer({
    sourceRoot: ROOT,
    workDir: fixture.base,
    outfile,
    plugins: [{
      name: 'fixture-config-app',
      setup(builder) {
        builder.onLoad({ filter: /server\/src\/app\.ts$/ }, () => ({
          contents: [
            'import { config } from "./config.ts";',
            'globalThis.details = { home: config.factoryHome, bin: config.factoryBin,',
            '  profiles: config.profilesDir };',
          ].join('\n'),
          loader: 'ts',
          resolveDir: path.join(ROOT, 'server/src'),
        }));
      },
    }],
  });
  const script = [
    `const entry = require(${JSON.stringify(outfile)});`,
    `entry.startPayloadServer(${JSON.stringify(binary)})`,
    '  .then(() => process.stdout.write(JSON.stringify(globalThis.details)))',
    '  .catch((error) => { console.error(error); process.exitCode = 1; });',
  ].join('\n');
  const run = spawnSync(process.execPath, ['-e', script], {
    cwd: fixture.base,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      GRIGDESK_HOME: fixture.linkedData,
      FACTORY_HOME: path.join(ROOT, 'engine'),
      GRIGDESK_FACTORY_BIN: path.join(ROOT, 'engine/bin/factory'),
    },
    encoding: 'utf8',
    timeout: 30_000,
  });

  assert.deepEqual(result.warnings, []);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    home: path.join(root, 'engine'),
    bin: path.join(root, 'engine/bin/factory'),
    profiles: path.join(fixture.data, 'profiles'),
  });
  assert.equal(run.stderr.match(/FACTORY_HOME, GRIGDESK_FACTORY_BIN из прежней настройки/gu)?.length, 1);
  assert.equal(run.stderr.includes(ROOT), false);
});
