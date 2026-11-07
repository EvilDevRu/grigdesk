import { migrationUrl } from './helpers/compile-vue.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from '../../web/node_modules/typescript/lib/typescript.js';

import { createWebLog } from '../../web/src/shared/webLog.ts';
import {
  WEB_LOG_ROUTES,
  normalizeRoute,
  projectWebLogEntry,
  utf8Bytes,
  vueErrorSource,
} from '../../shared/web-log/webLogContracts.ts';
import { createApiRouteMatcher } from '../../shared/web-log/webLogApiRoutes.ts';

function makeLog() {
  let clock = 0;
  const log = createWebLog({
    now: () => new Date(1_700_000_000_000 + clock),
    monotonicNow: () => clock,
    pageId: 'page-aaaaaaaaaaaaaaaa',
    tabId: 'tab-bbbbbbbbbbbbbbbb',
    version: 'dev',
    context: () => ({ route: '/projects/secret-123?token=abc', vis: 'visible', boot: null }),
  });

  return { log, advance: (ms) => { clock += ms; } };
}

test('общая проекция удаляет секреты из записи и вложенного дампа', () => {
  const raw = {
    v: 1, t: new Date().toISOString(), seq: 2, page: 'page-aaaaaaaaaaaaaaaa',
    tab: 'tab-bbbbbbbbbbbbbbbb', ver: 'dev', boot: null, lvl: 'error',
    ev: 'js.error', route: '/projects/secret-123?token=abc', vis: 'visible',
    data: { error: { name: 'Error', message: 'token=abc', stack: 'at /example/private:3:2' },
      surprise: 'private' },
    dump: { entries: [{ v: 1, t: new Date().toISOString(), seq: 1,
      page: 'page-aaaaaaaaaaaaaaaa', tab: 'tab-bbbbbbbbbbbbbbbb', ver: 'dev', boot: null,
      lvl: 'info', ev: 'app.pagehide', route: '/chats', vis: 'visible',
      data: { persisted: false, secret: 'private' } }], omitted: 0, from: null, to: null },
    cookie: 'private',
  };

  const cleaned = projectWebLogEntry(raw);
  assert.ok(cleaned);
  const text = JSON.stringify(cleaned);
  assert.doesNotMatch(text, /secret|private|token=abc|cookie/u);
  assert.equal(cleaned.route, '/projects/:id?');
  assert.equal(cleaned.data.error.message, 'unclassified');
});

test('ядро ограничивает кольцо и сохраняет seq после clear', () => {
  const { log } = makeLog();

  for (let i = 0; i < 520; i += 1) {
    assert.ok(log.record('page.visibility', { state: 'visible' }));
  }

  assert.equal(log.snapshot().entries.length, 500);
  // Ротация кольца — штатное вытеснение, а не потеря доставки.
  assert.equal(log.snapshot().ringEvicted, 20);
  assert.deepEqual(log.snapshot().loss, {
    queueEvicted: 0, storageFailed: 0, invalid: 0, quotaDropped: 0,
  });
  log.clear();
  assert.deepEqual(log.record('app.pagehide', { persisted: false }), {
    page: 'page-aaaaaaaaaaaaaaaa', seq: 521,
  });
});

test('две отметки получают плоскую предысторию с размерным пределом', () => {
  const { log } = makeLog();

  for (let i = 0; i < 100; i += 1) {
    log.record('ui.focus', { target: { tag: 'INPUT', context: 'other' } });
  }

  const first = log.mark('Сбой', null);
  const second = log.mark('Ещё сбой', null);
  const entries = log.snapshot().entries;
  const marks = entries.filter((entry) => entry.ev === 'mark');

  assert.ok(first && second);
  assert.equal(marks.length, 2);
  assert.ok(marks[1].dump.entries.every((entry) => !('dump' in entry)));
  assert.ok(utf8Bytes(marks[1].dump) <= 24 * 1024);
  assert.ok(utf8Bytes(marks[1]) <= 32 * 1024);
  assert.equal(marks[1].dump.entries.at(-1).seq, first.seq);
});

test('ошибки вызывающего кода и подписчика не ломают запись', () => {
  const { log } = makeLog();
  log.subscribe(() => { throw new Error('ошибка подписчика'); });
  assert.equal(log.record('unknown.event', {}), null);
  assert.equal(log.record('js.error', { error: {
    name: 'Error', get message() { throw new Error('недоступный getter'); },
  } }), null);
  assert.ok(log.record('app.pagehide', { persisted: true }));
  assert.ok(log.snapshot().loss.invalid >= 1);
});

test('повторы одной ошибки подавляются, другая ошибка того же вида — нет', () => {
  const { log, advance } = makeLog();
  const fail = (path, status) => log.record('api.fail', { method: 'GET', path, status,
    ms: 10, attempt: 1, willRetry: false });

  for (let i = 0; i < 12; i += 1) {
    fail('/api/tasks/:id', 503);
  }

  assert.equal(log.snapshot().entries.filter((entry) => entry.ev === 'api.fail').length, 5);
  assert.equal(log.snapshot().suppressed, 7);
  assert.ok(fail('/api/tasks/:id', 502), 'другой статус — другая сигнатура');
  assert.ok(fail('/api/projects', 503), 'другой путь — другая сигнатура');

  const error = (category) => ({ error: { name: 'TypeError', category, message: 'unclassified' } });

  for (let i = 0; i < 5; i += 1) {
    assert.ok(log.record('vue.error', error('unclassified')));
  }

  assert.equal(log.record('vue.error', error('unclassified')), null);
  assert.ok(log.record('vue.error', error('chunk-load')), 'сбой чанка не глушится чужими ошибками Vue');
  assert.ok(log.record('vue.error', { ...error('unclassified'), component: 'ChatView' }));

  // Сводка приходит по таймеру runtime, даже если ошибка больше не повторяется.
  advance(60_000);
  log.sweep();
  const summary = log.snapshot().entries.find((entry) => entry.ev === 'log.suppressed');
  assert.deepEqual(summary?.data, { signature: 'api', count: 7, periodMs: 60_000 });
});

test('имена stores, actions и компонентов и источник ошибки Vue попадают в запись', () => {
  const { log } = makeLog();
  const error = { name: 'TypeError', message: 'token=abc' };

  log.record('store.error', { store: 'task-favorites', action: 'loadAll', error });
  log.record('store.error', { store: 'bad store/id', action: 'x y', error });
  log.record('vue.error', { error, component: 'ChatView', info: vueErrorSource(
    'https://vuejs.org/error-reference/#runtime-1') });
  log.record('vue.error', { error, component: 'secret text', info: vueErrorSource('native event handler') });
  const [good, bad, render, handler] = log.snapshot().entries.map((entry) => entry.data);

  assert.deepEqual([good.store, good.action], ['task-favorites', 'loadAll']);
  assert.deepEqual([bad.store, bad.action], ['other', 'other']);
  assert.deepEqual([render.component, render.info], ['ChatView', 'render']);
  assert.deepEqual([handler.component, handler.info], ['other', 'native-event']);
  assert.equal(vueErrorSource('https://vuejs.org/error-reference/#runtime-m'), 'mounted');
  assert.equal(vueErrorSource('что-то своё'), 'other');
});

test('путь API: сервер сверяет шаблон с живым каталогом, без каталога — только форму', () => {
  const raw = {
    v: 1, t: new Date().toISOString(), seq: 1, page: 'page-aaaaaaaaaaaaaaaa',
    tab: 'tab-bbbbbbbbbbbbbbbb', ver: 'dev', boot: null, lvl: 'warn', ev: 'api.fail',
    route: '/chats', vis: 'visible',
    data: { method: 'GET', path: '/api/tasks/:id', ms: 1, attempt: 1, willRetry: false },
  };
  const withPath = (path) => ({ ...raw, data: { ...raw.data, path } });
  const catalog = new Set(['/api/tasks/:id']);

  assert.equal(projectWebLogEntry(raw, { apiRoutes: catalog }).data.path, '/api/tasks/:id');
  assert.equal(projectWebLogEntry(withPath('/api/tasks/123'), { apiRoutes: catalog }).data.path,
    'other');
  assert.equal(projectWebLogEntry(withPath('/api/tasks?token=abc')).data.path, 'other');
  assert.equal(projectWebLogEntry(withPath('/api/tasks/:id')).data.path, '/api/tasks/:id');
});

test('сопоставитель выбирает самый точный шаблон и отбрасывает id и query', () => {
  const match = createApiRouteMatcher([
    '/api/tasks',
    '/api/tasks/:id',
    '/api/tasks/:id/graph',
    '/api/tasks/favorites',
    '/api/showcase/:id?',
    '/api/files/*',
  ]);

  assert.equal(match('/api/tasks/7/graph?token=abc'), '/api/tasks/:id/graph');
  assert.equal(match('/api/tasks/favorites'), '/api/tasks/favorites');
  assert.equal(match('/api/tasks/private-42'), '/api/tasks/:id');
  assert.equal(match('https://brain.example/api/tasks'), '/api/tasks');
  assert.equal(match('/api/showcase'), '/api/showcase/:id?');
  assert.equal(match('/api/files/a/b/c.txt'), '/api/files/*');
  assert.equal(match('/api/unknown/private'), 'other');
});

test('шаблоны страниц журнала совпадают с component-маршрутами и корнем окна', async () => {
  const source = await readFile(migrationUrl('src/router.ts'), 'utf8');
  const ast = ts.createSourceFile('router.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = ast.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((entry) => entry.name.getText(ast) === 'routes'));

  assert.ok(statement && ts.isVariableStatement(statement));

  const declaration = statement.declarationList.declarations.find((entry) =>
    entry.name.getText(ast) === 'routes');

  assert.ok(declaration?.initializer && ts.isArrayLiteralExpression(declaration.initializer));

  // Старый /3d остаётся допустимым адресом исторических записей после redirect в плагин.
  const paths = ['/', '/3d'];

  for (const entry of declaration.initializer.elements) {
    assert.ok(ts.isObjectLiteralExpression(entry));

    const properties = entry.properties.filter(ts.isPropertyAssignment);
    const path = properties.find((property) => property.name.getText(ast) === 'path')?.initializer;
    const hasComponent = properties.some((property) => property.name.getText(ast) === 'component');

    assert.ok(path && ts.isStringLiteral(path));

    if (hasComponent) {
      paths.push(path.text);
    }
  }

  assert.deepEqual([...WEB_LOG_ROUTES].sort(), [...new Set(paths)].sort());
});

test('RET-LOG: снятый адрес не является страницей журнала', () => {
  assert.equal(normalizeRoute('/help'), '/help/:id?');
  assert.equal(normalizeRoute('/help/chats'), '/help/:id?');
  assert.equal(normalizeRoute('/agents'), 'other');
  assert.equal(normalizeRoute('/agents?x=1'), 'other');
  assert.equal(normalizeRoute('/routes'), '/routes');
});
