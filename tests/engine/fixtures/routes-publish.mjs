import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const { RoutesStore } = await import(
  path.resolve(fixtureDir, '../../../server/src/modules/routes/store.js')
);

const [
  baseDir,
  title = 'Диагностика',
  expected = 'null',
  conditionalValue = '"performance"',
] = process.argv.slice(2);
if (!baseDir) throw new Error('baseDir обязателен');
const parsedConditionalValue = JSON.parse(conditionalValue);

const profile = 'demo-profile';
const routeId = 'debug';
const stop = (target = 'human') => ({ stop: target });
const next = (target) => ({ next: target });
const commonAgent = ({ filesystem = 'state-only', ...node }) => ({
  executor: 'agent',
  emits: [],
  policy: {
    filesystem,
    timeoutClass: 'standard',
    budgetClass: 'standard',
  },
  fanout: {
    mode: 'single',
    maxExecutors: 1,
    degrade: 'forbid',
  },
  retry: {
    noResult: 1,
    providerFailure: {
      attempts: 1,
      strategy: 'runner-failover',
    },
    productFailure: 0,
  },
  ...node,
});

const route = {
  schema: 2,
  kind: 'route',
  profile,
  id: routeId,
  title,
  entry: 'instrument',
  sequence: {
    main: ['instrument', 'check', 'gate_plan'],
    tail: ['retro'],
  },
  nodes: [
    commonAgent({
      id: 'instrument',
      phase: 'main',
      runKey: 'INSTRUMENT',
      filesystem: 'transactional-write',
      prompt: {
        blocks: [
          { file: 'prompts/instrument.base.md' },
          {
            file: 'prompts/instrument.performance.md',
            when: {
              context: 'diagnosis.kind',
              equals: parsedConditionalValue,
            },
          },
        ],
        requiredContext: ['task', 'diagnosis'],
      },
      on: {
        done: next('check'),
        skipped: stop(),
        failed: stop(),
        exhausted: stop(),
      },
    }),
    {
      id: 'check',
      executor: 'command',
      phase: 'main',
      runKey: 'CHECK',
      commandId: 'project-check',
      emits: ['check_status'],
      policy: {
        filesystem: 'state-only',
        timeoutClass: 'check',
        budgetClass: 'small',
      },
      fanout: {
        mode: 'single',
        maxExecutors: 1,
        degrade: 'forbid',
      },
      retry: {
        noResult: 0,
        providerFailure: {
          attempts: 0,
          strategy: 'none',
        },
        productFailure: 0,
      },
      on: {
        done: next('gate_plan'),
        skipped: stop(),
        failed: stop('failed'),
        exhausted: stop(),
      },
      onFailure: {
        build: { rewind: 'instrument', reset: ['instrument', 'check'] },
        tests: stop(),
        environment: stop(),
        plan: { rewind: 'instrument', reset: ['instrument', 'check'] },
        human: stop(),
      },
    },
    {
      id: 'check_status',
      executor: 'status',
      phase: 'main',
      key: 'CHECK_STATUS',
      owner: 'check',
    },
    {
      id: 'gate_plan',
      executor: 'gate',
      phase: 'main',
      runKey: 'GATE_PLAN',
      emits: [],
      on: {
        approved: next('retro'),
        rejected: {
          rewind: 'instrument',
          reset: ['instrument', 'check', 'gate_plan'],
        },
      },
    },
    commonAgent({
      id: 'retro',
      phase: 'tail',
      runKey: 'RETRO',
      prompt: {
        blocks: [{ file: 'prompts/retro.base.md' }],
        requiredContext: ['task'],
      },
      on: {
        done: stop('done'),
        skipped: stop('done'),
        failed: stop(),
        exhausted: stop(),
      },
    }),
  ],
  escalation: [],
};

const bootstrap = {
  schema: 2,
  kind: 'bootstrap',
  profile,
  id: 'scout',
  entry: 'scout',
  sequence: {
    bootstrap: ['scout'],
  },
  nodes: [
    commonAgent({
      id: 'scout',
      phase: 'bootstrap',
      runKey: 'SCOUT',
      prompt: {
        blocks: [{ file: 'bootstrap/prompts/scout.base.md' }],
        requiredContext: ['task', 'routeCatalog'],
      },
      on: {
        done: {
          escalate: {
            routes: [routeId],
          },
        },
        skipped: stop(),
        failed: stop(),
        exhausted: stop(),
      },
    }),
  ],
  escalation: [
    {
      from: 'scout',
      allowedRoutes: [routeId],
      requiresHumanWhenPinned: true,
    },
  ],
};

const store = new RoutesStore({ baseDir });
const publishedRoute = await store.publishRoute(profile, routeId, {
  route,
  prompts: {
    'prompts/instrument.base.md': 'Расставь минимальные диагностические логи.',
    'prompts/instrument.performance.md': 'Измерь каждый участок вычисления.',
    'prompts/retro.base.md': 'Зафиксируй полезный урок.',
  },
});
const publishedCatalog = await store.publishCatalog(profile, {
  catalog: {
    schema: 2,
    profile,
    routes: {
      [routeId]: publishedRoute.routeHash,
    },
    bootstrap: {
      file: 'bootstrap/scout.json',
    },
  },
  bootstrap,
  prompts: {
    'bootstrap/prompts/scout.base.md':
      'Выбери маршрут только из закреплённого каталога.',
  },
}, {
  expectedCatalogHash: expected === 'null' ? null : expected,
});

process.stdout.write(`${JSON.stringify({
  profile,
  routeId,
  routeHash: publishedRoute.routeHash,
  catalogHash: publishedCatalog.catalogHash,
})}\n`);
