import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contextCacheStatus,
  normalizeContextCache,
  reportedContextCache,
} from '../../server/src/lib/chat/context-cache.js';

test('contextCache сохраняет только известные неотрицательные целые токены', () => {
  assert.deepEqual(reportedContextCache({
    readTokens: 12,
    writeTokens: 0,
    uncachedTokens: 3,
  }), {
    scope: 'request', status: 'reported', readTokens: 12, writeTokens: 0, uncachedTokens: 3,
  });
  assert.deepEqual(reportedContextCache({ readTokens: -1 }), {
    scope: 'request', status: 'unavailable',
  });
  assert.deepEqual(reportedContextCache({ uncachedTokens: 1.5 }), {
    scope: 'request', status: 'unavailable',
  });
  assert.deepEqual(reportedContextCache({ readTokens: '12' }), {
    scope: 'request', status: 'unavailable',
  }, 'числовая строка не подменяет фактически сообщённое число');
  assert.deepEqual(reportedContextCache({}), {
    scope: 'request', status: 'unavailable',
  }, 'reported без единой фактической метрики был бы ложным утверждением');
});

test('contextCache не выпускает числа при unavailable/not-applicable и чужую форму', () => {
  assert.deepEqual(normalizeContextCache({
    scope: 'request', status: 'unavailable', readTokens: 99,
  }), contextCacheStatus('unavailable'));
  assert.deepEqual(normalizeContextCache({
    scope: 'request', status: 'not-applicable', uncachedTokens: 99,
  }), contextCacheStatus('not-applicable'));
  assert.equal(normalizeContextCache({ scope: 'session', status: 'reported', readTokens: 1 }), null);
  assert.equal(normalizeContextCache({ scope: 'request', status: 'unknown' }), null);
});
