export interface BuildStep {
  id: string;
  weightMs?: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  elapsedMs: number;
}

const seconds: Record<string, number> = {
  'server.node': 30,
  'server.build': 240,
  'server.install': 30,
  'web.dependencies': 60,
  'web.build': 45,
  'window.package': 180,
  'window.install': 10,
  'bundle.server': 300,
  'bundle.b24': 120,
  'bundle.relay': 60,
  'bundle.deepseek': 240,
  'bundle.window': 180,
  'bundle.verify': 60,
  'bundle.pack': 30,
  'bundle.publish': 5,
};

/**
 * Оценка использует только завершённые веса и ограниченный вклад текущей стадии.
 * Процент не убывает и достигает ста только после подтверждения общего успеха.
 */
export function estimateBuildProgress(input: {
  steps: readonly BuildStep[];
  elapsedMs: number;
  previousPercent: number;
  succeeded: boolean;
}): { percent: number; remainingMs: number } {
  let total = 0;
  let completed = 0;
  let remainingMs = 0;

  for (const step of input.steps) {
    const weight = step.weightMs ?? (seconds[step.id] ?? 30) * 1000;

    total += weight;

    if (step.status === 'done') {
      completed += weight;
    } else if (step.status === 'running' || step.status === 'failed') {
      completed += weight * Math.min(step.elapsedMs / weight, 0.95);
      remainingMs += Math.max(weight - step.elapsedMs, 0);
    } else {
      remainingMs += weight;
    }
  }

  const percent = input.succeeded ? 100
    : Math.min(99, Math.max(input.previousPercent, total ? completed / total * 100 : 0));

  return { percent, remainingMs: input.succeeded ? 0 : remainingMs };
}

/**
 * Список совпадает с наблюдаемыми стадиями прежней оболочки и переносимого сборщика.
 * Он задаёт оценку до получения первого события, не управляя самой цепочкой сборки.
 */
export function buildStepIds(variant: string): string[] {
  if (variant === 'bundle') {
    return ['server', 'b24', 'relay', 'deepseek', 'window', 'verify', 'pack', 'publish']
      .map((name) => `bundle.${name}`);
  }

  return [
    ...['all', 'server'].includes(variant) ? ['server.node', 'server.build', 'server.install'] : [],
    ...['all', 'web', 'window'].includes(variant) ? ['web.dependencies', 'web.build'] : [],
    ...['all', 'window'].includes(variant) ? ['window.package', 'window.install'] : [],
  ];
}
