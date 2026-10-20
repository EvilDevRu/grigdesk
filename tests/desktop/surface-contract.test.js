import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseSurfaceTarget,
  parseMainRequest,
  surfaceUrl,
  surfaceTargetFromUrl,
} from '../../shared/desktop/surfaceContract.ts';
import {
  desktopUserAgent,
  desktopWindowRole,
  desktopDocumentMode,
} from '../../shared/desktop/desktopWindowContract.ts';

test('SC-01: только известная поверхность и канонический id', () => {
  assert.deepEqual(parseSurfaceTarget({ kind: 'task', id: '42' }), { kind: 'task', id: '42' });
  assert.deepEqual(parseSurfaceTarget({ kind: 'task', id: '9'.repeat(15) }), {
    kind: 'task', id: '9'.repeat(15),
  });

  for (const input of [
    null, [], { kind: 'code', id: '42' }, { kind: 'task', id: 42 },
    { kind: 'task', id: '0' }, { kind: 'task', id: '042' },
    { kind: 'task', id: '../42' }, { kind: 'task', id: '1'.repeat(16) },
    {
      kind: 'task',
      id: '42',
      options: {},
    },
    {
      kind: 'task', 
      id: '42', 
      url: 'https://example.org'
    },
  ]) {
    assert.equal(parseSurfaceTarget(input), null);
  }
});
test('SC-02: адрес строится только из origin и закрытого target', () => {
  const origin = 'http://127.0.0.1:47101';
  const target = { kind: 'task', id: '42' };
  const url = surfaceUrl(origin, target);

  assert.equal(url, origin + '/?surface=task&id=42#/surface');
  assert.deepEqual(surfaceTargetFromUrl(url, origin), target);

  for (const value of [
    origin + '/?surface=task&id=42&id=43#/surface',
    origin + '/?surface=task&id=42&x=1#/surface',
    origin + '/?surface=task&id=42#/pipeline',
    origin + '/other?surface=task&id=42#/surface',
    'http://127.0.0.1:47102/?surface=task&id=42',
    'http://u:p@127.0.0.1:47101/?surface=task&id=42',
  ]) {
    assert.equal(surfaceTargetFromUrl(value, origin), null);
  }
});
test('SC-03: роль surface отделена от main и обычной страницы', () => {
  const ua = desktopUserAgent('Electron', 'surface');

  assert.equal(desktopWindowRole(ua), 'surface');
  assert.equal(desktopDocumentMode(ua, ''), 'surface');
  assert.equal(desktopDocumentMode('Electron', '?surface=task&id=42'), 'page');
  assert.equal(desktopWindowRole(ua + ' GrigDeskWindow/main'), null);

  assert.deepEqual(parseMainRequest({ destination: 'pipeline' }), { destination: 'pipeline' });
  assert.deepEqual(parseMainRequest({
    destination: 'task-dialog', target: { kind: 'task', id: '42' },
  }), { destination: 'task-dialog', target: { kind: 'task', id: '42' } });

  for (const value of [
    null,
    [],
    { destination: 'unknown' },
    { destination: 'pipeline', target: { kind: 'task', id: '42' } },
    { destination: 'task-dialog' },
    { destination: 'task-dialog', target: { kind: 'task', id: '042' } },
    { destination: 'pipeline', url: 'http://example.org' },
    { destination: 'pipeline', options: {} },
  ]) {
    assert.equal(parseMainRequest(value), null);
  }
});
