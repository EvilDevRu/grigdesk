import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repository = path.resolve(import.meta.dirname, '../..');

/**
 * Единственный стаб ssh падает только для выбранного хоста: обе цели зовут одну
 * команду, различить их можно только по аргументам.
 */
async function stubBins(t, failHost = 'mirror.example') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-bins-'));
  const sshLog = path.join(dir, 'ssh.log');
  const scpLog = path.join(dir, 'scp.log');

  await fs.writeFile(path.join(dir, 'ssh'), [
    '#!/usr/bin/env bash',
    `echo "ssh $*" >> ${JSON.stringify(sshLog)}`,
    `if [[ "$*" == *user@${failHost}* ]]; then exit 9; fi`,
    'exit 0',
  ].join('\n'), { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'scp'), [
    '#!/usr/bin/env bash',
    `echo "scp $*" >> ${JSON.stringify(scpLog)}`,
    `if [[ "$*" == *user@${failHost}* ]]; then exit 9; fi`,
    'exit 0',
  ].join('\n'), { mode: 0o755 });
  t.after(() => {
    return fs.rm(dir, {
      recursive: true,
      force: true
    });
  });

  return {
    dir,
    sshLog,
    scpLog
  };
}

/**
 * Локальный выпуск подписывается одноразовым ключом и не требует сетевых операций.
 * Порча архива выполняется после вычисления сумм для проверки раннего отказа.
 */
async function release(t, tamperArchive = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-release-'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  t.after(() => {
    return fs.rm(dir, {
      recursive: true,
      force: true
    });
  });
  await fs.writeFile(path.join(dir, 'release.tar.gz'), 'ARCHIVE');

  const { createHash } = await import('node:crypto');
  const archiveSha = createHash('sha256')
    .update(await fs.readFile(path.join(dir, 'release.tar.gz'))).digest('hex');

  if (tamperArchive) {
    await fs.writeFile(path.join(dir, 'release.tar.gz'), 'TAMPERED');
  }

  const checksum = `${archiveSha}  release.tar.gz\n${'d'.repeat(64)}  release/bin/bundle.json\n`;

  await fs.writeFile(path.join(dir, 'release.tar.gz.sha256'), checksum);
  const signature = signBytes(null, Buffer.from(checksum, 'utf8'), privateKey)
    .toString('base64');

  await fs.writeFile(path.join(dir, 'release.tar.gz.sha256.sig'), `${signature}\n`);
  await fs.writeFile(path.join(dir, 'channel.json'), JSON.stringify({
    format: 1,
    latest: {
      version: '0.3.0',
      commit: 'c'.repeat(40),
      archiveSha256: archiveSha,
      archiveSize: 7,
      bundleSha256: 'd'.repeat(64),
      signature,
      archiveUrl: null,
      compat: {
        os: 'linux',
        arch: 'x64',
        glibc: '2.28'
      },
    },
    publishedAt: '2026-11-02T00:00:00.000Z',
  }));
  const pubFile = path.join(dir, 'release-signing.pub.pem');

  await fs.writeFile(pubFile, publicKey.export({
    type: 'spki',
    format: 'pem'
  }));

  return {
    dir,
    archiveSha,
    pubFile
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
  RELEASE_SIGNING_PUBLIC_KEY_FILE: '',
  ...extra,
});
};

test('RP-1: публикация заливает во временную папку и атомарно переименовывает', async (t) => {
  const rel = await release(t);
  const bins = await stubBins(t);
  const env = baseEnv(bins, { RELEASE_SIGNING_PUBLIC_KEY_FILE: rel.pubFile });

  const result = spawnSync(process.execPath, ['tools/release-publish.mts', rel.dir], {
    cwd: repository,
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const calls = (await fs.readFile(bins.sshLog, 'utf8'))
    + (await fs.readFile(bins.scpLog, 'utf8'));

  assert.match(calls, /scp .*release\.tar\.gz/);
  assert.match(calls, /scp .*channel\.json/);
  assert.match(calls, /ssh .*mv .*releases\/0\.3\.0/);
  assert.match(calls, /ssh .*api\/releases\/v1\/channel\.json/);

  const sshCalls = await fs.readFile(bins.sshLog, 'utf8');

  assert.ok(sshCalls.indexOf('else mv') < sshCalls.lastIndexOf('channel.json.new'),
    'канал переключается после публикации архива');

  const channel = JSON.parse(await fs.readFile(path.join(rel.dir, 'channel.json'), 'utf8'));

  assert.equal(channel.latest.archiveUrl,
    'https://grigdesk.com/releases/0.3.0/release.tar.gz', 'archiveUrl заполнен публикатором');
});

test('RP-2: без окружения отказ с перечнем переменных, команды не запускаются', async (t) => {
  const rel = await release(t);
  const bins = await stubBins(t);
  const env = baseEnv(bins);

  for (const name of ['RELEASE_SITE_HOST', 'RELEASE_SITE_USER', 'RELEASE_SITE_KEY',
    'RELEASE_SITE_DIR', 'RELEASE_SITE_PUBLIC_ORIGIN']) {
    env[name] = '';
  }

  const result = spawnSync(process.execPath, ['tools/release-publish.mts', rel.dir], {
    cwd: repository,
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /RELEASE_SITE_HOST/);
  await assert.rejects(fs.readFile(bins.sshLog), (error) => {
    return error.code === 'ENOENT';
  });
});

test('RP-3: битый архив — отказ до любой команды', async (t) => {
  const rel = await release(t, true);
  const bins = await stubBins(t);
  const env = baseEnv(bins, { RELEASE_SIGNING_PUBLIC_KEY_FILE: rel.pubFile });

  const result = spawnSync(process.execPath, ['tools/release-publish.mts', rel.dir], {
    cwd: repository,
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 3);
  await assert.rejects(fs.readFile(bins.sshLog), (error) => {
    return error.code === 'ENOENT';
  });
});

test('RP-4: отказ зеркала — предупреждение, публикация успешна', async (t) => {
  const rel = await release(t);
  const bins = await stubBins(t);
  const env = baseEnv(bins, {
    RELEASE_SIGNING_PUBLIC_KEY_FILE: rel.pubFile,
    RELEASE_SITE_MIRROR_HOST: 'mirror.example',
    RELEASE_SITE_MIRROR_USER: 'user',
    RELEASE_SITE_MIRROR_KEY: '/tmp/key',
    RELEASE_SITE_MIRROR_DIR: '/srv/grigdesk',
    RELEASE_SITE_MIRROR_PUBLIC_ORIGIN: 'https://grigdesk.ru',
  });

  const result = spawnSync(process.execPath, ['tools/release-publish.mts', rel.dir], {
    cwd: repository,
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /зеркал/i);
  const sshCalls = await fs.readFile(bins.sshLog, 'utf8');

  assert.match(sshCalls, /user@site\.example/, 'основной хост опубликован');
});

test('RP-5: отказ основного хоста — код 4, явная ошибка', async (t) => {
  const rel = await release(t);
  const bins = await stubBins(t, 'site.example');
  const env = baseEnv(bins, { RELEASE_SIGNING_PUBLIC_KEY_FILE: rel.pubFile });

  const result = spawnSync(process.execPath, ['tools/release-publish.mts', rel.dir], {
    cwd: repository,
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /site\.example/);
});

test('RP-6: несогласованная опись канала и чужая подпись отвергаются до SSH', async (t) => {
  for (const field of ['bundleSha256', 'signature']) {
    const rel = await release(t);
    const bins = await stubBins(t);
    const channelPath = path.join(rel.dir, 'channel.json');
    const channel = JSON.parse(await fs.readFile(channelPath, 'utf8'));

    channel.latest[field] = field === 'signature'
      ? Buffer.alloc(64, 8).toString('base64') : '1'.repeat(64);
    await fs.writeFile(channelPath, JSON.stringify(channel));

    const result = spawnSync(process.execPath, ['tools/release-publish.mts', rel.dir], {
      cwd: repository,
      env: baseEnv(bins, { RELEASE_SIGNING_PUBLIC_KEY_FILE: rel.pubFile }),
      encoding: 'utf8',
    });

    assert.equal(result.status, 3);
    await assert.rejects(fs.readFile(bins.sshLog), { code: 'ENOENT' });
  }
});

test('RP-7: dry-run не меняет канал и не отправляет выпуск', async (t) => {
  const rel = await release(t);
  const bins = await stubBins(t);
  const channelPath = path.join(rel.dir, 'channel.json');
  const before = await fs.readFile(channelPath, 'utf8');
  const result = spawnSync(process.execPath, ['tools/release-publish.mts', rel.dir, '--dry-run'], {
    cwd: repository,
    env: baseEnv(bins, { RELEASE_SIGNING_PUBLIC_KEY_FILE: rel.pubFile }),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(channelPath, 'utf8'), before);
  await assert.rejects(fs.readFile(bins.sshLog), { code: 'ENOENT' });
});
