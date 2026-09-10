// Исполнитель установки голоса целиком: шаги, приёмка и уборка за собой.
//
// Движок подменён исполняемым файлом, а источник голоса — локальным стендом:
// проверяется порядок и правила самого исполнителя, а не скорость чужой сети.
// Главное правило здесь одно: «установлено» обязано значить «говорит».
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { sha256Of } from '../../server/src/lib/showcase/voice/download.ts';

const run = promisify(execFile);

const WORKER = fileURLToPath(
  new URL('../../server/scripts/showcaseVoiceInstall.mts', import.meta.url),
);

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-install-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

async function archiveFixture(root) {
  const source = path.join(root, 'source');

  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'voice.onnx'), 'модель голоса', 'utf8');
  await writeFile(path.join(source, 'voice.onnx.json'), '{"sample_rate": 22050}', 'utf8');

  const archive = path.join(root, 'voice.tar.gz');

  await run('tar', ['-czf', archive, '-C', source, 'voice.onnx', 'voice.onnx.json']);

  const body = await readFile(archive);
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/gzip' });
    response.end(body);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    pack: {
      id: 'proba',
      name: 'Проба',
      language: 'ru',
      timbre: 'женский',
      url: `http://127.0.0.1:${server.address().port}/voice.tar.gz`,
      archiveSha256: await sha256Of(archive),
      archiveBytes: body.byteLength,
      modelName: 'voice.onnx',
      modelSha256: await sha256Of(path.join(source, 'voice.onnx')),
      configName: 'voice.onnx.json',
      configSha256: await sha256Of(path.join(source, 'voice.onnx.json')),
      sampleRate: 22_050,
      license: 'проверочная',
    },
  };
}

/**
 * Подменённое окружение: `pip install` отвечает успехом, а синтез печатает
 * заданные факты о файле. Так проверяются правила исполнителя, а не установка
 * настоящих колёс.
 */
async function fakeVenv(root, facts) {
  const venvDir = path.join(root, 'venv');

  await mkdir(path.join(venvDir, 'bin'), { recursive: true });

  const python = path.join(venvDir, 'bin', 'python');

  await writeFile(
    python,
    `#!/usr/bin/env bash
if [[ "$1" == '-m' ]]; then
  echo 'Successfully installed piper-tts'
  exit 0
fi
out=''
while [[ $# -gt 0 ]]; do
  if [[ "$1" == '--out' ]]; then out=$2; fi
  shift
done
cat > /dev/null
printf 'звук' > "$out"
echo '${facts}'
`,
    'utf8',
  );
  await chmod(python, 0o755);

  return venvDir;
}

async function runWorker(root, task) {
  const workDir = path.join(root, 'attempt');

  await mkdir(workDir, { recursive: true });

  const taskFile = path.join(workDir, 'task.json');

  await writeFile(
    taskFile,
    JSON.stringify({ attemptId: 'проба', workDir, ...task }, null, 2),
    'utf8',
  );

  await run(process.execPath, ['--experimental-strip-types', WORKER, taskFile], {
    timeout: 120_000,
  }).catch(() => null);

  return {
    workDir,
    result: JSON.parse(await readFile(path.join(workDir, 'result.json'), 'utf8')),
    progress: (await readFile(path.join(workDir, 'progress.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

test('установка проходит шаги по порядку и заканчивается проверкой синтезом', async (t) => {
  const root = await workspace(t);
  const source = await archiveFixture(root);

  t.after(() => source.close());

  const venvDir = await fakeVenv(root, '{"durationMs": 1500, "sampleRate": 22050, "peak": 0.4}');
  const voicesDir = path.join(root, 'voices');
  const outcome = await runWorker(root, {
    voice: source.pack,
    venvDir,
    voicesDir,
    requirementsFile: path.join(root, 'requirements.txt'),
    bootstrapPython: process.execPath,
    deadlineMs: 90_000,
  });

  assert.equal(outcome.result.state, 'succeeded', outcome.result.error ?? '');

  const steps = outcome.progress.map((line) => line.state);

  assert.deepEqual(
    [steps.includes('packages'), steps.includes('voice'), steps.includes('check')],
    [true, true, true],
    'все шаги видны в журнале попытки',
  );
  assert.ok(
    steps.indexOf('check') > steps.indexOf('voice'),
    'проверка идёт после раскладки файлов, а не до неё',
  );

  const manifest = JSON.parse(
    await readFile(path.join(voicesDir, 'proba', 'voice.json'), 'utf8'),
  );

  assert.equal(manifest.model, 'voice.onnx');
  await access(path.join(voicesDir, 'proba', 'voice.onnx'));
});

test('молчащий движок не считается установленным голосом', async (t) => {
  const root = await workspace(t);
  const source = await archiveFixture(root);

  t.after(() => source.close());

  const venvDir = await fakeVenv(root, '{"durationMs": 1500, "sampleRate": 22050, "peak": 0.0}');
  const voicesDir = path.join(root, 'voices');
  const outcome = await runWorker(root, {
    voice: source.pack,
    venvDir,
    voicesDir,
    requirementsFile: path.join(root, 'requirements.txt'),
    bootstrapPython: process.execPath,
    deadlineMs: 90_000,
  });

  assert.equal(outcome.result.state, 'failed');
  assert.match(outcome.result.error, /тишин/);

  // Файлы остаются — качать их снова незачем, — а вот манифеста быть не должно:
  // именно он означает «этим голосом можно озвучивать».
  await access(path.join(voicesDir, 'proba', 'voice.onnx'));
  await assert.rejects(() => access(path.join(voicesDir, 'proba', 'voice.json')));
});

test('подменённый источник останавливает установку до проверки синтезом', async (t) => {
  const root = await workspace(t);
  const source = await archiveFixture(root);

  t.after(() => source.close());

  const venvDir = await fakeVenv(root, '{"durationMs": 1500, "peak": 0.4}');
  const voicesDir = path.join(root, 'voices');
  const outcome = await runWorker(root, {
    voice: { ...source.pack, archiveSha256: 'a'.repeat(64) },
    venvDir,
    voicesDir,
    requirementsFile: path.join(root, 'requirements.txt'),
    bootstrapPython: process.execPath,
    deadlineMs: 90_000,
  });

  assert.equal(outcome.result.state, 'failed');
  assert.match(outcome.result.error, /sha256/);
  assert.ok(
    !outcome.progress.some((line) => line.state === 'check'),
    'до синтеза дело не дошло',
  );
});
