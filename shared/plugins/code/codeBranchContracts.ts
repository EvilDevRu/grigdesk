import { contractDecoders } from '../../lib/contractDecoders.ts';

const { text, boolean, listOf, nullable, objectOf, oneOf, wholeNumber } = contractDecoders((field) => {
  throw new Error(`Некорректный ответ переключения ветки: ${field}`);
});

const branch = objectOf({
  ref: text,
  name: text,
  kind: oneOf('local', 'remote'),
  commit: text,
  current: boolean,
  occupied: text,
});
const settings = objectOf({
  returnBranch: text,
  stop: text,
  prepare: text,
  build: text,
  start: text,
  check: text,
  url: text,
});
const job = objectOf({
  id: text,
  status: oneOf('running', 'succeeded', 'failed'),
  step: oneOf('checking', 'stop', 'switch', 'prepare', 'build', 'start', 'check', 'done'),
  branch: text,
  commit: text,
  url: text,
  startedAt: wholeNumber,
  finishedAt: wholeNumber,
  message: text,
});
const overview = objectOf({
  branches: listOf(branch),
  settings,
  job: nullable(job),
  actualBranch: text,
  actualCommit: text,
  log: text,
});

export type CodeBranch = ReturnType<typeof branch>;
export type CodeBranchSettings = ReturnType<typeof settings>;
export type CodeBranchJob = ReturnType<typeof job>;
export type CodeBranchOverview = ReturnType<typeof overview>;

export const DEFAULT_CODE_BRANCH_SETTINGS: CodeBranchSettings = {
  returnBranch: 'dev',
  stop: '',
  prepare: '',
  build: '',
  start: '',
  check: '',
  url: '',
};

/**
 * Снимок проверяется целиком до попадания в панель запуска.
 * Фактический checkout отделён от коммита последнего успешного задания.
 */
export function parseCodeBranchOverview(value: unknown): CodeBranchOverview {
  return overview(value, 'branchOverview');
}

/**
 * Команды сохраняются только через явную форму человека.
 * Декодер не извлекает исполняемые настройки из выбранной Git-ветки.
 */
export function parseCodeBranchSettings(value: unknown): CodeBranchSettings {
  return settings(value, 'branchSettings');
}
