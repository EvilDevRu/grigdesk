import { parseSandboxJob } from '../../../../shared/plugins/sandboxes/sandboxContracts';
import { sseSubscribe } from '../../composables/useSse.ts';
import { useSandboxesStore } from '../../stores/sandboxes';
import { loadSandboxes } from './loadSandboxes';
import { runtimeOf, type SandboxesStore } from './sandboxesRuntime';

/**
 * Кадр прогресса приходит из сети и доходит до состояния только проверенным:
 * испорченный кадр обязан отбрасываться, а не подменять собой задание.
 */
function applyProgress(store: SandboxesStore, data: unknown) {
  try {
    store.applyJob(parseSandboxJob(data));
  } catch {
    // кадр не по контракту: состояние остаётся прежним
  }
}

/**
 * Подписка на события раздела заводится один раз: раздел живёт прогрессом подъёма,
 * и вкладка, открытая на «Песочницах», обязана его получать.
 */
export function watchSandboxes(): void {
  const store = useSandboxesStore();
  const runtime = runtimeOf(store);

  if (runtime.off) {
    return;
  }

  runtime.off = sseSubscribe((name: string, data: unknown) => {
    if (name === 'sandboxes-changed' || name === 'projects-changed' || name === 'hello') {
      void loadSandboxes({ fresh: name !== 'sandboxes-changed' });
    }

    if (name === 'sandbox-progress') {
      applyProgress(store, data);
    }
  });
}
