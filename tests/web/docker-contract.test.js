import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';

const contract = await compileModule(webFile('../shared/plugins/docker/dockerContracts.ts'));

test('логи проверяют варианты сообщений и не принимают повреждённые строки', () => {
  const message = {
    t: 'log',
    lines: [{ stream: 'stdout', text: 'ready' }, { stream: 'stderr', text: 'warning' }],
  };

  assert.deepEqual(contract.parseDockerLogMessage(message), message);
  assert.deepEqual(contract.parseDockerLogMessage({ t: 'end' }), { t: 'end' });
  assert.deepEqual(contract.parseDockerLogMessage({ t: 'error', message: 'закрыт' }), {
    t: 'error',
    message: 'закрыт',
  });

  for (const invalid of [
    null,
    { t: 'log', lines: 'ready' },
    { t: 'log', lines: [{ stream: 'stdout', text: 123 }] },
    { t: 'log', lines: [{ stream: 'unknown', text: 'ready' }] },
    { t: 'end-of-stream' },
    { t: 'error', message: { secret: 'не выводить' } },
  ]) {
    assert.throws(() => contract.parseDockerLogMessage(invalid), contract.DockerContractError);
  }
});

test('пустой срез статистики допустим, неполные и бесконечные показатели отклоняются', () => {
  const empty = { t: 'stats', at: new Date().toISOString(), items: {} };
  const stats = {
    cpuPercent: 2,
    memoryUsed: 100,
    memoryLimit: 200,
    memoryPercent: 50,
    networkRx: 10,
    networkTx: 20,
    blockRead: 30,
    blockWrite: 40,
    pids: 1,
  };

  assert.deepEqual(contract.parseDockerStatsMessage(empty), empty);
  assert.deepEqual(contract.parseDockerStatsMessage({ ...empty, items: { app: stats } }).items.app, stats);
  assert.throws(() => contract.parseDockerStatsMessage({
    ...empty,
    items: { app: { cpuPercent: 2 } },
  }), contract.DockerContractError);
  assert.throws(() => contract.parseDockerStatsMessage({
    ...empty,
    items: { app: { ...stats, memoryUsed: Infinity } },
  }), contract.DockerContractError);
});

test('отчёт уборки сохраняет частичные отказы и отвергает неизвестную цель', () => {
  const response = {
    ok: true,
    report: {
      images: { removed: 0, freed: 0, error: 'образ используется' },
      buildCache: { removed: 4, freed: 1024 },
    },
  };

  assert.deepEqual(contract.parseDockerPruneResponse(response), response);
  assert.throws(() => contract.parseDockerPruneResponse({
    ok: true,
    report: { everything: { removed: 1, freed: 2 } },
  }), contract.DockerContractError);
  assert.throws(() => contract.parseDockerOkResponse({ ok: false }), contract.DockerContractError);
});

test('терминальный JSON допускает только сообщение ошибки, без утечки чужих полей', () => {
  assert.deepEqual(contract.parseDockerExecMessage({
    t: 'error',
    message: 'оболочка недоступна',
    internal: 'лишнее поле',
  }), { t: 'error', message: 'оболочка недоступна' });
  assert.throws(() => contract.parseDockerExecMessage({ t: 'resize', cols: 80, rows: 24 }),
    contract.DockerContractError);

  try {
    contract.parseDockerExecMessage({ t: 'error', message: ['не выводить это значение'] });
    assert.fail('повреждённый ответ обязан быть отклонён');
  } catch (error) {
    assert.match(error.message, /exec.message/u);
    assert.doesNotMatch(error.message, /не выводить/u);
  }
});
