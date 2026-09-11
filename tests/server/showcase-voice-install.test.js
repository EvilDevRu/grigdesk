// Установка локального голоса: скачивание из сети и жизненный цикл задания.
//
// Проверяется то, из-за чего такая кнопка обычно и вредит: пришёл не тот файл,
// «установлено» при неработающем синтезе, два процесса в один venv, и вечное
// «идёт» после смерти исполнителя.
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { installVoiceFiles, sha256Of } from '../../server/src/lib/showcase/voice/download.ts';
import { createVoiceInstaller } from '../../server/src/lib/showcase/voice/install.ts';
import { PIPER_VOICES } from '../../server/src/lib/showcase/voice/piperCatalog.ts';
import { SILERO_VOICES } from '../../server/src/lib/showcase/voice/sileroCatalog.ts';

const run = promisify(execFile);

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-voice-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

/**
 * Стенд-источник голоса: отдаёт заранее собранный архив. Настоящий адрес в тестах
 * не трогается — проверяется поведение раздела, а не доступность чужого сервера.
 */
async function startSource(t, archive) {
  const body = await readFile(archive);
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/gzip' });
    response.end(body);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  return `http://127.0.0.1:${server.address().port}/voice.tar.gz`;
}

/**
 * Архив голоса нужного вида: модель и описание с известными суммами. Настоящая
 * модель весит 63 МБ, и проверять на ней правила раскладки незачем.
 */
async function makeArchive(root, { modelBody = 'модель голоса', configBody = '{}' } = {}) {
  const source = path.join(root, 'source');

  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'voice.onnx'), modelBody, 'utf8');
  await writeFile(path.join(source, 'voice.onnx.json'), configBody, 'utf8');

  const archive = path.join(root, 'voice.tar.gz');

  await run('tar', ['-czf', archive, '-C', source, 'voice.onnx', 'voice.onnx.json']);

  return {
    archive,
    modelSha256: await sha256Of(path.join(source, 'voice.onnx')),
    configSha256: await sha256Of(path.join(source, 'voice.onnx.json')),
    archiveSha256: await sha256Of(archive),
    archiveBytes: (await readFile(archive)).byteLength,
  };
}

function packageOf(url, facts) {
  return {
    id: 'proba',
    name: 'Проба',
    language: 'ru',
    timbre: 'женский',
    url,
    archiveSha256: facts.archiveSha256,
    archiveBytes: facts.archiveBytes,
    modelName: 'voice.onnx',
    modelSha256: facts.modelSha256,
    configName: 'voice.onnx.json',
    configSha256: facts.configSha256,
    sampleRate: 22_050,
    license: 'проверочная',
  };
}

test('каталог голосов закрепляет адрес, размер и суммы', () => {
  assert.ok(PIPER_VOICES.length > 0, 'без голосов кнопке нечего ставить');

  for (const item of PIPER_VOICES) {
    assert.match(item.url, /^https:\/\//, 'голос качается только по https');
    assert.match(item.archiveSha256, /^[a-f0-9]{64}$/);
    assert.match(item.modelSha256, /^[a-f0-9]{64}$/);
    assert.match(item.configSha256, /^[a-f0-9]{64}$/);
    assert.ok(item.archiveBytes > 0, 'размер называется до нажатия');
  }
});

test('скачанный голос раскладывается по каталогу и не качается повторно', async (t) => {
  const root = await workspace(t);
  const facts = await makeArchive(root);
  const url = await startSource(t, facts.archive);
  const voicesDir = path.join(root, 'voices');
  const steps = [];
  const pack = packageOf(url, facts);
  const voiceDir = await installVoiceFiles(pack, voicesDir, (step, label) => {
    steps.push([step, label]);
  });

  assert.equal(await sha256Of(path.join(voiceDir, 'voice.onnx')), facts.modelSha256);
  assert.ok(steps.some(([, label]) => /скачиваю/.test(label)));

  const second = [];

  await installVoiceFiles(pack, voicesDir, (step, label) => {
    second.push([step, label]);
  });

  assert.ok(
    second.some(([, label]) => /уже на месте/.test(label)),
    'уже скачанный голос повторной загрузки не стоит',
  );
  assert.ok(!second.some(([, label]) => /скачиваю/.test(label)));
});

test('подменённый файл не становится голосом', async (t) => {
  const root = await workspace(t);
  const facts = await makeArchive(root);
  const url = await startSource(t, facts.archive);
  const voicesDir = path.join(root, 'voices');
  const wrong = {
    ...packageOf(url, facts),
    archiveSha256: createHash('sha256').update('другой файл').digest('hex'),
  };

  await assert.rejects(
    () => installVoiceFiles(wrong, voicesDir, () => {}),
    /sha256 скачанного голоса не совпал/,
  );

  await assert.rejects(
    () => readFile(path.join(voicesDir, 'proba', 'voice.onnx')),
    'каталог голоса при несовпадении не создаётся',
  );
});

test('заявленный размер тоже проверяется', async (t) => {
  const root = await workspace(t);
  const facts = await makeArchive(root);
  const url = await startSource(t, facts.archive);
  const wrong = { ...packageOf(url, facts), archiveBytes: facts.archiveBytes + 100 };

  await assert.rejects(
    () => installVoiceFiles(wrong, path.join(root, 'voices'), () => {}),
    /размер голоса не совпал/,
  );
});

/**
 * Поддельный исполнитель: пишет журнал и итог теми же файлами, что и настоящий.
 * Он нужен, чтобы проверить жизненный цикл установки, не скачивая движок.
 */
async function fakeWorker(root, body) {
  const file = path.join(root, 'fake-worker.mjs');

  await writeFile(file, body, 'utf8');

  return { file, marker: 'fake-worker' };
}

// Два голоса нужны там, где правило про них и написано: пока установка идёт,
// второй голос начинать нельзя. В закреплённом каталоге голос один, и проверить
// это правило на нём было бы самообманом.
const TWO_VOICES = [
  { ...PIPER_VOICES[0] },
  { ...PIPER_VOICES[0], id: 'второй', name: 'Второй' },
];

function installerAt(root, workerScript, events = [], voices = TWO_VOICES) {
  return createVoiceInstaller({
    voiceDir: path.join(root, 'voice'),
    broadcast: (name, data) => events.push([name, data]),
    workerScript,
    voices,
  });
}

const SUCCESS_WORKER = `
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const task = JSON.parse(await readFile(process.argv[2], 'utf8'));

await appendFile(
  path.join(task.workDir, 'progress.jsonl'),
  JSON.stringify({ attemptId: task.attemptId, sequence: 1, state: 'packages', label: 'ставлю движок' }) + '\\n',
  'utf8',
);
await writeFile(
  path.join(task.workDir, 'result.json'),
  JSON.stringify({ attemptId: task.attemptId, state: 'succeeded' }),
  'utf8',
);
`;

const HANGING_WORKER = `
await new Promise((resolve) => { setTimeout(resolve, 60_000); });
`;

async function settle(installer, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    await installer.poll();

    const status = await installer.status();

    if (status.job && status.job.state !== 'running') {
      return status;
    }

    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }

  throw new Error('установка не завершилась за отведённое время');
}

test('удачная установка доходит до состояния «готово» и сообщает шаги', async (t) => {
  const root = await workspace(t);
  const events = [];
  const installer = installerAt(root, await fakeWorker(root, SUCCESS_WORKER), events);

  await installer.start('irina');

  const status = await settle(installer);

  assert.equal(status.job.state, 'succeeded');
  assert.ok(
    events.some(([name, data]) => name === 'showcase-voice' && data.state === 'running'),
    'ход установки виден событием, а не только опросом',
  );
});

test('повторное нажатие не заводит вторую установку', async (t) => {
  const root = await workspace(t);
  const installer = installerAt(root, await fakeWorker(root, HANGING_WORKER));
  const first = await installer.start('irina');
  const second = await installer.start('irina');

  assert.equal(second.job.id, first.job.id, 'два pip в один venv портят его состав');

  await installer.cancel();
});

test('во время установки другой голос не начинается', async (t) => {
  const root = await workspace(t);
  const installer = installerAt(root, await fakeWorker(root, HANGING_WORKER));

  await installer.start('irina');
  await assert.rejects(
    () => installer.start('второй'),
    (error) => error.code === 'voice_install_busy' && error.status === 409,
  );

  const status = await installer.status();

  assert.equal(status.job.voiceId, 'irina', 'идущая установка осталась прежней');

  await installer.cancel();
});

test('отмена останавливает установку и говорит об этом', async (t) => {
  const root = await workspace(t);
  const installer = installerAt(root, await fakeWorker(root, HANGING_WORKER));

  await installer.start('irina');

  const status = await installer.cancel();

  assert.equal(status.job.state, 'cancelled');
});

test('исчезнувший исполнитель даёт «оборвалась», а не вечное «идёт»', async (t) => {
  const root = await workspace(t);
  const installer = installerAt(root, await fakeWorker(root, 'process.exit(0);'));

  await installer.start('irina');

  const status = await settle(installer);

  assert.equal(status.job.state, 'interrupted');
  assert.match(status.job.error, /повторите/);
});

test('неизвестный голос отвергается до запуска исполнителя', async (t) => {
  const root = await workspace(t);
  const installer = installerAt(root, await fakeWorker(root, SUCCESS_WORKER));

  await assert.rejects(
    () => installer.start('чужой-голос'),
    (error) => error.code === 'unknown_voice' && error.status === 400,
  );
});

// Исполнитель, который только показывает, ЧТО ему передали: окружение, состав и
// каталог голосов — по ним видно, что второй движок не ставится в venv первого.
const REPORTING_WORKER = `
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const task = JSON.parse(await readFile(process.argv[2], 'utf8'));

await writeFile(path.join(path.dirname(task.venvDir), 'seen-task.json'), JSON.stringify(task), 'utf8');
await writeFile(
  path.join(task.workDir, 'result.json'),
  JSON.stringify({ attemptId: task.attemptId, state: 'succeeded' }),
  'utf8',
);
`;

test('каталог по умолчанию называет движок и голоса каждого пакета', async (t) => {
  const root = await workspace(t);
  const installer = createVoiceInstaller({
    voiceDir: path.join(root, 'voice'),
    broadcast: () => {},
  });
  const status = await installer.status();
  const silero = status.available.find((item) => item.engineId === 'silero');
  const piper = status.available.find((item) => item.engineId === 'piper');

  assert.ok(silero, 'Silero ставится кнопкой наравне с Piper');
  assert.ok(silero.voices.length >= 5, 'дикторы модели названы до нажатия');
  assert.ok(silero.byteSize > SILERO_VOICES[0].fileBytes, 'в размер входит и движок, не только модель');
  assert.deepEqual(piper.voices, ['Ирина']);
  assert.equal(silero.installed, false);
});

test('установка Silero идёт в своё окружение со своим составом', async (t) => {
  const root = await workspace(t);
  const installer = installerAt(
    root,
    await fakeWorker(root, REPORTING_WORKER),
    [],
    [...SILERO_VOICES, ...PIPER_VOICES],
  );

  await installer.start(SILERO_VOICES[0].id);
  await settle(installer);

  const seen = JSON.parse(await readFile(path.join(root, 'voice', 'seen-task.json'), 'utf8'));

  assert.equal(seen.voice.engineId, 'silero');
  assert.match(seen.venvDir, /silero-venv$/);
  assert.match(seen.voicesDir, /voice\/silero$/);
  assert.match(seen.requirementsFile, /requirements-showcase-silero\.txt$/);

  const status = await installer.status();

  assert.equal(status.job.engineId, 'silero');
});
