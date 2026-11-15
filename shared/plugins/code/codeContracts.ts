// Контракт плагина «Код». Сетевой JSON получает тип только после проверки полей.

import { contractDecoders } from '../../lib/contractDecoders.ts';

export class CodeContractError extends Error {
  constructor(path: string) {
    super(`Некорректный ответ плагина «Код»: поле ${path}`);
    this.name = 'CodeContractError';
  }
}

const {
  boolean,
  listOf,
  nullable,
  objectOf,
  oneOf,
  optional,
  record,
  text,
  wholeNumber: numeric,
} = contractDecoders((path) => {
  throw new CodeContractError(path);
});

// Ответ-подтверждение: сервер обязан прислать именно true, а не что-нибудь истинное.
const success = oneOf(true);

const root = objectOf({
  project: text,
  repo: text,
  root: text,
  main: boolean,
  branch: text,
});
const roots = objectOf({ roots: listOf(root) });
const worktree = objectOf({
  path: text,
  main: boolean,
  name: text,
  task: text,
  branch: text,
});
const repoFields = objectOf({
  key: text,
  dir: text,
  trees: listOf(worktree),
});

function repo(value: unknown, path: string) {
  const source = record(value, path);

  return {
    ...repoFields(value, path),
    ...(source.from === undefined ? {} : { from: text(source.from, `${path}.from`) }),
  };
}

const repos = objectOf({ repos: listOf(repo) });
const projectRepo = objectOf({
  key: text,
  dir: text,
});
// Архив читается и здесь: сам «Код» архивный проект не открывает, но показывает
// его, если человек выбрал именно этот проект.
const projects = objectOf({
  projects: listOf(objectOf({
    id: text,
    repos: listOf(projectRepo),
    archivedAt: optional(text),
  })),
});
const directoryEntry = objectOf({
  name: text,
  dir: boolean,
});
const directory = objectOf({ entries: listOf(directoryEntry) });
const file = objectOf({
  size: numeric,
  binary: boolean,
  tooBig: boolean,
  content: text,
});
const gitEntryFields = objectOf({
  path: text,
  status: text,
  add: numeric,
  del: numeric,
  binary: boolean,
});
const gitFileContentFields = objectOf({
  tooBig: boolean,
  oldContent: text,
  newContent: text,
});

function gitGroup(value: unknown, path: string): 'staged' | 'work' | 'commits' {
  if (value !== 'staged' && value !== 'work' && value !== 'commits') {
    throw new CodeContractError(path);
  }

  return value;
}

/**
 * Старый путь есть только при переименовании. Общий taskDiff не задаёт группу,
 * поэтому эти поля остаются необязательными и после проверки JSON.
 */
function gitEntry(value: unknown, path: string) {
  const source = record(value, path);

  return {
    ...gitEntryFields(value, path),
    ...(source.group === undefined ? {} : { group: gitGroup(source.group, `${path}.group`) }),
    ...(source.oldPath === undefined ? {} : { oldPath: text(source.oldPath, `${path}.oldPath`) }),
  };
}

function gitFile(value: unknown, path: string) {
  return {
    ...gitEntry(value, path),
    ...gitFileContentFields(value, path),
  };
}

const gitDiffFields = {
  branch: text,
  stat: text,
  files: listOf(gitFile),
};
const gitDiff = objectOf(gitDiffFields);
const changesFields = {
  branch: text,
  stat: text,
  files: listOf(gitEntry),
  staged: listOf(gitEntry),
};
const changes = objectOf(changesFields);
const trackingRequired = objectOf({
  detached: boolean,
  upstream: text,
  ahead: numeric,
  behind: numeric,
});
function tracking(value: unknown, path: string) {
  const source = record(value, path);

  return {
    ...trackingRequired(value, path),
    ...(source.remote === undefined ? {} : { remote: text(source.remote, `${path}.remote`) }),
  };
}
const logEntry = objectOf({
  hash: text,
  subject: text,
  when: text,
});
const gitRequired = objectOf({ ...changesFields, tracking, log: listOf(logEntry) });

/** Старый сервер мог не прислать headMessage: декодер сохраняет совместимость. */
function git(value: unknown, path: string) {
  const source = record(value, path);

  return {
    ...gitRequired(value, path),
    ...(source.headMessage === undefined
      ? {}
      : { headMessage: text(source.headMessage, `${path}.headMessage`) }),
  };
}

const fileDiffFields = objectOf({
  path: text,
  status: text,
  binary: boolean,
  tooBig: boolean,
  oldContent: text,
  newContent: text,
});
/**
 * Необязательный fingerprint сохраняет совместимость со старым сервером.
 * При наличии проверяется полный SHA256, а не произвольная строка.
 */
function fingerprint(value: unknown, path: string): string {
  const result = text(value, path);

  if (!/^[a-f0-9]{64}$/u.test(result)) {
    throw new CodeContractError(path);
  }

  return result;
}

function fileDiff(value: unknown, path: string) {
  const source = record(value, path);

  return {
    ...fileDiffFields(value, path),
    ...(source.fingerprint === undefined
      ? {}
      : { fingerprint: fingerprint(source.fingerprint, `${path}.fingerprint`) }),
  };
}

export interface CodeComparison {
  group: 'work' | 'staged' | 'commits';
  path: string;
  base?: string;
  to?: string;
  work?: boolean;
}

const reviewFingerprints = objectOf({
  comparisons: listOf(objectOf({
    ...{ group: gitGroup, path: text },
    base: optional(text),
    to: optional(text),
    work: optional(boolean),
    fingerprint: nullable(fingerprint),
  })),
});
const conflictSide = objectOf({
  presence: boolean,
  binary: boolean,
  tooBig: boolean,
  content: text,
  fingerprint,
});
const conflict = objectOf({
  path: text,
  base: conflictSide,
  ours: conflictSide,
  theirs: conflictSide,
  work: conflictSide,
});
const partialAtom = objectOf({
  id: text,
  oldLine: nullable(numeric),
  newLine: nullable(numeric),
  oldText: text,
  newText: text,
});
const partialDiff = objectOf({
  token: text,
  fingerprint: optional(fingerprint),
  path: text,
  group: oneOf('work', 'staged'),
  patch: text,
  hunks: listOf(objectOf({
    id: text,
    oldStart: numeric,
    newStart: numeric,
    atoms: listOf(partialAtom),
  })),
});
const actionEntry = objectOf({ path: text, oldPath: optional(text) });
const actionFailure = objectOf({ path: text, reason: text });
const actionPreview = objectOf({
  token: text,
  eligible: listOf(actionEntry),
  excluded: listOf(actionFailure),
});
const actionResult = objectOf({
  ok: boolean,
  completed: listOf(actionEntry),
  failed: listOf(actionFailure),
  unattempted: listOf(actionEntry),
});
const ignorePreview = objectOf({
  token: text,
  target: oneOf('shared', 'local'),
  rules: listOf(text),
  paths: listOf(text),
});

export interface CodeActionOptions {
  action: 'stage' | 'unstage' | 'discard' | 'clean-new' | 'delete-new-dir';
  group: 'work' | 'staged';
  paths?: string[];
  directory?: string;
  token?: string;
}

export interface CodeIgnoreOptions {
  target: 'shared' | 'local';
  paths?: string[];
  directory?: string;
  token?: string;
}

export interface CodePartialOptions {
  group: 'work' | 'staged';
  path: string;
  token: string;
  atomIds: string[];
}

export const parseCodeReviewFingerprints = (value: unknown) => reviewFingerprints(value, 'fingerprints');
export const parseCodeConflict = (value: unknown) => conflict(value, 'conflict');
export const parseCodePartialDiff = (value: unknown) => partialDiff(value, 'partialDiff');
export const parseCodeActionPreview = (value: unknown) => actionPreview(value, 'actionPreview');
export const parseCodeActionResult = (value: unknown) => actionResult(value, 'actionResult');
export const parseCodeIgnorePreview = (value: unknown) => ignorePreview(value, 'ignorePreview');

export type CodePartialDiff = ReturnType<typeof partialDiff>;
export type CodeActionPreview = ReturnType<typeof actionPreview>;
export type CodeActionResult = ReturnType<typeof actionResult>;
export type CodeConflict = ReturnType<typeof conflict>;

const commitRange = objectOf({
  from: text,
  to: text,
  base: text,
  commits: numeric,
  // Правая сторона — рабочее дерево («с текущими изменениями»), а не коммит `to`.
  work: boolean,
});
const commitsDiff = objectOf({
  branch: text,
  stat: text,
  files: listOf(gitEntry),
  range: commitRange,
});
const stage = objectOf({
  ok: success,
  changed: numeric,
});
const commit = objectOf({
  ok: success,
  hash: text,
  subject: text,
});
const push = objectOf({
  ok: success,
  branch: text,
  remote: text,
  published: boolean,
  tracking,
});
const fetchResult = objectOf({
  ok: success,
  remote: text,
  tracking,
});
const pull = objectOf({
  ok: success,
  branch: text,
  updated: boolean,
  tracking,
});
const undoCommit = objectOf({
  ok: success,
  message: text,
});
const patchResult = objectOf({
  patch: text,
  truncated: boolean,
});
const fileLogEntry = objectOf({
  hash: text,
  base: text,
  subject: text,
  when: text,
  path: text,
});
const fileLog = objectOf({ entries: listOf(fileLogEntry) });
const blameLineFields = objectOf({
  line: numeric,
  hash: text,
  base: text,
  author: text,
  when: text,
  subject: text,
});

type DecodedBlameLine = ReturnType<typeof blameLineFields> & { sourcePath?: string | null };

/**
 * Отсутствие пути означает старый сервер, null — явный запрет перехода к источнику.
 * Пустой или выходящий из корня путь не должен открываться через файловую историю.
 */
function blameLine(value: unknown, path: string): DecodedBlameLine {
  const source = record(value, path);
  const base = blameLineFields(value, path);

  if (source.sourcePath === undefined) {
    return base;
  }
  if (source.sourcePath === null) {
    return { ...base, sourcePath: null };
  }

  const rel = text(source.sourcePath, `${path}.sourcePath`);

  if (!rel || rel.includes('\0') || rel.startsWith('/')
    || rel.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new CodeContractError(`${path}.sourcePath`);
  }

  return { ...base, sourcePath: rel };
}

const blame = objectOf({ lines: listOf(blameLine) });
const searchFile = objectOf({ path: text });
const searchMatch = objectOf({
  path: text,
  line: numeric,
  text,
});
const quickOpen = objectOf({ files: listOf(text) });

const search = objectOf({
  files: listOf(searchFile),
  matches: listOf(searchMatch),
  truncated: boolean,
});
const commitTitle = objectOf({
  ok: success,
  title: text,
  model: text,
  effort: nullable(text),
  truncated: boolean,
});

export type CodeRoot = ReturnType<typeof root>;
export type CodeRootsResponse = ReturnType<typeof roots>;
export type CodeWorktree = ReturnType<typeof worktree>;
export type CodeRepo = ReturnType<typeof repo>;
export type CodeReposResponse = ReturnType<typeof repos>;
export type CodeProject = ReturnType<typeof projects>['projects'][number];
export type CodeDirectoryEntry = ReturnType<typeof directoryEntry>;
export type CodeDirectoryResponse = ReturnType<typeof directory>;
export type CodeFileResponse = ReturnType<typeof file>;
export type CodeFile = CodeFileResponse;
export type CodeGitEntry = ReturnType<typeof gitEntry>;
export type CodeGitFile = ReturnType<typeof gitFile>;
export type CodeGitDiff = ReturnType<typeof gitDiff>;
export type CodeWorktreeChanges = ReturnType<typeof changes>;
export type CodeGitTracking = ReturnType<typeof tracking>;
export type CodeGitLogEntry = ReturnType<typeof logEntry>;
export type CodeGitResponse = ReturnType<typeof git>;
export type CodeGitSnapshot = CodeGitResponse;
export type CodeFileDiffResponse = ReturnType<typeof fileDiff>;
export type CodeCommitsDiffResponse = ReturnType<typeof commitsDiff>;
export type CodeStageResponse = ReturnType<typeof stage>;
export type CodeCommitResponse = ReturnType<typeof commit>;
export type CodePushResponse = ReturnType<typeof push>;
export type CodeFetchResponse = ReturnType<typeof fetchResult>;
export type CodePullResponse = ReturnType<typeof pull>;
export type CodeUndoCommitResponse = ReturnType<typeof undoCommit>;
export type CodePatchResponse = ReturnType<typeof patchResult>;
export type CodeFileLogEntry = ReturnType<typeof fileLogEntry>;
export type CodeFileLogResponse = ReturnType<typeof fileLog>;
export type CodeBlameLine = ReturnType<typeof blameLine>;
export type CodeBlameResponse = ReturnType<typeof blame>;
export type CodeQuickOpenResponse = { files: string[] };

export type CodeSearchResponse = ReturnType<typeof search>;
export type CodeCommitTitleResponse = ReturnType<typeof commitTitle>;

export interface CodeStagedContext {
  files: string;
  stat: string;
  patch: string;
  truncated: boolean;
  recentSubjects: string;
}

export interface CodeRequestContext {
  project: string;
  repoKey: string;
  treePath: string;
}

export interface CodeTarget {
  project: string;
  repo: string;
  root: string;
  path: string;
  line: number;
}

export function parseCodeRoots(value: unknown): CodeRootsResponse {
  return roots(value, 'roots');
}

export function parseCodeRepos(value: unknown): CodeReposResponse {
  return repos(value, 'repos');
}

export function parseCodeProjects(value: unknown): { projects: CodeProject[] } {
  return projects(value, 'projects');
}

export function parseCodeDirectory(value: unknown): CodeDirectoryResponse {
  return directory(value, 'directory');
}

export function parseCodeFile(value: unknown): CodeFileResponse {
  return file(value, 'file');
}

export function parseCodeGit(value: unknown): CodeGitResponse {
  return git(value, 'git');
}

export function parseCodeFileDiff(value: unknown): CodeFileDiffResponse {
  return fileDiff(value, 'fileDiff');
}

export function parseCodeCommitsDiff(value: unknown): CodeCommitsDiffResponse {
  return commitsDiff(value, 'commitsDiff');
}

export function parseCodeStageResponse(value: unknown): CodeStageResponse {
  return stage(value, 'stage');
}

export function parseCodeCommitResponse(value: unknown): CodeCommitResponse {
  return commit(value, 'commit');
}

export function parseCodePushResponse(value: unknown): CodePushResponse {
  return push(value, 'push');
}

export function parseCodeFetchResponse(value: unknown): CodeFetchResponse {
  return fetchResult(value, 'fetch');
}

/**
 * Подтверждение получения проверяется до обновления клиентского снимка.
 * Тип ответа выводится из того же декодера, что проверяет сетевые поля.
 */
export function parseCodePullResponse(value: unknown): CodePullResponse {
  return pull(value, 'pull');
}

export function parseCodeUndoCommitResponse(value: unknown): CodeUndoCommitResponse {
  return undoCommit(value, 'undoCommit');
}

export function parseCodePatch(value: unknown): CodePatchResponse {
  return patchResult(value, 'patch');
}

export function parseCodeFileLog(value: unknown): CodeFileLogResponse {
  return fileLog(value, 'fileLog');
}

export function parseCodeBlame(value: unknown): CodeBlameResponse {
  return blame(value, 'blame');
}

export function parseCodeSearch(value: unknown): CodeSearchResponse {
  return search(value, 'search');
}

export function parseCodeCommitTitleResponse(value: unknown): CodeCommitTitleResponse {
  return commitTitle(value, 'commitTitle');
}

/**
 * Проверяет форму ответа быстрого открытия до принятия в состояние клиента.
 * Повреждённые пути отвергаются общим декодером без преобразования типов.
 */
export function parseCodeQuickOpen(value: unknown): CodeQuickOpenResponse {
  return quickOpen(value, 'quickOpen');
}

const commitSearchEntry = objectOf({
  hash: text,
  oid: text,
  subject: text,
  when: text,
  ordinal: numeric,
});
const commitSearchResponse = objectOf({
  head: text,
  log: listOf(commitSearchEntry),
});

export type CodeCommitSearchEntry = ReturnType<typeof commitSearchEntry>;
export type CodeCommitSearchResponse = ReturnType<typeof commitSearchResponse>;

/**
 * Подтверждает один снимок истории и исходный порядок найденных коммитов.
 * Короткий hash совместим с /git, ordinal не зависит от фильтра поисковой строки.
 */
function decodeCommitHistory(value: unknown, maxEntries: number): CodeCommitSearchResponse {
  const parsed = commitSearchResponse(value, 'commitSearch');
  const hashes = new Set<string>();
  let previous = -1;

  if ((parsed.head && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(parsed.head))
    || (!parsed.head && parsed.log.length) || parsed.log.length > maxEntries) {
    throw new CodeContractError('commitSearch');
  }

  for (const entry of parsed.log) {
    if (!/^[0-9a-f]{4,64}$/u.test(entry.hash)
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(entry.oid) || !entry.oid.startsWith(entry.hash)
      || entry.ordinal < 0 || entry.ordinal > 199 || entry.ordinal <= previous
      || hashes.has(entry.hash)) {
      throw new CodeContractError('commitSearch.log');
    }

    previous = entry.ordinal;
    hashes.add(entry.hash);
  }

  return parsed;
}

/**
 * HTTP-поиск отдаёт не более 50 найденных строк одного снимка.
 * Поля и позиции проверяет тот же декодер, что и перенос выбора между окнами.
 */
export function parseCodeCommitSearch(value: unknown): CodeCommitSearchResponse {
  return decodeCommitHistory(value, 50);
}

/**
 * Перенос сохраняет выбранные записи полного окна из 200 коммитов, а не выдачу одного запроса.
 * Старые ordinals пригодны только после отдельной проверки контекста и HEAD получателем.
 */
export function parseCodeCommitSelectionHistory(value: unknown): CodeCommitSearchResponse {
  return decodeCommitHistory(value, 200);
}

const diffSummary = objectOf({ ok: success, summary: text });

export type CodeDiffSummaryResponse = { ok: true; summary: string };

/**
 * Проверяет успешный DTO сводки до записи результата в состояние панели.
 * Пробельная строка и ответ сверх потолка не становятся успешным сообщением.
 */
export function parseCodeDiffSummary(value: unknown): CodeDiffSummaryResponse {
  const parsed = diffSummary(value, 'diffSummary');

  if (!parsed.summary.trim() || parsed.summary.length > 500) {
    throw new CodeContractError('diffSummary.summary');
  }

  return parsed;
}
