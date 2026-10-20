// Контракт GLM-раннера движка: настоящие shell-тесты движка в собственном TEST_ROOT
// под offline guard. Модель, ключи и сеть провайдера не участвуют.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeProviderUsage } from '../../server/src/lib/analytics/normalizers.ts';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OFFLINE = path.join(ROOT, 'tests/engine/run-offline.sh');

/**
 * Запускает один shell-тест движка штатным воркером run-offline: свой TEST_ROOT,
 * `env -i` и FACTORY_FORBID_LIVE=1. Возвращает код и TAP-вывод для разбора отказа.
 */
async function runEngineTest(t, file) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glm-runner-contract-'));
  const lock = path.join(directory, 'out.lock');

  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(lock, '');

  return new Promise((resolve) => {
    execFile('bash', [OFFLINE, '--one', path.join(ROOT, file)], {
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        OFFLINE_OUT_LOCK: lock,
      },
      timeout: 300000,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;

      resolve({ code, output: `${stdout}${stderr}` });
    });
  });
}

/**
 * Каждый файл обязан завершиться нулём без единого `not ok`: пустой вывод или
 * обрыв до finish_tests не считается зелёным результатом.
 */
async function assertEngineTests(t, files) {
  for (const file of files) {
    const { code, output } = await runEngineTest(t, file);
    const failures = output.split('\n').filter((line) => line.startsWith('not ok'));

    assert.deepEqual(failures, [], `${file}\n${output}`);
    assert.equal(code, 0, `${file}\n${output}`);
    assert.match(output, /^1\.\.[1-9][0-9]*$/mu, `${file} не дошёл до finish_tests\n${output}`);
  }
}

test('SB12a: GLM-раннер проходит общий контракт, probe и каталог без ключа', async (t) => {
  await assertEngineTests(t, [
    'tests/engine/unit/glm-runner.sh',
    'tests/engine/contract/runner-contract.sh',
    'tests/engine/contract/classifier-fixtures.sh',
  ]);
});

test('SB12b: запуск, классификация, делегирование и остановка этапа GLM', async (t) => {
  await assertEngineTests(t, [
    'tests/engine/unit/glm-runner-launch.sh',
    'tests/engine/contract/classifier-fixtures.sh',
    'tests/engine/integration/glm-runtime-stop.sh',
    'tests/engine/integration/symmetric-failover.sh',
    'tests/engine/integration/runtime-switch.sh',
  ]);
});

test('SB12c: отказ wrapper-а GLM виден в карточке остановки, класс остаётся unknown', async (t) => {
  await assertEngineTests(t, [
    'tests/engine/integration/runner-failure-detail.sh',
    'tests/engine/unit/routes-editor-capabilities.sh',
  ]);
});

test('SB12c: расход GLM — unavailable, а не нулевой billing', () => {
  const raw = [
    '{"event":"glm_start","mode":"read-only","model":"[\\"zai\\",\\"glm-5.3\\"]"}',
    '{"event":"result","stopReason":"end_turn"}',
  ].join('\n');
  const usage = normalizeProviderUsage({
    provider: 'glm',
    dialect: 'glm-jsonl-unknown',
    rawText: raw,
  });

  assert.equal(usage.source, 'unavailable');
  assert.equal(usage.completeness, 'missing');
  assert.deepEqual(usage.usageSegments, []);
  assert.deepEqual(usage.samples, []);
});

test('SB12a: tripwire glm не даёт случайному живому вызову пройти незамеченным', async () => {
  const code = await new Promise((resolve) => {
    execFile(path.join(ROOT, 'tests/engine/fakes/bin/glm'), ['--version'], (error) => {
      resolve(error ? error.code : 0);
    });
  });

  assert.equal(code, 97);
});
