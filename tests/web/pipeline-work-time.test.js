import assert from 'node:assert/strict';
import test from 'node:test';

import { pipelineWorkSec } from '../../web/src/shared/format.js';

test('ожидание на воротах не входит в чистое время работы', () => {
  const timing = {
    workSec: 4 * 60 * 60,
    gateWaitSec: 60 * 60,
    runningSinceMs: null,
  };

  // В сценарии «2 часа работы → час ворот → ещё 2 часа работы» карточка
  // показывает четыре часа, хотя календарно с первого старта прошло пять.
  assert.equal(pipelineWorkSec(timing, 5 * 60 * 60 * 1000), 4 * 60 * 60);
});

test('живой рабочий узел дотикивает только текущий интервал', () => {
  const sinceMs = 1_000_000;
  assert.equal(pipelineWorkSec({
    workSec: 2 * 60 * 60,
    gateWaitSec: 60 * 60,
    runningSinceMs: sinceMs,
  }, sinceMs + 2 * 60 * 60 * 1000), 4 * 60 * 60);
});

test('старому прогону без work-time телеметрии цифра не выдумывается', () => {
  assert.equal(pipelineWorkSec(null, Date.now()), null);
});
