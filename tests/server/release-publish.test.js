import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repository = path.resolve(import.meta.dirname, '../..');

/**
 * Стабы ssh/scp пишут вызовы в журнал и всегда отвечают успехом.
 * Журнал даёт ранним отказам обёртки доказать отсутствие сетевых команд.
 */
async function stubBins(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-bins-'));
  const sshLog = path.join(dir, 'ssh.log');
  const ssh = [
    '#!/usr/bin/env bash',
    `echo "ssh $*" >> ${JSON.stringify(sshLog)}`,
    'exit 0',
  ].join('\n');

  await fs.writeFile(path.join(dir, 'ssh'), ssh, { mode: 0o755 });

  t.after(() => {
    return fs.rm(dir, {
      recursive: true,
      force: true
    });
  });

  return {
    dir,
    sshLog
  };
}

const baseEnv = (bins, extra = {}) => {
  return ({
  ...process.env,
  PATH: `${bins.dir}:${process.env.PATH}`,
  RELEASE_SITE_HOST: 'site.example',
  RELEASE_SITE_USER: 'user',
  RELEASE_SITE_KEY: '/tmp/key',
  RELEASE_SITE_DIR: '/srv/grigdesk',
  RELEASE_SITE_PUBLIC_ORIGIN: 'https://grigdesk.com',
  ...extra,
});
};

/**
 * Production CLI не получает тестового флага: отдельный child вызывает модульный порт.
 */
function runPublication(directory, options) {
  const script = `import { publishRelease } from './tools/release-publish.mts';
    await publishRelease(process.argv[1], {
      dryRun: process.argv.includes('--dry-run'),
    });`;

  return spawnSync(process.execPath, ['--input-type=module', '-e', script, directory,
    ...(options.dryRun ? ['--dry-run'] : [])], options);
}

test('RP-1: каталог без release-artifacts — отказ до любых команд', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-empty-'));
  const bins = await stubBins(t);

  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const result = runPublication(dir, {
    cwd: repository,
    env: baseEnv(bins),
    encoding: 'utf8',
  });

  assert.equal(result.status, 3);
  assert.match(result.stderr, /release-artifacts/);
  await assert.rejects(fs.readFile(bins.sshLog), { code: 'ENOENT' });
});

test('RP-2: без окружения отказ с перечнем переменных, команды не запускаются', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-empty-'));
  const bins = await stubBins(t);
  const env = baseEnv(bins);

  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  for (const name of ['RELEASE_SITE_HOST', 'RELEASE_SITE_USER', 'RELEASE_SITE_KEY',
    'RELEASE_SITE_DIR', 'RELEASE_SITE_PUBLIC_ORIGIN']) {
    env[name] = '';
  }

  const result = runPublication(dir, {
    cwd: repository,
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /RELEASE_SITE_HOST/);
  await assert.rejects(fs.readFile(bins.sshLog), { code: 'ENOENT' });
});

const { installedBuild, loadInstalledModule } = await import('../helpers/installedBuildFixture.mjs');
const { isolatedEnvironment } = await import('../helpers/installedUpdateFixture.mjs');
const { compileHelpSources } = await import('../../shared/node/helpSources.ts');
const { HELP_LOCALES, helpResourceFile } = await import('../../shared/help/helpContracts.ts');

/**
 * Синтетический builder выдаёт исполняемый серверный контракт, содержащий настоящий help.
 * Publisher запускает его и проверяет корпус; SSH/SCP исполняют те же команды в локальном site-root.
 */
async function installedPublicationFixture(t, channel) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'installed-site-'));
  const bins = path.join(temporary, 'bin');
  const site = path.join(temporary, 'site');
  const mirror = path.join(temporary, 'mirror');
  const preparedRoot = path.join(temporary, 'runtime', 'b'.repeat(64));

  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.mkdir(bins, { recursive: true });
  await fs.mkdir(path.join(preparedRoot, 'server/help/site'), { recursive: true });

  const built = await installedBuild(t, channel, {
    serverSource: async (input, metadata) => {
      const help = path.join(preparedRoot, 'server/help');

      for (const locale of HELP_LOCALES) {
        const bundle = await compileHelpSources(repository, {
          version: input.env.GRIGDESK_RELEASE_VERSION,
          commit: input.env.GRIGDESK_RELEASE_COMMIT,
        }, locale);
        const file = helpResourceFile(locale);

        await fs.writeFile(path.join(help, file), JSON.stringify(bundle));
        await fs.writeFile(path.join(help, 'site', file), JSON.stringify(bundle));
      }

      for (const name of ['index.html', 'latest.html', 'latest.js']) {
        await fs.writeFile(path.join(help, 'site', name), `ресурс:${name}`);
      }

      const runtime = {
        format: 1,
        hostContract: 1,
        version: metadata.version,
        packagingVersion: 2,
        packageId: metadata.packageId,
        runtime: {
          node: '24.21.0',
          abi: '137',
          platform: 'linux',
          arch: 'x64',
        },
        capabilities: ['api', 'ipc', 'helpers', 'engine'],
        engine: { protocol: 'route-v2', sha256: 'a'.repeat(64) },
        payload: {
          sha256: 'c'.repeat(64),
          size: 1,
          entryCount: 1,
        },
      };
      const prepared = {
        packageId: metadata.packageId,
        root: preparedRoot,
        node: path.join(preparedRoot, 'runtime/node/bin/node'),
        engine: path.join(preparedRoot, 'engine/bin/factory'),
        installationBin: input.outDir,
        preparationToken: '12345678-1234-4234-8234-123456789abc',
      };

      return [
        '#!/bin/sh',
        'case "$1" in',
        `--runtime-info) printf '%s\\n' '${JSON.stringify(runtime)}';;`,
        `--prepare) printf '%s\\n' '${JSON.stringify(prepared)}';;`,
        "--release-preparation) printf '%s\\n' '{\"ok\":true}';;",
        `*) printf '%s\\n' '${JSON.stringify(metadata)}';;`,
        'esac',
      ].join('\n');
    },
  });

  await fs.writeFile(path.join(bins, 'ssh'), [
    '#!/usr/bin/python3',
    'import os, subprocess, sys',
    'if "fixture@mirror" in sys.argv and os.environ.get("PUBLISH_FAIL_MIRROR"): sys.exit(9)',
    'sys.exit(subprocess.run(["/bin/sh", "-c", sys.argv[-1]]).returncode)',
  ].join('\n'), { mode: 0o700 });
  await fs.writeFile(path.join(bins, 'scp'), [
    '#!/usr/bin/python3',
    'import os, shutil, sys',
    'args = iter(sys.argv[1:]); files = []',
    'for arg in args:',
    '    if arg in ["-o", "-i", "-P"]: next(args)',
    '    else: files.append(arg)',
    'destination = files.pop().split(":", 1)[1]',
    'for source in files:',
    '    shutil.copy(source, destination)',
    '    if os.environ.get("PUBLISH_FAIL_SCP"): sys.exit(9)',
  ].join('\n'), { mode: 0o700 });
  isolatedEnvironment(t, { PATH: `${bins}:/usr/bin:/bin` });

  for (const directory of [site, mirror]) {
    await fs.mkdir(path.join(directory, 'api/releases/v1'), { recursive: true });
    await fs.writeFile(path.join(directory, `api/releases/v1/${channel}.json`), 'OLD');
    await fs.writeFile(path.join(directory, `api/releases/v1/${channel === 'dev' ? 'release' : 'dev'}.json`),
      'OTHER');
  }

  const { publishInstalledRelease } = await loadInstalledModule(t, 'tools/installedPublication.mts',
    built.signer.publicKeyPem);
  const targets = [site, mirror].map((dir, index) => ({
    host: index ? 'mirror' : 'primary',
    user: 'fixture',
    port: '22',
    key: path.join(temporary, 'unused-key'),
    origin: 'https://grigdesk.com',
    dir,
  }));

  return {
    built,
    site,
    mirror,
    preparedRoot,
    targets,
    publishInstalledRelease,
  };
}

for (const channel of ['release', 'dev']) {
  test(`PUB-CHANNELS: ${channel}, partial upload/retry, immutable site и отказ зеркала`, async (t) => {
    const box = await installedPublicationFixture(t, channel);
    const latest = path.join(box.site, `api/releases/v1/${channel}.json`);
    const other = path.join(box.site, `api/releases/v1/${channel === 'dev' ? 'release' : 'dev'}.json`);
    const version = box.built.index.latest.payload.version;

    await fs.writeFile(path.join(box.built.directory, `grigdesk_${version}_amd64.deb`),
      'DEB-PAYLOAD', { mode: 0o644 });

    const translatedSite = path.join(box.preparedRoot, 'server/help/site/help.en.json');
    const translatedBytes = await fs.readFile(translatedSite);

    await fs.rm(translatedSite);
    await assert.rejects(box.publishInstalledRelease(box.built.directory, box.targets),
      /help_site_mismatch/u);
    assert.equal(await fs.readFile(latest, 'utf8'), 'OLD');
    await fs.writeFile(translatedSite, translatedBytes);

    isolatedEnvironment(t, { PUBLISH_FAIL_SCP: '1' });
    await assert.rejects(box.publishInstalledRelease(box.built.directory, box.targets));
    assert.equal(await fs.readFile(latest, 'utf8'), 'OLD');
    delete process.env.PUBLISH_FAIL_SCP;

    await box.publishInstalledRelease(box.built.directory, box.targets);
    assert.deepEqual(JSON.parse(await fs.readFile(latest, 'utf8')), box.built.index);
    assert.equal(await fs.readFile(other, 'utf8'), 'OTHER');
    assert.equal(await fs.readFile(path.join(box.site, 'releases', version,
      `grigdesk_${version}_amd64.deb`), 'utf8'), 'DEB-PAYLOAD');

    for (const locale of HELP_LOCALES) {
      for (const site of [box.site, box.mirror]) {
        const bundle = JSON.parse(await fs.readFile(path.join(site, 'help', version,
          helpResourceFile(locale)), 'utf8'));

        assert.equal(bundle.locale, locale);
        assert.deepEqual(bundle, JSON.parse(await fs.readFile(path.join(box.preparedRoot,
          'server/help', helpResourceFile(locale)), 'utf8')));
      }
    }

    await box.publishInstalledRelease(box.built.directory, box.targets);

    const immutableEnglish = path.join(box.site, 'help', version, 'help.en.json');

    await fs.writeFile(immutableEnglish, '{}');
    await assert.rejects(box.publishInstalledRelease(box.built.directory, box.targets));
    await fs.writeFile(immutableEnglish, translatedBytes);
    isolatedEnvironment(t, { PUBLISH_FAIL_MIRROR: '1' });
    await box.publishInstalledRelease(box.built.directory, box.targets);
    assert.deepEqual(JSON.parse(await fs.readFile(latest, 'utf8')), box.built.index);
  });
}
