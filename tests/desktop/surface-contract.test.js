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

test('TC-01: tool target и канонический URL instance; адреса карточек побайтно прежние', () => {
  const origin = 'http://127.0.0.1:47101';
  const instance = 'tool-instance-aaaaaaaa';

  for(const id of ['code', 'shelf', 'ssh', 'db', 'docker', 'plugin:example']) {
    const target = { kind: 'tool', id };

    assert.deepEqual(parseSurfaceTarget(target), target);

    const url = surfaceUrl(origin, target, instance);

    assert.equal(url, `${origin}/?surface=tool&id=${encodeURIComponent(id)}&instance=${instance}#/surface`);
    assert.deepEqual(surfaceTargetFromUrl(url, origin), { ...target, instance });
  }

  assert.equal(surfaceUrl(origin, { kind: 'task', id: '42' }), origin + '/?surface=task&id=42#/surface');
});

test('TC-02: закрытый контракт не принимает лишние поля, запретные tools и чужие документы', () => {
  const origin = 'http://127.0.0.1:47101';

  for(const id of ['terminal', 'studio3d', 'unknown', 'plugin:../x', 'plugin:', 'plugin:X']) {
    assert.equal(parseSurfaceTarget({ kind: 'tool', id }), null);
  }

  for(const input of [
    {
      kind: 'tool',
      id: 'code',
      url: 'https://example.org'


    },
    {
      kind: 'tool',
      id: 'code',
      options: {}


    },
    { kind: 'unknown', id: 'code' },
    {
      kind: 'tool',
      id: 'code',
      instance: 'caller-created'


    },
  ]) {
    assert.equal(parseSurfaceTarget(input), null);
  }

  const url = origin + '/?surface=tool&id=code&instance=tool-instance-aaaaaaaa#/surface';

  for(const invalid of [
    url.replace(origin, 'http://127.0.0.1:47102'),
    url.replace('&instance=', '&id=shelf&instance='),
    url.replace('#/surface', '&extra=1#/surface'),
    url.replace('instance=tool-instance-aaaaaaaa', 'instance='),
    url.replace('#/surface', '#/code'),
    url.replace('/?surface', '/other?surface'),
  ]) {
    assert.equal(surfaceTargetFromUrl(invalid, origin), null);
  }

  assert.equal(parseMainRequest({
    destination: 'task-dialog', target: { kind: 'tool', id: 'code' },
  }), null);
});

test('SC-SOURCE: source-aware target проходит URL и main request без потери источника', () => {
  const source = `grigdesk-b24@${'a'.repeat(64)}`;
  const target = {
    kind: 'task',
    id: '42',
    source
  };

  assert.deepEqual(parseSurfaceTarget(target), target);
  assert.deepEqual(surfaceTargetFromUrl(surfaceUrl('http://127.0.0.1:8140', target),
    'http://127.0.0.1:8140'), target);
  assert.deepEqual(parseMainRequest({ destination: 'task-dialog', target }),
    { destination: 'task-dialog', target });
  assert.equal(parseSurfaceTarget({
    kind: 'task',
    id: '42',
    source: 'grigdesk'
  }), null);
});
