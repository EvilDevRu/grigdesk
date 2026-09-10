import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AgentsContractError,
  parseAgentCard,
  parseAgentInstallResult,
  parseAgentList,
} from '../../shared/agentsContracts.ts';
import {
  FactoryGraphContractError,
  parseFactoryGraph,
} from '../../shared/factoryGraphContracts.ts';
import { ProjectsContractError, parseProjectList } from '../../shared/projectsContracts.ts';
import { ProvidersContractError, parseProviderEfforts } from '../../shared/providersContracts.ts';
import {
  RoutesContractError,
  parseRoutePublish,
  parseRouteRevisions,
  publishSummary,
} from '../../shared/routesContracts.ts';
import { DocumentsContractError, parseResolvedDocument } from '../../shared/documentsContracts.ts';

const agent = {
  id: 'recon',
  kind: 'agent',
  label: 'Разведка',
  sub: 'lint · tests',
  key: 'recon',
  tier: 'reasoning',
  effort: 'high',
  timeout: 900,
  budget: 0,
  readonly: true,
  optional: false,
  prompt: 'Осмотри репозиторий',
};

test('карточка агента отбрасывает посторонние поля и требует объявленные', () => {
  assert.deepEqual(parseAgentCard({ ...agent, ignored: 'лишнее' }), agent);
  assert.deepEqual(parseAgentList({ agents: [agent] }), [agent]);
  // Времена и флаги — не строки: рукописный файл базы читает сервер, а сюда он
  // приходит уже нормализованным, и строка здесь означала бы сломанный ответ.
  assert.throws(() => parseAgentCard({ ...agent, timeout: '900' }), AgentsContractError);
  assert.throws(() => parseAgentCard({ ...agent, readonly: 'yes' }), AgentsContractError);
  for (const invalid of [null, [], 'text', 12, {}]) {
    assert.throws(() => parseAgentList(invalid), AgentsContractError);
  }
});

test('род агента остаётся свободным: рукописная карточка не исчезает из списка', () => {
  const custom = { ...agent, kind: 'review' };

  assert.equal(parseAgentCard(custom).kind, 'review');
});

test('пустая доустановка агентов — не отказ', () => {
  assert.deepEqual(parseAgentInstallResult({ ok: true }), {
    ok: true,
    created: null,
    skipped: null,
  });
  assert.throws(() => parseAgentInstallResult({ created: [] }), AgentsContractError);
});

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

test('источник пути проекта закрыт перечислением', () => {
  const project = {
    id: 'cockpit',
    factory: true,
    repos: [{ key: 'be', dir: '/srv/be', from: 'factory', exists: true }],
    routes: ['hunt'],
  };

  assert.deepEqual(parseProjectList({ projects: [project] }), [project]);
  // Чужой источник открыл бы правку путей, заданных профилем фабрики.
  assert.throws(
    () => parseProjectList({ projects: [{ ...project, repos: [{ ...project.repos[0], from: 'guess' }] }] }),
    ProjectsContractError,
  );
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
    profile: 'cockpit',
    publishSupported: true,
    currentCatalogHash: null,
    revisions: [broken],
  });

  assert.deepEqual(parsed.revisions, [broken]);
  assert.throws(() => parseRouteRevisions({
    profile: 'cockpit',
    publishSupported: true,
    currentCatalogHash: null,
    revisions: [{ ...broken, isCurrent: 'да' }],
  }), RoutesContractError);
});

test('вывод публикатора остаётся данными профиля, а раздел читает из него два поля', () => {
  const response = parseRoutePublish({
    profile: 'cockpit',
    mode: 'publish',
    result: { catalogCreated: false, catalogHash: 'b'.repeat(64), своё: 1 },
    currentCatalogHash: null,
  });

  // Формат вывода принадлежит скрипту профиля: кокпит его не обрезает.
  assert.equal(response.result['своё'], 1);
  assert.deepEqual(publishSummary(response.result), {
    catalogCreated: false,
    catalogHash: 'b'.repeat(64),
  });
  // «Неизвестно» и «ревизия не изменилась» — разные ответы человеку.
  assert.deepEqual(publishSummary({}), { catalogCreated: null, catalogHash: null });
  assert.throws(() => parseRoutePublish({
    profile: 'cockpit',
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
    ref: { source: 'cockpit', path: 'docs/readme.md' },
    name: 'readme.md',
    format: 'md',
    source: { id: 'cockpit', label: 'Кокпит' },
  };

  assert.deepEqual(parseResolvedDocument({ ...resolved, absolute: '/etc/passwd' }), resolved);
  assert.throws(
    () => parseResolvedDocument({ ...resolved, ref: { source: 'cockpit' } }),
    DocumentsContractError,
  );
});
