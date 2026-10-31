import assert from 'node:assert/strict';
import test from 'node:test';

import { createFactoryBrowserTrusted } from '../../server/src/lib/browser/factoryBrowserTrusted.ts';

import type { FactoryStateAdapter } from '../../server/src/adapters/factoryState.ts';
import type { RoutesStore } from '../../server/src/modules/routes/store.ts';

type Ledger = Awaited<ReturnType<FactoryStateAdapter['readTrustedAttempt']>>;
type Catalog = Awaited<ReturnType<RoutesStore['readCatalog']>>;
type StoredRoute = Awaited<ReturnType<RoutesStore['readRoute']>>;

const ATTEMPT = `a_${'a'.repeat(32)}`;
const HASH = 'a'.repeat(64);
const CATALOG = 'b'.repeat(64);

/**
 * Double сохраняет реальные типы существующих readers, включая nullable cursor.
 * Необязательный hook даёт late terminal/delete во время отдельного await.
 */
function fixture() {
  const calls: unknown[] = [];
  let terminal: Ledger['terminal'] = null;
  let state = 'ready';
  let browser = 'allow';
  let exists = true;
  let catalogRoute = HASH;
  let runKey = 'CHECK';
  const ledger: Ledger = {
    task: '77',
    attempt: ATTEMPT,
    createdAt: '2026-10-30T00:00:00Z',
    profile: 'fixture',
    catalogHash: CATALOG,
    origin: 'fresh',
    previousAttemptId: null,
    queueDispatchId: null,
    runnerPrimaryOverride: '',
    route: 'feature',
    routeHash: HASH,
    terminal: null,
    terminalRecord: null,
    cursor: {
      node: 'check',
      state: 'ready',
      stop: null,
      pauseReason: null
    },
    stageIdentity: { sequence: 4, headEventHash: HASH },
    bootstrapStop: null,
    workspaceMode: 'shared',
    standOwnership: 'external',
    sourceBranch: 'main',
    container: 'fixture',
    serviceHost: '127.0.0.1',
    frontendPort: null,
    apiPort: null,
    repositories: [],
    resources: [],
  };
  const route: StoredRoute = {
    routeHash: HASH,
    prompts: {},
    manifest: {
      schema: 1,
      kind: 'route',
      profile: 'fixture',
      id: 'feature',
      algorithm: 'sha256',
      files: []
    },
    route: {
      schema: 2,
      kind: 'route',
      profile: 'fixture',
      id: 'feature',
      entry: 'check',
      sequence: { main: ['check'] },
      escalation: [],
      nodes: [{
        id: 'check',
        executor: 'agent',
        phase: 'main',
        runKey: 'CHECK',
        policy: { filesystem: 'state-only', browser: 'allow' },
      }],
    },
  };
  const catalog: Catalog = {
    catalogHash: CATALOG,
    prompts: {},
    manifest: {
      schema: 1,
      kind: 'catalog',
      profile: 'fixture',
      algorithm: 'sha256',
      files: []
    },
    catalog: {
      schema: 2,
      profile: 'fixture',
      routes: { feature: HASH },
      bootstrap: { file: 'bootstrap.json' },
    },
    bootstrap: route.route,
  };
  const read = createFactoryBrowserTrusted({
    state: {
      readRegistry: async () => ({ registry: { PROFILE: 'forged-projection' }, mtime: 0 }),
      readTrustedAttempt: async (task, registry) => {
        calls.push(['ledger', task, registry]);

        return {
          ...ledger,
          terminal,
          cursor: {
            node: 'check',
            state,
            stop: null,
            pauseReason: null
          }
        };
      },
    },
    routes: {
      readCatalog: async (profile, hash) => {
        calls.push(['catalog', profile, hash]);

        return { ...catalog, catalog: { ...catalog.catalog, routes: { feature: catalogRoute } } };
      },
      readRoute: async (profile, id, hash) => {
        calls.push(['route', profile, id, hash]);

        const node = route.route.nodes[0]!;

        return { ...route, route: { ...route.route, nodes: [{
          ...node,
          runKey,
          policy: { filesystem: 'state-only', browser }
        }] } };
      },
    },
    projectExists: async () => exists,
  });

  return {
    read,
    calls,
    setTerminal: () => {
      terminal = 'completed';
    },
    pause: () => {
      state = 'paused';
    },
    forbid: () => {
      browser = 'forbid';
    },
    deleteProject: () => {
      exists = false;
    },
    corruptCatalog: () => {
      catalogRoute = 'c'.repeat(64);
    },
    changeRunKey: () => {
      runKey = 'BUILD';
    },
  };
}

test('BR17-T1: trusted adapter читает current pinned catalog и route, а не current pointer/env', async () => {
  const f = fixture();
  const result = await f.read('77');

  assert.equal(result.attempt, ATTEMPT);
  assert.equal(result.runKey, 'CHECK');
  assert.deepEqual(f.calls.slice(1), [
    ['catalog', 'fixture', CATALOG], ['route', 'fixture', 'feature', HASH],
  ]);
});

test('BR17-T2: terminal, paused, forbid, deleted project и mismatched pin дают отказ', async (t) => {
  for (const change of ['setTerminal', 'pause', 'forbid', 'deleteProject', 'corruptCatalog'] as const) {
    await t.test(change, async () => {
      const f = fixture();

      f[change]();
      await assert.rejects(() => f.read('77'), /browser_run_stale/u);
    });
  }
});
