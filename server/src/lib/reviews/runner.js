// Host-side runner исправления PR. Агент получает только BUILD-envelope и не
// получает publisher. Commit, VERIFY и durable state остаются под контролем host.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  REVIEW_RUN_STATES,
  ReviewStateError,
  ReviewStateStore,
  acceptReviewRunState,
  approveScopeState,
  canonicalDigest,
  completeBuildState,
  completeVerifyState,
  createReviewRunState,
  reviewCriterionId,
  startBuildState,
  startVerifyState,
} from './review-state-machine.js';

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const MAX_OUTPUT = 256 * 1024;
const DEFAULT_LEASE_MS = 30 * 60_000;
const VERIFY_COMMAND_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const RESERVED_VERIFY_COMMAND_IDS = new Set(['git-diff-check', 'verify-not-configured']);

function errorWithCode(code, message, details) {
  const error = new ReviewStateError(code, message, details);
  return error;
}

function clip(value, limit = MAX_OUTPUT) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[обрезано]`;
}

function runExecFile(command, args, {
  cwd,
  env,
  timeout = 120_000,
  maxBuffer = 16 * 1024 * 1024,
} = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd,
      env,
      timeout,
      maxBuffer,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const result = {
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        exitCode: Number.isInteger(error?.code) ? error.code : (error ? 1 : 0),
        signal: error?.signal || null,
        timedOut: error?.killed === true && error?.signal === 'SIGTERM',
      };
      if (error) {
        error.result = result;
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}

export function createBubblewrapVerifyExecutor({
  binary = '/usr/bin/bwrap',
  exec = runExecFile,
} = {}) {
  return Object.freeze({
    async run({ command, args, cwd, env, timeoutMs }) {
      if (!path.isAbsolute(binary) || !path.isAbsolute(cwd)) {
        throw errorWithCode('VERIFY_SANDBOX_INVALID', 'Некорректная конфигурация bwrap');
      }
      try {
        await fs.access(binary, 1);
      } catch {
        throw errorWithCode(
          'VERIFY_SANDBOX_UNAVAILABLE',
          'VERIFY sandbox недоступен; host-native fallback запрещён',
        );
      }
      const nodePrefix = path.dirname(path.dirname(process.execPath));
      const sandboxArgs = [
        '--die-with-parent',
        '--unshare-all',
        '--new-session',
        '--clearenv',
      ];
      for (const source of ['/usr', '/bin', '/lib', '/lib64']) {
        try {
          await fs.access(source);
          sandboxArgs.push('--ro-bind', source, source);
        } catch {
          // Не все дистрибутивы имеют отдельные /bin или /lib64.
        }
      }
      sandboxArgs.push(
        '--dir', '/runtime',
        '--ro-bind', nodePrefix, '/runtime/node',
        '--proc', '/proc',
        '--dev', '/dev',
        '--tmpfs', '/tmp',
        '--dir', '/home',
        '--dir', '/home/cockpit',
        '--bind', cwd, '/workspace',
        '--chdir', '/workspace',
      );
      const sandboxEnv = {
        ...env,
        PATH: `/runtime/node/bin:${env.PATH || '/usr/bin:/bin'}`,
        HOME: '/home/cockpit',
      };
      for (const [key, value] of Object.entries(sandboxEnv)) {
        sandboxArgs.push('--setenv', key, String(value));
      }
      let sandboxCommand = command;
      if (path.isAbsolute(command)
          && (command === nodePrefix || command.startsWith(`${nodePrefix}${path.sep}`))) {
        sandboxCommand = path.posix.join(
          '/runtime/node',
          path.relative(nodePrefix, command).split(path.sep).join('/'),
        );
      }
      sandboxArgs.push('--', sandboxCommand, ...args);
      return exec(binary, sandboxArgs, {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
    },
  });
}

export async function defaultGit(cwd, args, options = {}) {
  // Любая операция host Git (включая worktree add, commit и publisher push)
  // обязана игнорировать repository-configured hooks. Иначе PR-код из
  // versioned .husky может выполниться с host-сетью и host-секретами.
  const explicit = options.env && typeof options.env === 'object' ? options.env : {};
  const network = options.network === true;
  const home = String(
    explicit.HOME
      || (network ? process.env.HOME : '')
      || path.join(os.tmpdir(), 'cockpit-review-git-no-home'),
  );
  const env = {
    PATH: String(explicit.PATH || process.env.PATH || '/usr/bin:/bin'),
    LANG: String(explicit.LANG || 'C.UTF-8'),
    LC_ALL: String(explicit.LC_ALL || 'C.UTF-8'),
    HOME: home,
    // Не наследуем GIT_*, LD_*, NODE_OPTIONS/BASH_ENV и прочие runtime
    // injections из процесса. Local repo config остаётся доступен: он нужен
    // linked worktree, но system/global config не участвуют в host Git.
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
  if (typeof explicit.GIT_INDEX_FILE === 'string') {
    if (!path.isAbsolute(explicit.GIT_INDEX_FILE)
        || explicit.GIT_INDEX_FILE.includes('\0')) {
      throw errorWithCode('GIT_INDEX_FILE_INVALID', 'Некорректный временный Git index');
    }
    env.GIT_INDEX_FILE = explicit.GIT_INDEX_FILE;
  }
  // Сетевому fetch/push оставляем только две явно нужные возможности:
  // SSH agent и host HOME для known_hosts/.ssh/config. На local Git они не
  // попадают, поэтому PR-код не наследует host credential environment.
  if (network) {
    const sshAuthSock = String(explicit.SSH_AUTH_SOCK || process.env.SSH_AUTH_SOCK || '');
    if (sshAuthSock && !sshAuthSock.includes('\0')) env.SSH_AUTH_SOCK = sshAuthSock;
  }
  return runExecFile(options.gitBin || 'git', [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-C', cwd,
    ...args,
  ], {
    timeout: options.timeout ?? 120_000,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    env,
  });
}

function normalizeGitResult(result) {
  if (typeof result === 'string') return { stdout: result, stderr: '', exitCode: 0 };
  return {
    stdout: String(result?.stdout ?? result?.out ?? ''),
    stderr: String(result?.stderr ?? result?.err ?? ''),
    exitCode: Number(result?.exitCode ?? result?.code ?? 0),
  };
}

function commandId(command, index) {
  return String(command?.id || command?.name || `verify-${index + 1}`).trim();
}

function normalizeItemKeys(command, index) {
  const value = command?.itemKeys
    ?? command?.scopeItemKeys
    ?? command?.covers
    ?? [];
  if (!Array.isArray(value)
      || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw errorWithCode(
      'VERIFY_COMMAND_INVALID',
      `Некорректная привязка scope у VERIFY-команды #${index + 1}`,
    );
  }
  return [...new Set(value.map((item) => item.trim()))].sort();
}

function normalizeVerifyCommand(command, index) {
  if (Array.isArray(command)) {
    if (!command.length || !command.every((part) => typeof part === 'string' && part.length > 0)) {
      throw errorWithCode('VERIFY_COMMAND_INVALID', `Некорректная команда VERIFY #${index + 1}`);
    }
    return {
      id: `verify-${index + 1}`,
      command: command[0],
      args: command.slice(1),
      required: true,
      timeoutMs: 10 * 60_000,
      env: {},
      itemKeys: [],
      coversAllCriteria: false,
      compareBaseline: false,
    };
  }
  if (!command || typeof command.command !== 'string' || !command.command
      || !Array.isArray(command.args ?? [])
      || !(command.args ?? []).every((arg) => typeof arg === 'string')) {
    throw errorWithCode('VERIFY_COMMAND_INVALID', `Некорректная команда VERIFY #${index + 1}`);
  }
  if (command.shell === true) {
    throw errorWithCode('VERIFY_SHELL_FORBIDDEN', 'VERIFY не запускает команды через shell');
  }
  const id = commandId(command, index);
  if (!VERIFY_COMMAND_ID.test(id) || RESERVED_VERIFY_COMMAND_IDS.has(id)) {
    throw errorWithCode(
      'VERIFY_COMMAND_INVALID',
      `Некорректный или зарезервированный id VERIFY-команды #${index + 1}`,
    );
  }
  return {
    id,
    label: String(command.label || command.name || id).trim().slice(0, 256),
    command: command.command,
    args: command.args ?? [],
    required: command.required !== false,
    timeoutMs: Number.isSafeInteger(command.timeoutMs) && command.timeoutMs > 0
      ? command.timeoutMs
      : 10 * 60_000,
    env: command.env && typeof command.env === 'object' ? command.env : {},
    itemKeys: normalizeItemKeys(command, index),
    coversAllCriteria: command.coversAllCriteria === true,
    compareBaseline: command.compareBaseline === true || command.baseline === true,
  };
}

function safeEnvironment(extra = {}, home) {
  const base = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    CI: '1',
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const [key, value] of Object.entries(extra)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key)
        || /(TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|SSH|GITHUB|GH_)/.test(key)) {
      throw errorWithCode('VERIFY_ENV_FORBIDDEN', `Переменная ${key} запрещена в VERIFY`);
    }
    base[key] = String(value);
  }
  return base;
}

function timestamp(now) {
  return Number(typeof now === 'function' ? now() : now);
}

async function executeVerifyCommand(verifyExecutor, command, {
  cwd,
  now,
  reviewRunId,
  phase,
}) {
  const startedAt = timestamp(now);
  try {
    const raw = await verifyExecutor.run({
      command: command.command,
      args: command.args,
      cwd,
      env: safeEnvironment(command.env, '/home/cockpit'),
      timeoutMs: command.timeoutMs,
      reviewRunId,
      phase,
    });
    const exitCode = Number.isInteger(raw?.exitCode) ? raw.exitCode : 0;
    return {
      id: command.id,
      label: command.label || command.id,
      required: command.required,
      ok: raw?.ok !== false && exitCode === 0,
      exitCode,
      signal: raw?.signal || null,
      timedOut: raw?.timedOut === true,
      stdout: clip(raw?.stdout),
      stderr: clip(raw?.stderr),
      execution: 'sandbox',
      phase,
      startedAt,
      finishedAt: timestamp(now),
    };
  } catch (error) {
    return {
      id: command.id,
      label: command.label || command.id,
      required: command.required,
      ok: false,
      exitCode: error.result?.exitCode ?? 1,
      signal: error.result?.signal ?? null,
      timedOut: error.result?.timedOut ?? false,
      stdout: clip(error.result?.stdout),
      stderr: clip(error.result?.stderr || error.message),
      execution: 'sandbox',
      phase,
      startedAt,
      finishedAt: timestamp(now),
    };
  }
}

function outputFingerprint(result, cwd) {
  const workspace = String(cwd || '');
  const normalize = (value) => {
    let text = String(value || '');
    if (workspace) text = text.replaceAll(workspace, '<workspace>');
    return text.replace(/\r\n?/g, '\n').trimEnd();
  };
  return canonicalDigest({
    exitCode: result?.exitCode,
    signal: result?.signal || null,
    timedOut: result?.timedOut === true,
    stdout: normalize(result?.stdout),
    stderr: normalize(result?.stderr),
  });
}

function applyBaselineDelta(candidate, baseline, {
  candidateCwd,
  baselineCwd,
  requested,
}) {
  if (!requested) {
    return {
      ...candidate,
      effectiveOk: candidate.ok,
      delta: {
        requested: false,
        classification: 'candidate-only',
        candidateOk: candidate.ok,
        baselineOk: null,
      },
    };
  }
  if (!baseline || baseline.available === false) {
    return {
      ...candidate,
      effectiveOk: false,
      baseline: baseline || {
        available: false,
        reason: 'baseline не был выполнен',
      },
      delta: {
        requested: true,
        classification: 'baseline-unavailable',
        candidateOk: candidate.ok,
        baselineOk: null,
      },
    };
  }

  let classification;
  let effectiveOk;
  if (baseline.ok && candidate.ok) {
    classification = 'unchanged-pass';
    effectiveOk = true;
  } else if (baseline.ok && !candidate.ok) {
    classification = 'regression';
    effectiveOk = false;
  } else if (!baseline.ok && candidate.ok) {
    classification = 'resolved';
    effectiveOk = true;
  } else {
    const unchanged = outputFingerprint(candidate, candidateCwd)
      === outputFingerprint(baseline, baselineCwd);
    classification = unchanged ? 'known-failure' : 'changed-failure';
    effectiveOk = unchanged;
  }
  return {
    ...candidate,
    effectiveOk,
    baseline: {
      ...baseline,
      available: true,
    },
    delta: {
      requested: true,
      classification,
      candidateOk: candidate.ok,
      baselineOk: baseline.ok,
    },
  };
}

function buildVerifyTraceability(state, results) {
  const treeDigest = canonicalDigest({
    candidateCommit: state.candidate.commit,
    candidateTree: state.candidate.tree,
  });
  const artifacts = [{
    id: 'candidate-tree',
    kind: 'git-tree',
    commit: state.candidate.commit,
    tree: state.candidate.tree,
    digest: treeDigest,
  }];
  const diffArtifactIds = [];
  for (const file of state.candidate.diff?.files || []) {
    const id = `diff-${canonicalDigest({
      path: file.path,
      previousPath: file.previousPath || null,
      status: file.status,
    }).slice(0, 20)}`;
    artifacts.push({
      id,
      kind: 'git-diff-file',
      path: file.path,
      previousPath: file.previousPath || null,
      status: file.status,
    });
    diffArtifactIds.push(id);
  }
  for (const command of results) {
    artifacts.push({
      id: `command-log-${canonicalDigest(command.id).slice(0, 20)}`,
      kind: 'command-log',
      commandId: command.id,
      fields: command.baseline
        ? ['stdout', 'stderr', 'baseline.stdout', 'baseline.stderr']
        : ['stdout', 'stderr'],
    });
  }

  const criteria = (state.scope || []).map((item) => {
    const acceptanceCriterion = String(item.instruction || '').trim();
    const required = Boolean(acceptanceCriterion);
    const mapped = results.filter((command) => command.source === 'project'
      && (command.coversAllCriteria || command.itemKeys.includes(item.itemKey)));
    let status = 'not-required';
    let reason = 'Для замечания не задан отдельный обязательный критерий приёмки';
    if (required && mapped.length === 0) {
      status = 'unchecked';
      reason = 'К обязательному критерию не привязана ни одна VERIFY-команда';
    } else if (required && mapped.every((command) => command.effectiveOk === true)) {
      status = 'passed';
      reason = 'Все привязанные проверки дали достаточное доказательство';
    } else if (required) {
      status = 'failed';
      reason = 'Хотя бы одна привязанная проверка не прошла или дала новую регрессию';
    }
    return {
      id: reviewCriterionId(item),
      itemKey: item.itemKey,
      itemVersion: item.itemVersion,
      acceptanceCriterion: acceptanceCriterion || null,
      required,
      status,
      reason,
      commandIds: mapped.map((command) => command.id),
      diffArtifactIds: [...diffArtifactIds],
    };
  });
  const links = criteria.map((criterion) => ({
    criterionId: criterion.id,
    itemKey: criterion.itemKey,
    diffArtifactIds: [...criterion.diffArtifactIds],
    commandIds: [...criterion.commandIds],
    result: criterion.status,
  }));
  return {
    treeDigest,
    artifacts,
    criteria,
    links,
  };
}

function uniqueRunId() {
  return `rr-${Date.now().toString(36)}-${crypto.randomUUID().replaceAll('-', '')}`;
}

function uniqueOwner(prefix) {
  return `${prefix}-${process.pid}-${crypto.randomUUID()}`;
}

export function createBuildEnvelope(run) {
  const cwd = run.binding.worktreePath;
  if (!cwd || !path.isAbsolute(cwd)) {
    throw errorWithCode('WORKTREE_REQUIRED', 'BUILD требует подготовленный worktree');
  }
  return Object.freeze({
    schemaVersion: 1,
    stage: 'BUILD',
    reviewRunId: run.reviewRunId,
    cwd,
    baseHeadSha: run.binding.headSha,
    scope: structuredClone(run.scope),
    filesystem: Object.freeze({
      writableRoots: Object.freeze([cwd]),
      readableRoots: Object.freeze([cwd]),
      deniedNames: Object.freeze([
        '.env',
        '.git-credentials',
        '.npmrc',
        '.netrc',
        '.config/gh',
      ]),
    }),
    capabilities: Object.freeze({
      gitPush: false,
      githubMutation: false,
      publisher: false,
      siblingWorktrees: false,
      hostHome: false,
      arbitraryNetwork: false,
    }),
    environment: Object.freeze({
      inheritHostEnvironment: false,
      allow: Object.freeze(['PATH', 'LANG', 'LC_ALL', 'CI']),
    }),
  });
}

async function gitValue(git, cwd, args, options) {
  const result = normalizeGitResult(await git(cwd, args, options));
  return result.stdout.trim();
}

async function gitOutput(git, cwd, args, options) {
  return normalizeGitResult(await git(cwd, args, options)).stdout;
}

async function gitSucceeds(git, cwd, args) {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

async function gitStatus(git, cwd, options) {
  return gitValue(git, cwd, ['status', '--porcelain=v1', '--untracked-files=all'], options);
}

async function candidateReport(git, cwd, baseSha, candidateSha) {
  const [stat, names, patch] = await Promise.all([
    gitValue(git, cwd, [
      'diff', '--no-ext-diff', '--no-textconv', '--stat', `${baseSha}..${candidateSha}`,
    ]),
    gitValue(git, cwd, [
      'diff', '--no-ext-diff', '--no-textconv', '--name-status', `${baseSha}..${candidateSha}`,
    ]),
    gitValue(git, cwd, [
      'diff', '--no-ext-diff', '--no-textconv', '--binary', `${baseSha}..${candidateSha}`,
    ]),
  ]);
  const files = names.split('\n').filter(Boolean).map((line) => {
    const [rawStatus, ...paths] = line.split('\t');
    return {
      status: rawStatus,
      path: paths.at(-1),
      previousPath: paths.length > 1 ? paths[0] : null,
    };
  });
  return {
    stat,
    files,
    patch: clip(patch, 2 * 1024 * 1024),
    patchTruncated: patch.length > 2 * 1024 * 1024,
  };
}

const SENSITIVE_CANDIDATE_NAMES = new Set([
  '.env',
  '.gitattributes',
  '.gitmodules',
  '.git-credentials',
  '.lfsconfig',
  '.netrc',
  '.npmrc',
  'id_rsa',
  'id_ed25519',
]);

function normalizeAllowedBuildPaths(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw errorWithCode(
      'BUILD_ALLOWED_PATHS_REQUIRED',
      'BUILD adapter не вернул exact allowlist изменённых путей',
    );
  }
  const paths = value.map((entry) => {
    const relativePath = String(entry || '');
    const parts = relativePath.split('/');
    const basename = parts.at(-1)?.toLowerCase() || '';
    if (!relativePath
        || relativePath.includes('\\')
        || path.posix.normalize(relativePath) !== relativePath
        || path.posix.isAbsolute(relativePath)
        || parts.some((part) => !part || part === '.' || part === '..')
        || SENSITIVE_CANDIDATE_NAMES.has(basename)
        || basename.startsWith('.env.')
        || /\.(?:pem|p12|pfx|key)$/i.test(basename)
        || /[\u0000\r\n]/.test(relativePath)) {
      throw errorWithCode(
        'BUILD_ALLOWED_PATH_INVALID',
        `BUILD adapter вернул небезопасный путь ${relativePath || '(пусто)'}`,
      );
    }
    return relativePath;
  });
  if (new Set(paths).size !== paths.length) {
    throw errorWithCode('BUILD_ALLOWED_PATH_DUPLICATE', 'BUILD allowlist содержит дубли');
  }
  return paths.sort();
}

async function stagedCandidatePaths(git, cwd) {
  const result = normalizeGitResult(await git(cwd, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--cached',
    '--name-only',
    '-z',
    '--diff-filter=ACMRD',
  ]));
  return result.stdout.split('\0').filter(Boolean).sort();
}

function buildEvidence(result, allowedPaths, scope) {
  const scopeKeys = new Set((scope || []).map((item) => item.itemKey));
  const perRemark = Array.isArray(result?.perRemark)
    ? result.perRemark
      .filter((item) => scopeKeys.has(String(item?.itemKey || '')))
      .map((item) => ({
        itemKey: String(item.itemKey),
        change: clip(item.change, 20_000),
        verification: clip(item.verification, 20_000),
      }))
    : [];
  const reviewItems = Array.isArray(result?.review?.items)
    ? result.review.items
      .filter((item) => scopeKeys.has(String(item?.itemKey || '')))
      .map((item) => ({
        itemKey: String(item.itemKey),
        status: String(item.status || '').slice(0, 64),
        evidence: clip(item.evidence, 20_000),
      }))
    : [];
  return {
    summary: clip(result?.summary, 20_000),
    allowedPaths: [...allowedPaths],
    perRemark,
    review: result?.review && typeof result.review === 'object'
      ? {
        approved: result.review.approved === true,
        items: reviewItems,
        unrelatedChanges: Array.isArray(result.review.unrelatedChanges)
          ? result.review.unrelatedChanges.map((item) => clip(item, 2_000)).slice(0, 100)
          : [],
        summary: clip(result.review.summary, 20_000),
      }
      : null,
  };
}

async function changedCandidatePathsBeforeStaging(git, cwd) {
  const outputs = await Promise.all([
    gitOutput(git, cwd, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--name-only',
      '-z',
    ]),
    gitOutput(git, cwd, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--cached',
      '--name-only',
      '-z',
    ]),
    gitOutput(git, cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
    // Игнорируемый .gitattributes всё равно влияет на `git add` соседних
    // файлов. Поэтому отдельно видим и ignored untracked paths.
    gitOutput(git, cwd, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '-z',
    ]),
  ]);
  const ignoredControls = outputs[3]
    .split('\0')
    .filter(Boolean)
    .filter((relativePath) => {
      const basename = relativePath.split('/').at(-1)?.toLowerCase();
      return basename === '.gitattributes' || basename === '.lfsconfig';
    });
  return [...new Set(
    outputs.slice(0, 3)
      .flatMap((output) => output.split('\0').filter(Boolean))
      .concat(ignoredControls),
  )].sort();
}

function assertBuildAttributeControlsUnchanged(paths) {
  for (const relativePath of paths) {
    const basename = relativePath.split('/').at(-1)?.toLowerCase();
    if (basename === '.gitattributes' || basename === '.lfsconfig') {
      throw errorWithCode(
        'BUILD_GIT_ATTRIBUTES_FORBIDDEN',
        `BUILD не может менять ${relativePath}: Git attributes управляет host checkout/staging`,
      );
    }
  }
}

async function assertTrackedAttributeControlsExact(git, cwd, exactCommit) {
  const output = await gitOutput(git, cwd, [
    'ls-tree',
    '-r',
    '-z',
    exactCommit,
    '--',
  ]);
  for (const record of output.split('\0').filter(Boolean)) {
    const match = /^([0-7]{6}) ([a-z]+) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(record);
    if (!match) {
      throw errorWithCode(
        'GIT_TREE_LIST_INVALID',
        'Git ls-tree вернул некорректную запись',
      );
    }
    const [, expectedMode, expectedType, expectedObject, relativePath] = match;
    const basename = relativePath.split('/').at(-1)?.toLowerCase();
    if (basename !== '.gitattributes' && basename !== '.lfsconfig') continue;
    try {
      const fullPath = path.resolve(cwd, relativePath);
      if (!fullPath.startsWith(`${path.resolve(cwd)}${path.sep}`)) {
        throw new Error('path escape');
      }
      const stat = await fs.lstat(fullPath);
      const actualMode = stat.isSymbolicLink()
        ? '120000'
        : (stat.isFile() ? ((stat.mode & 0o111) ? '100755' : '100644') : null);
      const actualObject = await gitValue(git, cwd, [
        'hash-object',
        '--no-filters',
        '--',
        relativePath,
      ]);
      if (expectedType !== 'blob'
          || actualMode !== expectedMode
          || actualObject !== expectedObject) {
        throw new Error('content mismatch');
      }
    } catch {
      throw errorWithCode(
        'BUILD_GIT_ATTRIBUTES_FORBIDDEN',
        `BUILD изменил ${relativePath}: Git attributes управляет host checkout/staging`,
      );
    }
  }
}

function attributePathBatches(paths) {
  const batches = [];
  let batch = [];
  let bytes = 0;
  for (const relativePath of paths) {
    if (typeof relativePath !== 'string'
        || !relativePath
        || relativePath.includes('\0')
        || relativePath.includes('\uFFFD')) {
      throw errorWithCode(
        'GIT_ATTRIBUTE_PATH_INVALID',
        'Git attributes получил небезопасный или недекодируемый path',
      );
    }
    const size = Buffer.byteLength(relativePath) + 1;
    if (size > 48 * 1024) {
      throw errorWithCode('GIT_ATTRIBUTE_PATH_INVALID', 'Git path слишком длинный');
    }
    if (batch.length && (batch.length >= 128 || bytes + size > 48 * 1024)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(relativePath);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function assertNoFilterAttributes(git, cwd, paths, options, {
  code,
  message,
}) {
  for (const batch of attributePathBatches(paths)) {
    const output = await gitOutput(git, cwd, [
      '--literal-pathspecs',
      'check-attr',
      '--cached',
      '-z',
      'filter',
      '--',
      ...batch,
    ], options);
    const fields = output.split('\0');
    if (fields.at(-1) === '') fields.pop();
    if (fields.length !== batch.length * 3) {
      throw errorWithCode(
        'GIT_ATTRIBUTE_CHECK_INVALID',
        'Git check-attr вернул неполный результат',
      );
    }
    const requested = new Set(batch);
    for (let index = 0; index < fields.length; index += 3) {
      const [relativePath, attribute, value] = fields.slice(index, index + 3);
      if (!requested.has(relativePath) || attribute !== 'filter' || !value) {
        throw errorWithCode(
          'GIT_ATTRIBUTE_CHECK_INVALID',
          'Git check-attr вернул неожиданный результат',
        );
      }
      if (value !== 'unspecified') {
        throw errorWithCode(code, message, {
          path: relativePath,
          filter: value,
        });
      }
    }
  }
}

async function validateCandidatePaths(git, cwd) {
  const raw = normalizeGitResult(await git(cwd, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--cached',
    '--name-only',
    '-z',
    '--diff-filter=ACMRD',
  ])).stdout;
  const files = raw.split('\0').filter(Boolean);
  for (const relativePath of files) {
    const parts = relativePath.split('/');
    const basename = parts.at(-1).toLowerCase();
    if (path.isAbsolute(relativePath)
        || parts.includes('..')
        || SENSITIVE_CANDIDATE_NAMES.has(basename)
        || basename.startsWith('.env.')
        || /\.(?:pem|p12|pfx|key)$/i.test(basename)) {
      throw errorWithCode(
        'CANDIDATE_PATH_FORBIDDEN',
        `BUILD попытался включить чувствительный путь ${relativePath}`,
      );
    }
    const stage = await gitValue(git, cwd, ['ls-files', '--stage', '--', relativePath]);
    if (stage.startsWith('160000 ')) {
      throw errorWithCode('CANDIDATE_SUBMODULE_FORBIDDEN', 'BUILD не может добавлять submodule');
    }
    const fullPath = path.resolve(cwd, relativePath);
    if (fullPath !== cwd && !fullPath.startsWith(`${path.resolve(cwd)}${path.sep}`)) {
      throw errorWithCode('CANDIDATE_PATH_ESCAPE', 'Candidate path вышел за пределы worktree');
    }
    try {
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(fullPath);
        const resolvedTarget = path.resolve(path.dirname(fullPath), target);
        if (resolvedTarget !== cwd && !resolvedTarget.startsWith(`${path.resolve(cwd)}${path.sep}`)) {
          throw errorWithCode(
            'CANDIDATE_SYMLINK_ESCAPE',
            `Симлинк ${relativePath} выходит за пределы worktree`,
          );
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return files;
}

export function createReviewRunner({
  stateDir,
  worktreeRoot,
  agentAdapter,
  verifyCommands = [],
  gitBin = 'git',
  git: injectedGit,
  verifyExecutor: injectedVerifyExecutor,
  commandRunner,
  verifySandboxBin = '/usr/bin/bwrap',
  now = Date.now,
  leaseTtlMs = DEFAULT_LEASE_MS,
} = {}) {
  if (!path.isAbsolute(String(worktreeRoot || ''))) {
    throw errorWithCode('WORKTREE_ROOT_INVALID', 'worktreeRoot должен быть абсолютным');
  }
  if (!agentAdapter || typeof (agentAdapter.run || agentAdapter.build) !== 'function') {
    throw errorWithCode('AGENT_ADAPTER_INVALID', 'Нужен injected BUILD adapter');
  }
  const store = new ReviewStateStore({ stateDir, now });
  const git = injectedGit
    ? async (cwd, args, options) => normalizeGitResult(await injectedGit(cwd, args, options))
    : async (cwd, args, options = {}) => defaultGit(cwd, args, { ...options, gitBin });
  const verifyExecutor = injectedVerifyExecutor
    || (typeof commandRunner === 'function' ? { run: commandRunner } : commandRunner)
    || createBubblewrapVerifyExecutor({ binary: verifySandboxBin });
  if (typeof verifyExecutor?.run !== 'function') {
    throw errorWithCode('VERIFY_EXECUTOR_INVALID', 'Нужен sandboxed verifyExecutor');
  }

  function worktreePath(reviewRunId) {
    return path.join(worktreeRoot, `review-${reviewRunId}`);
  }

  function candidateBranch(reviewRunId) {
    return `cockpit/review/${reviewRunId}`;
  }

  function baselineWorktreePath(reviewRunId) {
    return path.join(worktreeRoot, `review-baseline-${reviewRunId}`);
  }

  async function ensureBaselineWorktree(state) {
    const target = baselineWorktreePath(state.reviewRunId);
    await assertExactTreeFilterSafe(state.binding.repoPath, state.binding.headSha);
    let exists = false;
    try {
      exists = (await fs.lstat(target)).isDirectory();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (exists) {
      const [head, branch, status] = await Promise.all([
        gitValue(git, target, ['rev-parse', 'HEAD']).catch(() => null),
        gitValue(git, target, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null),
        gitStatus(git, target).catch(() => null),
      ]);
      if (head !== state.binding.headSha || branch !== 'HEAD' || status !== '') {
        throw errorWithCode(
          'VERIFY_BASELINE_COLLISION',
          'Baseline worktree относится не к exact base или был изменён',
        );
      }
      return { path: target, reused: true };
    }
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await git(state.binding.repoPath, [
      'worktree',
      'add',
      '--detach',
      target,
      state.binding.headSha,
    ], { timeout: 120_000 });
    const [head, status] = await Promise.all([
      gitValue(git, target, ['rev-parse', 'HEAD']),
      gitStatus(git, target),
    ]);
    if (head !== state.binding.headSha || status) {
      throw errorWithCode(
        'VERIFY_BASELINE_MISMATCH',
        'Baseline worktree не совпал с exact base',
      );
    }
    return { path: target, reused: false };
  }

  async function removeBaselineWorktree(state, target) {
    if (target !== baselineWorktreePath(state.reviewRunId)) {
      throw errorWithCode('VERIFY_BASELINE_PATH_MISMATCH', 'Некорректный путь baseline worktree');
    }
    await git(state.binding.repoPath, ['worktree', 'remove', '--force', target], {
      timeout: 120_000,
    });
  }

  function disposableGitEnvironment(home) {
    return {
      PATH: process.env.PATH || '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    };
  }

  async function assertExactTreeFilterSafe(repoPath, exactCommit, {
    paths = null,
    code = 'HEAD_FILTER_ATTRIBUTE_FORBIDDEN',
    message = 'Exact PR tree активирует Git filter; host checkout запрещён',
  } = {}) {
    if (!SHA.test(exactCommit || '')) {
      throw errorWithCode('HEAD_SHA_INVALID', 'Некорректный exact SHA для проверки attributes');
    }
    const runtimeRoot = path.join(worktreeRoot, '.git-index-runtime');
    await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const temporary = await fs.mkdtemp(path.join(runtimeRoot, 'attrs-'));
    const options = {
      env: { GIT_INDEX_FILE: path.join(temporary, 'index') },
      timeout: 120_000,
    };
    try {
      // Git 2.34 ещё не умеет `check-attr --source=<tree>`. Временный
      // isolated index даёт тот же exact-tree контракт без checkout и без
      // запуска clean/smudge filter.
      await git(repoPath, ['read-tree', `${exactCommit}^{tree}`], options);
      const checkedPaths = paths || (
        await gitOutput(git, repoPath, [
          'ls-tree',
          '-r',
          '--name-only',
          '-z',
          exactCommit,
          '--',
        ], options)
      ).split('\0').filter(Boolean);
      await assertNoFilterAttributes(git, repoPath, checkedPaths, options, {
        code,
        message,
      });
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }

  async function createDisposableVerifyTree({
    source,
    root,
    phase,
    expectedTree,
  }) {
    const target = path.join(root, phase);
    const resolvedSource = path.resolve(source);
    const home = path.join(root, `.home-${phase}`);
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    const options = { env: disposableGitEnvironment(home), timeout: 120_000 };
    await fs.mkdir(target, { recursive: true, mode: 0o700 });

    // Копировать весь worktree нельзя: git status намеренно не показывает ignored
    // `.env`, локальные кэши и зависимости, а fs.cp раньше переносил их в sandbox.
    // Материализуем только stage-0 entries exact Git tree. Содержимое берём из уже
    // проверенного чистого worktree, а последующий commit/tree-check доказывает,
    // что получился именно expectedTree.
    const trackedOutput = await gitValue(git, resolvedSource, [
      'ls-files',
      '--stage',
      '-z',
    ], options);
    for (const record of trackedOutput.split('\0').filter(Boolean)) {
      const match = /^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])\t([\s\S]+)$/.exec(record);
      if (!match || match[3] !== '0') {
        throw errorWithCode(
          'VERIFY_DISPOSABLE_INDEX_INVALID',
          `Disposable ${phase}: некорректная запись Git index`,
        );
      }
      const mode = match[1];
      const relative = match[4];
      const sourcePath = path.resolve(resolvedSource, relative);
      const targetPath = path.resolve(target, relative);
      if (
        sourcePath === resolvedSource
        || targetPath === target
        || !sourcePath.startsWith(`${resolvedSource}${path.sep}`)
        || !targetPath.startsWith(`${target}${path.sep}`)
        || relative.split(/[\\/]/).includes('.git')
      ) {
        throw errorWithCode(
          'VERIFY_DISPOSABLE_PATH_INVALID',
          `Disposable ${phase}: небезопасный tracked path`,
        );
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(sourcePath);
      if (mode === '100644' || mode === '100755') {
        if (!stat.isFile()) {
          throw errorWithCode(
            'VERIFY_DISPOSABLE_TYPE_MISMATCH',
            `Disposable ${phase}: тип ${relative} не совпал с Git index`,
          );
        }
        await fs.copyFile(sourcePath, targetPath);
        await fs.chmod(targetPath, mode === '100755' ? 0o755 : 0o644);
      } else if (mode === '120000') {
        if (!stat.isSymbolicLink()) {
          throw errorWithCode(
            'VERIFY_DISPOSABLE_TYPE_MISMATCH',
            `Disposable ${phase}: тип ${relative} не совпал с Git index`,
          );
        }
        const link = await fs.readlink(sourcePath);
        const resolvedLink = path.resolve(path.dirname(sourcePath), link);
        const linkRelative = path.relative(resolvedSource, resolvedLink);
        if (
          path.isAbsolute(link)
          || resolvedLink === resolvedSource
          || !resolvedLink.startsWith(`${resolvedSource}${path.sep}`)
          || linkRelative.split(path.sep).includes('.git')
        ) {
          throw errorWithCode(
            'VERIFY_DISPOSABLE_SYMLINK_FORBIDDEN',
            `Disposable ${phase}: symlink ${relative} выходит за exact tree`,
          );
        }
        await fs.symlink(link, targetPath);
      } else {
        throw errorWithCode(
          'VERIFY_DISPOSABLE_TYPE_FORBIDDEN',
          `Disposable ${phase}: Git mode ${mode} не поддерживается`,
        );
      }
    }
    await git(target, ['init', '--initial-branch=verify'], options);
    await git(target, ['add', '-A'], options);
    await git(target, [
      '-c', 'user.name=Cockpit Verify',
      '-c', 'user.email=cockpit-verify@localhost.invalid',
      'commit', '--no-gpg-sign', '--no-verify', '-m', `Disposable ${phase}`,
    ], options);
    const tree = await gitValue(git, target, ['rev-parse', 'HEAD^{tree}'], options);
    if (tree !== expectedTree) {
      throw errorWithCode(
        'VERIFY_DISPOSABLE_TREE_MISMATCH',
        `Disposable ${phase} не совпал с exact Git tree`,
      );
    }
    return { path: target, options };
  }

  async function ensureWorktree(state) {
    const target = worktreePath(state.reviewRunId);
    const branch = candidateBranch(state.reviewRunId);
    const expected = state.binding.headSha;
    let exists = false;
    try {
      const stat = await fs.lstat(target);
      exists = stat.isDirectory();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (exists) {
      const [head, actualBranch] = await Promise.all([
        gitValue(git, target, ['rev-parse', 'HEAD']),
        gitValue(git, target, ['rev-parse', '--abbrev-ref', 'HEAD']),
      ]);
      if (head !== expected || actualBranch !== branch) {
        throw errorWithCode(
          'WORKTREE_COLLISION',
          `Worktree ${target} уже относится к другой базе`,
        );
      }
      await assertExactTreeFilterSafe(state.binding.repoPath, expected);
      return { target, branch };
    }
    try {
      await git(state.binding.repoPath, [
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        state.binding.headRepoUrl,
        state.binding.headRef,
      ], { timeout: 120_000, network: true });
    } catch (error) {
      throw errorWithCode(
        'SNAPSHOT_STALE',
        'Не удалось получить exact head ref PR',
        { gitError: clip(error?.result?.stderr || error?.message, 500) },
      );
    }
    const fetchedHead = await gitValue(git, state.binding.repoPath, ['rev-parse', 'FETCH_HEAD^{commit}'])
      .catch(() => null);
    if (fetchedHead !== expected) {
      throw errorWithCode('SNAPSHOT_STALE', 'Head ref PR изменился после снимка', {
        expected,
        actual: fetchedHead,
      });
    }
    if (!await gitSucceeds(git, state.binding.repoPath, ['cat-file', '-e', `${expected}^{commit}`])) {
      throw errorWithCode('HEAD_SHA_MISSING', 'Exact PR head SHA не появился после fetch');
    }
    // Выполняется до worktree add: checkout применяет filter.<name>.smudge
    // из local repo config с полномочиями host-процесса.
    await assertExactTreeFilterSafe(state.binding.repoPath, expected);
    if (await gitSucceeds(git, state.binding.repoPath, ['show-ref', '--verify', `refs/heads/${branch}`])) {
      throw errorWithCode('CANDIDATE_BRANCH_EXISTS', `Ветка ${branch} уже существует без worktree`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await git(state.binding.repoPath, ['worktree', 'add', '-b', branch, target, expected], {
      timeout: 120_000,
    });
    const actual = await gitValue(git, target, ['rev-parse', 'HEAD']);
    if (actual !== expected) {
      throw errorWithCode('WORKTREE_HEAD_MISMATCH', 'Worktree создан не от exact PR head');
    }
    return { target, branch };
  }

  async function updatePrepared(state, lease, prepared) {
    return store.update(state.reviewRunId, (current) => {
      if (current.binding.headSha !== state.binding.headSha) {
        throw errorWithCode('SNAPSHOT_STALE', 'Head SHA изменился во время provisioning');
      }
      current.binding.worktreePath = prepared.target;
      current.binding.candidateBranch = prepared.branch;
      current.status = REVIEW_RUN_STATES.APPROVED;
      current.recovery = null;
      return current;
    }, {
      owner: lease.owner,
      fencingToken: lease.fencingToken,
    });
  }

  async function claim(reviewRunId, owner, ttl = leaseTtlMs) {
    const leased = await store.acquireLease(reviewRunId, {
      owner,
      now,
      ttlMs: ttl,
    });
    return { state: leased, lease: leased.lease };
  }

  function startLeaseHeartbeat(reviewRunId, lease, ttl = leaseTtlMs) {
    let pending = null;
    let failure = null;
    let stopped = false;
    const tick = () => {
      if (stopped || pending) return;
      pending = store.renewLease(reviewRunId, {
        owner: lease.owner,
        fencingToken: lease.fencingToken,
        now,
        ttlMs: ttl,
      }).then((state) => {
        lease.expiresAt = state.lease.expiresAt;
      }).catch((error) => {
        failure = error;
      }).finally(() => {
        pending = null;
      });
    };
    const interval = setInterval(tick, Math.max(25, Math.min(60_000, Math.floor(ttl / 3))));
    interval.unref?.();
    return {
      async assertOwned() {
        tick();
        if (pending) await pending;
        if (failure) throw failure;
      },
      async stop() {
        stopped = true;
        clearInterval(interval);
        if (pending) await pending;
      },
    };
  }

  async function release(reviewRunId, lease) {
    try {
      return await store.releaseLease(reviewRunId, {
        owner: lease.owner,
        fencingToken: lease.fencingToken,
        now,
      });
    } catch (error) {
      if (error?.code === 'FENCING_TOKEN_STALE') return store.load(reviewRunId);
      throw error;
    }
  }

  async function markFailure(reviewRunId, lease, error, fallbackStatus = REVIEW_RUN_STATES.FAILED) {
    try {
      await store.update(reviewRunId, (state) => {
        state.status = fallbackStatus;
        state.error = {
          code: error?.code || 'REVIEW_RUN_FAILED',
          message: clip(error?.message || 'Неизвестная ошибка', 2_000),
          at: Number(typeof now === 'function' ? now() : now),
        };
        return state;
      }, {
        owner: lease.owner,
        fencingToken: lease.fencingToken,
      });
    } catch (writeError) {
      if (writeError?.code !== 'FENCING_TOKEN_STALE') throw writeError;
    }
  }

  async function prepareWithLease(state, lease) {
    if (state.status !== REVIEW_RUN_STATES.APPROVED) {
      throw errorWithCode('PREPARE_STATE_INVALID', `Нельзя создать worktree из ${state.status}`);
    }
    const provisioning = await store.update(state.reviewRunId, (current) => {
      current.status = REVIEW_RUN_STATES.PROVISIONING;
      return current;
    }, {
      owner: lease.owner,
      fencingToken: lease.fencingToken,
    });
    const prepared = await ensureWorktree(provisioning);
    return updatePrepared(provisioning, lease, prepared);
  }

  async function createRun({
    reviewRunId = uniqueRunId(),
    projectId,
    repositoryId,
    prNumber,
    repoPath,
    headRepoUrl,
    headRef,
    headSha,
    snapshotDigest,
    snapshotVersion,
    reviewRoute = null,
    verificationPolicy = null,
  }) {
    const state = createReviewRunState({
      reviewRunId,
      projectId,
      repositoryId,
      prNumber,
      snapshot: {
        digest: snapshotDigest,
        version: snapshotVersion,
        headSha,
      },
      binding: {
        repoPath,
        headRepoUrl,
        headRef,
        headSha,
      },
      reviewRoute,
      verificationPolicy,
    }, { now });
    return store.createExclusive(state);
  }

  async function approveScope(reviewRunId, input) {
    return store.update(
      reviewRunId,
      (state) => approveScopeState(state, input, { now }),
    );
  }

  async function prepare(reviewRunId, { owner = uniqueOwner('prepare') } = {}) {
    const { state, lease } = await claim(reviewRunId, owner);
    try {
      const prepared = state.binding.worktreePath
        ? state
        : await prepareWithLease(state, lease);
      return await release(reviewRunId, lease) ?? prepared;
    } catch (error) {
      await markFailure(reviewRunId, lease, error, REVIEW_RUN_STATES.BLOCKED);
      await release(reviewRunId, lease);
      throw error;
    }
  }

  async function build(reviewRunId, {
    owner = uniqueOwner('build'),
    instruction = '',
  } = {}) {
    const { state: claimed, lease } = await claim(reviewRunId, owner);
    const heartbeat = startLeaseHeartbeat(reviewRunId, lease);
    try {
      let state = claimed;
      if (!state.binding.worktreePath) state = await prepareWithLease(state, lease);
      if (state.status !== REVIEW_RUN_STATES.APPROVED) {
        throw errorWithCode('BUILD_STATE_INVALID', `BUILD нельзя начать из ${state.status}`);
      }
      const cwd = state.binding.worktreePath;
      const [head, dirty] = await Promise.all([
        gitValue(git, cwd, ['rev-parse', 'HEAD']),
        gitStatus(git, cwd),
      ]);
      if (head !== state.binding.headSha || dirty) {
        throw errorWithCode('BUILD_BASE_DIRTY', 'BUILD не начинается поверх чужих изменений');
      }
      state = await store.update(reviewRunId, (current) => startBuildState(current, { now }), {
        owner: lease.owner,
        fencingToken: lease.fencingToken,
      });
      const envelope = createBuildEnvelope(state);
      const runAgent = agentAdapter.run || agentAdapter.build;
      const result = await runAgent.call(agentAdapter, {
        stage: 'BUILD',
        cwd,
        run: structuredClone(state),
        scope: structuredClone(state.scope),
        instruction: String(instruction),
        envelope,
      });
      if (result?.ok === false) {
        throw errorWithCode(
          'BUILD_AGENT_FAILED',
          result.message || result.summary || 'BUILD adapter сообщил об ошибке',
        );
      }
      const allowedPaths = normalizeAllowedBuildPaths(result?.allowedPaths);
      await heartbeat.assertOwned();
      const afterAgentHead = await gitValue(git, cwd, ['rev-parse', 'HEAD']);
      if (afterAgentHead !== state.binding.headSha) {
        throw errorWithCode('AGENT_CHANGED_HEAD', 'Commit создаёт host runner, а не BUILD adapter');
      }
      await assertTrackedAttributeControlsExact(git, cwd, state.binding.headSha);
      const changedBeforeStaging = await changedCandidatePathsBeforeStaging(git, cwd);
      // Проверяем до `git add`: даже ignored/unlisted .gitattributes способен
      // активировать local filter command во время staging другого файла.
      assertBuildAttributeControlsUnchanged(changedBeforeStaging);
      await assertExactTreeFilterSafe(state.binding.repoPath, state.binding.headSha, {
        paths: changedBeforeStaging,
        code: 'BUILD_FILTER_ATTRIBUTE_FORBIDDEN',
        message: 'BUILD path активирует Git filter exact base; host staging запрещён',
      });
      await git(cwd, ['add', '-A']);
      const hasChanges = !await gitSucceeds(git, cwd, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--cached',
        '--quiet',
      ]);
      if (!hasChanges) {
        throw errorWithCode('BUILD_NO_CHANGES', 'BUILD не создал изменений для candidate');
      }
      const actualPaths = await stagedCandidatePaths(git, cwd);
      if (canonicalDigest(actualPaths) !== canonicalDigest(allowedPaths)) {
        throw errorWithCode(
          'BUILD_PATH_SET_MISMATCH',
          'Фактически staged пути не совпадают с exact BUILD allowlist',
          {
            allowedPaths,
            actualPaths,
          },
        );
      }
      await validateCandidatePaths(git, cwd);
      await git(cwd, [
        '-c', 'user.name=Cockpit Review',
        '-c', 'user.email=cockpit@localhost.invalid',
        'commit', '--no-gpg-sign', '--no-verify', '-m', `Cockpit review ${reviewRunId}`,
      ]);
      const candidateCommit = await gitValue(git, cwd, ['rev-parse', 'HEAD']);
      const candidateTree = await gitValue(git, cwd, ['rev-parse', 'HEAD^{tree}']);
      const diff = await candidateReport(git, cwd, state.binding.headSha, candidateCommit);
      await heartbeat.assertOwned();
      state = await store.update(reviewRunId, (current) => completeBuildState(current, {
        candidateCommit,
        candidateTree,
        diff,
        buildEvidence: buildEvidence(result, allowedPaths, state.scope),
        worktreePath: cwd,
        candidateBranch: current.binding.candidateBranch,
      }, { now }), {
        owner: lease.owner,
        fencingToken: lease.fencingToken,
      });
      await heartbeat.stop();
      await release(reviewRunId, lease);
      return store.load(reviewRunId);
    } catch (error) {
      await heartbeat.stop();
      await markFailure(reviewRunId, lease, error);
      await release(reviewRunId, lease);
      throw error;
    }
  }

  async function verify(reviewRunId, {
    owner = uniqueOwner('verify'),
    commands = verifyCommands,
  } = {}) {
    const { state: claimed, lease } = await claim(reviewRunId, owner);
    const heartbeat = startLeaseHeartbeat(reviewRunId, lease);
    let baselinePath = null;
    let stateForBaselineCleanup = null;
    let verifyRoot = null;
    let candidateVerify = null;
    let baselineVerify = null;
    try {
      let state = await store.update(
        reviewRunId,
        (current) => startVerifyState(current, { now }),
        { owner: lease.owner, fencingToken: lease.fencingToken },
      );
      const cwd = state.binding.worktreePath;
      const [head, tree, beforeStatus] = await Promise.all([
        gitValue(git, cwd, ['rev-parse', 'HEAD']),
        gitValue(git, cwd, ['rev-parse', 'HEAD^{tree}']),
        gitStatus(git, cwd),
      ]);
      if (head !== state.candidate.commit || tree !== state.candidate.tree || beforeStatus) {
        throw errorWithCode('VERIFY_CANDIDATE_CHANGED', 'Candidate изменён до VERIFY');
      }
      const verifyParent = path.join(worktreeRoot, '.verify-runtime');
      await fs.mkdir(verifyParent, { recursive: true, mode: 0o700 });
      verifyRoot = await fs.mkdtemp(path.join(verifyParent, `${reviewRunId}-`));
      candidateVerify = await createDisposableVerifyTree({
        source: cwd,
        root: verifyRoot,
        phase: 'candidate',
        expectedTree: state.candidate.tree,
      });
      const results = [];
      const normalizedCommands = commands.map(normalizeVerifyCommand);
      const normalizedIds = normalizedCommands.map((command) => command.id);
      if (new Set(normalizedIds).size !== normalizedIds.length) {
        throw errorWithCode('VERIFY_COMMAND_DUPLICATE', 'VERIFY-команды имеют одинаковый id');
      }
      const baselineRequested = normalizedCommands.some((command) => command.compareBaseline);
      let baseline = {
        requested: baselineRequested,
        available: false,
        exactBaseSha: state.binding.headSha,
        cleanup: {
          attempted: false,
          ok: !baselineRequested,
        },
      };
      if (baselineRequested) {
        try {
          const preparedBaseline = await ensureBaselineWorktree(state);
          baselinePath = preparedBaseline.path;
          stateForBaselineCleanup = state;
          const baselineTree = await gitValue(git, baselinePath, ['rev-parse', 'HEAD^{tree}']);
          baselineVerify = await createDisposableVerifyTree({
            source: baselinePath,
            root: verifyRoot,
            phase: 'baseline',
            expectedTree: baselineTree,
          });
          baseline = {
            ...baseline,
            available: true,
            reused: preparedBaseline.reused,
          };
        } catch (error) {
          baseline = {
            ...baseline,
            available: false,
            error: {
              code: error?.code || 'VERIFY_BASELINE_UNAVAILABLE',
              message: clip(error?.message, 2_000),
            },
          };
        }
      }
      // Фиксированный Git-check выполняет host runner: это не PR-скрипт, его
      // argv состоит только из уже проверенных object ID. В linked worktree
      // `.git` указывает в metadata основного repo, которое намеренно не
      // монтируется в bwrap с недоверенными командами.
      const gitCheckStartedAt = Number(typeof now === 'function' ? now() : now);
      try {
        const result = await git(cwd, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--check',
          `${state.binding.headSha}..${state.candidate.commit}`,
        ]);
        results.push({
          id: 'git-diff-check',
          label: 'Проверка пробелов и конфликт-маркеров Git',
          required: true,
          ok: true,
          effectiveOk: true,
          exitCode: result.exitCode,
          stdout: clip(result.stdout),
          stderr: clip(result.stderr),
          execution: 'host-fixed-git',
          source: 'host',
          phase: 'candidate',
          itemKeys: [],
          coversAllCriteria: false,
          compareBaseline: false,
          delta: {
            requested: false,
            classification: 'candidate-only',
            candidateOk: true,
            baselineOk: null,
          },
          startedAt: gitCheckStartedAt,
          finishedAt: timestamp(now),
        });
      } catch (error) {
        results.push({
          id: 'git-diff-check',
          label: 'Проверка пробелов и конфликт-маркеров Git',
          required: true,
          ok: false,
          effectiveOk: false,
          exitCode: error?.result?.exitCode ?? 1,
          stdout: clip(error?.result?.stdout),
          stderr: clip(error?.result?.stderr || error?.message),
          execution: 'host-fixed-git',
          source: 'host',
          phase: 'candidate',
          itemKeys: [],
          coversAllCriteria: false,
          compareBaseline: false,
          delta: {
            requested: false,
            classification: 'candidate-only',
            candidateOk: false,
            baselineOk: null,
          },
          startedAt: gitCheckStartedAt,
          finishedAt: timestamp(now),
        });
      }
      if (!normalizedCommands.some((command) => command.required)) {
        results.push({
          id: 'verify-not-configured',
          label: 'Обязательные проверки проекта',
          required: true,
          ok: false,
          effectiveOk: false,
          exitCode: null,
          stdout: '',
          stderr: 'Не настроена ни одна обязательная VERIFY-команда',
          execution: 'not-run',
          source: 'host',
          phase: 'candidate',
          itemKeys: [],
          coversAllCriteria: false,
          compareBaseline: false,
          delta: {
            requested: false,
            classification: 'not-configured',
            candidateOk: false,
            baselineOk: null,
          },
        });
      }
      for (const command of normalizedCommands) {
        await heartbeat.assertOwned();
        let baselineResult = null;
        if (command.compareBaseline) {
          baselineResult = baseline.available
            ? await executeVerifyCommand(verifyExecutor, command, {
              cwd: baselineVerify.path,
              now,
              reviewRunId,
              phase: 'baseline',
            })
            : {
              available: false,
              reason: baseline.error?.message || 'Baseline worktree недоступен',
            };
        }
        const candidateResult = await executeVerifyCommand(verifyExecutor, command, {
          cwd: candidateVerify.path,
          now,
          reviewRunId,
          phase: 'candidate',
        });
        results.push({
          ...applyBaselineDelta(candidateResult, baselineResult, {
            candidateCwd: candidateVerify.path,
            baselineCwd: baselineVerify?.path,
            requested: command.compareBaseline,
          }),
          source: 'project',
          itemKeys: [...command.itemKeys],
          coversAllCriteria: command.coversAllCriteria,
          compareBaseline: command.compareBaseline,
        });
      }
      await heartbeat.assertOwned();
      const [afterHead, afterTree, afterStatus, disposableStatus] = await Promise.all([
        gitValue(git, cwd, ['rev-parse', 'HEAD']),
        gitValue(git, cwd, ['rev-parse', 'HEAD^{tree}']),
        gitStatus(git, cwd),
        gitStatus(git, candidateVerify.path, candidateVerify.options),
      ]);
      const worktreeClean = !afterStatus
        && !disposableStatus
        && afterHead === state.candidate.commit
        && afterTree === state.candidate.tree;
      if (baselinePath) {
        baseline.cleanup.attempted = true;
        try {
          await removeBaselineWorktree(state, baselinePath);
          baseline.cleanup.ok = true;
          baselinePath = null;
          stateForBaselineCleanup = null;
        } catch (error) {
          baseline.cleanup.ok = false;
          baseline.cleanup.error = {
            code: error?.code || 'VERIFY_BASELINE_CLEANUP_FAILED',
            message: clip(error?.message, 2_000),
          };
        }
      }
      await fs.rm(verifyRoot, { recursive: true, force: true });
      verifyRoot = null;
      candidateVerify = null;
      baselineVerify = null;
      const traceability = buildVerifyTraceability(state, results);
      const requiredCriteria = traceability.criteria.filter((item) => item.required);
      const requiredCommands = results.filter((item) => item.required);
      const passed = worktreeClean
        && baseline.cleanup.ok
        && requiredCommands.length > 0
        && requiredCommands.every((item) => item.effectiveOk === true)
        && requiredCriteria.every((item) => item.status === 'passed');
      const summary = {
        status: passed ? 'passed' : 'failed',
        commandCount: results.length,
        projectCommandCount: results.filter((item) => item.source === 'project').length,
        requiredCommandCount: requiredCommands.length,
        passedCommands: results.filter((item) => item.effectiveOk === true).length,
        failedCommands: results.filter((item) => item.effectiveOk !== true).length,
        regressions: results.filter((item) => item.delta?.classification === 'regression').length,
        knownFailures: results
          .filter((item) => item.delta?.classification === 'known-failure').length,
        resolvedFailures: results.filter((item) => item.delta?.classification === 'resolved').length,
        criterionCount: traceability.criteria.length,
        requiredCriterionCount: requiredCriteria.length,
        passedCriteria: requiredCriteria.filter((item) => item.status === 'passed').length,
        failedCriteria: requiredCriteria.filter((item) => item.status === 'failed').length,
        uncheckedCriteria: requiredCriteria.filter((item) => item.status === 'unchecked').length,
      };
      const report = {
        schemaVersion: 2,
        candidateCommit: state.candidate.commit,
        candidateTree: state.candidate.tree,
        candidateTreeDigest: traceability.treeDigest,
        passed,
        worktreeClean,
        unexpectedStatus: disposableStatus || afterStatus || null,
        baseline,
        summary,
        commands: results,
        criteria: traceability.criteria,
        artifacts: traceability.artifacts,
        links: traceability.links,
        aliases: {
          checks: 'commands',
          scopeResults: 'criteria',
          evidence: 'artifacts',
          traceability: 'links',
        },
      };
      state = await store.update(reviewRunId, (current) => completeVerifyState(current, {
        report,
      }, { now }), {
        owner: lease.owner,
        fencingToken: lease.fencingToken,
      });
      await heartbeat.stop();
      await release(reviewRunId, lease);
      return store.load(reviewRunId);
    } catch (error) {
      if (verifyRoot) {
        await fs.rm(verifyRoot, { recursive: true, force: true }).catch(() => {});
      }
      if (baselinePath && stateForBaselineCleanup) {
        await removeBaselineWorktree(stateForBaselineCleanup, baselinePath).catch(() => {});
      }
      await heartbeat.stop();
      await markFailure(reviewRunId, lease, error);
      await release(reviewRunId, lease);
      throw error;
    }
  }

  async function accept(reviewRunId, input) {
    return store.update(
      reviewRunId,
      (state) => acceptReviewRunState(state, input, { now }),
    );
  }

  async function abandon(reviewRunId, {
    actor,
    owner = uniqueOwner('abandon'),
  } = {}) {
    const requestedBy = String(actor || '').trim();
    if (!requestedBy) throw errorWithCode('ACTOR_REQUIRED', 'Нужен автор отказа от результата');
    const { state, lease } = await claim(reviewRunId, owner, 60_000);
    try {
      if (![REVIEW_RUN_STATES.VERIFIED, REVIEW_RUN_STATES.ACCEPTED].includes(state.status)) {
        throw errorWithCode(
          'ABANDON_STATE_INVALID',
          `От результата нельзя отказаться из состояния ${state.status}`,
        );
      }
      await store.update(reviewRunId, (current) => {
        current.status = REVIEW_RUN_STATES.BLOCKED;
        current.acceptance = null;
        current.publication = null;
        current.failure = {
          code: 'RUN_ABANDONED',
          message: 'Пользователь отказался от подготовленного результата',
          actor: requestedBy,
          detectedAt: Number(typeof now === 'function' ? now() : now),
        };
        return current;
      }, {
        owner: lease.owner,
        fencingToken: lease.fencingToken,
      });
      await release(reviewRunId, lease);
      return store.load(reviewRunId);
    } catch (error) {
      await release(reviewRunId, lease);
      throw error;
    }
  }

  async function cleanup(reviewRunId, {
    actor,
    discardCandidate = false,
    owner = uniqueOwner('cleanup'),
  } = {}) {
    const requestedBy = String(actor || '').trim();
    if (!requestedBy) throw errorWithCode('ACTOR_REQUIRED', 'Нужен автор ручного cleanup');
    const before = await store.load(reviewRunId);
    if (before.cleanup?.status === 'completed') return before;
    const terminal = new Set([
      REVIEW_RUN_STATES.VERIFICATION_FAILED,
      REVIEW_RUN_STATES.PUBLISHED,
      REVIEW_RUN_STATES.STALE,
      REVIEW_RUN_STATES.BLOCKED,
      REVIEW_RUN_STATES.FAILED,
    ]);
    if (!terminal.has(before.status)) {
      throw errorWithCode(
        'CLEANUP_STATE_INVALID',
        `Среду нельзя удалить из состояния ${before.status}`,
      );
    }
    const expectedPath = worktreePath(reviewRunId);
    if (!before.binding.worktreePath
        || path.resolve(before.binding.worktreePath) !== path.resolve(expectedPath)) {
      throw errorWithCode('CLEANUP_PATH_MISMATCH', 'State указывает не на exact review worktree');
    }
    if (before.binding.candidateBranch !== candidateBranch(reviewRunId)) {
      throw errorWithCode('CLEANUP_BRANCH_MISMATCH', 'State указывает не на exact candidate branch');
    }
    const { state, lease } = await claim(reviewRunId, owner, 5 * 60_000);
    try {
      let worktreeExists = false;
      try {
        const stat = await fs.lstat(expectedPath);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw errorWithCode('CLEANUP_PATH_MISMATCH', 'Review worktree подменён');
        }
        worktreeExists = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (worktreeExists) {
        const dirty = await gitStatus(git, expectedPath);
        if (dirty) {
          throw errorWithCode(
            'CLEANUP_WORKTREE_DIRTY',
            'Worktree содержит несохранённые данные и оставлен для диагностики',
          );
        }
        await git(state.binding.repoPath, ['worktree', 'remove', expectedPath], {
          timeout: 120_000,
        });
      } else {
        await git(state.binding.repoPath, ['worktree', 'prune'], { timeout: 30_000 });
      }
      const deleteBranch = state.status === REVIEW_RUN_STATES.PUBLISHED
        || !state.candidate
        || discardCandidate === true;
      let branchDeleted = false;
      if (deleteBranch) {
        if (await gitSucceeds(
          git,
          state.binding.repoPath,
          ['show-ref', '--verify', `refs/heads/${state.binding.candidateBranch}`],
        )) {
          await git(state.binding.repoPath, ['branch', '-D', state.binding.candidateBranch]);
        }
        branchDeleted = !await gitSucceeds(
          git,
          state.binding.repoPath,
          ['show-ref', '--verify', `refs/heads/${state.binding.candidateBranch}`],
        );
      }
      await store.update(reviewRunId, (current) => {
        current.cleanup = {
          status: 'completed',
          actor: requestedBy,
          worktreeRemoved: true,
          branchDeleted,
          candidatePreserved: !deleteBranch && Boolean(current.candidate),
          completedAt: Number(typeof now === 'function' ? now() : now),
        };
        return current;
      }, {
        owner: lease.owner,
        fencingToken: lease.fencingToken,
      });
      await release(reviewRunId, lease);
      return store.load(reviewRunId);
    } catch (error) {
      await release(reviewRunId, lease);
      throw error;
    }
  }

  async function recover(reviewRunId, { now: recoveryNow = Date.now } = {}) {
    const timestamp = Number(typeof recoveryNow === 'function' ? recoveryNow() : recoveryNow);
    const current = await store.load(reviewRunId);
    if (current.lease && current.lease.expiresAt > timestamp) {
      throw errorWithCode('LEASE_BUSY', 'Живой worker не требует восстановления');
    }
    const cwd = current.binding.worktreePath || worktreePath(reviewRunId);
    let exists = false;
    try {
      exists = (await fs.stat(cwd)).isDirectory();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    let outcome = { status: current.status, reason: 'no_action' };
    const inspect = async () => {
      if (!exists) return { exists: false };
      const [head, tree, dirty, subject] = await Promise.all([
        gitValue(git, cwd, ['rev-parse', 'HEAD']).catch(() => null),
        gitValue(git, cwd, ['rev-parse', 'HEAD^{tree}']).catch(() => null),
        gitStatus(git, cwd).catch(() => 'unreadable'),
        gitValue(git, cwd, ['log', '-1', '--format=%s']).catch(() => ''),
      ]);
      return { exists: true, head, tree, dirty, subject };
    };
    const observed = await inspect();
    if (current.status === REVIEW_RUN_STATES.PROVISIONING) {
      if (!observed.exists) outcome = { status: REVIEW_RUN_STATES.APPROVED, reason: 'provision_retry' };
      else if (observed.head === current.binding.headSha && !observed.dirty) {
        outcome = { status: REVIEW_RUN_STATES.APPROVED, reason: 'provision_reused' };
      } else {
        outcome = { status: REVIEW_RUN_STATES.BLOCKED, reason: 'provision_result_unknown' };
      }
    } else if (current.status === REVIEW_RUN_STATES.BUILDING) {
      if (!observed.exists) {
        outcome = { status: REVIEW_RUN_STATES.APPROVED, reason: 'build_not_started' };
      } else if (observed.dirty) {
        outcome = {
          status: REVIEW_RUN_STATES.BLOCKED,
          reason: 'build_result_unknown_dirty_worktree',
        };
      } else if (observed.head === current.binding.headSha) {
        outcome = { status: REVIEW_RUN_STATES.APPROVED, reason: 'build_not_committed' };
      } else {
        const parent = await gitValue(git, cwd, ['rev-parse', `${observed.head}^`]).catch(() => null);
        if (parent === current.binding.headSha
            && observed.subject === `Cockpit review ${reviewRunId}`
            && SHA.test(observed.tree || '')) {
          // Subject/parent недостаточно: между host commit и durable state
          // нельзя заново доказать exact allowedPaths и buildEvidence. Commit
          // сохраняем для диагностики, но в candidate автоматически не повышаем.
          outcome = { status: REVIEW_RUN_STATES.BLOCKED, reason: 'build_commit_unjournaled' };
        } else {
          outcome = { status: REVIEW_RUN_STATES.BLOCKED, reason: 'unknown_candidate_commit' };
        }
      }
    } else if (current.status === REVIEW_RUN_STATES.VERIFYING) {
      if (observed.exists && !observed.dirty
          && observed.head === current.candidate?.commit
          && observed.tree === current.candidate?.tree) {
        outcome = { status: REVIEW_RUN_STATES.BUILT, reason: 'verify_must_repeat' };
      } else {
        outcome = { status: REVIEW_RUN_STATES.BLOCKED, reason: 'verify_candidate_changed' };
      }
    } else if (current.status === REVIEW_RUN_STATES.PUBLISHING) {
      outcome = {
        status: REVIEW_RUN_STATES.PUBLICATION_UNKNOWN,
        reason: 'publish_requires_remote_reconcile',
      };
    }
    return store.update(reviewRunId, (state) => {
      state.lease = null;
      state.status = outcome.status;
      state.recovery = { reason: outcome.reason, recoveredAt: timestamp };
      if (outcome.reason === 'verify_must_repeat') {
        state.verify = null;
        state.acceptance = null;
      }
      return state;
    }, { expectedRevision: current.revision });
  }

  return Object.freeze({
    store,
    git,
    worktreePath,
    createRun,
    getRun: (reviewRunId) => store.load(reviewRunId),
    listRuns: () => store.list(),
    approveScope,
    prepare,
    build,
    verify,
    accept,
    abandon,
    cleanup,
    recover,
  });
}
