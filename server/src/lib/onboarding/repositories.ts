import { git } from '../gitRefresh.ts';
import { checkRepositoryPath } from '../projects/repositoryCheck.ts';
import type { RepositoryInspection } from '../../../../shared/runtime/onboardingContracts.ts';

/**
 * Образец профиля принимает только ограниченные локальные имена веток.
 * Несовместимую ветку показываем, но не подставляем в будущий профиль.
 */
export function compatibleBranch(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(name) && !name.includes('..');
}

/**
 * Все команды только читают локальные refs; индекс и рабочая папка не меняются.
 * Отдельный порт Git позволяет проверить отказы без доступа к личной машине.
 */
export async function inspectRepository(
  dir: string,
  ports: { git?: typeof git } = {},
): Promise<RepositoryInspection> {
  const failed = (reason: string): RepositoryInspection => ({
    state: 'invalid',
    currentBranch: null,
    branches: [],
    reason,
  });

  if (!dir.startsWith('/') || dir.includes('\0')) {
    return failed('invalid_path');
  }

  const check = await checkRepositoryPath(dir);

  if (check.state !== 'git' && check.state !== 'worktree') {
    return failed(check.state);
  }

  try {
    const run = ports.git ?? git;
    const env = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
    const inside = await run(dir, ['rev-parse', '--is-inside-work-tree'], 3000, env);

    if (!inside.ok || inside.out !== 'true') {
      return failed('not_git');
    }

    const refs = await run(dir, ['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads'], 3000, env);
    const head = await run(dir, ['symbolic-ref', '--quiet', 'HEAD'], 3000, env);

    if (!refs.ok) {
      return failed('git_failed');
    }

    const branches = refs.out.split('\n').filter(Boolean).map((name) => ({
      name,
      compatible: compatibleBranch(name),
    }));
    const currentBranch = head.ok ? head.out.replace(/^refs\/heads\//, '') : null;
    const state = branches.length === 0 ? 'unborn' : currentBranch ? 'ok' : 'detached';

    return {
      state,
      currentBranch,
      branches,
      reason: state === 'ok' ? null : state,
    };
  } catch (error) {
    return failed(String((error as NodeJS.ErrnoException).code ?? 'git_failed'));
  }
}
