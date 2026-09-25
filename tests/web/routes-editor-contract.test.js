import assert from 'node:assert/strict';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import {
  parseRouteDraft,
  parseRouteDraftList,
  parseRouteEditorIssue,
  parseRoutePublication,
} from '../../shared/routesContracts.ts';

test('RE-A1-01: DTO сохраняет полный документ без потери полей и байтов текста', () => {
  const original = makeDraft();
  const check = original.routes.quick.route.nodes.find((node) => node.id === 'check');
  check.onFailure = {
    build: { rewind: 'build', reset: ['build', 'check'] },
    tests: { stop: 'human' },
    environment: { stop: 'human' },
    plan: { stop: 'human' },
    human: { stop: 'human' },
  };
  original.presentation.quick = { build: { x: 10, y: 20 } };
  original.provenance.quick = { templateId: 'sample-template', version: 2 };
  const parsed = parseRouteDraft(original);

  assert.deepEqual(parsed, original);
});

const invalidFields = [
  ['нулевая revision', 'revision', (draft) => { draft.revision = 0; }],
  ['дробная revision', 'revision', (draft) => { draft.revision = 1.5; }],
  ['нет baseCatalogHash', 'baseCatalogHash', (draft) => { delete draft.baseCatalogHash; }],
  ['неизвестный state', 'state', (draft) => { draft.state = 'waiting'; }],
];

for (const [label, field, corrupt] of invalidFields) {
  test(`RE-A1-02: ${label} отклоняется с именем поля`, () => {
    const draft = makeDraft();
    corrupt(draft);

    assert.throws(() => parseRouteDraft(draft), new RegExp(field));
  });
}

test('RE-A1-03: неизвестное поле узла не исчезает при декодировании', () => {
  const draft = makeDraft();
  draft.routes.quick.route.nodes[0].futureFlag = true;

  assert.throws(() => parseRouteDraft(draft), /nodes\[0\]\.futureFlag/);
});

test('RE-A1-04: неизвестная версия черновика отклоняется', () => {
  const draft = makeDraft();
  draft.schema = 99;

  assert.throws(() => parseRouteDraft(draft), /schema/);
});

test('RE-A1-04: пустой entry и невыбранный переход сохраняются', () => {
  const draft = makeDraft();
  draft.routes.quick.route.entry = null;
  draft.routes.quick.route.nodes[0].on.done = null;

  assert.deepEqual(parseRouteDraft(draft), draft);
});

test('RE-A1-05: список, диагностика и receipt сохраняют поля и отвергают лишние', () => {
  const draft = makeDraft();
  const list = {
    drafts: [{
      id: draft.id,
      profile: draft.profile,
      title: draft.title,
      revision: draft.revision,
      baseCatalogHash: draft.baseCatalogHash,
      state: draft.state,
      updatedAt: draft.updatedAt,
    }],
  };
  const issue = {
    code: 'missing_transition',
    severity: 'error',
    scope: 'route',
    routeId: 'quick',
    nodeId: 'build',
    path: '/routes/quick/route/nodes/0/on/done',
    message: 'Выберите переход',
  };
  const receipt = {
    operationId: '22222222-2222-4222-8222-222222222222',
    requestHash: 'a'.repeat(64),
    draftId: draft.id,
    draftRevision: 1,
    fromCatalogHash: null,
    toCatalogHash: 'b'.repeat(64),
    sourceRevision: 1,
    state: 'committed',
    currentChanged: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  assert.deepEqual(parseRouteDraftList(list), list);
  assert.deepEqual(parseRouteEditorIssue(issue), issue);
  assert.deepEqual(parseRoutePublication(receipt), receipt);
  assert.throws(() => parseRouteDraftList({ drafts: [{ ...list.drafts[0], shell: 'x' }] }), /shell/);
  assert.throws(() => parseRouteEditorIssue({ ...issue, severity: 'fatal' }), /severity/);
  assert.throws(() => parseRoutePublication({ ...receipt, currentChanged: 'yes' }), /currentChanged/);
});
