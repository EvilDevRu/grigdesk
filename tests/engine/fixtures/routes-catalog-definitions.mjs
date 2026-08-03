export const PROFILE_ID = 'demo-profile';
export const ROUTE_IDS = ['debug', 'feature', 'trivial', 'hunt', 'command'];

const stop = (target = 'human') => ({ stop: target });
const next = (target) => ({ next: target });
const rewind = (target, reset) => ({ rewind: target, reset });

function retry(productFailure = 0) {
  return {
    noResult: 1,
    providerFailure: {
      attempts: 1,
      strategy: 'runner-failover',
    },
    productFailure,
  };
}

function agent({
  id,
  runKey,
  phase = 'main',
  filesystem = 'state-only',
  timeoutClass = 'standard',
  budgetClass = 'standard',
  browser,
  fanout = {
    mode: 'single',
    maxExecutors: 1,
    degrade: 'forbid',
  },
  requiredContext = ['task'],
  blocks = [{ file: `prompts/${id}.base.md` }],
  on,
  productFailure = 0,
}) {
  return {
    id,
    executor: 'agent',
    phase,
    runKey,
    emits: [],
    prompt: {
      blocks,
      requiredContext,
    },
    policy: {
      filesystem,
      timeoutClass,
      budgetClass,
      ...(browser ? { browser } : {}),
    },
    fanout,
    retry: retry(productFailure),
    on,
  };
}

function command({ id, runKey, commandId, on, onFailure }) {
  return {
    id,
    executor: 'command',
    phase: 'main',
    runKey,
    commandId,
    emits: [],
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
      providerFailure: { attempts: 0, strategy: 'none' },
      productFailure: 0,
    },
    on,
    ...(onFailure ? { onFailure } : {}),
  };
}

function gate({ id, runKey, approved, rejected = stop() }) {
  return {
    id,
    executor: 'gate',
    phase: 'main',
    runKey,
    emits: [],
    on: {
      approved,
      rejected,
    },
  };
}

function defaultOn(done, overrides = {}) {
  return {
    done,
    skipped: stop(),
    failed: stop(),
    exhausted: stop(),
    ...overrides,
  };
}

function promptsFor(nodeIds, { publish = false } = {}) {
  const prompts = Object.fromEntries(nodeIds.map((nodeId) => [
    `prompts/${nodeId}.base.md`,
    `Выполни fixture-этап ${nodeId} и верни проверяемый результат.`,
  ]));
  if (publish) {
    prompts['prompts/ship.publish.md'] =
      'Публикация принятого изменения разрешена typed-контекстом delivery.';
  }
  return prompts;
}

const shipBlocks = [
  { file: 'prompts/ship.base.md' },
  {
    file: 'prompts/ship.publish.md',
    when: {
      context: 'delivery.mode',
      equals: 'publish',
    },
  },
];

const debugRoute = {
  schema: 2,
  kind: 'route',
  profile: PROFILE_ID,
  id: 'debug',
  title: 'Fixture debug v2',
  entry: 'repro',
  sequence: {
    main: [
      'repro',
      'instrument',
      'diagnose',
      'hyposkeptic',
      'proof',
      'translator',
      'gate_cause',
      'tests',
      'build',
      'review',
      'measure',
      'phpcheck',
      'lint',
      'gate_accept',
    ],
    tail: ['ship', 'retro'],
  },
  nodes: [
    agent({
      id: 'repro',
      runKey: 'REPRO',
      timeoutClass: 'diagnostic',
      on: defaultOn(next('instrument')),
    }),
    agent({
      id: 'instrument',
      runKey: 'INSTRUMENT',
      filesystem: 'transactional-write',
      timeoutClass: 'diagnostic',
      on: defaultOn(next('diagnose'), { skipped: next('diagnose') }),
    }),
    agent({
      id: 'diagnose',
      runKey: 'DIAGNOSE',
      timeoutClass: 'diagnostic',
      on: defaultOn(next('hyposkeptic')),
    }),
    agent({
      id: 'hyposkeptic',
      runKey: 'HYPOSKEPTIC',
      timeoutClass: 'diagnostic',
      on: defaultOn(next('proof')),
    }),
    agent({
      id: 'proof',
      runKey: 'PROOF',
      filesystem: 'transactional-write',
      timeoutClass: 'diagnostic',
      on: defaultOn(next('translator')),
    }),
    agent({
      id: 'translator',
      runKey: 'TRANSLATOR',
      budgetClass: 'small',
      on: defaultOn(next('gate_cause')),
    }),
    gate({
      id: 'gate_cause',
      runKey: 'GATE_CAUSE',
      approved: next('tests'),
    }),
    agent({
      id: 'tests',
      runKey: 'TESTS',
      filesystem: 'workspace-write',
      timeoutClass: 'test',
      on: defaultOn(next('build'), { skipped: next('build') }),
    }),
    agent({
      id: 'build',
      runKey: 'BUILD',
      filesystem: 'workspace-write',
      timeoutClass: 'build',
      budgetClass: 'large',
      productFailure: 1,
      on: defaultOn(next('review')),
    }),
    agent({
      id: 'review',
      runKey: 'REVIEW',
      timeoutClass: 'review',
      on: defaultOn(next('measure')),
    }),
    agent({
      id: 'measure',
      runKey: 'MEASURE',
      timeoutClass: 'diagnostic',
      on: defaultOn(next('phpcheck')),
    }),
    agent({
      id: 'phpcheck',
      runKey: 'PHPCHECK',
      timeoutClass: 'check',
      budgetClass: 'small',
      on: defaultOn(next('lint'), { skipped: next('lint') }),
    }),
    agent({
      id: 'lint',
      runKey: 'LINT',
      timeoutClass: 'check',
      budgetClass: 'small',
      on: defaultOn(next('gate_accept'), { skipped: next('gate_accept') }),
    }),
    gate({
      id: 'gate_accept',
      runKey: 'GATE_ACCEPT',
      approved: next('ship'),
    }),
    agent({
      id: 'ship',
      runKey: 'SHIP',
      phase: 'tail',
      filesystem: 'workspace-write',
      timeoutClass: 'delivery',
      requiredContext: ['task', 'delivery'],
      blocks: shipBlocks,
      on: defaultOn(next('retro')),
    }),
    agent({
      id: 'retro',
      runKey: 'RETRO',
      phase: 'tail',
      budgetClass: 'small',
      on: defaultOn(stop('done'), { skipped: stop('done') }),
    }),
  ],
  escalation: [],
};

const featureRoute = {
  schema: 2,
  kind: 'route',
  profile: PROFILE_ID,
  id: 'feature',
  title: 'Fixture feature v2',
  entry: 'plan',
  sequence: {
    main: ['plan', 'gate_plan'],
    tail: ['ship', 'retro'],
  },
  nodes: [
    agent({
      id: 'plan',
      runKey: 'PLAN',
      timeoutClass: 'planning',
      on: defaultOn(next('gate_plan')),
    }),
    gate({
      id: 'gate_plan',
      runKey: 'GATE_PLAN',
      approved: next('ship'),
      rejected: rewind('plan', ['plan', 'gate_plan']),
    }),
    agent({
      id: 'ship',
      runKey: 'SHIP',
      phase: 'tail',
      filesystem: 'workspace-write',
      timeoutClass: 'delivery',
      requiredContext: ['task', 'delivery'],
      blocks: shipBlocks,
      on: defaultOn(next('retro')),
    }),
    agent({
      id: 'retro',
      runKey: 'RETRO',
      phase: 'tail',
      budgetClass: 'small',
      on: defaultOn(stop('done'), { skipped: stop('done') }),
    }),
  ],
  escalation: [],
};

const trivialRoute = {
  schema: 2,
  kind: 'route',
  profile: PROFILE_ID,
  id: 'trivial',
  title: 'Fixture trivial v2',
  entry: 'build',
  sequence: {
    main: ['build', 'review', 'phpcheck', 'lint', 'gate_accept'],
    tail: ['ship', 'retro'],
  },
  nodes: [
    agent({
      id: 'build',
      runKey: 'BUILD',
      filesystem: 'workspace-write',
      timeoutClass: 'build',
      productFailure: 1,
      on: defaultOn(next('review')),
    }),
    agent({
      id: 'review',
      runKey: 'REVIEW',
      timeoutClass: 'review',
      on: defaultOn(next('phpcheck'), {
        failed: rewind('build', ['build', 'review']),
      }),
    }),
    agent({
      id: 'phpcheck',
      runKey: 'PHPCHECK',
      timeoutClass: 'check',
      budgetClass: 'small',
      on: defaultOn(next('lint'), { skipped: next('lint') }),
    }),
    agent({
      id: 'lint',
      runKey: 'LINT',
      timeoutClass: 'check',
      budgetClass: 'small',
      on: defaultOn(next('gate_accept'), { skipped: next('gate_accept') }),
    }),
    gate({
      id: 'gate_accept',
      runKey: 'GATE_ACCEPT',
      approved: next('ship'),
    }),
    agent({
      id: 'ship',
      runKey: 'SHIP',
      phase: 'tail',
      filesystem: 'workspace-write',
      timeoutClass: 'delivery',
      requiredContext: ['task', 'delivery'],
      blocks: shipBlocks,
      on: defaultOn(next('retro')),
    }),
    agent({
      id: 'retro',
      runKey: 'RETRO',
      phase: 'tail',
      budgetClass: 'small',
      on: defaultOn(stop('done'), { skipped: stop('done') }),
    }),
  ],
  escalation: [],
};

const huntRoute = {
  schema: 2,
  kind: 'route',
  profile: PROFILE_ID,
  id: 'hunt',
  title: 'Fixture hunt v2 without delivery',
  entry: 'hunt_access',
  sequence: {
    main: [
      'hunt_access',
      'hunt_data',
      'hunt_errors',
      'hunt_race',
      'verify',
      'triage',
      'gate_accept',
    ],
    tail: ['retro'],
  },
  nodes: [
    agent({
      id: 'hunt_access',
      runKey: 'HUNT_ACCESS',
      timeoutClass: 'diagnostic',
      on: defaultOn(next('hunt_data'), { skipped: next('hunt_data') }),
    }),
    agent({
      id: 'hunt_data',
      runKey: 'HUNT_DATA',
      timeoutClass: 'diagnostic',
      on: defaultOn(next('hunt_errors'), { skipped: next('hunt_errors') }),
    }),
    agent({
      id: 'hunt_errors',
      runKey: 'HUNT_ERRORS',
      timeoutClass: 'diagnostic',
      on: defaultOn(next('hunt_race'), { skipped: next('hunt_race') }),
    }),
    agent({
      id: 'hunt_race',
      runKey: 'HUNT_RACE',
      timeoutClass: 'diagnostic',
      on: defaultOn(next('verify'), { skipped: next('verify') }),
    }),
    agent({
      id: 'verify',
      runKey: 'VERIFY',
      timeoutClass: 'diagnostic',
      browser: 'allow',
      on: defaultOn(next('triage')),
    }),
    agent({
      id: 'triage',
      runKey: 'TRIAGE',
      on: defaultOn(next('gate_accept')),
    }),
    {
      id: 'gate_accept',
      executor: 'gate',
      phase: 'main',
      runKey: 'GATE_ACCEPT',
      emits: [],
      on: {
        approved: next('retro'),
        rejected: rewind('triage', ['triage', 'gate_accept']),
      },
    },
    agent({
      id: 'retro',
      runKey: 'RETRO',
      phase: 'tail',
      budgetClass: 'small',
      on: defaultOn(stop('done'), { skipped: stop('done') }),
    }),
  ],
  escalation: [],
};

const commandRoute = {
  schema: 2,
  kind: 'route',
  profile: PROFILE_ID,
  id: 'command',
  title: 'Fixture trusted command v2',
  entry: 'prepare',
  sequence: {
    main: ['prepare', 'verify'],
    tail: ['retro'],
  },
  nodes: [
    agent({
      id: 'prepare',
      runKey: 'PREPARE',
      fanout: {
        mode: 'parallel',
        maxExecutors: 3,
        degrade: 'allow-single',
      },
      on: defaultOn(next('verify')),
    }),
    command({
      id: 'verify',
      runKey: 'VERIFY',
      commandId: 'fixture-verify',
      on: defaultOn(next('retro')),
      onFailure: {
        build: rewind('prepare', ['prepare', 'verify']),
        tests: stop(),
        environment: stop(),
        plan: rewind('prepare', ['prepare', 'verify']),
        human: stop(),
      },
    }),
    agent({
      id: 'retro',
      runKey: 'RETRO',
      phase: 'tail',
      budgetClass: 'small',
      on: defaultOn(stop('done'), { skipped: stop('done') }),
    }),
  ],
  escalation: [],
};

export const ROUTE_DEFINITIONS = {
  debug: {
    route: debugRoute,
    prompts: promptsFor([
      'repro',
      'instrument',
      'diagnose',
      'hyposkeptic',
      'proof',
      'translator',
      'tests',
      'build',
      'review',
      'measure',
      'phpcheck',
      'lint',
      'ship',
      'retro',
    ], { publish: true }),
  },
  feature: {
    route: featureRoute,
    prompts: promptsFor(['plan', 'ship', 'retro'], { publish: true }),
  },
  trivial: {
    route: trivialRoute,
    prompts: promptsFor(
      ['build', 'review', 'phpcheck', 'lint', 'ship', 'retro'],
      { publish: true },
    ),
  },
  hunt: {
    route: huntRoute,
    prompts: promptsFor([
      'hunt_access',
      'hunt_data',
      'hunt_errors',
      'hunt_race',
      'verify',
      'triage',
      'retro',
    ]),
  },
  command: {
    route: commandRoute,
    prompts: promptsFor(['prepare', 'retro']),
  },
};

export const bootstrap = {
  schema: 2,
  kind: 'bootstrap',
  profile: PROFILE_ID,
  id: 'scout',
  title: 'Fixture route selection',
  entry: 'scout',
  sequence: {
    bootstrap: ['scout'],
  },
  nodes: [
    agent({
      id: 'scout',
      runKey: 'SCOUT',
      phase: 'bootstrap',
      timeoutClass: 'planning',
      requiredContext: ['task', 'routeCatalog'],
      blocks: [{ file: 'bootstrap/prompts/scout.base.md' }],
      on: {
        done: {
          escalate: {
            routes: ROUTE_IDS,
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
      allowedRoutes: ROUTE_IDS,
      requiresHumanWhenPinned: true,
    },
  ],
};

export const bootstrapPrompts = {
  'bootstrap/prompts/scout.base.md':
    'Подтверди маршрут, закреплённый в fixture-каталоге.',
};

export function catalogForRoutes(routeHashes) {
  return {
    schema: 2,
    profile: PROFILE_ID,
    routes: Object.fromEntries(
      ROUTE_IDS.map((routeId) => [routeId, routeHashes[routeId]]),
    ),
    bootstrap: {
      file: 'bootstrap/scout.json',
    },
  };
}
