import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FactoryGraphContractError,
  parseFactoryGraph,
} from '../../shared/pipeline/factoryGraphContracts.ts';
import { ProvidersContractError, parseProviderEfforts } from '../../shared/chat/providersContracts.ts';
import {
  RoutesContractError,
  parseRoutePublish,
  parseRouteRevisions,
  publishSummary,
} from '../../shared/pipeline/routesContracts.ts';
import {
  DocumentsContractError,
  parseResolvedDocument,
} from '../../shared/plugins/documents/documentsContracts.ts';

test('ступени усилия собираются без повторов и переживают исполнителя без моделей', () => {
  assert.deepEqual(parseProviderEfforts({
    providers: [
      { models: [{ efforts: ['low', 'high'] }, { efforts: ['high'] }] },
      { models: [] },
      {},
    ],
  }), ['low', 'high']);
  assert.throws(() => parseProviderEfforts({ providers: null }), ProvidersContractError);
});

test('повреждённая ревизия каталога остаётся в списке, а не роняет раздел', () => {
  const broken = {
    catalogHash: 'a'.repeat(64),
    createdAt: '2026-09-01T08:00:00.000Z',
    isCurrent: false,
    routes: null,
    integrity: 'ROUTES_V2_BUNDLE_CORRUPT',
  };
  const parsed = parseRouteRevisions({
    profile: 'grigdesk',
    publishSupported: true,
    currentCatalogHash: null,
    revisions: [broken],
  });

  assert.deepEqual(parsed.revisions, [broken]);
  assert.throws(() => parseRouteRevisions({
    profile: 'grigdesk',
    publishSupported: true,
    currentCatalogHash: null,
    revisions: [{ ...broken, isCurrent: 'да' }],
  }), RoutesContractError);
});

test('вывод публикатора остаётся данными профиля, а раздел читает из него два поля', () => {
  const response = parseRoutePublish({
    profile: 'grigdesk',
    mode: 'publish',
    result: { catalogCreated: false, catalogHash: 'b'.repeat(64), своё: 1 },
    currentCatalogHash: null,
  });

  // Формат вывода принадлежит скрипту профиля: GrigDesk его не обрезает.
  assert.equal(response.result['своё'], 1);
  assert.deepEqual(publishSummary(response.result), {
    catalogCreated: false,
    catalogHash: 'b'.repeat(64),
  });
  // «Неизвестно» и «ревизия не изменилась» — разные ответы человеку.
  assert.deepEqual(publishSummary({}), { catalogCreated: null, catalogHash: null });
  assert.throws(() => parseRoutePublish({
    profile: 'grigdesk',
    mode: 'deploy',
    result: {},
    currentCatalogHash: null,
  }), RoutesContractError);
});

test('схема конвейера без узлов и рёбер отвергается, а не рисуется пустой', () => {
  const graph = { pos: {}, nodes: {}, edges: [] };

  assert.deepEqual(parseFactoryGraph(graph), graph);
  assert.throws(() => parseFactoryGraph({ pos: {}, nodes: {} }), FactoryGraphContractError);
  assert.throws(() => parseFactoryGraph({ pos: [], nodes: {}, edges: [] }), FactoryGraphContractError);
});

test('документ описывается ссылкой внутри корня, а не путём на диске', () => {
  const resolved = {
    ref: { source: 'grigdesk', path: 'docs/readme.md' },
    name: 'readme.md',
    format: 'md',
    source: { id: 'grigdesk', label: 'GrigDesk' },
  };

  assert.deepEqual(parseResolvedDocument({ ...resolved, absolute: '/etc/passwd' }), resolved);
  assert.throws(
    () => parseResolvedDocument({ ...resolved, ref: { source: 'grigdesk' } }),
    DocumentsContractError,
  );
});
