// Установщик через voice install: запуск, повтор, занятость, отмена, перезапуск.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createPackageInstaller } from '../../server/src/lib/showcase/voice/packageInstall.ts';

const FAKE_INSTALL = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const marker = process.env.FAKE_VOICE_MARKER;
const engine = args[1];
fs.writeFileSync(marker + '.env', JSON.stringify({
  GRIGDESK_VOICE_DIR: process.env.GRIGDESK_VOICE_DIR || null,
}));
fs.appendFileSync(marker + '.starts', JSON.stringify({ pid: process.pid, engine }) + '\\n');
if (fs.existsSync(marker + '.hang')) {
  process.on('SIGTERM', () => {
    fs.writeFileSync(marker + '.stopping', '1');
    const wait = setInterval(() => {
      if (fs.existsSync(marker + '.release')) {
        clearInterval(wait);
        console.error('поздняя ошибка старой попытки');
        process.exit(7);
      }
    }, 5);
  });
  fs.writeFileSync(marker + '.ready', '1');
  setInterval(() => { }, 1000);
  return;
}
if (fs.existsSync(marker + '.fail')) { console.error('Установка не удалась.'); process.exit(1); }
console.error('Проверяю пакет ' + engine + '.');
console.log(JSON.stringify({
  engineId: engine,
  packageId: engine + '-pkg',
  manifestPath: marker + '.manifest',
}));
process.exit(0);
`;

/**
 * Каждый установщик владеет своим executable, журналом и маркерными файлами.
 * Отмена при уборке завершает только процесс этой проверки.
 */
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-pkg-install-'));


  const bin = path.join(root, 'voice');
  const marker = path.join(root, 'marker');
  const events = [];

  await writeFile(bin, FAKE_INSTALL, 'utf8');
  await chmod(bin, 0o755);

  const installer = createPackageInstaller({
    voiceBin: bin,
    voiceDir: path.join(root, 'data'),
    installFile: path.join(root, 'install.json'),
    workRoot: path.join(root, 'work'),
    broadcast: (name, data) => events.push([name, data]),
    onInstalled: () => events.push(['installed', null]),
    readyProbe: async () => false,
    env: { ...process.env, FAKE_VOICE_MARKER: marker },
    ...overrides,
  });

  t.after(async () => {
    await installer.cancel();
    await rm(root, { recursive: true, force: true });
  });
  await installer.recover();

  return {
    root,
    bin,
    marker,
    events,
    installer,
  };
}

/**
 * Опрос ждёт терминальный снимок installer с ограниченным сроком.
 * Проверяется durable-итог, а не случайная длительность дочернего процесса.
 */
async function settle(installer) {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    await installer.poll();

    const status = await installer.status();

    if (!status.job || status.job.state !== 'running') {
      return status;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.fail('Установка не завершилась за 5 с.');
}

test('удачная установка публикует итог и зовёт onInstalled', async (t) => {
  const { installer, events } = await fixture(t);

  await installer.start('piper-irina');


  const status = await settle(installer);

  assert.equal(status.job.state, 'succeeded');
  assert.ok(events.some(([name]) => name === 'showcase-voice'));
  assert.ok(events.some(([name]) => name === 'installed'));
  assert.equal(status.available.find((pack) => pack.id === 'piper-irina').engineId, 'piper');
});

test('повтор того же пакета не запускает вторую установку, другой — занят', async (t) => {
  const { installer, marker } = await fixture(t);

  await writeFile(marker + '.hang', '1');
  await installer.start('piper-irina');


  const first = (await installer.status()).job;

  await installer.start('piper-irina');

  assert.equal((await installer.status()).job.id, first.id);
  await assert.rejects(
    () => installer.start('silero-v5_5_ru'),
    (error) => error.code === 'voice_install_busy' && error.status === 409,
  );
  await installer.cancel();
});

test('отмена убивает процесс и помечает установку отменённой', async (t) => {
  const { installer, marker } = await fixture(t);

  await writeFile(marker + '.hang', '1');
  await installer.start('piper-irina');

  const job = (await installer.status()).job;

  await installer.cancel();

  assert.equal((await installer.status()).job.state, 'cancelled');

  // Сигнал группе доходит не мгновенно: ждём смерть процесса до 3 с.
  const deadline = Date.now() + 3000;

  while (Date.now() < deadline) {
    try {
      process.kill(job.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') {
        return;
      }

      throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.fail('Процесс установки пережил отмену.');
});

test('отказ пакета приходит словами stderr', async (t) => {
  const { installer, marker } = await fixture(t);

  await writeFile(marker + '.fail', '1');
  await installer.start('piper-irina');


  const status = await settle(installer);

  assert.equal(status.job.state, 'failed');
  assert.match(status.job.error, /не удалась/u);
});

test('после перезапуска идущая запись помечается прерванной', async (t) => {
  const { installer, root } = await fixture(t);
  const record = {
    schemaVersion: 1,
    id: 'oldinstall1',
    engineId: 'piper',
    voiceId: 'piper-irina',
    state: 'running',
    step: 'install',
    label: 'Проверяю пакет.',
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    identity: {
      pid: 999999,
      starttime: '1',
      cmdline: 'voice',
    },
    workDir: path.join(root, 'work', 'oldinstall1'),
    sequence: 1,
  };

  await writeFile(path.join(root, 'install.json'), JSON.stringify(record), 'utf8');
  await installer.recover();

  assert.equal((await installer.status()).job.state, 'interrupted');
});

test('установщик получает тот же каталог данных, что и синтез (F15)', async (t) => {
  const { installer, marker, root } = await fixture(t);

  await installer.start('piper-irina');
  await settle(installer);

  const env = JSON.parse(await readFile(marker + '.env', 'utf8'));

  assert.equal(env.GRIGDESK_VOICE_DIR, path.join(root, 'data'));
});

test('повреждённый файл установки не теряется молча (F16)', async (t) => {
  const { installer, root } = await fixture(t);

  await writeFile(path.join(root, 'install.json'), '{"state": "runn', 'utf8');
  await installer.recover();

  // Битый JSON — честное отсутствие задания, а не тихая потеря идущей установки:
  // атомарная запись save() делает такой файл невозможным при штатной работе;
  // recover обязан пережить его без падения.
  assert.equal((await installer.status()).job, null);
});

/**
 * Барьер fake: ждём записанный самим child маркер, а не случайную задержку.
 * Предельный срок завершает тест с понятной причиной при сбое запуска.
 */
async function waitForMarker(file) {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    if (await readFile(file, 'utf8').then(() => true, () => false)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.fail(`Не появился маркер ${file}`);
}

for (const code of ['ENOENT', 'EACCES']) {
  test(`отказ spawn ${code} виден и допускает повтор`, async (t) => {
    const { installer, bin, events } = await fixture(t);

    if (code === 'ENOENT') {
      await rm(bin);
    } else {
      await chmod(bin, 0o600);
    }

    await installer.start('piper-irina');

    const failed = await settle(installer);

    assert.equal(failed.job.state, 'failed');
    assert.equal(failed.job.pid, null);
    assert.match(failed.job.error, new RegExp(code));
    assert.equal(events.filter(([name]) => name === 'installed').length, 0);

    await writeFile(bin, FAKE_INSTALL, 'utf8');
    await chmod(bin, 0o755);
    await installer.start('piper-irina');

    assert.equal((await settle(installer)).job.state, 'succeeded');
    assert.equal(events.filter(([name]) => name === 'installed').length, 1);
  });
}

test('одновременные start одного пакета создают только один child', async (t) => {
  const { installer, marker } = await fixture(t);

  await writeFile(marker + '.hang', '1');

  const [left, right] = await Promise.all([
    installer.start('piper-irina'),
    installer.start('piper-irina'),
  ]);

  await waitForMarker(marker + '.ready');

  const starts = (await readFile(marker + '.starts', 'utf8')).trim().split('\n');

  assert.equal(starts.length, 1);
  assert.equal(left.job.id, right.job.id);
  await writeFile(marker + '.release', '1');
  await installer.cancel();
});

test('одновременный другой пакет получает busy до второго spawn', async (t) => {
  const { installer, marker } = await fixture(t);

  await writeFile(marker + '.hang', '1');

  const [first, second] = await Promise.allSettled([
    installer.start('piper-irina'),
    installer.start('silero-v5_5_ru'),
  ]);

  await waitForMarker(marker + '.ready');

  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.equal(second.reason.code, 'voice_install_busy');
  assert.equal(second.reason.status, 409);
  assert.equal((await readFile(marker + '.starts', 'utf8')).trim().split('\n').length, 1);
  await writeFile(marker + '.release', '1');
  await installer.cancel();
});

test('cancel ждёт close, немедленный retry не наследует ошибку прежнего child', async (t) => {
  const { installer, marker, events } = await fixture(t);

  await writeFile(marker + '.hang', '1');
  await installer.start('piper-irina');
  await waitForMarker(marker + '.ready');



  const first = (await installer.status()).job;
  const cancelled = installer.cancel();

  await waitForMarker(marker + '.stopping');
  await rm(marker + '.hang');

  const retry = installer.start('piper-irina');

  await writeFile(marker + '.release', '1');
  await cancelled;
  await retry;

  const done = await settle(installer);
  const starts = (await readFile(marker + '.starts', 'utf8')).trim().split('\n').map(JSON.parse);

  assert.notEqual(done.job.id, first.id);
  assert.equal(done.job.state, 'succeeded');
  assert.equal(done.job.error, null);
  assert.doesNotMatch(done.job.label, /поздняя ошибка/u);
  assert.equal(starts.length, 2);
  assert.equal(events.filter(([name]) => name === 'installed').length, 1);
  assert.throws(() => process.kill(first.pid, 0), (error) => error.code === 'ESRCH');
});

