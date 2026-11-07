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
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  downloadChecked,
  gitBlobSha1Of,
  installQwenFiles,
  installVoiceFiles,
  sha256Of,
} from '../../server/src/lib/showcase/voice/download.ts';
import { createVoiceInstaller } from '../../server/src/lib/showcase/voice/install.ts';
import { PIPER_VOICES } from '../../server/src/lib/showcase/voice/piperCatalog.ts';
import { QWEN_VOICES } from '../../server/src/lib/showcase/voice/qwenCatalog.ts';
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
  const installed = [];
  const installer = createVoiceInstaller({
    voiceDir: path.join(root, 'voice'),
    broadcast: (name, data) => events.push([name, data]),
    workerScript: await fakeWorker(root, SUCCESS_WORKER),
    voices: TWO_VOICES,
    onInstalled: (voiceId) => installed.push(voiceId),
  });

  await installer.start('irina');

  const status = await settle(installer);

  assert.equal(status.job.state, 'succeeded');
  assert.ok(
    events.some(([name, data]) => name === 'showcase-voice' && data.state === 'running'),
    'ход установки виден событием, а не только опросом',
  );
  assert.deepEqual(installed, ['irina'], 'по удачной установке движки забывают кэш готовности');
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
  const qwen = status.available.find((item) => item.engineId === 'qwen');

  assert.ok(silero, 'Silero ставится кнопкой наравне с Piper');
  assert.ok(silero.voices.length >= 5, 'дикторы модели названы до нажатия');
  assert.ok(silero.byteSize > SILERO_VOICES[0].fileBytes, 'в размер входит и движок, не только модель');
  assert.deepEqual(piper.voices, ['Ирина']);
  assert.equal(silero.installed, false);

  assert.ok(qwen, 'Qwen3-TTS ставится той же кнопкой');
  assert.equal(status.available[0].engineId, 'qwen', 'Qwen первым: его ставят ради качества');
  assert.ok(qwen.voices.length >= 9, 'дикторы модели названы до нажатия');
  assert.ok(qwen.byteSize > QWEN_VOICES[0].modelBytes, 'в размер входит и движок с CUDA');
  assert.match(qwen.license, /Apache/);
  assert.equal(qwen.installed, false);
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

test('установка Qwen идёт в своё окружение со своим составом и каталогом', async (t) => {
  const root = await workspace(t);
  const installer = installerAt(
    root,
    await fakeWorker(root, REPORTING_WORKER),
    [],
    [...QWEN_VOICES, ...SILERO_VOICES, ...PIPER_VOICES],
  );

  await installer.start(QWEN_VOICES[0].id);
  await settle(installer);

  const seen = JSON.parse(await readFile(path.join(root, 'voice', 'seen-task.json'), 'utf8'));

  assert.equal(seen.voice.engineId, 'qwen');
  assert.match(seen.venvDir, /qwen-venv$/);
  assert.match(seen.voicesDir, /voice\/qwen$/);
  assert.match(seen.requirementsFile, /requirements-showcase-qwen\.txt$/);
  assert.equal((await installer.status()).job.engineId, 'qwen');
});

/**
 * Стенд-источник модели Qwen: маленькие файлы по тем же относительным путям, что
 * и в репозитории, с честно посчитанными sha256 и git blob sha1. Раскладка по
 * подкаталогам и правила сверки не зависят от размера файлов.
 */
async function qwenSource(t, root) {
  const source = path.join(root, 'source');
  const bodies = {
    'config.json': '{"model_type": "qwen3_tts"}',
    'model.safetensors': 'веса модели',
    'speech_tokenizer/config.json': '{"model_type": "tokenizer"}',
    'speech_tokenizer/model.safetensors': 'веса токенизатора',
  };
  const files = [];

  for (const [relative, body] of Object.entries(bodies)) {
    const file = path.join(source, relative);

    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body, 'utf8');

    // LFS-файлы сверяются по sha256, остальные — по git blob sha1, как в репозитории.
    files.push(relative.endsWith('.safetensors')
      ? { path: relative, bytes: Buffer.byteLength(body), sha256: await sha256Of(file) }
      : { path: relative, bytes: Buffer.byteLength(body), gitBlobSha1: await gitBlobSha1Of(file) });
  }

  const requests = [];
  const server = http.createServer(async (request, response) => {
    requests.push(request.url);

    const body = await readFile(path.join(source, decodeURIComponent(request.url.slice(1))))
      .catch(() => null);

    if (!body) {
      response.writeHead(404);
      response.end();

      return;
    }

    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(body.byteLength),
    });
    response.end(body);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  return {
    requests,
    pack: {
      ...QWEN_VOICES[0],
      baseUrl: `http://127.0.0.1:${server.address().port}/`,
      files,
      modelBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    },
  };
}

test('git blob sha1 считается как в git: с префиксом «blob <байт>»', async (t) => {
  const root = await workspace(t);
  const file = path.join(root, 'blob.txt');

  await writeFile(file, 'hello\n', 'utf8');

  // Известная сумма: `printf 'hello\n' | git hash-object --stdin`.
  assert.equal(await gitBlobSha1Of(file), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('модель Qwen раскладывается по подкаталогам и второй раз не качается', async (t) => {
  const root = await workspace(t);
  const { pack, requests } = await qwenSource(t, root);
  const modelsDir = path.join(root, 'qwen');
  const steps = [];
  const modelDir = await installQwenFiles(pack, modelsDir, (step, label) => {
    steps.push(label);
  });

  assert.equal(modelDir, path.join(modelsDir, pack.id));
  assert.equal(
    await readFile(path.join(modelDir, 'speech_tokenizer', 'model.safetensors'), 'utf8'),
    'веса токенизатора',
    'подкаталог токенизатора создан и заполнен',
  );
  assert.equal(requests.length, 4, 'каждый файл скачан по одному разу');
  assert.ok(steps.some((label) => /скачиваю model\.safetensors/.test(label)));

  const again = [];

  await installQwenFiles(pack, modelsDir, (step, label) => {
    again.push(label);
  });

  assert.equal(requests.length, 4, 'файлы с верными суммами повторно не качаются');
  assert.ok(again.every((label) => /уже на месте/.test(label)));
  assert.deepEqual(
    (await readdir(modelsDir)).filter((name) => name.startsWith('.staging')),
    [],
    'промежуточный каталог убран',
  );
});

test('подменённый файл модели Qwen останавливает установку и называет обе суммы', async (t) => {
  const root = await workspace(t);
  const { pack } = await qwenSource(t, root);
  const wrongSha = { ...pack, files: pack.files.map((file) => (file.sha256
    ? { ...file, sha256: 'a'.repeat(64) }
    : file)) };

  await assert.rejects(
    () => installQwenFiles(wrongSha, path.join(root, 'qwen-sha'), () => {}),
    (error) => /sha256 файла model\.safetensors не совпал: ожидалось a{64}, получено [0-9a-f]{64}/.test(
      error.message,
    ),
  );

  const wrongBlob = { ...pack, files: pack.files.map((file) => (file.gitBlobSha1
    ? { ...file, gitBlobSha1: 'b'.repeat(40) }
    : file)) };

  await assert.rejects(
    () => installQwenFiles(wrongBlob, path.join(root, 'qwen-blob'), () => {}),
    /git blob sha1 файла config\.json не совпал: ожидалось b{40}, получено [0-9a-f]{40}/,
  );

  await assert.rejects(
    () => readFile(path.join(root, 'qwen-blob', pack.id, 'config.json')),
    'файл с неверной суммой в каталог модели не попадает',
  );
});

test('заявленный размер файла Qwen тоже проверяется', async (t) => {
  const root = await workspace(t);
  const { pack } = await qwenSource(t, root);
  const wrong = { ...pack, files: pack.files.map((file, index) => (index === 0
    ? { ...file, bytes: file.bytes + 1 }
    : file)) };

  await assert.rejects(
    () => installQwenFiles(wrong, path.join(root, 'qwen'), () => {}),
    /размер файла config\.json не совпал/,
  );
});

/**
 * Капризный источник: первые `cuts` ответов на большой файл обрываются на середине,
 * дальше он честно отдаёт остаток по Range (или весь файл, если Range не понимает).
 * Так проверяется докачка, а не удача сети.
 */
async function flakySource(t, { cuts = 1, ranges = true } = {}) {
  const body = Buffer.from('веса модели '.repeat(4000), 'utf8');
  const requests = [];
  let failures = 0;
  const server = http.createServer((request, response) => {
    requests.push(request.headers.range ?? '');

    if (failures < cuts) {
      failures += 1;
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(body.byteLength),
      });
      // Обрыв — после того, как половина ушла в сокет: иначе клиент не получит
      // ни байта, и докачивать будет нечего.
      response.write(body.subarray(0, Math.floor(body.byteLength / 2)), () => {
        setTimeout(() => response.destroy(), 20);
      });

      return;
    }

    const match = /^bytes=(\d+)-$/.exec(request.headers.range ?? '');

    if (match && ranges) {
      const from = Number(match[1]);

      response.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-length': String(body.byteLength - from),
        'content-range': `bytes ${from}-${body.byteLength - 1}/${body.byteLength}`,
      });
      response.end(body.subarray(from));

      return;
    }

    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(body.byteLength),
    });
    response.end(body);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  return {
    requests,
    source: {
      url: `http://127.0.0.1:${server.address().port}/model.safetensors`,
      bytes: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex'),
    },
  };
}

test('обрыв загрузки докачивается по Range с места обрыва, а не с нуля', async (t) => {
  const root = await workspace(t);
  const { requests, source } = await flakySource(t);
  const target = path.join(root, 'model.safetensors');
  const steps = [];

  await downloadChecked(source, target, 'model.safetensors', (step, label) => {
    steps.push(label);
  }, { attempts: 3, pauseMs: 50 });

  assert.equal(await sha256Of(target), source.sha256, 'склеенный файл совпал с суммой');
  assert.equal(requests.length, 2);
  assert.match(requests[1], /^bytes=\d+-$/, 'второй запрос просит остаток');
  assert.ok(steps.some((label) => /повтор 1 из/.test(label)), 'повтор назван в журнале');
  assert.ok(steps.some((label) => /продолжаю с \d+%/.test(label)));
  await assert.rejects(() => readFile(`${target}.part`), 'кусок переименован в целевой файл');
});

test('источник без Range после обрыва отдаёт файл заново — и это тоже принимается', async (t) => {
  const root = await workspace(t);
  const { requests, source } = await flakySource(t, { ranges: false });
  const target = path.join(root, 'model.safetensors');

  await downloadChecked(source, target, 'model.safetensors', () => {}, { attempts: 3, pauseMs: 50 });

  assert.equal(await sha256Of(target), source.sha256);
  assert.equal(requests.length, 2);
});

test('опечатка в сумме каталога чинится без повторной загрузки, а испорченный файл качается заново', async (t) => {
  const root = await workspace(t);
  const { requests, source } = await flakySource(t, { cuts: 0 });
  const target = path.join(root, 'model.safetensors');
  const wrong = { ...source, sha256: 'a'.repeat(64) };

  await assert.rejects(
    () => downloadChecked(wrong, target, 'model.safetensors', () => {}),
    /ожидалось a{64}, получено [0-9a-f]{64}/,
  );
  assert.equal(requests.length, 1);
  assert.equal((await readFile(`${target}.part`)).byteLength, source.bytes, 'скачанное сохранено');

  // Сумма исправлена в каталоге: файл принимается без единого запроса к источнику.
  await downloadChecked(source, target, 'model.safetensors', () => {});
  assert.equal(requests.length, 1);
  assert.equal(await sha256Of(target), source.sha256);

  // Та же неверная сумма второй раз подряд означает испорченный файл: он качается заново.
  const again = path.join(root, 'again.safetensors');

  await assert.rejects(() => downloadChecked(wrong, again, 'again', () => {}), /ожидалось a{64}/);
  await assert.rejects(() => downloadChecked(wrong, again, 'again', () => {}), /ожидалось a{64}/);
  assert.equal(requests.length, 3, 'после повторного несовпадения файл скачан заново');
});

test('окончательный отказ источника не повторяется без конца', async (t) => {
  const root = await workspace(t);
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(404);
    response.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await assert.rejects(
    () => downloadChecked(
      { url: `http://127.0.0.1:${server.address().port}/x`, bytes: 10, sha256: 'a'.repeat(64) },
      path.join(root, 'x'),
      'x',
      () => {},
    ),
    /источник ответил 404/,
  );
  assert.equal(requests.length, 1, '404 — не повод для повторов');
});

test('недоступный основной источник заменяется зеркалом, а суммы сверяются и у него', async (t) => {
  const root = await workspace(t);
  const { pack, requests } = await qwenSource(t, root);
  const deadPort = await new Promise((resolve) => {
    const probe = http.createServer();

    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();

      probe.close(() => resolve(port));
    });
  });
  const mirrored = {
    ...pack,
    // Основной адрес — закрытый порт: соединение отказывает сразу, без ожидания.
    baseUrl: `http://127.0.0.1:${deadPort}/`,
    mirrorUrls: [pack.baseUrl],
  };
  const steps = [];
  const fast = { attempts: 2, pauseMs: 50 };
  const modelDir = await installQwenFiles(mirrored, path.join(root, 'qwen'), (step, label) => {
    steps.push(label);
  }, fast);

  assert.equal(
    await readFile(path.join(modelDir, 'speech_tokenizer', 'model.safetensors'), 'utf8'),
    'веса токенизатора',
  );
  assert.equal(requests.length, 4, 'все файлы пришли с зеркала');
  assert.equal(
    steps.filter((label) => /пробую другой источник/.test(label)).length,
    1,
    'мёртвый источник запоминается и не опрашивается для каждого файла',
  );

  // Зеркало с подменённым содержимым останавливает установку так же, как основной.
  const tampered = {
    ...mirrored,
    files: pack.files.map((file) => (file.sha256 ? { ...file, sha256: 'c'.repeat(64) } : file)),
  };

  await assert.rejects(
    () => installQwenFiles(tampered, path.join(root, 'qwen-tampered'), () => {}, fast),
    /sha256 файла model\.safetensors не совпал/,
  );
});

test('нестабильная сеть выдерживается десятками попыток с растущей паузой', async (t) => {
  const root = await workspace(t);
  const { requests, source } = await flakySource(t, { cuts: 4 });
  const target = path.join(root, 'model.safetensors');
  const steps = [];

  await downloadChecked(source, target, 'model.safetensors', (step, label) => {
    steps.push(label);
  }, { attempts: 6, pauseMs: 10 });

  assert.equal(await sha256Of(target), source.sha256);
  assert.equal(requests.length, 5, 'четыре обрыва и один удачный остаток');
  assert.equal(steps.filter((label) => /повтор \d из 5/.test(label)).length, 4);
});
