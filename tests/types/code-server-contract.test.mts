import { stageWorktreeChanges, worktreeChanges, taskDiff } from '../../server/src/lib/git.ts';
import { generateCommitTitle, buildCommitTitlePrompt } from '../../server/src/lib/codeCommitMessage.ts';
import type { CodeModuleOptions } from '../../server/src/modules/code/index.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;
type Changes = Awaited<ReturnType<typeof worktreeChanges>>;

export type ChangesAreChecked = Checked<IsUnchecked<Changes>>;
export type ChangedFileIsChecked = Checked<IsUnchecked<Changes['files'][number]>>;
export type TaskDiffIsChecked = Checked<IsUnchecked<Awaited<ReturnType<typeof taskDiff>>>>;

/**
 * Git и генерация названия возвращают строгие контракты. Соседний JS не должен
 * превращать параметры или результат серверного плагина в непроверенные значения.
 */
async function checkServerContracts(options: CodeModuleOptions, input: unknown): Promise<void> {
  // @ts-expect-error Корень Git является строковым путём.
  worktreeChanges({ cwd: '/tmp/repo' });
  // @ts-expect-error Серверный флаг all уже нормализован HTTP-слоем.
  stageWorktreeChanges('/tmp/repo', { all: 'true' });
  // @ts-expect-error Prompt принимает только проверенный staged context.
  buildCommitTitlePrompt(input);

  const changes = await worktreeChanges('/tmp/repo');

  // @ts-expect-error Список изменений может быть пустым.
  changes.staged[0].path.toLowerCase();

  const result = await generateCommitTitle({ cwd: '/tmp/repo', modelRef: input });

  if (result.ok) {
    result.title.toLowerCase();
    // @ts-expect-error Успех не содержит кода отказа.
    result.error.toLowerCase();
  } else {
    result.error.toLowerCase();
    // @ts-expect-error Отказ модели не содержит названия коммита.
    result.title.toLowerCase();
  }

  void options;
}

void checkServerContracts;
