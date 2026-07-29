import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  FactoryReviewRouteError,
  inspectFactoryReviewRoute,
  loadFactoryReviewRoute,
} from '../../server/src/lib/reviews/factory-route.js';

async function fixture(t, {
  profile = [
    'PROFILE_REVIEW_ROUTE=quick',
    'PROFILE_ROUTE_STAGES_dev=(SCOUT PLAN BUILD CHECK GATE_ACCEPT)',
    'PROFILE_ROUTE_STAGES_quick=(SCOUT BUILD CHECK GATE_ACCEPT)',
    '',
  ].join('\n'),
  graph = { default_route: 'dev', routes: { dev: {}, quick: {} } },
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-factory-route.'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const profilesDir = path.join(root, 'profiles');
  const profileDir = path.join(profilesDir, 'demo');
  await mkdir(profileDir, { recursive: true });
  const profileFile = path.join(profileDir, 'profile.sh');
  const graphFile = path.join(profileDir, 'graph.json');
  await Promise.all([
    writeFile(profileFile, profile),
    writeFile(graphFile, `${JSON.stringify(graph)}\n`),
  ]);
  return { root, profilesDir, profileDir, profileFile, graphFile };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof FactoryReviewRouteError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test('MAP-07 READY-02: descriptor берётся из runtime Factory profile, а не routesDir', async (t) => {
  const fx = await fixture(t);
  // Editor-only схема с тем же Project намеренно лежит рядом, но helper даже не
  // принимает routesDir и потому не может признать её runtime-маршрутом.
  const editorRoutes = path.join(fx.root, 'routes', 'demo');
  await mkdir(editorRoutes, { recursive: true });
  await writeFile(path.join(editorRoutes, 'forged.json'), '{"stages":["build"]}\n');

  const descriptor = await loadFactoryReviewRoute({
    profilesDir: fx.profilesDir,
    projectId: 'demo',
  });

  assert.deepEqual(descriptor, {
    schemaVersion: 1,
    source: 'factory-profile',
    profileId: 'demo',
    routeId: 'quick',
    stages: ['SCOUT', 'BUILD', 'CHECK', 'GATE_ACCEPT'],
    revision: descriptor.revision,
  });
  assert.match(descriptor.revision, /^factory-review-route:v1:[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(Object.isFrozen(descriptor.stages), true);
});

test('revision стабилен для одного снимка и меняется вместе с Factory profile', async (t) => {
  const fx = await fixture(t);
  const input = { profilesDir: fx.profilesDir, projectId: 'demo' };
  const first = await loadFactoryReviewRoute(input);
  const same = await loadFactoryReviewRoute(input);
  assert.equal(same.revision, first.revision);

  await writeFile(fx.profileFile, [
    'PROFILE_REVIEW_ROUTE=quick',
    'PROFILE_ROUTE_STAGES_quick=(SCOUT BUILD LINT GATE_ACCEPT)',
    '',
  ].join('\n'));
  const changed = await loadFactoryReviewRoute(input);
  assert.notEqual(changed.revision, first.revision);
  assert.deepEqual(changed.stages, ['SCOUT', 'BUILD', 'LINT', 'GATE_ACCEPT']);
});

test('helper не меняет profile.sh и graph.json', async (t) => {
  const fx = await fixture(t);
  const before = await Promise.all([
    readFile(fx.profileFile),
    readFile(fx.graphFile),
  ]);
  await loadFactoryReviewRoute({ profilesDir: fx.profilesDir, projectId: 'demo' });
  const after = await Promise.all([
    readFile(fx.profileFile),
    readFile(fx.graphFile),
  ]);
  assert.deepEqual(after, before);
});

test('MAP-07: отсутствие PROFILE_REVIEW_ROUTE — ожидаемая view-only конфигурация', async (t) => {
  const fx = await fixture(t, {
    profile: 'PROFILE_ROUTE_STAGES_quick=(SCOUT BUILD CHECK GATE_ACCEPT)\n',
  });
  const input = { profilesDir: fx.profilesDir, projectId: 'demo' };

  await expectCode(loadFactoryReviewRoute(input), 'REVIEW_ROUTE_NOT_CONFIGURED');
  assert.deepEqual(await inspectFactoryReviewRoute(input), {
    ready: false,
    descriptor: null,
    error: {
      code: 'REVIEW_ROUTE_NOT_CONFIGURED',
      message: 'Профиль Factory demo не задаёт PROFILE_REVIEW_ROUTE',
    },
  });
});

test('route из graph/editor не подменяет отсутствующий runtime route', async (t) => {
  const fx = await fixture(t, {
    profile: [
      'PROFILE_REVIEW_ROUTE=quick',
      'PROFILE_ROUTE_STAGES_dev=(SCOUT BUILD CHECK GATE_ACCEPT)',
      '',
    ].join('\n'),
    graph: { default_route: 'quick', routes: { quick: {} } },
  });

  await expectCode(
    loadFactoryReviewRoute({ profilesDir: fx.profilesDir, projectId: 'demo' }),
    'REVIEW_ROUTE_NOT_FOUND',
  );
});

test('review route обязан содержать BUILD до GATE_ACCEPT', async (t) => {
  const cases = [
    {
      profile: 'PROFILE_REVIEW_ROUTE=quick\nPROFILE_ROUTE_STAGES_quick=(SCOUT CHECK GATE_ACCEPT)\n',
      code: 'REVIEW_ROUTE_BUILD_REQUIRED',
    },
    {
      profile: 'PROFILE_REVIEW_ROUTE=quick\nPROFILE_ROUTE_STAGES_quick=(SCOUT BUILD CHECK)\n',
      code: 'REVIEW_ROUTE_ACCEPT_GATE_REQUIRED',
    },
    {
      profile: 'PROFILE_REVIEW_ROUTE=quick\nPROFILE_ROUTE_STAGES_quick=(SCOUT GATE_ACCEPT BUILD)\n',
      code: 'REVIEW_ROUTE_ORDER_INVALID',
    },
  ];
  for (const item of cases) {
    await t.test(item.code, async (subtest) => {
      const fx = await fixture(subtest, { profile: item.profile });
      await expectCode(
        loadFactoryReviewRoute({ profilesDir: fx.profilesDir, projectId: 'demo' }),
        item.code,
      );
    });
  }
});

test('битые stage/id и path traversal отклоняются fail-closed', async (t) => {
  const duplicated = await fixture(t, {
    profile: [
      'PROFILE_REVIEW_ROUTE=quick',
      'PROFILE_ROUTE_STAGES_quick=(SCOUT BUILD BUILD GATE_ACCEPT)',
      '',
    ].join('\n'),
  });
  await expectCode(
    loadFactoryReviewRoute({ profilesDir: duplicated.profilesDir, projectId: 'demo' }),
    'REVIEW_ROUTE_STAGES_INVALID',
  );

  await expectCode(
    loadFactoryReviewRoute({ profilesDir: duplicated.profilesDir, projectId: '../demo' }),
    'FACTORY_PROFILE_ID_INVALID',
  );
  await expectCode(
    loadFactoryReviewRoute({ profilesDir: 'profiles', projectId: 'demo' }),
    'FACTORY_PROFILES_DIR_INVALID',
  );
});

test('несуществующий или повреждённый Factory profile не становится review route', async (t) => {
  const fx = await fixture(t, { graph: [] });
  await expectCode(
    loadFactoryReviewRoute({ profilesDir: fx.profilesDir, projectId: 'demo' }),
    'FACTORY_PROFILE_GRAPH_INVALID',
  );
  await expectCode(
    loadFactoryReviewRoute({ profilesDir: fx.profilesDir, projectId: 'missing' }),
    'FACTORY_PROFILE_NOT_FOUND',
  );
});
