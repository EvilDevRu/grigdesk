import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { sign } from 'node:crypto';

import { canonicalJson } from '../../shared/lib/canonicalJson.ts';
import { sha256 } from '../../shared/node/hash.ts';
import { signedIndex } from '../helpers/releaseV2Fixture.mjs';
import { renderBootstrap, readBootstrap } from '../../tools/installBootstrap.mts';
import { startPty, assertRestored } from '../cli/helpers/pty.mts';

const repository = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Фикстура собирает полный script из реального шаблона и каталогов проекта.
 * Helper заменён stub-ом, записывающим argv в $DIALOG_RECORD: сетевые проверки
 * целостности остаются настоящими, установка не выполняется.
 */
async function dialogBox(t: TestContext) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'install-dialog-'));
  const signer = signedIndex({ channel: 'release' });
  const record = path.join(temporary, 'argv');
  const helper = Buffer.from(['#!/bin/sh', 'for argument in "$@"; do',
    '  printf \'%s\\n\' "$argument" >> "$DIALOG_RECORD/argv"', 'done', 'exit 0',
    ''].join('\n'));
  const compressed = gzipSync(helper);
  const indexBytes = Buffer.from(canonicalJson({
    format: 2,
    channel: signer.identity.channel,
    publishedAt: signer.envelope.payload.publishedAt,
    latest: signer.envelope,
  }));
  const base = indexBytes.length + compressed.length;
  const template = await fs.readFile(path.join(repository, 'tools/installBootstrap.sh'), 'utf8');
  const messages = {
    ru: JSON.parse(await fs.readFile(path.join(repository,
      'shared/i18n/assets/locales/ru/installer.json'), 'utf8')),
    en: JSON.parse(await fs.readFile(path.join(repository,
      'shared/i18n/assets/locales/en/installer.json'), 'utf8')),
  };
  const script = renderBootstrap({
    format: 1,
    version: signer.identity.version,
    channel: 'release',
    origin: 'https://grigdesk.test',
    manifestDigest: signer.manifestDigest,
    indexSha256: sha256(indexBytes),
    indexSize: indexBytes.length,
    helperSha256: sha256(helper),
    helperSize: helper.length,
    compressedSha256: sha256(compressed),
    compressedSize: compressed.length,
    downloadBytes: {
      local: base + signer.envelope.payload.artifacts.desktop.size
        + signer.envelope.payload.artifacts.server.size,
      remote: base + signer.envelope.payload.artifacts.desktop.size,
      server: base + signer.envelope.payload.artifacts.server.size,
    },
  }, template, messages);
  const proof = `GrigDesk installer v1\n${sha256(Buffer.from(script, 'utf8'))}  grigdesk-install\n`
    + `${signer.manifestDigest}\n`;
  const files = path.join(temporary, 'files');

  await fs.writeFile(path.join(temporary, 'script'), script, { mode: 0o755 });
  await fs.mkdir(files, { mode: 0o700 });
  await fs.writeFile(path.join(files, 'release.json'), indexBytes, { mode: 0o644 });
  await fs.writeFile(path.join(files, 'grigdesk-maintenance.gz'), compressed);
  await fs.writeFile(path.join(files, 'grigdesk-install.sha256'), proof);
  await fs.writeFile(path.join(files, 'grigdesk-install.sig'),
    sign(null, Buffer.from(proof), signer.privateKey).toString('base64'));

  t.after(() => fs.rm(temporary, { recursive: true, force: true }));

  return {
    temporary,
    files,
    signer,
    script,
    record,
  };
}

function dialogEnvironment(box: Awaited<ReturnType<typeof dialogBox>>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: box.temporary,
    LANG: 'C.UTF-8',
    DIALOG_RECORD: box.temporary,
  } as NodeJS.ProcessEnv;
}

for (const language of ['ru', 'en'] as const) {
  test(`DIALOG-REMOTE-${language}: режим, пути и подтверждение`, async (t) => {
    const box = await dialogBox(t);
    const session = startPty(t, {
      argv: ['sh', path.join(box.temporary, 'script'), '--lang', language,
        '--source-dir', path.join(box.temporary, 'files')],
      env: dialogEnvironment(box),
      cwd: box.temporary,
    });

    await session.wait(language === 'ru' ? /Режим:/u : /Mode:/u, 8000);
    session.write('2\r');
    await session.wait(language === 'ru' ? /Папка программы/u : /Program folder/u, 8000);
    session.write(path.join(box.temporary, 'program') + '\r');
    await session.wait(language === 'ru' ? /Папка данных/u : /Data folder/u, 8000);
    session.write(path.join(box.temporary, 'data') + '\r');
    await session.wait(language === 'ru' ? /Продолжить/u : /Continue/u, 8000);
    session.write('y\r');

    const result = await session.done;

    assert.equal(result.code, 0, session.output());

    const argv = (await fs.readFile(box.record, 'utf8')).split('\n').filter(Boolean);

    assert.equal(argv[0], 'install-online');
    assert.equal(argv[argv.indexOf('--mode') + 1], 'remote');
    assert.equal(argv[argv.indexOf('--root') + 1], path.join(box.temporary, 'program'));
    assert.equal(argv[argv.indexOf('--data-home') + 1], path.join(box.temporary, 'data'));
    assert.ok(!argv.includes('--yes'));

    if (process.env.GRIGDESK_ARTIFACTS_DIR) {
      await fs.writeFile(path.join(process.env.GRIGDESK_ARTIFACTS_DIR,
        `installer-dialog-${language}.txt`), session.output());
    }
  });
}

test('DIALOG-CANCEL: явный отказ завершает код 0 без эффектов', async (t) => {
  const box = await dialogBox(t);
  const session = startPty(t, {
    argv: ['sh', path.join(box.temporary, 'script'), '--lang', 'ru',
      '--source-dir', path.join(box.temporary, 'files')],
    env: dialogEnvironment(box),
    cwd: box.temporary,
  });

  await session.wait(/Режим:/u, 8000);
  session.write('2\r');
  await session.wait(/Папка программы/u, 8000);
  session.write('\r');
  await session.wait(/Папка данных/u, 8000);
  session.write('\r');
  await session.wait(/Продолжить/u, 8000);
  session.write('n\r');

  const result = await session.done;

  assert.equal(result.code, 0);
  await assert.rejects(fs.stat(box.record), { code: 'ENOENT' });
});

test('DIALOG-EOF: закрытие ввода даёт код 2 без эффектов', async (t) => {
  const box = await dialogBox(t);
  const session = startPty(t, {
    argv: ['sh', path.join(box.temporary, 'script'), '--lang', 'ru'],
    env: dialogEnvironment(box),
    cwd: box.temporary,
  });

  await session.wait(/Режим:/u, 8000);
  session.write('\x04');

  const result = await session.done;

  assert.equal(result.code, 2);
  await assert.rejects(fs.stat(box.record), { code: 'ENOENT' });
});

test('DIALOG-BAD-MODE: неизвестный номер режима даёт код 2', async (t) => {
  const box = await dialogBox(t);
  const session = startPty(t, {
    argv: ['sh', path.join(box.temporary, 'script'), '--lang', 'ru'],
    env: dialogEnvironment(box),
    cwd: box.temporary,
  });

  await session.wait(/Режим:/u, 8000);
  session.write('9\r');

  const result = await session.done;

  assert.equal(result.code, 2);
});

test('DIALOG-CTRL-C: прерывание даёт 130 и восстанавливает терминал', async (t) => {
  const box = await dialogBox(t);
  const session = startPty(t, {
    argv: ['sh', path.join(box.temporary, 'script'), '--lang', 'ru'],
    env: dialogEnvironment(box),
    cwd: box.temporary,
  });

  await session.wait(/Режим:/u, 8000);
  session.write('\x03');

  const result = await session.done;

  assert.equal(result.code, 130);
  assertRestored(result, session.output());
});

function completed(child: import('node:child_process').ChildProcess) {
  return new Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({
      code: code ?? 1,
      stdout,
      stderr,
    }));
  });
}

test('DIALOG-FLAGS: все шесть публичных флагов путей проходят в helper без изменения', async (t) => {
  const box = await dialogBox(t);
  const root = path.join(box.temporary, 'program');
  const data = path.join(box.temporary, 'data');
  const user = path.join(box.temporary, 'user');
  const bin = path.join(box.temporary, 'bin');
  const apps = path.join(box.temporary, 'apps');
  const unit = path.join(box.temporary, 'units');

  const result = await completed(spawn('sh', [path.join(box.temporary, 'script'),
    '--yes', '--mode', 'remote', '--root', root, '--data-home', data, '--user-data', user,
    '--bin-dir', bin, '--applications-dir', apps, '--unit-dir', unit,
    '--source-dir', path.join(box.temporary, 'files')],
  { env: dialogEnvironment(box), cwd: box.temporary }));

  assert.equal(result.code, 0, result.stderr);

  const argv = (await fs.readFile(box.record, 'utf8')).split('\n').filter(Boolean);

  assert.equal(argv[argv.indexOf('--root') + 1], root);
  assert.equal(argv[argv.indexOf('--data-home') + 1], data);
  assert.equal(argv[argv.indexOf('--user-data') + 1], user);
  assert.equal(argv[argv.indexOf('--bin-dir') + 1], bin);
  assert.equal(argv[argv.indexOf('--applications-dir') + 1], apps);
  assert.equal(argv[argv.indexOf('--unit-dir') + 1], unit);
});

test('DIALOG-NO-TTY: без терминала и без --yes — код 2 до сети', async (t) => {
  const box = await dialogBox(t);

  const result = await completed(spawn('sh', [path.join(box.temporary, 'script')],
    { env: dialogEnvironment(box), cwd: box.temporary }));

  assert.equal(result.code, 2);
  assert.match(result.stderr, /terminal|--yes|Dialog/u);
  await assert.rejects(fs.stat(box.record), { code: 'ENOENT' });
});

test('DIALOG-UNSUPPORTED-OS: чужая платформа отклоняется до загрузки helper', async (t) => {
  const box = await dialogBox(t);
  const stub = path.join(box.temporary, 'stub-bin');

  await fs.mkdir(stub, { mode: 0o700 });
  await fs.writeFile(path.join(stub, 'uname'), '#!/bin/sh\nprintf \'Darwin\\n\'\n',
    { mode: 0o700 });

  const result = await completed(spawn('sh', [path.join(box.temporary, 'script'),
    '--yes', '--mode', 'server', '--source-dir', path.join(box.temporary, 'files')],
  { env: { ...dialogEnvironment(box), PATH: `${stub}:${process.env.PATH}` },
    cwd: box.temporary }));

  assert.equal(result.code, 2);
  await assert.rejects(fs.stat(box.record), { code: 'ENOENT' });
});

test('DIALOG-TAMPER: повреждённый helper.gz отвергается до запуска helper', async (t) => {
  const box = await dialogBox(t);
  const file = path.join(box.temporary, 'files', 'grigdesk-maintenance.gz');
  const bytes = await fs.readFile(file);

  bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 0xff, bytes.length - 1);
  await fs.writeFile(file, bytes);

  const result = await completed(spawn('sh', [path.join(box.temporary, 'script'),
    '--yes', '--mode', 'server', '--source-dir', path.join(box.temporary, 'files')],
  { env: dialogEnvironment(box), cwd: box.temporary }));

  assert.equal(result.code, 2);
  await assert.rejects(fs.stat(box.record), { code: 'ENOENT' });
});
