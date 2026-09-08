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
const gitFileFields = objectOf({
  path: text,
  status: text,
  add: numeric,
  del: numeric,
  binary: boolean,
  tooBig: boolean,
  oldContent: text,
  newContent: text,
});

function gitGroup(value: unknown, path: string): 'staged' | 'work' {
  if (value !== 'staged' && value !== 'work') {
    throw new CodeContractError(path);
  }

  return value;
}

/**
 * Старый путь есть только при переименовании. Общий taskDiff не задаёт группу,
 * поэтому эти поля остаются необязательными и после проверки JSON.
 */
function gitFile(value: unknown, path: string) {
  const source = record(value, path);

  return {
    ...gitFileFields(value, path),
    ...(source.group === undefined ? {} : { group: gitGroup(source.group, `${path}.group`) }),
    ...(source.oldPath === undefined ? {} : { oldPath: text(source.oldPath, `${path}.oldPath`) }),
  };
}

const gitDiffFields = {
  branch: text,
  stat: text,
  files: listOf(gitFile),
};
const gitDiff = objectOf(gitDiffFields);
const changesFields = {
  ...gitDiffFields,
  staged: listOf(gitFile),
};
const changes = objectOf(changesFields);
const tracking = objectOf({
  detached: boolean,
  upstream: text,
  ahead: numeric,
  behind: numeric,
});
const logEntry = objectOf({
  hash: text,
  subject: text,
  when: text,
});
const git = objectOf({
  ...changesFields,
  tracking,
  log: listOf(logEntry),
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
export type CodeGitFile = ReturnType<typeof gitFile>;
export type CodeGitDiff = ReturnType<typeof gitDiff>;
export type CodeWorktreeChanges = ReturnType<typeof changes>;
export type CodeGitTracking = ReturnType<typeof tracking>;
export type CodeGitLogEntry = ReturnType<typeof logEntry>;
export type CodeGitResponse = ReturnType<typeof git>;
export type CodeGitSnapshot = CodeGitResponse;
export type CodeStageResponse = ReturnType<typeof stage>;
export type CodeCommitResponse = ReturnType<typeof commit>;
export type CodePushResponse = ReturnType<typeof push>;
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

export function parseCodeStageResponse(value: unknown): CodeStageResponse {
  return stage(value, 'stage');
}

export function parseCodeCommitResponse(value: unknown): CodeCommitResponse {
  return commit(value, 'commit');
}

export function parseCodePushResponse(value: unknown): CodePushResponse {
  return push(value, 'push');
}

export function parseCodeCommitTitleResponse(value: unknown): CodeCommitTitleResponse {
  return commitTitle(value, 'commitTitle');
}
