import type { CodeGitFile, CodeGitResponse, CodeRequestContext } from '../../shared/codeContracts.ts';
import { parseCodeGit } from '../../shared/codeContracts.ts';
import { codeApi } from '../../web/src/shared/codeApi.ts';
import type { GitDirectoryRow, GitGroup } from '../../web/src/shared/codeTree.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type FileIsChecked = Checked<IsUnchecked<CodeGitFile>>;
export type ApiGitIsChecked = Checked<IsUnchecked<Awaited<ReturnType<typeof codeApi.git>>>>;
export type ApiProjectIsChecked = Checked<IsUnchecked<Awaited<ReturnType<typeof codeApi.projects>>[number]>>;
export type GroupFileIsChecked = Checked<IsUnchecked<GitGroup['files'][number]>>;

/**
 * Примеры запускает только компилятор. Если неизвестный JSON или неверная цель
 * действия начнут приниматься без проверки, обязательный typecheck упадёт.
 */
function checkContracts(input: unknown, context: CodeRequestContext, row: GitDirectoryRow): void {
  // @ts-expect-error Непроверенный JSON не является снимком Git.
  const unchecked: CodeGitResponse = input;
  // @ts-expect-error Статистика хранится числом, а не строкой интерфейса.
  const lines: CodeGitFile['add'] = '12';
  // @ts-expect-error Группа изменения ограничена индексом и рабочим деревом.
  const group: CodeGitFile['group'] = 'all';
  // @ts-expect-error Каталог не содержит выбранного файла.
  row.file.path.toLowerCase();
  // @ts-expect-error Поле all не принимает текстовый флаг из произвольного JSON.
  codeApi.stage(context, { all: 'true' });
  // @ts-expect-error Клиент отправляет только строковые пути.
  codeApi.unstage(context, { paths: [12] });
  // @ts-expect-error Контекст запроса должен указывать worktree.
  codeApi.git({ project: 'demo', repoKey: 'main' });

  const snapshot = parseCodeGit(input);

  // @ts-expect-error Список изменений может быть пустым.
  snapshot.files[0].path.toLowerCase();

  void [unchecked, lines, group];
}

void checkContracts;
