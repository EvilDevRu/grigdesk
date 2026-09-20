// Контракт плагина «Код». Сетевой JSON получает тип только после проверки полей.

import { contractDecoders } from './contractDecoders.ts';

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
const projects = objectOf({
  projects: listOf(objectOf({
    id: text,
    repos: listOf(projectRepo),
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

const fileDiff = objectOf({
  path: text,
  status: text,
  binary: boolean,
  tooBig: boolean,
  oldContent: text,
  newContent: text,
});
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
const blameLine = objectOf({
  line: numeric,
  hash: text,
  base: text,
  author: text,
  when: text,
  subject: text,
});
const blame = objectOf({ lines: listOf(blameLine) });
const searchFile = objectOf({ path: text });
const searchMatch = objectOf({
  path: text,
  line: numeric,
  text,
});
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
export type CodeUndoCommitResponse = ReturnType<typeof undoCommit>;
export type CodePatchResponse = ReturnType<typeof patchResult>;
export type CodeFileLogEntry = ReturnType<typeof fileLogEntry>;
export type CodeFileLogResponse = ReturnType<typeof fileLog>;
export type CodeBlameLine = ReturnType<typeof blameLine>;
export type CodeBlameResponse = ReturnType<typeof blame>;
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
