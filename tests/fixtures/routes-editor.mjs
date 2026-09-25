const PROFILE = 'sample';
const DRAFT_ID = '11111111-1111-4111-8111-111111111111';

const stop = (kind = 'human') => ({ stop: kind });
const next = (id) => ({ next: id });

/**
 * Создаёт независимый исполняемый узел для синтетических вариантов fixture.
 * Значения политики совпадают с безопасными начальными значениями редактора.
 */
export function makeAgentNode({
  id = 'build',
  phase = 'main',
  promptFile = `prompts/${id}.base.md`,
  requiredContext = ['task'],
  on = {
    done: stop('done'),
    skipped: stop(),
    failed: stop('failed'),
    exhausted: stop(),
  },
} = {}) {
  return {
    id,
    executor: 'agent',
    phase,
    runKey: id.toUpperCase(),
    emits: [],
    prompt: {
      blocks: [{ file: promptFile }],
      requiredContext: [...requiredContext],
    },
    policy: {
      filesystem: 'state-only',
      timeoutClass: 'standard',
      budgetClass: 'standard',
      browser: 'forbid',
    },
    fanout: {
      mode: 'single',
      maxExecutors: 1,
      degrade: 'forbid',
    },
    retry: {
      noResult: 0,
      productFailure: 0,
      providerFailure: {
        attempts: 0,
        strategy: 'none',
      },
    },
    on: structuredClone(on),
  };
}

/**
 * Возвращает полный каталог авторства с фиксированными ожидаемыми переходами.
 * Fixture не зависит от конструкторов и преобразователей продукта.
 */
export function makeCatalogInput() {
  const build = makeAgentNode({
    on: {
      done: next('check'),
      skipped: next('gate_accept'),
      failed: stop('failed'),
      exhausted: stop(),
    },
  });
  build.prompt.blocks.push({
    file: 'prompts/build.audit.md',
    when: {
      context: 'task.kind',
      equals: 'audit',
    },
  });

  const scout = makeAgentNode({
    id: 'scout',
    phase: 'bootstrap',
    promptFile: 'bootstrap/prompts/scout.base.md',
    requiredContext: ['task', 'routeCatalog'],
    on: {
      done: { escalate: { routes: ['quick'] } },
      skipped: stop(),
      failed: stop(),
      exhausted: stop(),
    },
  });

  return {
    profile: PROFILE,
    routes: {
      quick: {
        route: {
          schema: 2,
          kind: 'route',
          profile: PROFILE,
          id: 'quick',
          title: 'Быстрый маршрут',
          entry: 'build',
          sequence: {
            main: ['build', 'check', 'gate_accept'],
            tail: [],
          },
          nodes: [
            build,
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
                budgetClass: 'standard',
                browser: 'forbid',
              },
              fanout: {
                mode: 'single',
                maxExecutors: 1,
                degrade: 'forbid',
              },
              retry: {
                noResult: 0,
                productFailure: 0,
                providerFailure: {
                  attempts: 0,
                  strategy: 'none',
                },
              },
              on: {
                done: next('gate_accept'),
                skipped: stop(),
                failed: stop(),
                exhausted: stop(),
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
              id: 'gate_accept',
              executor: 'gate',
              phase: 'main',
              runKey: 'GATE_ACCEPT',
              emits: [],
              on: {
                approved: stop('done'),
                rejected: {
                  rewind: 'build',
                  reset: ['build', 'check', 'gate_accept'],
                },
              },
            },
          ],
          escalation: [],
        },
        prompts: {
          'prompts/build.base.md': 'Создай проверяемый результат.\n',
          'prompts/build.audit.md': 'Для аудита перечисли найденные риски.\n',
        },
      },
    },
    bootstrap: {
      schema: 2,
      kind: 'bootstrap',
      profile: PROFILE,
      id: 'scout',
      entry: 'scout',
      sequence: {
        bootstrap: ['scout'],
      },
      nodes: [scout],
      escalation: [{
        from: 'scout',
        allowedRoutes: ['quick'],
        requiresHumanWhenPinned: true,
      }],
    },
    bootstrapPrompts: {
      'bootstrap/prompts/scout.base.md': 'Выбери маршрут из каталога.\n',
    },
  };
}

/**
 * Даёт новый черновик с полным содержимым и стабильными тестовыми метаданными.
 */
export function makeDraft() {
  const catalog = makeCatalogInput();

  return {
    schema: 1,
    id: DRAFT_ID,
    profile: catalog.profile,
    title: 'Черновик быстрого маршрута',
    revision: 1,
    baseCatalogHash: null,
    baseSourceRevision: 0,
    routes: catalog.routes,
    bootstrap: catalog.bootstrap,
    bootstrapPrompts: catalog.bootstrapPrompts,
    presentation: {},
    provenance: {},
    state: 'editing',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    publication: null,
  };
}
