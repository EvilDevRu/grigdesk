import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const routesDirectory = path.dirname(fileURLToPath(import.meta.url));
export const profile = JSON.parse(readFileSync(path.join(routesDirectory, '../project.json'), 'utf8')).id;
export const routeIds = ['small', 'feature', 'debug'];
export const stop = () => ({ stop: 'human' });
export const single = {
  mode: 'single',
  maxExecutors: 1,
  degrade: 'forbid',
};
export const requiredContext = [
  'task', 'attempt', 'project', 'workspace', 'artifacts', 'evidence', 'decisions',
];

/**
 * Формирует точный непрерывный участок возврата до текущего узла.
 * Последующие этапы остаются вне reset, а неизвестные владельцы останавливаются у человека.
 */
export function failureAction(route, id, owner, sequence) {
  let target;

  if (route === 'feature') {
    const matrix = {
      skeptic: {
        plan: 'plan',
        build: 'plan',
      },
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
      audit: {
        tests: 'tests',
        build: 'build',
      },
    };

    target = matrix[id]?.[owner];
  } else if (route === 'debug' && owner === 'plan') {
    if (id === 'diagnose') {
      target = 'repro';
    } else if (['build', 'verify', 'review', 'recheck', 'browser'].includes(id)) {
      target = 'diagnose';
    }
  } else if (['verify', 'review', 'recheck', 'browser'].includes(id)
      && ['build', 'tests'].includes(owner)) {
    target = 'build';
  }

  return target ? {
    rewind: target,
    reset: sequence.slice(sequence.indexOf(target), sequence.indexOf(id) + 1),
  } : stop();
}

/**
 * Создаёт узлы трёх маршрутов из одной общей матрицы прав и возвратов.
 * Проектные команды, модели и адреса в immutable topology не попадают.
 */
export function machine(id, main) {
  const sequence = [...main, 'ship'];
  const nodes = sequence.map((nodeId, index) => {
    const next = sequence[index + 1];
    const common = {
      id: nodeId,
      executor: nodeId.startsWith('gate_') ? 'gate' : 'agent',
      phase: nodeId === 'ship' ? 'tail' : 'main',
      runKey: nodeId.toUpperCase(),
      emits: [],
    };

    if (common.executor === 'gate') {
      const target = nodeId === 'gate_plan' ? 'plan' : 'build';

      return {
        ...common,
        on: {
          approved: { next },
          rejected: {
            rewind: target,
            reset: sequence.slice(sequence.indexOf(target), index + 1),
          },
        },
      };
    }

    const command = ['verify', 'recheck'].includes(nodeId);
    const readonly = ['plan', 'skeptic', 'repro', 'diagnose', 'browser', 'audit'].includes(nodeId);
    const blocks = [{ file: `prompts/${nodeId}.md` }];
    const context = [...requiredContext];

    if (['build', 'browser', 'repro', 'diagnose'].includes(nodeId)) {
      context.push('services');
    }

    if (nodeId === main[0]) {
      blocks.unshift({ file: 'prompts/task-map.md' });
    }

    if (nodeId === 'browser' && id === 'small') {
      blocks.push({ file: 'prompts/browser-budget.md' });
    }

    if (nodeId === 'review') {
      blocks.push({ file: 'prompts/review-fix.md' });
    }

    if (nodeId === 'ship') {
      context.push('delivery');
    }

    return {
      ...common,
      executor: command ? 'command' : 'agent',
      ...(command ? { commandId: nodeId } : {
        prompt: {
          blocks,
          requiredContext: context,
        },
      }),
      policy: {
        filesystem: readonly || command ? 'state-only' : 'workspace-write',
        timeoutClass: nodeId === 'ship' ? 'delivery' : 'browser',
        budgetClass: 'standard',
        browser: nodeId === 'browser' ? 'allow' : 'forbid',
      },
      fanout: single,
      retry: {
        noResult: command ? 0 : 1,
        providerFailure: {
          attempts: command ? 0 : 1,
          strategy: command ? 'none' : 'runner-failover',
        },
        productFailure: 0,
      },
      on: {
        done: next ? { next } : { stop: 'done' },
        skipped: stop(),
        failed: stop(),
        exhausted: stop(),
      },
      onFailure: Object.fromEntries(['plan', 'tests', 'build', 'human', 'environment']
        .map((owner) => [owner, failureAction(id, nodeId, owner, sequence)])),
    };
  });

  return {
    schema: 2,
    kind: 'route',
    profile,
    id,
    title: {
      small: 'Небольшое изменение',
      feature: 'Разработка по TDD',
      debug: 'Исправление ошибки',
    }[id],
    bootstrap: 'skip',
    entry: main[0],
    sequence: { main, tail: ['ship'] },
    nodes,
    escalation: [],
  };
}

/**
 * Читает только используемые prompt-файлы относительно самого образца.
 * Публикация из другого cwd получает те же bytes и не зависит от профилей машины.
 */
export function promptsFor(route) {
  const files = new Set(route.nodes.flatMap((node) => node.prompt?.blocks.map((block) => block.file) || []));

  return Object.fromEntries([...files].map((file) => [file,
    readFileSync(path.join(routesDirectory, file), 'utf8')]));
}
