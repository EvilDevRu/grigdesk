import assert from 'node:assert/strict';
import test from 'node:test';

import { createWebLog } from '../../web/src/shared/webLog.ts';
import { projectWebLogEntry } from '../../shared/web-log/webLogContracts.ts';

/**
 * Настоящее ядро и серверная проекция независимо проверяют новые поля.
 * Часы фиксированы, источники данных и токены только синтетические.
 */
function fixture(level = 'verbose') {
  return createWebLog({
    now: () => new Date('2026-11-04T00:00:00Z'),
    monotonicNow: () => 0,
    pageId: 'page-aaaaaaaaaaaaaaaa',
    tabId: 'tab-bbbbbbbbbbbbbbbb',
    version: 'dev',
    context: () => ({
      route: '/projects/private?token=secret',
      vis: 'visible',
      boot: null
    }),
    level,
  });
}

test('каждое открытие проходит обе проекции, только verbose и без подавления', () => {
  for (const level of ['off', 'errors', 'decisions', 'verbose']) {
    const log = fixture(level);

    for (let surface = 1; surface <= 12; surface += 1) {
      const key = log.record('perf.surface', {
        surface,
        kind: 'route',
        target: 'projects',
        view: '/projects/private?token=secret',
        phase: 'ready',
        origin: 'navigation',
        first: surface === 1,
        ms: 25,
        mountedMs: 10,
        pending: 0,
        privateText: 'secret',
      });

      assert.equal(key !== null, level === 'verbose');
    }

    assert.equal(log.snapshot().count, level === 'verbose' ? 12 : 0);

    for (const entry of log.snapshot().entries) {
      assert.deepEqual(projectWebLogEntry(entry), entry);
      assert.equal(entry.data.view, '/projects/:id?');
      assert.doesNotMatch(JSON.stringify(entry), /secret|private|privateText/u);
    }
  }
});

test('неизвестные цели очищаются, корреляция и API числа сохраняются без текста', () => {
  const log = fixture();

  log.record('api.complete', {
    method: 'GET',
    path: '/api/auth/state',
    ms: 25,
    attempt: 1,
    request: 1,
    surface: 7,
    phase: 'done',
    outcome: 'success',
    serverRequest: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    pipeMs: 20,
    body: 'secret',
  });
  log.record('perf.surface', {
    surface: 1,
    kind: 'tool',
    target: 'private-plugin',
    view: '/ext/private-plugin',
    phase: 'start',
    origin: 'surface',
    first: true,
    ms: 0,
    pending: 0,
  });

  const entries = log.snapshot().entries;

  assert.equal(entries.length, 2);
  assert.equal(entries[0].data.serverRequest, 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
  assert.equal(entries[0].data.pipeMs, 20);
  assert.equal(entries[1].data.target, 'other');
  assert.equal(entries[1].data.view, '/ext/:id');
  assert.doesNotMatch(JSON.stringify(entries), /private-plugin|secret/u);
});
