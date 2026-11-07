import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { RoutesStore } from '../../server/src/modules/routes/store.ts';
import {
  ROOT, ENGINE, SEQUENCES, TASK, fixture, published, context, put, run, ok, hook, requireSample,
} from '../fixtures/pipelineSample.mjs';

const OWNERS = ['plan', 'tests', 'build', 'human', 'environment'];

/**
 * Ожидаемая матрица — прямое переложение шагов 5 и 7 принятого плана.
 * Источник ожидания независим от definition.mjs: ошибку перехода нельзя узаконить её же чтением.
 */
function failureTarget(route, node, owner) {
  if (owner === 'human' || owner === 'environment') {
    return null;
  }

  if (route === 'feature') {
    const matrix = {
      skeptic: { plan: 'plan', build: 'plan' },
      build: { tests: 'tests' },
      verify: {
        tests: 'tests',
        build: 'build',
        plan: 'plan',
      },
      browser: {
        tests: 'tests',
        build: 'build',
        plan: 'plan',
      },
      audit: { tests: 'tests', build: 'build' },
    };

    return matrix[node]?.[owner] || null;
  }

  if (route === 'debug' && owner === 'plan') {
    if (node === 'diagnose') {
      return 'repro';
    }

    return ['build', 'verify', 'review', 'recheck', 'browser'].includes(node) ? 'diagnose' : null;
  }

  if (['verify', 'review', 'recheck', 'browser'].includes(node) && ['build', 'tests'].includes(owner)) {
    return 'build';
  }

  return null;
}

/**
 * Проверяет reset как непрерывный участок вплоть до текущего узла.
 * Список после текущего узла сбрасывать нельзя: это отдельный контракт возобновления.
 */
function expectedAction(sequence, current, target) {
  return target ? { rewind: target, reset: sequence.slice(sequence.indexOf(target),
    sequence.indexOf(current) + 1) } : { stop: 'human' };
}

test('SAMPLE-ROUTES-01: exact sequences and triage', async (t) => {
  const f = await fixture(t);
  const p = await published(f);

  assert.deepEqual(Object.keys(p.current.routes).sort(), Object.keys(SEQUENCES).sort());

  for (const [route, sequence] of Object.entries(SEQUENCES)) {
    const machine = p.describe(route);

    assert.equal(machine.entry, sequence[0]);
    assert.equal(machine.bootstrap, 'skip');
    assert.deepEqual(machine.sequence, { main: sequence, tail: ['ship'] });
    assert.deepEqual(machine.nodes.map((node) => node.id).sort(), [...sequence, 'ship'].sort());
  }

  const triage = ok(run('bash', ['-c', 'source "$1" || exit; printf "%s" "$PROFILE_TRIAGE_ROUTES"',
    'fixture', path.join(f.profile, 'profile.sh')], { env: f.env }));

  assert.equal(triage, 'feature:light=small feature:mid=small feature:full=feature '
    + 'debug:light=debug debug:mid=debug debug:full=debug');
});

test('SAMPLE-ROUTES-02: owners and contiguous resets', async (t) => {
  const f = await fixture(t);
  const p = await published(f);

  for (const [route, main] of Object.entries(SEQUENCES)) {
    const sequence = [...main, 'ship'];

    for (const node of p.describe(route).nodes) {
      if (node.executor === 'gate') {
        const target = node.id === 'gate_plan' ? 'plan' : 'build';
        const action = JSON.parse(ok(p.cli('transition', ...p.args, '--route', route,
          '--node', node.id, '--outcome', 'rejected'))).action;

        assert.deepEqual(action, expectedAction(sequence, node.id, target));
        continue;
      }

      for (const owner of OWNERS) {
        const action = JSON.parse(ok(p.cli('transition', ...p.args, '--route', route,
          '--node', node.id, '--outcome', 'failed', '--failure-owner', owner))).action;
        const expected = expectedAction(sequence, node.id, failureTarget(route, node.id, owner));

        assert.deepEqual(action, expected, `${route}/${node.id}/${owner}`);

        if (action.rewind) {
          assert.equal(node.retry.productFailure, 0);
        }
      }
    }
  }
});

test('SAMPLE-ROUTES-03: acceptance never skips to success', async (t) => {
  const f = await fixture(t);
  const p = await published(f);

  for (const [route, main] of Object.entries(SEQUENCES)) {
    const sequence = [...main, 'ship'];

    const nodes = p.describe(route).nodes;

    for (const [index, id] of sequence.entries()) {
      const node = nodes.find((item) => item.id === id);
      const outcome = node.executor === 'gate' ? 'approved' : 'done';
      const action = JSON.parse(ok(p.cli('transition', ...p.args, '--route', route,
        '--node', node.id, '--outcome', outcome))).action;

      assert.deepEqual(action, index + 1 === sequence.length
        ? { stop: 'done' } : { next: sequence[index + 1] });

      if (node.executor !== 'gate') {
        for (const rejected of ['skipped', 'failed', 'exhausted']) {
          const stopped = JSON.parse(ok(p.cli('transition', ...p.args, '--route', route,
            '--node', node.id, '--outcome', rejected))).action;

          assert.deepEqual(stopped, { stop: 'human' }, `${route}/${node.id}/${rejected}`);
        }
      }
    }
  }
});

test('SAMPLE-ROUTES-04: prompts preserve product contracts and command boundaries', async (t) => {
  const f = await fixture(t);
  const p = await published(f);
  const readonly = new Set(['plan', 'skeptic', 'repro', 'diagnose', 'browser', 'audit']);

  for (const route of Object.keys(SEQUENCES)) {
    for (const node of p.describe(route).nodes) {
      assert.equal('model' in node || 'provider' in node, false);

      if (node.executor === 'gate') {
        continue;
      }

      assert.equal(node.policy.filesystem, readonly.has(node.id)
        || ['verify', 'recheck'].includes(node.id) ? 'state-only' : 'workspace-write');
      assert.equal(node.policy.browser || 'forbid', node.id === 'browser' ? 'allow' : 'forbid');

      if (['verify', 'recheck'].includes(node.id)) {
        assert.equal(node.executor, 'command');
        continue;
      }

      for (const field of ['task', 'attempt', 'project', 'workspace', 'artifacts', 'evidence', 'decisions']) {
        assert.ok(node.prompt.requiredContext.includes(field), `${route}/${node.id}/${field}`);
      }

      if (['browser', 'repro', 'diagnose'].includes(node.id)) {
        assert.ok(node.prompt.requiredContext.includes('services'));
      }

      if (node.id === 'ship') {
        assert.equal(node.policy.timeoutClass, 'delivery');
        assert.ok(node.prompt.requiredContext.includes('delivery'));
      } else {
        assert.equal(node.policy.timeoutClass, 'browser');
      }

      if (node.id === 'skeptic') {
        assert.deepEqual(node.fanout, {
          mode: 'single',
          maxExecutors: 1,
          degrade: 'forbid',
        });
      }

      if (node.id === 'plan' && node.fanout.mode === 'parallel') {
        assert.equal(node.fanout.degrade, 'allow-single');
      }
    }
  }
});

test('SAMPLE-PROMPTS-01/02/03: engine renders human-first work and task-wide acceptance', async (t) => {
  const f = await fixture(t);
  const p = await published(f);
  const value = await context(f);
  const file = await put(f.root, 'context.json', JSON.stringify(value));
  const render = (route, node) => ok(p.cli('render-route', ...p.args,
    '--route', route, '--node', node, '--context', file));

  for (const [route, first] of [['feature', 'plan'], ['small', 'build'], ['debug', 'repro']]) {
    const text = render(route, first);

    for (const requirement of [/Пункты постановки/, /Карта задачи/, /Как принято у нас/,
      /уже есть в коде/iu, /правил[а-я]* продукта/iu, /объ[её]м[\s\S]*не суж/iu]) {
      assert.match(text, requirement, `${route}/${first}`);
    }
  }

  for (const [route, node] of [['feature', 'plan'], ['debug', 'diagnose']]) {
    assert.match(render(route, node), /(?:перв[а-я]*|начни|начина[а-я]*)[\s\S]*Коротко для человека/iu);
  }

  assert.match(render('feature', 'plan'), /слаб[\s\S]*модел|модел[\s\S]*слаб/iu);
  assert.match(render('feature', 'tests'), /RED/);
  assert.match(render('feature', 'tests'), /GREEN/);
  assert.match(render('feature', 'build'), /tests|TESTS/);
  assert.match(render('small', 'review'), /мелк/iu);
  assert.match(render('feature', 'audit'), /возвращ|верн/iu);

  for (const route of Object.keys(SEQUENCES)) {
    const text = render(route, 'browser');

    for (const requirement of [/вс[еюя][\s\S]*задач/iu, /интерфейс/iu, /браузер/iu,
      /человек/iu, /стенд/iu, /критери/iu]) {
      assert.match(text, requirement, route);
    }
  }

  assert.match(render('small', 'browser'), /15\s*мин/iu);

  const empty = await put(f.root, 'empty.json', '{}');

  assert.notEqual(p.cli('render-route', ...p.args, '--route', 'feature',
    '--node', 'plan', '--context', empty).status, 0);
});

test('SAMPLE-E2E-01: synthetic project passes complete offline chain', async (t) => {
  const f = await fixture(t);

  ok(run('python3', [path.join(f.profile, 'configure.py'), '--factory', path.join(ENGINE, 'bin/factory')],
    { env: f.env }));

  const p = await published(f);
  const definitions = path.join(f.profile, 'routes/definition.test.mjs');
  const previousKit = process.env.GRIGDESK_ROUTES_KIT;

  process.env.GRIGDESK_ROUTES_KIT = f.env.GRIGDESK_ROUTES_KIT;

  try {
    await import(pathToFileURL(definitions).href);
  } finally {
    if (previousKit === undefined) {
      delete process.env.GRIGDESK_ROUTES_KIT;
    } else {
      process.env.GRIGDESK_ROUTES_KIT = previousKit;
    }
  }

  const store = new RoutesStore({ baseDir: p.routes });
  const current = await store.readCurrent(f.project.id);

  assert.equal(current.catalogHash, p.current.catalogHash);

  for (const [route, hash] of Object.entries(p.current.routes)) {
    const stored = await store.readRoute(f.project.id, route, hash);

    assert.ok(stored);
  }

  const stale = run(process.execPath, [path.join(f.profile, 'routes/publish.mjs'), '--publish',
    '--base-dir', p.routes, '--expected-catalog-hash', 'f'.repeat(64)], { env: f.env });

  assert.notEqual(stale.status, 0);
  assert.equal((await store.readCurrent(f.project.id)).catalogHash, p.current.catalogHash);

  const graphFile = path.join(f.profile, 'graph.json');
  const graph = JSON.parse(await readFile(graphFile, 'utf8'));

  graph.capabilities = ['route-v2'];
  await writeFile(graphFile, JSON.stringify(graph));
  ok(run(path.join(ENGINE, 'bin/factory-check'), [f.project.id, '--quick'], { env: f.env }));

  for (const route of Object.keys(SEQUENCES)) {
    ok(run(path.join(ENGINE, 'bin/factory'), ['check', '--profile', f.project.id,
      '--route', route, '--routes-dir', p.routes], { env: f.env }));

    const value = await context(f, route);
    const file = await put(f.root, 'context.json', JSON.stringify(value));

    for (const node of p.describe(route).nodes.filter((item) => item.executor === 'agent')) {
      assert.ok(ok(p.cli('render-route', ...p.args, '--route', route, '--node', node.id,
        '--context', file)).length > 0);
    }
  }

  const value = await context(f);
  const file = await put(f.root, 'bootstrap-context.json', JSON.stringify({ ...value,
    routeCatalog: p.current.routes }));

  assert.ok(ok(p.cli('render-bootstrap', ...p.args, '--node', 'scout', '--context', file)));

  const bootstrap = JSON.parse(ok(p.cli('describe-bootstrap', ...p.args))).machine;

  assert.equal(bootstrap.entry, 'scout');
  assert.deepEqual(bootstrap.sequence, { bootstrap: ['scout'] });
  assert.equal(bootstrap.nodes[0].policy.filesystem, 'state-only');

  for (const outcome of ['done', 'skipped', 'failed', 'exhausted']) {
    const action = JSON.parse(ok(p.cli('transition-bootstrap', ...p.args,
      '--node', 'scout', '--outcome', outcome))).action;

    if (outcome === 'done') {
      assert.deepEqual(action.escalate.routes.slice().sort(), Object.keys(SEQUENCES).sort());
    } else {
      assert.deepEqual(action, { stop: 'human' });
    }
  }

  for (const owner of OWNERS) {
    const action = JSON.parse(ok(p.cli('transition-bootstrap', ...p.args,
      '--node', 'scout', '--outcome', 'failed', '--failure-owner', owner))).action;

    assert.deepEqual(action, { stop: 'human' });
  }

  await put(f.state, `t${TASK}.recon.md`,
    '## Карта задачи\nСинтетическая карта\n### Как принято у нас\nПравила\n');

  const map = ok(run('bash', ['-c',
    'source "$FACTORY_HOME/lib/core.sh"; _stage_task_map_block "$1"', 'fixture',
    path.join(f.state, `t${TASK}.recon.md`)], { env: f.env }));

  assert.match(map, /Синтетическая карта/);
  assert.equal(hook(f, 'profile_workspace_mode').status, 0);
});

test('SAMPLE-SUITE-01: planned test entries are reached by project scripts', async () => {
  const all = await readFile(path.join(ROOT, 'tests/run-all.sh'), 'utf8');
  const server = JSON.parse(await readFile(path.join(ROOT, 'server/package.json'), 'utf8'));
  const offline = await readFile(path.join(ROOT, 'tests/engine/run-offline.sh'), 'utf8');

  assert.match(all, /tests\/docs\/\*\.test\.mjs/);
  assert.match(all, /npm --prefix "\$PROJECT_ROOT\/server" test/);
  assert.match(all, /tests\/engine\/run-offline\.sh/);
  assert.match(server.scripts.test, /tests\/server\/\*\.test\.js/);

  for (const group of ['unit', 'contract', 'integration']) {
    assert.ok(offline.includes(`/${group}`));
  }

  await requireSample('profile/routes/definition.test.mjs');
});
