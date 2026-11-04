import assert from 'node:assert/strict';
import test from 'node:test';

import { detectStall } from '../../server/src/lib/stall.ts';

test('ошибка транспорта видна в карточке поверх итоговой строки диспетчера', () => {
  const stall = detectStall({
    registry: { STALLED_HUMAN: '1' },
    timeline: [{
      ts: '2026-01-01 12:00:00',
      event: 'route: BROWSER: браузерный транспорт не запущен — browser_run_stale',
    }, {
      ts: '2026-01-01 12:00:01',
      event: 'route: dispatcher остановлен fail-closed (код 75)',
    }],
    daemonAlive: false,
  });

  assert.equal(stall?.stop, 'browser-transport');
  assert.equal(stall?.stage, 'BROWSER');
  assert.match(stall?.title ?? '', /browser_run_stale/u);
  assert.match(stall?.presentation?.details.retained ?? '', /бюджет повторов узла сохранён/u);
  assert.match(stall?.hint ?? '', /resume/u);
});
