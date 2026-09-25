import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { validateDraft } from '../../server/src/modules/routes/validation.ts';

const ROUTE_TOOL = fileURLToPath(new URL('../../engine/bin/factory-route', import.meta.url));
const ROOT = path.dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));

function engineCheck(draft) {
  const input = {
    profile: draft.profile,
    routes: draft.routes,
    bootstrap: draft.bootstrap,
    bootstrapPrompts: draft.bootstrapPrompts,
  };
  const result = spawnSync(ROUTE_TOOL, ['--profile', draft.profile, 'editor-check'], {
    cwd: ROOT,
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined);
  const output = JSON.parse(result.stdout);
  assert.equal(result.status === 0, output.ok);
  return output;
}

function serverCheck(draft) {
  try {
    const report = validateDraft(draft);
    return { ok: report.issues.every((item) => item.severity !== 'error'), issues: report.issues };
  } catch (error) {
    return { ok: false, issues: [], thrown: error };
  }
}

test('RE-C2-01: ручная таблица executor и переходов совпадает по verdict', () => {
  const cases = [
    { name: 'все четыре executor и типы перехода', valid: true, change() {} },
    {
      name: 'явный пропуск разведки', valid: true,
      change(draft) { draft.routes.quick.route.bootstrap = 'skip'; },
    },
    {
      name: 'явная обязательная разведка', valid: true,
      change(draft) { draft.routes.quick.route.bootstrap = 'required'; },
    },
    {
      name: 'вход в середину достижимого цикла', valid: true,
      change(draft) { draft.routes.quick.route.entry = 'gate_accept'; },
    },
    {
      name: 'неизвестная политика разведки', valid: false,
      change(draft) { draft.routes.quick.route.bootstrap = 'auto'; },
    },
    {
      name: 'политика разведки не строка', valid: false,
      change(draft) { draft.routes.quick.route.bootstrap = ['skip']; },
    },
    {
      name: 'bootstrap не может отключать сам себя', valid: false,
      change(draft) { draft.bootstrap.bootstrap = 'skip'; },
    },
    {
      name: 'entry не существует', valid: false,
      change(draft) { draft.routes.quick.route.entry = 'ghost'; },
    },
    {
      name: 'entry не может быть status', valid: false,
      change(draft) { draft.routes.quick.route.entry = 'check_status'; },
    },
    {
      name: 'полный typed onFailure',
      valid: true,
      change(draft) {
        draft.routes.quick.route.nodes[1].onFailure = Object.fromEntries(
          ['build', 'tests', 'environment', 'plan', 'human']
            .map((owner) => [owner, { stop: 'human' }]),
        );
      },
    },
    {
      name: 'неизвестный executor', valid: false,
      change(draft) { draft.routes.quick.route.nodes[1].executor = 'external'; },
    },
    {
      name: 'next на отсутствующий узел', valid: false, path: '/on/done',
      change(draft) { draft.routes.quick.route.nodes[0].on.done = { next: 'ghost' }; },
    },
    {
      name: 'next назад', valid: false, path: '/on/approved',
      change(draft) { draft.routes.quick.route.nodes[3].on.approved = { next: 'build' }; },
    },
    {
      name: 'status как цель', valid: false, path: '/on/done',
      change(draft) { draft.routes.quick.route.nodes[0].on.done = { next: 'check_status' }; },
    },
    {
      name: 'неизвестный stop', valid: false,
      change(draft) { draft.routes.quick.route.nodes[0].on.failed = { stop: 'later' }; },
    },
    {
      name: 'null-переход', valid: false, path: '/on/done',
      change(draft) { draft.routes.quick.route.nodes[0].on.done = null; },
    },
    {
      name: 'prompt-условие без requiredContext', valid: false,
      change(draft) {
        draft.routes.quick.route.nodes[0].prompt.blocks[1].when.context = 'unknown.kind';
      },
    },
    {
      name: 'профиль bootstrap не совпадает', valid: false,
      change(draft) { draft.bootstrap.profile = 'another'; },
    },
  ];

  for (const item of cases) {
    const draft = makeDraft();
    item.change(draft);
    const server = serverCheck(draft);
    const engine = engineCheck(draft);
    assert.equal(server.ok, item.valid, `${item.name}: server`);
    assert.equal(engine.ok, item.valid, `${item.name}: engine`);
    if (item.path) {
      assert.ok(server.issues.some((issue) => issue.path.includes(item.path)),
        `${item.name}: путь server`);
      assert.ok(engine.issues.some((issue) => issue.path.includes(item.path)),
        `${item.name}: путь engine`);
    }
  }
});

test('RE-C2-02: onFailure escalation на удалённый route отвергают обе стороны', () => {
  const draft = makeDraft();
  const check = draft.routes.quick.route.nodes[1];
  check.onFailure = {
    build: { escalate: { routes: ['ghost'] } },
    tests: { stop: 'human' },
    environment: { stop: 'human' },
    plan: { stop: 'human' },
    human: { stop: 'human' },
  };
  draft.routes.quick.route.escalation.push({
    from: 'check',
    allowedRoutes: ['ghost'],
    requiresHumanWhenPinned: true,
  });

  const server = validateDraft(draft);
  const engine = engineCheck(draft);
  assert.ok(server.issues.some((item) => item.code === 'route_reference_missing'
    && item.path.includes('/onFailure/build/')));
  assert.equal(engine.ok, false);
  assert.ok(engine.issues.some((item) => item.path.includes('/onFailure/build/')));
});

test('RE-C2-03: reset, runKey, registry, достижимость и prompts имеют код и адрес', () => {
  const cases = [
    {
      name: 'неполный reset',
      code: 'rewind_reset_invalid',
      path: '/routes/quick/route/nodes/3/on/rejected/reset',
      change(draft) {
        draft.routes.quick.route.nodes[3].on.rejected.reset = ['build'];
      },
    },
    {
      name: 'id не соответствует runKey',
      code: 'route_schema_invalid',
      path: '/routes/quick/route/nodes',
      change(draft) {
        draft.routes.quick.route.nodes[1].runKey = 'OTHER';
      },
    },
    {
      name: 'повтор ключа реестра',
      code: 'route_schema_invalid',
      path: '/routes/quick/route/nodes',
      change(draft) {
        draft.routes.quick.route.nodes[2].key = 'BUILD';
      },
    },
    {
      name: 'недостижимый check',
      code: 'route_schema_invalid',
      path: '/routes/quick/route/nodes',
      change(draft) {
        draft.routes.quick.route.nodes[0].on.done = { next: 'gate_accept' };
      },
    },
    {
      name: 'неиспользуемый prompt',
      code: 'prompt_unused',
      path: '/routes/quick/prompts/prompts~1unused.base.md',
      change(draft) {
        draft.routes.quick.prompts['prompts/unused.base.md'] = 'Лишняя инструкция.';
      },
    },
  ];

  for (const item of cases) {
    const draft = makeDraft();
    item.change(draft);
    const server = serverCheck(draft);
    const engine = engineCheck(draft);
    assert.equal(server.ok, false, `${item.name}: server`);
    assert.equal(engine.ok, false, `${item.name}: engine`);
    assert.ok(server.issues.some((issue) => issue.code === item.code
      && issue.path.startsWith(item.path)), `${item.name}: server code/path`);
    assert.ok(engine.issues.some((issue) => issue.code === item.code
      && issue.path.startsWith(item.path)), `${item.name}: engine code/path`);
  }
});

test('RE-C2-04: исторический productFailure+rewind читается, новый draft не проходит', () => {
  const draft = makeDraft();
  const check = draft.routes.quick.route.nodes[1];
  check.executor = 'agent';
  delete check.commandId;
  check.prompt = {
    blocks: [{ file: 'prompts/check.base.md' }],
    requiredContext: ['task'],
  };
  check.retry.productFailure = 1;
  check.on.failed = { rewind: 'build', reset: ['build', 'check'] };
  draft.routes.quick.prompts['prompts/check.base.md'] = 'Проверь результат.';

  const server = serverCheck(draft);
  const engine = engineCheck(draft);
  const historical = spawnSync('python3', ['-c', [
    'import json, sys',
    'from route_model import validate_machine',
    'value = json.load(sys.stdin)',
    'validate_machine(value["route"], "sample", "quick", "route", set(value["prompts"]))',
  ].join('\n')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PYTHONPATH: path.join(ROOT, 'engine', 'lib'),
    },
    input: JSON.stringify(draft.routes.quick),
    encoding: 'utf8',
  });
  assert.equal(historical.status, 0, historical.stderr);
  assert.equal(server.ok, false);
  assert.ok(server.issues.some((item) => item.code === 'product_failure_rewind'));
  assert.equal(engine.ok, false);
  assert.ok(engine.issues.some((item) => item.code === 'product_failure_rewind'
    && item.path.includes('/retry/productFailure')));
});
