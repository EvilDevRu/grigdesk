// Оркестратор пользовательского процесса «Ревью».
//
// GitHub watcher, model queues и runner намеренно остаются отдельными
// компонентами. Этот слой связывает их с Project, хранит человеческий scope,
// применяет freshness-gates и отдаёт канонический снимок для UI.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { projectsOverview } from '../projects.js';
import { snapshotDigest, snapshotKey } from './identity.js';
import { inspectFactoryReviewRoute } from './factory-route.js';
import { REVIEW_RUN_STATES } from './review-state-machine.js';
import { canAutoAnalyzeRemark } from './watcher.js';

const exec = promisify(execFile);
const OPEN_RUN_STATES = new Set([
  REVIEW_RUN_STATES.AWAITING_SCOPE,
  REVIEW_RUN_STATES.APPROVED,
  REVIEW_RUN_STATES.PROVISIONING,
  REVIEW_RUN_STATES.BUILDING,
  REVIEW_RUN_STATES.BUILT,
  REVIEW_RUN_STATES.VERIFYING,
]);
const TERMINAL_RUN_STATES = new Set([
  REVIEW_RUN_STATES.VERIFICATION_FAILED,
  REVIEW_RUN_STATES.PUBLISHED,
  REVIEW_RUN_STATES.STALE,
  REVIEW_RUN_STATES.BLOCKED,
  REVIEW_RUN_STATES.FAILED,
]);
const SCOPE_ACTIONS = new Set(['fix', 'reply', 'skip', 'decision']);
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const SAFE_SOURCE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)(?!.*[\u0000\r\n]).+$/;
const DENIED_SOURCE_PART = /^(?:\.git|\.env(?:\..*)?|\.npmrc|\.netrc|auth\.json|credentials?)$/i;
const SCOPE_PATH_LIMIT = 40;
const RISKY_SCOPE_PATH = /^(?:\.github\/|\.gitlab-ci\.yml$|Dockerfile(?:\..*)?$|docker-compose(?:\..*)?\.ya?ml$|(?:[^/]+\/)*(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock)|(?:[^/]+\/)*(?:deploy|deployment|infra|terraform|ansible|scripts\/release)(?:\/|$))/i;
const TONE_PRIORITY = Object.freeze({ '': 0, blue: 1, yellow: 2, red: 3 });

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function serviceError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function assertReviewExecutorAvailable(binding) {
  if (binding?.factoryReviewExecutorAvailable === true) return;
  throw serviceError(
    'REVIEW_EXECUTOR_UNAVAILABLE',
    'Исправление отключено, пока не подключён изолированный Factory review executor',
  );
}

function stableHash(value, length = 32) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function configuredRepositoryId(projectId, repoKey, slug) {
  return `repository:v1:${Buffer.from(
    JSON.stringify([String(projectId), String(repoKey), String(slug).toLowerCase()]),
    'utf8',
  ).toString('base64url')}`;
}

function runnerSafeId(prefix, value) {
  return `${prefix}-${stableHash(value)}`;
}

function pullId(repoNodeId, prNodeId) {
  return snapshotKey(repoNodeId, prNodeId);
}

function activeRemarks(pullRequest) {
  return (pullRequest?.remarks || []).filter((remark) => (
    remark?.state === 'open' && remark.actionable !== false
  ));
}

function normalizeScopePaths(value, { allowRiskyPaths = false } = {}) {
  const source = Array.isArray(value) ? value : [];
  if (!source.length || source.length > SCOPE_PATH_LIMIT) {
    throw serviceError(
      'SCOPE_PATHS_REQUIRED',
      `Для исправления укажи от 1 до ${SCOPE_PATH_LIMIT} разрешённых файлов`,
    );
  }
  const paths = [...new Set(source.map((entry) => String(entry || '').trim().replaceAll('\\', '/')))]
    .sort();
  for (const filePath of paths) {
    if (!isSafeSourcePath(filePath) || filePath.length > 1_000) {
      throw serviceError('SCOPE_PATH_INVALID', `Некорректный разрешённый путь: ${filePath || '(пусто)'}`);
    }
    if (RISKY_SCOPE_PATH.test(filePath) && allowRiskyPaths !== true) {
      throw serviceError(
        'SCOPE_RISKY_PATH_CONFIRMATION_REQUIRED',
        `Изменение ${filePath} требует отдельного подтверждения инфраструктурного риска`,
      );
    }
  }
  return paths;
}

/** Fail-closed проверка runtime provider: prefs могут быть изменены не только HTTP-route. */
export function validateReviewRepositories(repositories) {
  const rows = (Array.isArray(repositories) ? repositories : []).map((repository) => {
    const executorAvailable = repository?.factoryReviewExecutorAvailable === true;
    const configurationError = repository?.configurationError || (!executorAvailable ? {
      code: 'REVIEW_EXECUTOR_UNAVAILABLE',
      message: 'Исправление отключено: runtime Factory review executor ещё не подключён',
    } : null);
    return {
      ...repository,
      factoryReviewExecutorAvailable: executorAvailable,
      ...(configurationError && { configurationError }),
      canFix: configurationError == null
      && executorAvailable
      && repository?.reviewRoute?.schemaVersion === 1
      && repository.reviewRoute.source === 'factory-profile'
      && repository.reviewRoute.profileId === repository.projectId
      && Array.isArray(repository?.verifyCommands)
      && repository.verifyCommands.length > 0
      && repository.verifyCoversCriteria === true,
    };
  });
  const slugs = new Map();
  const ids = new Set();
  for (const repository of rows) {
    const slug = String(repository?.slug || '').toLowerCase();
    const id = String(repository?.id || '');
    if (!slug || !id || ids.has(id) || slugs.has(slug)) {
      throw serviceError(
        'AMBIGUOUS_REPOSITORY_BINDING',
        'GitHub-репозиторий неоднозначно привязан к Project',
        {
          slug: slug || null,
          projects: [slugs.get(slug)?.projectId, repository?.projectId].filter(Boolean),
        },
      );
    }
    ids.add(id);
    slugs.set(slug, repository);
  }
  return rows;
}

function pullSemanticValue(repository, pullRequest) {
  return {
    repoNodeId: repository.repoNodeId,
    prNodeId: pullRequest.prNodeId,
    number: pullRequest.number,
    state: pullRequest.state,
    headSha: pullRequest.headSha,
    headRefName: pullRequest.headRefName,
    headRepositoryNodeId: pullRequest.headRepositoryNodeId,
    headRepositoryUrl: pullRequest.headRepositoryUrl,
    remarks: (pullRequest.remarks || []).map((remark) => ({
      key: remark.key,
      versionId: remark.versionId,
      state: remark.state,
    })),
  };
}

function pullDigest(repository, pullRequest) {
  return snapshotDigest(pullSemanticValue(repository, pullRequest));
}

function scopeVersion(repository, pullRequest, items) {
  return `scope:v1:${stableHash(JSON.stringify({
    pull: pullSemanticValue(repository, pullRequest),
    items,
  }), 64)}`;
}

function strongerTone(left, right) {
  return TONE_PRIORITY[right] > TONE_PRIORITY[left] ? right : left;
}

function pluralPr(count) {
  const n = Math.abs(Number(count)) % 100;
  const last = n % 10;
  if (n > 10 && n < 20) return 'PR требуют внимания';
  if (last === 1) return 'PR требует внимания';
  return 'PR требуют внимания';
}

function isSafeSourcePath(value) {
  const source = String(value || '');
  if (!source || !SAFE_SOURCE_PATH.test(source) || path.posix.normalize(source) !== source) {
    return false;
  }
  return !source.split('/').some((part) => DENIED_SOURCE_PART.test(part));
}

async function readSourceSnapshot({ repository, pullRequest, items }) {
  if (!repository?.repoPath || !SHA.test(String(pullRequest?.headSha || ''))) {
    return {
      readOnly: true,
      headSha: pullRequest?.headSha || null,
      files: [],
      unavailableReason: 'Локальный exact SHA недоступен',
    };
  }
  const paths = [...new Set((items || [])
    .map((item) => item?.path)
    .filter(isSafeSourcePath))]
    .slice(0, 20);
  const files = [];
  let total = 0;
  for (const filePath of paths) {
    if (total >= 500_000) break;
    try {
      const { stdout } = await exec('git', [
        '--no-pager',
        '-C',
        repository.repoPath,
        'show',
        `${pullRequest.headSha}:${filePath}`,
      ], {
        timeout: 10_000,
        maxBuffer: 600_000,
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin',
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          HOME: '/nonexistent',
          XDG_CONFIG_HOME: '/nonexistent',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_NO_LAZY_FETCH: '1',
          GIT_OPTIONAL_LOCKS: '0',
        },
      });
      const content = String(stdout).slice(0, Math.max(0, 100_000));
      total += content.length;
      files.push({ path: filePath, content, truncated: String(stdout).length > content.length });
    } catch {
      files.push({ path: filePath, unavailable: true });
    }
  }
  return {
    readOnly: true,
    headSha: pullRequest.headSha,
    files,
  };
}

/**
 * Единственный источник Project → GitHub binding для watcher и ReviewService.
 * Неподтверждённый remote здесь не становится рабочей конфигурацией.
 */
export function createReviewRepositoryProvider({
  config,
  prefs,
  factoryReviewExecutorAvailable = false,
}) {
  return async function reviewRepositories() {
    const projects = await projectsOverview({ config, prefs });
    const repositories = [];
    for (const project of projects) {
      const route = await inspectFactoryReviewRoute({
        profilesDir: config.profilesDir,
        factoryHome: config.factoryHome,
        projectId: project.id,
      });
      for (const repository of project.repos
        .filter((item) => item.exists && item.github?.confirmed)) {
        const [owner, name] = repository.github.slug.split('/');
        const id = configuredRepositoryId(project.id, repository.key, repository.github.slug);
        const verifyCommands = clone(repository.github.verifyCommands || []);
        const verifyCoversCriteria = repository.github.verifyCoversCriteria === true;
        let verifyCommandsValid = verifyCommands.length > 0;
        try {
          verifyCommands.forEach((command, index) => parseReviewVerifyCommand(command, index));
        } catch {
          verifyCommandsValid = false;
        }
        const configurationError = !route.ready
          ? route.error
          : !verifyCommandsValid && verifyCommands.length > 0
            ? {
              code: 'VERIFY_COMMAND_INVALID',
              message: 'Сохранена некорректная команда обязательной проверки',
            }
            : null;
        repositories.push({
          id,
          projectId: project.id,
          repoKey: repository.key,
          repoPath: repository.dir,
          slug: repository.github.slug,
          owner,
          name,
          confirmed: true,
          enabled: repository.github.autoSync !== false,
          autoAnalyze: repository.github.autoAnalyze !== false,
          verifyCommands,
          verifyCoversCriteria,
          factoryReviewExecutorAvailable: factoryReviewExecutorAvailable === true,
          reviewRoute: clone(route.descriptor),
          canFix: factoryReviewExecutorAvailable === true
            && route.ready
            && verifyCommandsValid
            && verifyCoversCriteria,
          ...(configurationError && { configurationError }),
          // Общий cooldown относится к авторизации gh этой машины, но токен в
          // state никогда не попадает.
          credentialFingerprint: 'github-cli:default',
          runnerProjectId: runnerSafeId('project', project.id),
          runnerRepositoryId: runnerSafeId('repository', id),
        });
      }
    }
    return validateReviewRepositories(repositories);
  };
}

/**
 * Разбирает одну сохранённую команду без shell. Кавычки нужны только для
 * пробелов; pipe/redirection/substitution не получают специальных прав.
 */
export function parseReviewVerifyCommand(source, index = 0, {
  coversAllCriteria = false,
} = {}) {
  const input = String(source || '');
  if (!input.trim() || /[\u0000\r\n]/.test(input) || input.length > 4_096) {
    throw serviceError('VERIFY_COMMAND_INVALID', `Некорректная команда проверки #${index + 1}`);
  }
  const parts = [];
  let value = '';
  let quote = '';
  let escaped = false;
  let started = false;
  for (const character of input) {
    if (escaped) {
      value += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      else value += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        parts.push(value);
        value = '';
        started = false;
      }
      continue;
    }
    value += character;
    started = true;
  }
  if (escaped || quote) {
    throw serviceError('VERIFY_COMMAND_INVALID', `Незакрытая кавычка в проверке #${index + 1}`);
  }
  if (started) parts.push(value);
  if (!parts.length || !parts[0] || parts.length > 100) {
    throw serviceError('VERIFY_COMMAND_INVALID', `Некорректная команда проверки #${index + 1}`);
  }
  return {
    id: `project-${index + 1}`,
    command: parts[0],
    args: parts.slice(1),
    required: true,
    coversAllCriteria: coversAllCriteria === true,
    // Любая проектная проверка сравнивается с exact PR head. Иначе старый
    // lint/type debt неотличим от регрессии кандидата.
    compareBaseline: true,
  };
}

function normalizeRunState(run) {
  const status = String(run?.status || '');
  const state = {
    [REVIEW_RUN_STATES.AWAITING_SCOPE]: 'queued',
    [REVIEW_RUN_STATES.APPROVED]: 'queued',
    [REVIEW_RUN_STATES.PROVISIONING]: 'preparing',
    [REVIEW_RUN_STATES.BUILDING]: 'running',
    [REVIEW_RUN_STATES.BUILT]: 'verifying',
    [REVIEW_RUN_STATES.VERIFYING]: 'verifying',
    [REVIEW_RUN_STATES.VERIFIED]: 'ready',
    [REVIEW_RUN_STATES.VERIFICATION_FAILED]: 'failed',
    [REVIEW_RUN_STATES.ACCEPTED]: 'accepted',
    [REVIEW_RUN_STATES.PUBLISHING]: 'publishing',
    [REVIEW_RUN_STATES.PUBLICATION_UNKNOWN]: 'failed',
    [REVIEW_RUN_STATES.PUBLISHED]: 'published',
    [REVIEW_RUN_STATES.STALE]: 'stale',
    [REVIEW_RUN_STATES.BLOCKED]: 'failed',
    [REVIEW_RUN_STATES.FAILED]: 'failed',
  }[status] || status;
  const verifyReport = clone(run.verify?.report || null);
  const cell = (value) => String(value ?? '')
    .replaceAll('|', '\\|')
    .replace(/\s+/g, ' ')
    .trim();
  const buildByItem = new Map(
    (run.candidate?.buildEvidence?.perRemark || []).map((item) => [item.itemKey, item]),
  );
  const scopeByItem = new Map((run.scope || []).map((item) => [item.itemKey, item]));
  const criterionRows = (verifyReport?.criteria || []).map((criterion) => {
    const build = buildByItem.get(criterion.itemKey);
    const scope = scopeByItem.get(criterion.itemKey);
    const checks = criterion.commandIds?.length
      ? criterion.commandIds.join(', ')
      : criterion.reason;
    const risks = (scope?.risks || []).map((risk) => risk.text || risk.id).filter(Boolean).join('; ');
    return `| ${cell(criterion.itemKey)} | ${cell(build?.change || 'Нет отчёта BUILD')} | ${cell(checks)} | ${cell(criterion.status)} | ${cell(risks || 'Не указаны')} |`;
  });
  const reportText = verifyReport
    ? [
      verifyReport.passed ? 'Обязательные проверки пройдены.' : 'Обязательные проверки не пройдены.',
      `Candidate tree: \`${cell(verifyReport.candidateTreeDigest || verifyReport.candidateTree)}\``,
      ...(criterionRows.length ? [
        '',
        '| Замечание | Что изменено | Как проверено | Результат | Оставшийся риск |',
        '|---|---|---|---|---|',
        ...criterionRows,
      ] : []),
    ].join('\n')
    : '';
  return {
    id: run.reviewRunId,
    reviewRunId: run.reviewRunId,
    state,
    rawState: status,
    canAccept: status === REVIEW_RUN_STATES.VERIFIED,
    canPublish: [
      REVIEW_RUN_STATES.ACCEPTED,
      REVIEW_RUN_STATES.PUBLICATION_UNKNOWN,
    ].includes(status),
    canReconcile: status === REVIEW_RUN_STATES.PUBLICATION_UNKNOWN,
    stale: status === REVIEW_RUN_STATES.STALE,
    candidate: clone(run.candidate),
    verify: clone(run.verify),
    branch: run.binding?.candidateBranch || null,
    sandbox: run.binding?.worktreePath || null,
    report: reportText,
    verification: verifyReport ? {
      passed: verifyReport.passed === true,
      summary: reportText,
      report: verifyReport,
    } : null,
    artifacts: clone(verifyReport?.artifacts || []),
    screenshots: clone(verifyReport?.screenshots || []),
    acceptance: clone(run.acceptance),
    publication: clone(run.publication),
    cleanup: clone(run.cleanup),
    error: clone(run.error || run.failure),
    updatedAt: run.updatedAt,
  };
}

function jobForRemark(state, remark) {
  return Object.values(state.jobs || {})
    .filter((job) => ['pending', 'running'].includes(job.status))
    .find((job) => {
      if (job.queue === 'analysis') {
        return (job.payload?.request?.identity?.itemVersions || [])
          .some((item) => (
            item.itemKey === remark.key && item.versionId === remark.versionId
          ));
      }
      if (job.queue === 'translation') {
        return (job.payload?.entries || []).some((item) => (
          item.itemKey === remark.key && item.versionId === remark.versionId
        ));
      }
      return false;
    });
}

export class ReviewService {
  constructor({
    store,
    controlStore,
    watcher,
    analysisQueue,
    translatorQueue,
    runner,
    publisher,
    repositoryProvider,
    sse = null,
    log = null,
    now = Date.now,
    modelConcurrency = 1,
  } = {}) {
    if (!store || !controlStore || !runner || !publisher || !repositoryProvider) {
      throw new TypeError('ReviewService: не переданы обязательные зависимости');
    }
    this.store = store;
    this.controlStore = controlStore;
    this.watcher = watcher;
    this.analysisQueue = analysisQueue;
    this.translatorQueue = translatorQueue;
    this.runner = runner;
    this.publisher = publisher;
    this.repositoryProvider = repositoryProvider;
    this.sse = sse;
    this.log = log;
    this.now = typeof now === 'function' ? now : () => now.now();
    this.modelConcurrency = Math.max(1, Math.min(8, Number(modelConcurrency) || 1));
    this.closed = false;
    this.modelDrain = null;
    this.runDrain = null;
    this.modelTimer = null;
    this.runTimer = null;
    this.runMaintenance = null;
    this.runWorkerId = `review-run:${process.pid}:${crypto.randomUUID()}`;
    this.runClaimLeaseMs = 120_000;
  }

  async init() {
    await Promise.all([this.store.init(), this.controlStore.init()]);
    await this.#reconcileRuns();
    if (this.watcher) {
      // start() сам делает catch-up и ставит interval. Сеть не должна задерживать
      // подъём остальных страниц Cockpit.
      Promise.resolve()
        .then(() => this.watcher.start())
        .then(() => this.#kickModels())
        .catch((error) => this.log?.error?.({
          code: error?.code,
          err: error?.message,
        }, 'review watcher не стартовал'));
    }
    // Job может иметь coalesce/retry availableAt в будущем. Периодический
    // неблокирующий kick нужен и после рестарта, и когда новых GitHub-событий нет.
    this.modelTimer = setInterval(() => this.#kickModels(), 5_000);
    this.modelTimer.unref?.();
    this.runTimer = setInterval(() => this.#maintainRuns(), 5_000);
    this.runTimer.unref?.();
    this.#maintainRuns();
    return this;
  }

  async close() {
    this.closed = true;
    if (this.modelTimer) clearInterval(this.modelTimer);
    this.modelTimer = null;
    if (this.runTimer) clearInterval(this.runTimer);
    this.runTimer = null;
    await this.watcher?.stop?.();
    await Promise.allSettled([
      this.modelDrain,
      this.runDrain,
      this.runMaintenance,
    ].filter(Boolean));
  }

  async snapshot() {
    const [state, control, repositories, runs] = await Promise.all([
      this.store.read(),
      this.controlStore.read(),
      this.#repositories(),
      this.runner.listRuns(),
    ]);
    const bindings = new Map(repositories.map((item) => [item.slug.toLowerCase(), item]));
    const runById = new Map(runs.map((run) => [run.reviewRunId, run]));
    const pulls = [];
    for (const repository of Object.values(state.repositories || {})) {
      const binding = bindings.get(String(repository.nameWithOwner || '').toLowerCase());
      if (!binding) continue;
      for (const pullRequest of repository.pullRequests || []) {
        const id = pullId(repository.repoNodeId, pullRequest.prNodeId);
        const scope = control.scopes[id];
        const linkedIds = Object.values(control.runLinks)
          .filter((link) => link.pullId === id)
          .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
        const activeId = control.activeRuns[id];
        const activeRun = runById.get(activeId);
        const currentRun = activeRun
          || runById.get(linkedIds.find((link) => runById.has(link.runId))?.runId);
        const scopeByRemark = new Map((scope?.items || []).map((item) => [item.remarkId, item]));
        const remarks = (pullRequest.remarks || []).map((remark) => {
          const analysisRecord = state.analyses?.[remark.key];
          const translationRecord = state.translations?.[remark.key];
          const analysis = analysisRecord?.current?.versionId === remark.versionId
            ? analysisRecord.current
            : null;
          const translation = translationRecord?.current?.versionId === remark.versionId
            && translationRecord.current.analysisId === analysis?.analysisId
            ? translationRecord.current
            : null;
          const job = jobForRemark(state, remark);
          const autoDeferred = analysisRecord?.autoDeferred?.versionId === remark.versionId
            ? analysisRecord.autoDeferred
            : null;
          const analysisError = analysisRecord?.error?.versionId === remark.versionId
            ? analysisRecord.error
            : null;
          const translationError = translationRecord?.error?.versionId === remark.versionId
            ? translationRecord.error
            : null;
          let analysisStatus = 'pending';
          if (remark.state === 'outdated') analysisStatus = 'outdated';
          else if (['resolved', 'closed'].includes(remark.state)) analysisStatus = 'resolved';
          else if (translation) analysisStatus = 'ready';
          else if (job?.queue === 'translation') analysisStatus = 'translating';
          else if (job) analysisStatus = job.status === 'running' ? 'analyzing' : 'queued';
          else if (analysisError || translationError) analysisStatus = 'failed';
          else if (analysis?.stale) analysisStatus = 'stale';
          else if (analysis) analysisStatus = 'translating';
          else if (
            autoDeferred
            || binding.autoAnalyze === false
            || !canAutoAnalyzeRemark(remark)
          ) {
            analysisStatus = 'manual_required';
          }
          return {
            id: remark.key,
            kind: remark.kind,
            author: remark.author,
            authorAssociation: remark.authorAssociation || 'UNKNOWN',
            path: remark.path,
            line: remark.line,
            url: remark.url,
            body: remark.body,
            state: remark.state,
            resolved: ['resolved', 'closed'].includes(remark.state),
            outdated: remark.state === 'outdated',
            actionable: remark.actionable !== false,
            updatedAt: remark.updatedAt,
            versionId: remark.versionId,
            analysisStatus,
            analysis: clone(analysis),
            translation: clone(translation),
            analysisError: clone(analysisError || translationError),
            autoAnalysis: analysisStatus === 'manual_required'
              ? {
                reason: autoDeferred?.reason
                  || (binding.autoAnalyze === false
                    ? 'auto_analysis_disabled'
                    : 'untrusted_author'),
                message: autoDeferred?.message
                  || (binding.autoAnalyze === false
                    ? 'Автоматический анализ отключён в настройках Project; его можно запустить вручную'
                    : 'Автоанализ для этого автора отключён; исходный комментарий сохранён'),
              }
              : null,
            scopeAction: clone(scopeByRemark.get(remark.key) || null),
          };
        });
        const open = String(pullRequest.state || '').toLowerCase() === 'open';
        const unread = open
          && Number(pullRequest.attentionVersion || 0) > Number(pullRequest.readVersion || 0);
        const failed = open && (
          remarks.some((remark) => ['failed', 'stale'].includes(remark.analysisStatus))
          || [REVIEW_RUN_STATES.STALE, REVIEW_RUN_STATES.BLOCKED, REVIEW_RUN_STATES.FAILED]
            .includes(currentRun?.status)
          || currentRun?.status === REVIEW_RUN_STATES.VERIFICATION_FAILED
        );
        const needsDecision = open && remarks.some((remark) => (
          !remark.resolved
          && !remark.outdated
          && (
            remark.scopeAction?.action === 'decision'
            || (!remark.scopeAction
              && remark.analysis?.decisionId === 'PRODUCT_DECISION')
          )
        ));
        const needsAnalysis = open && remarks.some((remark) => (
          !remark.resolved
          && !remark.outdated
          && remark.analysisStatus === 'manual_required'
        ));
        const tone = failed
          ? 'red'
          : (needsDecision || needsAnalysis)
            ? 'yellow'
            : unread
              ? 'blue'
              : '';
        const currentDigest = pullDigest(repository, pullRequest);
        pulls.push({
          id,
          projectId: binding.projectId,
          projectTitle: binding.projectId,
          repoKey: binding.repoKey,
          repoSlug: binding.slug,
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.url,
          author: pullRequest.author,
          headRef: pullRequest.headRefName,
          headSha: pullRequest.headSha,
          updatedAt: pullRequest.updatedAt,
          state: pullRequest.state,
          attention: {
            active: Boolean(tone),
            tone,
            unread,
            failed,
            needsDecision,
            needsAnalysis,
            version: Number(pullRequest.attentionVersion || 0),
            readVersion: Number(pullRequest.readVersion || 0),
          },
          canRun: open
            && binding.confirmed
            && binding.canFix === true
            && Boolean(pullRequest.headRepositoryUrl)
            && scope?.snapshotDigest === currentDigest
            && (scope.items || []).some((item) => item.action === 'fix')
            && !(scope.items || []).some((item) => item.action === 'decision')
            && !activeRun,
          runBlockedReason: binding.canFix === true
            ? null
            : binding.configurationError?.message
              || 'В Project нужны обязательные команды проверки и явное подтверждение, что они покрывают критерии.',
          scope: clone(scope || null),
          run: currentRun ? normalizeRunState(currentRun) : null,
          history: linkedIds
            .map((link) => runById.get(link.runId))
            .filter(Boolean)
            .map(normalizeRunState),
          remarks,
        });
      }
    }
    pulls.sort((left, right) => (
      String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
      || left.repoSlug.localeCompare(right.repoSlug)
      || Number(left.number) - Number(right.number)
    ));
    const summary = this.#summaryFrom(pulls, state.revision);
    return {
      pulls,
      repositories: repositories.map((repository) => ({
        projectId: repository.projectId,
        repoKey: repository.repoKey,
        repoSlug: repository.slug,
        enabled: repository.enabled,
        autoAnalyze: repository.autoAnalyze,
        canFix: repository.canFix === true,
        reviewRoute: clone(repository.reviewRoute),
        configurationError: clone(repository.configurationError || null),
        watcher: clone(state.watcher?.[repository.id] || null),
      })),
      summary,
      revision: state.revision,
    };
  }

  async summary() {
    return (await this.snapshot()).summary;
  }

  async projectStatus() {
    const snapshot = await this.snapshot();
    return snapshot.repositories.map((repository) => {
      const pulls = snapshot.pulls.filter((pull) => (
        pull.projectId === repository.projectId && pull.repoKey === repository.repoKey
      ));
      return {
        projectId: repository.projectId,
        repoKey: repository.repoKey,
        openPullRequests: pulls.filter((pull) => String(pull.state).toLowerCase() === 'open').length,
        attentionPullRequests: pulls.filter((pull) => pull.attention?.active).length,
        lastSyncAt: repository.watcher?.lastSuccessAt || null,
        lastSyncError: clone(repository.watcher?.lastError || null),
        canFix: repository.canFix === true,
        reviewRoute: clone(repository.reviewRoute),
        configurationError: clone(repository.configurationError || null),
      };
    });
  }

  async sync({ projectId, repoKey } = {}) {
    if (!this.watcher) throw serviceError('GITHUB_UNAVAILABLE', 'GitHub watcher не настроен');
    const repositories = (await this.#repositories()).filter((repository) => (
      (!projectId || repository.projectId === projectId)
      && (!repoKey || repository.repoKey === repoKey)
    ));
    if ((projectId || repoKey) && !repositories.length) {
      throw serviceError('REPOSITORY_NOT_FOUND', 'Привязанный GitHub-репозиторий не найден');
    }
    for (const repository of repositories) {
      let result;
      try {
        result = await this.watcher.trigger(repository.id, { manual: true });
      } catch (error) {
        throw serviceError('GITHUB_UNAVAILABLE', 'Не удалось проверить GitHub', {
          reason: error?.code || 'watcher_failed',
        });
      }
      this.#assertSyncResult(result);
    }
    this.#kickModels();
    return this.snapshot();
  }

  async markRead(id) {
    const found = await this.#findPull(id);
    const result = await this.store.markRead({
      repoNodeId: found.repository.repoNodeId,
      prNodeId: found.pullRequest.prNodeId,
      version: Number(found.pullRequest.attentionVersion || 0),
    });
    if (!result.applied) throw serviceError('PULL_NOT_FOUND', 'PR не найден');
    this.#broadcast({ reason: 'read', pullId: id });
    return this.snapshot();
  }

  async analyze(id, { remarkId = null } = {}) {
    const found = await this.#findPull(id);
    const active = activeRemarks(found.pullRequest);
    const items = remarkId == null
      ? active
      : active.filter((remark) => remark.key === String(remarkId));
    if (!items.length) throw serviceError('REMARK_NOT_FOUND', 'В PR нет открытых замечаний');
    await this.#enqueueAnalysis(found, items, { manual: true });
    this.#kickModels();
    this.#broadcast({ reason: 'analysis-queued', pullId: id });
    return this.snapshot();
  }

  async setScope(id, items) {
    if (!Array.isArray(items)) throw serviceError('BAD_SCOPE', 'Нужен список решений');
    const found = await this.#findPull(id);
    if (String(found.pullRequest.state).toLowerCase() !== 'open') {
      throw serviceError('PR_CLOSED', 'PR уже закрыт');
    }
    const active = activeRemarks(found.pullRequest);
    const byKey = new Map(active.map((remark) => [remark.key, remark]));
    if (items.length !== active.length) {
      throw serviceError('SCOPE_INCOMPLETE', 'Нужно выбрать действие для каждого открытого замечания');
    }
    const seen = new Set();
    const normalized = items.map((item) => {
      const remarkId = String(item?.remarkId || '');
      const action = String(item?.action || '');
      if (!byKey.has(remarkId) || seen.has(remarkId) || !SCOPE_ACTIONS.has(action)) {
        throw serviceError('SCOPE_ITEM_INVALID', 'Scope содержит неизвестный или повторный пункт');
      }
      seen.add(remarkId);
      const reason = String(item?.reason || '').trim();
      const acceptance = String(item?.acceptance || '').trim();
      if (action === 'skip' && !reason) {
        throw serviceError('SCOPE_SKIP_REASON_REQUIRED', 'Для пропуска нужна причина');
      }
      if (action === 'fix' && !acceptance) {
        throw serviceError(
          'SCOPE_ACCEPTANCE_REQUIRED',
          'Для исправления нужен простой проверяемый критерий готовности',
        );
      }
      const allowRiskyPaths = item?.allowRiskyPaths === true;
      const allowedPaths = action === 'fix'
        ? normalizeScopePaths(item?.allowedPaths, { allowRiskyPaths })
        : [];
      if (reason.length > 10_000 || acceptance.length > 10_000) {
        throw serviceError('SCOPE_ITEM_INVALID', 'Текст решения слишком длинный');
      }
      const remark = byKey.get(remarkId);
      return {
        remarkId,
        versionId: remark.versionId,
        action,
        ...(reason && { reason }),
        ...(acceptance && { acceptance }),
        ...(allowedPaths.length && { allowedPaths }),
        ...(allowRiskyPaths && { allowRiskyPaths: true }),
      };
    }).sort((left, right) => left.remarkId.localeCompare(right.remarkId));
    const digest = pullDigest(found.repository, found.pullRequest);
    const version = scopeVersion(found.repository, found.pullRequest, normalized);
    await this.controlStore.mutate((state) => {
      if (state.activeRuns[id]) {
        throw serviceError(
          'ACTIVE_RUN_EXISTS',
          'Сначала заверши или откажись от текущего результата этого PR',
        );
      }
      state.scopes[id] = {
        pullId: id,
        repoNodeId: found.repository.repoNodeId,
        prNodeId: found.pullRequest.prNodeId,
        headSha: found.pullRequest.headSha,
        snapshotDigest: digest,
        version,
        items: normalized,
        approvedBy: 'cockpit-user',
        approvedAt: this.now(),
      };
      return state.scopes[id];
    });
    this.#broadcast({ reason: 'scope', pullId: id });
    return this.snapshot();
  }

  async run(id) {
    const before = await this.#findPull(id);
    assertReviewExecutorAvailable(before.binding);
    // Перед созданием пишущего запуска используем тот же GitHub sync, что watcher.
    await this.#syncBinding(before.binding);
    const found = await this.#findPull(id);
    assertReviewExecutorAvailable(found.binding);
    const control = await this.controlStore.read();
    const scope = control.scopes[id];
    this.#assertFreshScope(found, scope);
    if ((scope.items || []).some((item) => item.action === 'decision')) {
      throw serviceError('SCOPE_DECISION_REQUIRED', 'Сначала нужно принять продуктовое решение');
    }
    const fixes = (scope.items || []).filter((item) => item.action === 'fix');
    if (!fixes.length) {
      throw serviceError('SCOPE_NOT_WRITABLE', 'В scope нет замечаний для исправления кода');
    }
    if (found.binding.canFix !== true) {
      throw serviceError(
        'ROUTE_NOT_CONFIGURED',
        found.binding.configurationError?.message
          || 'Для Project не настроен Factory review route и обязательные проверки',
        found.binding.configurationError
          ? { reason: found.binding.configurationError.code }
          : undefined,
      );
    }
    const activeRunId = control.activeRuns[id];
    if (activeRunId) {
      let active;
      try {
        active = await this.runner.getRun(activeRunId);
      } catch (error) {
        throw serviceError(
          'ACTIVE_RUN_UNKNOWN',
          `Состояние активного запуска ${activeRunId} недоступно; новый запуск запрещён`,
          { cause: error?.code || 'RUN_STATE_UNAVAILABLE' },
        );
      }
      if (!TERMINAL_RUN_STATES.has(active.status)) {
        throw serviceError('ACTIVE_RUN_EXISTS', 'Для этого PR уже есть активный запуск');
      }
      await this.#releaseActiveRun(id, activeRunId, active.status);
    }
    const headRepoUrl = found.pullRequest.headRepositoryUrl;
    const headRefName = String(found.pullRequest.headRefName || '');
    if (!headRepoUrl || !headRefName) {
      throw serviceError('BAD_RUN_BINDING', 'GitHub не вернул head-репозиторий или ветку PR');
    }
    const reviewState = await this.store.read();
    const currentRemarks = new Map(
      activeRemarks(found.pullRequest).map((remark) => [remark.key, remark]),
    );
    const immutableBuildScope = fixes.map((item, index) => {
      const remark = currentRemarks.get(item.remarkId);
      const analysis = reviewState.analyses?.[item.remarkId]?.current;
      if (!remark
          || !analysis
          || analysis.stale
          || analysis.versionId !== remark.versionId
          || analysis.headSha !== found.pullRequest.headSha) {
        throw serviceError(
          'SCOPE_ANALYSIS_REQUIRED',
          'Перед исправлением нужен актуальный технический разбор каждого замечания',
        );
      }
      return {
        itemKey: item.remarkId,
        itemVersion: item.versionId,
        action: 'fix',
        instruction: item.acceptance,
        acceptance: item.acceptance,
        body: String(remark.body || ''),
        url: String(remark.url || ''),
        path: remark.path ?? null,
        line: remark.line ?? null,
        kind: remark.kind,
        reviewerRequest: analysis.reviewerRequest,
        expectedChange: analysis.expectedChange,
        verification: analysis.verification,
        decisionId: analysis.decisionId,
        confidenceId: analysis.confidenceId,
        evidence: clone(analysis.evidence || []),
        risks: clone(analysis.risks || []),
        allowedPaths: clone(item.allowedPaths || []),
        allowRiskyPaths: item.allowRiskyPaths === true,
        analysisId: analysis.analysisId,
        ...(index === 0 && { pullRequestDiff: String(found.pullRequest.diff || '') }),
      };
    });
    const reviewRunId = `rr-${crypto.randomUUID()}`;
    const link = {
      runId: reviewRunId,
      pullId: id,
      repositoryId: found.binding.id,
      projectId: found.binding.projectId,
      repoKey: found.binding.repoKey,
      reviewRouteRevision: found.binding.reviewRoute?.revision || null,
      createdAt: this.now(),
      pending: true,
    };
    // Reservation durable появляется до filesystem state. Поэтому concurrent
    // Project rebind/path edit уже видит активный run и обязан остановиться.
    await this.controlStore.mutate((state) => {
      const existing = state.activeRuns[id];
      if (existing) {
        throw serviceError('ACTIVE_RUN_EXISTS', 'Для этого PR уже есть активный запуск');
      }
      if (state.scopes[id]?.version !== scope.version
          || state.scopes[id]?.snapshotDigest !== scope.snapshotDigest) {
        throw serviceError('SCOPE_APPROVAL_STALE', 'Scope изменился до создания запуска');
      }
      state.runLinks[reviewRunId] = link;
      state.activeRuns[id] = reviewRunId;
      return link;
    });
    let run = null;
    try {
      const reserved = await this.#findPull(id);
      if (reserved.binding.id !== found.binding.id
          || reserved.binding.projectId !== found.binding.projectId
          || reserved.binding.repoKey !== found.binding.repoKey
          || path.resolve(reserved.binding.repoPath) !== path.resolve(found.binding.repoPath)
          || reserved.binding.runnerProjectId !== found.binding.runnerProjectId
          || reserved.binding.runnerRepositoryId !== found.binding.runnerRepositoryId
          || reserved.binding.reviewRoute?.revision !== found.binding.reviewRoute?.revision) {
        throw serviceError(
          'REPOSITORY_BINDING_STALE',
          'Project binding изменился одновременно с созданием запуска',
        );
      }
      run = await this.runner.createRun({
        reviewRunId,
        projectId: found.binding.runnerProjectId,
        repositoryId: found.binding.runnerRepositoryId,
        prNumber: found.pullRequest.number,
        repoPath: found.binding.repoPath,
        headRepoUrl,
        headRef: `refs/heads/${headRefName}`,
        headSha: found.pullRequest.headSha,
        snapshotDigest: scope.snapshotDigest,
        snapshotVersion: scope.version,
        reviewRoute: found.binding.reviewRoute,
        verificationPolicy: {
          commands: clone(found.binding.verifyCommands),
          coversAllCriteria: found.binding.verifyCoversCriteria === true,
        },
      });
      run = await this.runner.approveScope(run.reviewRunId, {
        scope: immutableBuildScope,
        scopeVersion: scope.version,
        actor: 'cockpit-user',
      });
      await this.controlStore.mutate((state) => {
        const existing = state.activeRuns[id];
        if (existing !== run.reviewRunId
            || state.runLinks[run.reviewRunId]?.pending !== true) {
          throw serviceError('ACTIVE_RUN_EXISTS', 'Для этого PR уже есть активный запуск');
        }
        if (state.scopes[id]?.version !== scope.version
            || state.scopes[id]?.snapshotDigest !== scope.snapshotDigest) {
          throw serviceError(
            'SCOPE_APPROVAL_STALE',
            'Scope изменился одновременно с созданием запуска',
          );
        }
        state.runLinks[run.reviewRunId] = { ...link, pending: false };
        if (!state.queue.includes(run.reviewRunId)) state.queue.push(run.reviewRunId);
        return link;
      });
    } catch (error) {
      const persisted = await this.runner.getRun(reviewRunId).catch(() => null);
      if (persisted) {
        await this.runner.store.update(reviewRunId, (state) => {
          state.status = REVIEW_RUN_STATES.BLOCKED;
          state.failure = { code: error.code || 'RUN_LINK_FAILED', message: error.message };
          return state;
        }).catch(() => {});
      }
      await this.controlStore.mutate((state) => {
        if (state.activeRuns[id] === reviewRunId) delete state.activeRuns[id];
        state.queue = state.queue.filter((candidate) => candidate !== reviewRunId);
        if (persisted) {
          state.runLinks[reviewRunId] = { ...link, pending: false, failed: true };
        } else {
          delete state.runLinks[reviewRunId];
        }
      }).catch(() => {});
      throw error;
    }
    this.#kickRuns();
    this.#broadcast({ reason: 'run-queued', pullId: id, runId: run.reviewRunId });
    return { run: normalizeRunState(await this.runner.getRun(run.reviewRunId)) };
  }

  async getRun(id) {
    return normalizeRunState(await this.runner.getRun(id));
  }

  async accept(id, { actor = 'cockpit-user' } = {}) {
    const control = await this.controlStore.read();
    const link = control.runLinks[id];
    if (!link) throw serviceError('RUN_NOT_FOUND', 'Связь запуска с PR не найдена');
    const before = await this.#findPull(link.pullId);
    assertReviewExecutorAvailable(before.binding);
    await this.#syncBinding(before.binding);
    const found = await this.#findPull(link.pullId);
    assertReviewExecutorAvailable(found.binding);
    const scope = (await this.controlStore.read()).scopes[link.pullId];
    try {
      this.#assertFreshScope(found, scope);
      const current = await this.runner.getRun(id);
      this.#assertRunMatchesScope(found, scope, current, link);
    } catch (error) {
      await this.#markRunStale(id, error);
      this.#broadcast({ reason: 'run-stale', runId: id });
      throw error;
    }
    const run = await this.runner.accept(id, { actor });
    this.#broadcast({ reason: 'accepted', runId: id });
    return normalizeRunState(run);
  }

  async publish(id, {
    actor = 'cockpit-user',
    operationId,
    retryUnknown = false,
  } = {}) {
    const control = await this.controlStore.read();
    const link = control.runLinks[id];
    if (!link) throw serviceError('RUN_NOT_FOUND', 'Связь запуска с PR не найдена');
    await this.#assertLinkedExecutorAvailable(link);
    let run = await this.runner.getRun(id);
    // После сетевого обрыва push мог уже изменить remote ref. Сначала
    // reconcилируем durable operation по самому ref; синхронизация GitHub уже
    // увидит candidate как новый head и ошибочно объявит старый scope stale.
    if ([REVIEW_RUN_STATES.PUBLISHING, REVIEW_RUN_STATES.PUBLICATION_UNKNOWN]
      .includes(run.status)) {
      run = await this.publisher.reconcile({ reviewRunId: id, actor });
      if (run.status !== REVIEW_RUN_STATES.PUBLICATION_UNKNOWN
          || retryUnknown !== true) {
        await this.#releaseActiveRun(link.pullId, id, run.status);
        this.#broadcast({ reason: 'publication-reconciled', runId: id });
        return normalizeRunState(run);
      }
    }
    try {
      await this.revalidatePublication(run);
    } catch (error) {
      if (error?.code !== 'REVIEW_EXECUTOR_UNAVAILABLE') {
        await this.#markRunStale(id, error);
        this.#broadcast({ reason: 'run-stale', runId: id });
      }
      throw error;
    }
    const published = await this.publisher.publish({
      reviewRunId: id,
      acceptanceDigest: run.acceptance?.digest,
      actor,
      operationId,
      retryUnknown: retryUnknown === true,
    });
    await this.#releaseActiveRun(link.pullId, id, published.status);
    this.#broadcast({ reason: 'published', runId: id });
    return normalizeRunState(published);
  }

  async abandon(id, { actor = 'cockpit-user' } = {}) {
    const run = await this.runner.abandon(id, { actor });
    const link = (await this.controlStore.read()).runLinks[id];
    if (link) {
      await this.#releaseActiveRun(link.pullId, id, run.status);
    }
    this.#broadcast({ reason: 'run-abandoned', runId: id });
    return normalizeRunState(run);
  }

  // Вызывается и перед созданием publish-operation, и прямо перед host push.
  // Второй вызов закрывает окно между кликом и фактической публикацией настолько,
  // насколько это возможно без атомарной транзакции GitHub comments+Git ref.
  async revalidatePublication(runOrId) {
    const run = typeof runOrId === 'string'
      ? await this.runner.getRun(runOrId)
      : runOrId;
    const id = String(run?.reviewRunId || '');
    const control = await this.controlStore.read();
    const link = control.runLinks[id];
    if (!link) throw serviceError('RUN_NOT_FOUND', 'Связь запуска с PR не найдена');
    const before = await this.#findPull(link.pullId);
    assertReviewExecutorAvailable(before.binding);
    await this.#syncBinding(before.binding);
    const found = await this.#findPull(link.pullId);
    assertReviewExecutorAvailable(found.binding);
    const scope = (await this.controlStore.read()).scopes[link.pullId];
    this.#assertFreshScope(found, scope);
    this.#assertRunMatchesScope(found, scope, run, link);
    if (String(found.pullRequest.state).toLowerCase() !== 'open'
        || found.pullRequest.headSha !== run.binding.headSha
        || `refs/heads/${found.pullRequest.headRefName}` !== run.binding.headRef
        || found.pullRequest.headRepositoryUrl !== run.binding.headRepoUrl) {
      throw serviceError('SNAPSHOT_STALE', 'PR или его head-ветка изменились');
    }
    return true;
  }

  async cleanup(id) {
    const run = await this.runner.cleanup(id, { actor: 'cockpit-user' });
    this.#broadcast({ reason: 'environment-cleaned', runId: id });
    return normalizeRunState(run);
  }

  async assertRepositoryMutable(projectId, repoKey) {
    const control = await this.controlStore.read();
    await this.#assertRepositoryMutableInState(control, projectId, [repoKey]);
    return true;
  }

  /**
   * Выполняет запись Project binding под тем же control lock, под которым run()
   * создаёт durable reservation. Отдельные «проверил → prefs.write» оставляли
   * окно, в котором запуск успевал привязаться к уже изменённому репозиторию.
   */
  async mutateRepositoryConfiguration(projectId, repoKeys, mutation) {
    if (typeof mutation !== 'function') {
      throw new TypeError('Нужна функция изменения Project binding');
    }
    const keys = repoKeys == null
      ? null
      : [...new Set((Array.isArray(repoKeys) ? repoKeys : [repoKeys])
        .map((key) => String(key || ''))
        .filter(Boolean))];
    const outcome = await this.controlStore.mutate(async (_next, current) => {
      await this.#assertRepositoryMutableInState(current, projectId, keys);
      return mutation();
    });
    this.#broadcast({
      reason: 'repository-configuration',
      projectId,
      repoKeys: keys,
    });
    return outcome.result;
  }

  async #assertRepositoryMutableInState(control, projectId, repoKeys = null) {
    const wanted = repoKeys == null ? null : new Set(repoKeys);
    const candidates = Object.values(control.runLinks || {}).filter((link) => (
      link.projectId === projectId && (!wanted || wanted.has(link.repoKey))
    ));
    for (const link of candidates) {
      let run;
      try {
        run = await this.runner.getRun(link.runId);
      } catch (error) {
        throw serviceError(
          'REPOSITORY_RUN_UNKNOWN',
          `Состояние запуска ${link.runId} недоступно; изменение привязки запрещено`,
          { cause: error?.code || 'RUN_STATE_UNAVAILABLE' },
        );
      }
      if (!TERMINAL_RUN_STATES.has(run.status)) {
        throw serviceError(
          'REPOSITORY_RUN_ACTIVE',
          `Сначала заверши или сделай устаревшим активный запуск ${link.runId}`,
        );
      }
    }
  }

  async #repositories() {
    return validateReviewRepositories(await this.repositoryProvider());
  }

  async #assertLinkedExecutorAvailable(link) {
    const repositories = await this.#repositories();
    const binding = repositories.find((repository) => (
      repository.id === link?.repositoryId
      && repository.projectId === link?.projectId
      && repository.repoKey === link?.repoKey
    ));
    assertReviewExecutorAvailable(binding);
    return binding;
  }

  async #findPull(id) {
    const [state, repositories] = await Promise.all([
      this.store.read(),
      this.#repositories(),
    ]);
    const bindings = new Map(repositories.map((item) => [item.slug.toLowerCase(), item]));
    for (const repository of Object.values(state.repositories || {})) {
      const binding = bindings.get(String(repository.nameWithOwner || '').toLowerCase());
      if (!binding) continue;
      for (const pullRequest of repository.pullRequests || []) {
        if (pullId(repository.repoNodeId, pullRequest.prNodeId) === id) {
          return { state, repository, pullRequest, binding };
        }
      }
    }
    throw serviceError('PULL_NOT_FOUND', 'PR не найден');
  }

  async #syncBinding(binding) {
    if (!this.watcher) throw serviceError('GITHUB_UNAVAILABLE', 'GitHub watcher не настроен');
    let result;
    try {
      result = await this.watcher.trigger(binding.id, { manual: true });
    } catch (error) {
      throw serviceError('GITHUB_UNAVAILABLE', 'Не удалось доказать свежесть PR', {
        reason: error?.code || 'watcher_failed',
      });
    }
    this.#assertSyncResult(result);
    this.#kickModels();
  }

  #assertSyncResult(result) {
    if (['changed', 'unchanged'].includes(result?.status)) return true;
    if (['cooldown', 'backoff'].includes(result?.status)) {
      throw serviceError('RATE_LIMITED', 'GitHub временно ограничил обновление', {
        retryAt: result.retryAt || null,
        reason: result.reason || result.status,
      });
    }
    if (result?.status === 'busy') {
      throw serviceError('GITHUB_SYNC_BUSY', 'Этот репозиторий уже проверяется другим процессом');
    }
    throw serviceError('GITHUB_UNAVAILABLE', 'Не удалось доказать свежесть PR', {
      reason: result?.code || result?.status || 'unknown',
      retryAt: result?.retryAt || null,
    });
  }

  #assertFreshScope(found, scope) {
    if (!scope) throw serviceError('SCOPE_APPROVAL_REQUIRED', 'Сначала сохрани решения по замечаниям');
    const active = activeRemarks(found.pullRequest);
    const currentVersions = new Map(active.map((remark) => [remark.key, remark.versionId]));
    if (String(found.pullRequest.state).toLowerCase() !== 'open') {
      throw serviceError('PR_CLOSED', 'PR уже закрыт');
    }
    if (scope.headSha !== found.pullRequest.headSha
        || scope.snapshotDigest !== pullDigest(found.repository, found.pullRequest)
        || scope.items.length !== currentVersions.size
        || scope.items.some((item) => currentVersions.get(item.remarkId) !== item.versionId)) {
      throw serviceError('SCOPE_APPROVAL_STALE', 'PR или замечания изменились после выбора scope');
    }
  }

  #assertRunMatchesScope(found, scope, run, link = null) {
    if (!run
        || run.projectId !== found.binding.runnerProjectId
        || run.repositoryId !== found.binding.runnerRepositoryId
        || !run.reviewRoute
        || run.reviewRoute.revision !== found.binding.reviewRoute?.revision
        || run.reviewRoute.profileId !== found.binding.reviewRoute?.profileId
        || run.reviewRoute.routeId !== found.binding.reviewRoute?.routeId
        || JSON.stringify(run.verificationPolicy) !== JSON.stringify({
          commands: found.binding.verifyCommands,
          coversAllCriteria: found.binding.verifyCoversCriteria === true,
        })
        || !run.binding?.repoPath
        || path.resolve(run.binding.repoPath) !== path.resolve(found.binding.repoPath)
        || (link && (
          link.repositoryId !== found.binding.id
          || link.projectId !== found.binding.projectId
          || link.repoKey !== found.binding.repoKey
          || link.reviewRouteRevision !== found.binding.reviewRoute?.revision
        ))
        || run.binding?.headSha !== found.pullRequest.headSha
        || run.binding?.headRepoUrl !== found.pullRequest.headRepositoryUrl
        || run.binding?.headRef !== `refs/heads/${found.pullRequest.headRefName}`
        || run.snapshot?.headSha !== found.pullRequest.headSha
        || run.snapshot?.digest !== scope.snapshotDigest
        || run.snapshot?.version !== scope.version
        || run.scopeApproval?.version !== scope.version) {
      throw serviceError(
        'SCOPE_APPROVAL_STALE',
        'Выбранный объём работы изменился после создания этого запуска',
      );
    }
  }

  async #enqueueAnalysis(found, items, { manual = false } = {}) {
    if (!this.analysisQueue) throw serviceError('MODEL_UNAVAILABLE', 'Анализатор не настроен');
    const sourceSnapshot = await readSourceSnapshot({
      repository: found.binding,
      pullRequest: found.pullRequest,
      items,
    });
    let result;
    try {
      result = await this.analysisQueue.enqueue({
        repoNodeId: found.repository.repoNodeId,
        prNodeId: found.pullRequest.prNodeId,
        headSha: found.pullRequest.headSha,
        items,
        diff: String(found.pullRequest.diff || ''),
        sourceSnapshot,
      }, {
        availableAt: manual ? this.now() : undefined,
      });
    } catch (error) {
      if (error instanceof TypeError) {
        throw serviceError(
          'BAD_ANALYSIS_INPUT',
          `Замечания слишком велики или некорректны для безопасного анализа: ${error.message}`,
        );
      }
      throw error;
    }
    if (manual) {
      await this.store.clearAutoAnalysisDeferrals(items.map((item) => item.key));
    }
    return result;
  }

  #kickModels() {
    if (this.closed || this.modelDrain || !this.analysisQueue || !this.translatorQueue) return;
    const worker = async (workerIndex) => {
      let preferredQueue = workerIndex % 2 === 0 ? 'analysis' : 'translation';
      const queues = {
        analysis: this.analysisQueue,
        translation: this.translatorQueue,
      };
      for (;;) {
        const fallbackQueue = preferredQueue === 'analysis' ? 'translation' : 'analysis';
        let handled = false;
        for (const queueName of [preferredQueue, fallbackQueue]) {
          const outcome = await queues[queueName].runNext();
          if (!outcome) continue;
          this.#broadcast({ reason: `${queueName}-finished` });
          preferredQueue = queueName === 'analysis' ? 'translation' : 'analysis';
          handled = true;
          break;
        }
        if (!handled) break;
      }
    };
    this.modelDrain = Promise.all(
      Array.from({ length: this.modelConcurrency }, (_, index) => worker(index)),
    ).catch((error) => {
      this.log?.error?.({ code: error?.code, err: error?.message }, 'review model queue упала');
    }).finally(() => {
      this.modelDrain = null;
    });
  }

  #kickRuns() {
    if (this.closed || this.runDrain) return;
    this.runDrain = this.#drainRuns()
      .catch((error) => {
        this.log?.error?.({ code: error?.code, err: error?.message }, 'review run queue упала');
      })
      .finally(() => {
        this.runDrain = null;
      });
  }

  #maintainRuns() {
    if (this.closed || this.runMaintenance) return;
    this.runMaintenance = this.#reconcileRuns()
      .then(() => this.#kickRuns())
      .catch((error) => {
        this.log?.error?.({ code: error?.code, err: error?.message }, 'review recovery tick упал');
      })
      .finally(() => {
        this.runMaintenance = null;
      });
  }

  #runClaimHeartbeat(claim) {
    const state = { error: null, stopped: false, pending: Promise.resolve() };
    const renew = () => {
      if (state.stopped) return;
      state.pending = this.controlStore.renewRunClaim({
        runId: claim.runId,
        workerId: claim.workerId,
        fencingToken: claim.fencingToken,
        leaseMs: this.runClaimLeaseMs,
      }).catch((error) => { state.error = error; });
    };
    const timer = setInterval(renew, Math.max(1_000, Math.floor(this.runClaimLeaseMs / 3)));
    timer.unref?.();
    return {
      assertOwned: async () => {
        renew();
        await state.pending;
        if (state.error) throw state.error;
      },
      stop: async () => {
        state.stopped = true;
        clearInterval(timer);
        await state.pending;
      },
    };
  }

  async #drainRuns() {
    while (!this.closed) {
      const claim = await this.controlStore.claimNextRun({
        workerId: this.runWorkerId,
        leaseMs: this.runClaimLeaseMs,
      });
      if (!claim) break;
      const { runId, link } = claim;
      const claimHeartbeat = this.#runClaimHeartbeat(claim);
      let claimReleased = false;
      try {
        let context = await this.#freshRunContext(link, runId);
        let { run } = context;
        if (run.status === REVIEW_RUN_STATES.APPROVED) {
          await claimHeartbeat.assertOwned();
          run = await this.runner.build(runId, {
            instruction: 'Исправь только утверждённые пункты scope и не расширяй изменение.',
          });
          // Комментарий/head/scope могли измениться во время долгого BUILD.
          // Candidate сохраняем, но к VERIFY допускаем только свежий запуск.
          await claimHeartbeat.assertOwned();
          context = await this.#freshRunContext(link, runId);
          run = context.run;
        }
        if (run.status === REVIEW_RUN_STATES.BUILT) {
          await claimHeartbeat.assertOwned();
          const commands = (run.verificationPolicy?.commands || []).map((command, index) => (
            parseReviewVerifyCommand(command, index, {
              coversAllCriteria: run.verificationPolicy?.coversAllCriteria === true,
            })
          ));
          run = await this.runner.verify(runId, { commands });
          // Не показываем VERIFIED как актуальный, если PR изменился во время
          // проверок. Отчёт остаётся в истории старой попытки.
          await claimHeartbeat.assertOwned();
          context = await this.#freshRunContext(link, runId);
          run = context.run;
        }
        await claimHeartbeat.assertOwned();
        await this.controlStore.completeRunClaim({
          runId,
          workerId: claim.workerId,
          fencingToken: claim.fencingToken,
          releaseActive: TERMINAL_RUN_STATES.has(run.status),
        });
        claimReleased = true;
      } catch (error) {
        if (['SCOPE_APPROVAL_STALE', 'SNAPSHOT_STALE', 'PR_CLOSED'].includes(error?.code)) {
          await this.#markRunStale(runId, error).catch(() => {});
        }
        let current = await this.runner.getRun(runId).catch(() => null);
        if (current && !TERMINAL_RUN_STATES.has(current.status)
            && this.#isTransientRunError(error)) {
          const deferred = await this.controlStore.deferRunClaim({
            runId,
            workerId: claim.workerId,
            fencingToken: claim.fencingToken,
            availableAt: this.#runRetryAt(error),
            error,
            countAttempt: error?.code !== 'RATE_LIMITED',
          }).catch((deferError) => {
            if (deferError?.code === 'STALE_FENCE') return null;
            throw deferError;
          });
          claimReleased = Boolean(deferred);
          if (deferred && error?.code === 'GITHUB_UNAVAILABLE' && deferred.attempts >= 3) {
            current = await this.#markRunBlocked(runId, error).catch(() => current);
            await this.#releaseActiveRun(link.pullId, runId, current?.status);
          }
        } else if (current && !TERMINAL_RUN_STATES.has(current.status)
            && error?.code !== 'STALE_FENCE') {
          current = await this.#markRunBlocked(runId, error).catch(() => current);
        }
        if (current && TERMINAL_RUN_STATES.has(current.status) && !claimReleased) {
          await claimHeartbeat.assertOwned().catch(() => {});
          await this.controlStore.completeRunClaim({
            runId,
            workerId: claim.workerId,
            fencingToken: claim.fencingToken,
            releaseActive: true,
          }).then(() => { claimReleased = true; }).catch((completeError) => {
            if (completeError?.code !== 'STALE_FENCE') throw completeError;
          });
        } else if (current && TERMINAL_RUN_STATES.has(current.status)) {
          await this.#releaseActiveRun(link.pullId, runId, current.status);
        }
        this.log?.warn?.({
          runId,
          code: error?.code,
          err: error?.message,
        }, 'review run завершён без готового результата');
      } finally {
        await claimHeartbeat.stop();
        if (!claimReleased) {
          await this.controlStore.releaseRunClaim({
            runId,
            workerId: claim.workerId,
            fencingToken: claim.fencingToken,
          }).catch((error) => {
            if (error?.code !== 'STALE_FENCE') throw error;
          });
        }
      }
      this.#broadcast({ reason: 'run-updated', runId });
    }
  }

  async #freshRunContext(link, runId) {
    const before = await this.#findPull(link.pullId);
    assertReviewExecutorAvailable(before.binding);
    await this.#syncBinding(before.binding);
    const found = await this.#findPull(link.pullId);
    assertReviewExecutorAvailable(found.binding);
    const scope = (await this.controlStore.read()).scopes[link.pullId];
    const run = await this.runner.getRun(runId);
    this.#assertFreshScope(found, scope);
    this.#assertRunMatchesScope(found, scope, run, link);
    return { found, scope, run };
  }

  #isTransientRunError(error) {
    return new Set([
      'RATE_LIMITED',
      'GITHUB_UNAVAILABLE',
      'GITHUB_SYNC_BUSY',
      'LEASE_BUSY',
      'REVIEW_CONTROL_LOCK_LOST',
      'STATE_LOCK_TIMEOUT',
      'STATE_LOCK_UNAVAILABLE',
      'STATE_LOCK_LOST',
      'REVIEW_CONTROL_LOCK_TIMEOUT',
      'REVIEW_CONTROL_LOCK_UNAVAILABLE',
      'REVIEW_STORE_LOCK_TIMEOUT',
      'REVIEW_STORE_LOCK_UNAVAILABLE',
      'REVIEW_STORE_LOCK_LOST',
    ]).has(error?.code);
  }

  #runRetryAt(error) {
    const requested = Number(error?.details?.retryAt || 0);
    if (Number.isFinite(requested) && requested > this.now()) return requested;
    if (error?.code === 'RATE_LIMITED') return this.now() + 60_000;
    if (['GITHUB_SYNC_BUSY', 'LEASE_BUSY'].includes(error?.code)) return this.now() + 2_000;
    return this.now() + 5_000;
  }

  async #markRunBlocked(runId, error) {
    return this.runner.store.update(runId, (state) => {
      state.status = REVIEW_RUN_STATES.BLOCKED;
      state.failure = {
        code: error?.code || 'RUN_BLOCKED',
        message: String(error?.message || 'Запуск заблокирован').slice(0, 2_000),
        detectedAt: this.now(),
      };
      state.acceptance = null;
      state.publication = null;
      return state;
    });
  }

  async #markRunStale(runId, error) {
    return this.runner.store.update(runId, (state) => {
      state.status = REVIEW_RUN_STATES.STALE;
      state.stale = {
        code: error?.code || 'SNAPSHOT_STALE',
        message: String(error?.message || 'PR изменился').slice(0, 2_000),
        detectedAt: this.now(),
      };
      state.acceptance = null;
      state.publication = null;
      return state;
    });
  }

  async #releaseActiveRun(pullKey, runId, status) {
    if (!TERMINAL_RUN_STATES.has(status) && status !== REVIEW_RUN_STATES.PUBLISHED) return;
    await this.controlStore.mutate((state) => {
      if (state.activeRuns[pullKey] === runId) delete state.activeRuns[pullKey];
      state.queue = state.queue.filter((candidate) => candidate !== runId);
      if (state.runRetries) delete state.runRetries[runId];
      return true;
    });
  }

  async #reconcileRuns() {
    const runs = await this.runner.listRuns();
    const knownRunIds = new Set(runs.map((run) => run.reviewRunId).filter(Boolean));
    for (const run of runs) {
      let link = (await this.controlStore.read()).runLinks[run.reviewRunId];
      if (!link) link = await this.#recoverOrphanRun(run);
      if (!link) continue;
      if (link.pending) {
        // Crash между durable reservation/createRun и approveScope оставляет
        // AWAITING_SCOPE без worker-а, который знает immutable BUILD scope.
        // Автоматически продолжать такой run нельзя и держать PR навечно
        // активным тоже нельзя.
        if (run.status === REVIEW_RUN_STATES.AWAITING_SCOPE) {
          await this.#markRunBlocked(run.reviewRunId, serviceError(
            'ORPHAN_SCOPE_INCOMPLETE',
            'Запуск прервался до durable утверждения scope; создай новую попытку',
          )).catch(() => {});
          await this.controlStore.mutate((state) => {
            const currentLink = state.runLinks[run.reviewRunId];
            if (currentLink) {
              state.runLinks[run.reviewRunId] = {
                ...currentLink,
                pending: false,
                failed: true,
              };
            }
            if (state.activeRuns[link.pullId] === run.reviewRunId) {
              delete state.activeRuns[link.pullId];
            }
            state.queue = state.queue.filter((candidate) => candidate !== run.reviewRunId);
            if (state.runClaims) delete state.runClaims[run.reviewRunId];
            if (state.runRetries) delete state.runRetries[run.reviewRunId];
            return true;
          });
          continue;
        }
        await this.controlStore.mutate((state) => {
          const currentLink = state.runLinks[run.reviewRunId];
          if (currentLink?.pending) currentLink.pending = false;
          return true;
        });
        link = { ...link, pending: false };
      }
      let current = run;
      if ([
        REVIEW_RUN_STATES.PROVISIONING,
        REVIEW_RUN_STATES.BUILDING,
        REVIEW_RUN_STATES.VERIFYING,
        REVIEW_RUN_STATES.PUBLISHING,
      ].includes(current.status)) {
        current = await this.runner.recover(current.reviewRunId).catch(() => current);
      }
      if ([REVIEW_RUN_STATES.APPROVED, REVIEW_RUN_STATES.BUILT].includes(current.status)) {
        await this.controlStore.mutate((state) => {
          if (!state.queue.includes(current.reviewRunId)) state.queue.push(current.reviewRunId);
          state.activeRuns[link.pullId] = current.reviewRunId;
          return true;
        });
      } else if (TERMINAL_RUN_STATES.has(current.status)) {
        await this.#releaseActiveRun(link.pullId, current.reviewRunId, current.status);
      }
    }
    // Crash до createRun оставляет только reservation. После рестарта worker,
    // который мог бы создать state, уже не существует — reservation можно снять.
    await this.controlStore.mutate((state) => {
      for (const [runId, link] of Object.entries(state.runLinks || {})) {
        if (!link?.pending || knownRunIds.has(runId)) continue;
        if (state.activeRuns[link.pullId] === runId) delete state.activeRuns[link.pullId];
        state.queue = state.queue.filter((candidate) => candidate !== runId);
        delete state.runLinks[runId];
      }
      return true;
    });
  }

  async #recoverOrphanRun(run) {
    if (TERMINAL_RUN_STATES.has(run.status)) return null;
    const [inbox, repositories] = await Promise.all([
      this.store.read(),
      this.#repositories(),
    ]);
    const binding = repositories.find((repository) => (
      repository.runnerProjectId === run.projectId
      && repository.runnerRepositoryId === run.repositoryId
      && repository.repoPath === run.binding?.repoPath
      && repository.reviewRoute?.revision === run.reviewRoute?.revision
    ));
    const storedRepository = binding
      ? Object.values(inbox.repositories || {}).find((repository) => (
        String(repository.nameWithOwner || '').toLowerCase() === binding.slug.toLowerCase()
      ))
      : null;
    const pullRequest = storedRepository?.pullRequests?.find((pull) => (
      Number(pull.number) === Number(run.prNumber)
      && pull.headSha === run.binding?.headSha
    ));
    if (!binding || !storedRepository || !pullRequest) {
      await this.#markRunBlocked(run.reviewRunId, serviceError(
        'ORPHAN_RUN_BINDING_LOST',
        'После сбоя не удалось однозначно восстановить связь запуска с PR',
      )).catch(() => {});
      return null;
    }
    const id = pullId(storedRepository.repoNodeId, pullRequest.prNodeId);
    const link = {
      runId: run.reviewRunId,
      pullId: id,
      repositoryId: binding.id,
      projectId: binding.projectId,
      repoKey: binding.repoKey,
      reviewRouteRevision: binding.reviewRoute?.revision || null,
      createdAt: Number(run.createdAt || this.now()),
      recoveredAt: this.now(),
    };
    try {
      await this.controlStore.mutate((state) => {
        const active = state.activeRuns[id];
        if (active && active !== run.reviewRunId) {
          throw serviceError(
            'ACTIVE_RUN_EXISTS',
            `PR уже связан с другим активным запуском ${active}`,
          );
        }
        state.runLinks[run.reviewRunId] = link;
        state.activeRuns[id] = run.reviewRunId;
        if ([REVIEW_RUN_STATES.APPROVED, REVIEW_RUN_STATES.BUILT].includes(run.status)
            && !state.queue.includes(run.reviewRunId)) {
          state.queue.push(run.reviewRunId);
        }
        return link;
      });
    } catch (error) {
      await this.#markRunBlocked(run.reviewRunId, error).catch(() => {});
      return null;
    }
    if (run.status === REVIEW_RUN_STATES.AWAITING_SCOPE) {
      await this.#markRunBlocked(run.reviewRunId, serviceError(
        'ORPHAN_SCOPE_INCOMPLETE',
        'Сбой произошёл до durable утверждения scope; автоматический повтор запрещён',
      )).catch(() => {});
      await this.#releaseActiveRun(id, run.reviewRunId, REVIEW_RUN_STATES.BLOCKED);
    }
    return link;
  }

  #summaryFrom(pulls, version) {
    const attention = pulls.filter((pull) => (
      String(pull.state).toLowerCase() === 'open' && pull.attention?.tone
    ));
    let tone = '';
    for (const pull of attention) tone = strongerTone(tone, pull.attention.tone);
    return {
      count: new Set(attention.map((pull) => pull.id)).size,
      tone,
      title: attention.length
        ? `${new Set(attention.map((pull) => pull.id)).size} ${pluralPr(
          new Set(attention.map((pull) => pull.id)).size,
        )}`
        : 'Нет PR, требующих внимания',
      version,
    };
  }

  #broadcast(data) {
    try {
      this.sse?.broadcast?.('reviews-change', { at: this.now(), ...data });
    } catch {
      // SSE — сигнал. Durable state уже записан и останется источником истины.
    }
  }
}

export const createReviewSourceSnapshot = readSourceSnapshot;
export const reviewPullId = pullId;
