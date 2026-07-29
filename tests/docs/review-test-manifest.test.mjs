import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

// Одна запись описывает ровно один обычный критерий из плана. `required` означает,
// что уже существует исполняемый тест с этим ID. `planned` честно оставляет
// критерий незавершённым; его будущий файл пока может отсутствовать.
const manifest = Object.freeze([
  { id: 'RB-01', path: 'tests/docs/review-test-manifest.test.mjs', runner: 'docs', phase: '00-test-contour', status: 'required' },
  { id: 'RB-02', path: 'tests/server/review-identity.test.js', runner: 'server', phase: '00-test-contour', status: 'required' },
  { id: 'RB-03', path: 'tests/server/review-store.test.js', runner: 'server', phase: '00-test-contour', status: 'required' },
  { id: 'RB-04', path: 'tests/server/review-api.test.js', runner: 'server', phase: '00-test-contour', status: 'planned' },
  { id: 'RB-05', path: 'tests/server/review-publish-git.test.js', runner: 'server', phase: '00-test-contour', status: 'required' },
  { id: 'RB-06', path: 'tests/server/review-model-adapter.test.js', runner: 'server', phase: '00-test-contour', status: 'planned' },
  { id: 'RB-07', path: 'tests/server/review-auth.test.js', runner: 'server', phase: '00-test-contour', status: 'planned' },

  { id: 'MAP-01', path: 'tests/server/review-project-repositories.test.js', runner: 'server', phase: '01-project-binding', status: 'planned' },
  { id: 'MAP-02', path: 'tests/server/review-project-repositories.test.js', runner: 'server', phase: '01-project-binding', status: 'required' },
  { id: 'MAP-03', path: 'tests/server/review-project-repositories.test.js', runner: 'server', phase: '01-project-binding', status: 'required' },
  { id: 'MAP-04', path: 'tests/server/review-project-repositories.test.js', runner: 'server', phase: '01-project-binding', status: 'required' },
  { id: 'MAP-05', path: 'tests/server/review-project-repositories.test.js', runner: 'server', phase: '01-project-binding', status: 'required' },
  { id: 'MAP-06', path: 'tests/server/review-project-repositories.test.js', runner: 'server', phase: '01-project-binding', status: 'required' },
  { id: 'MAP-07', path: 'tests/server/review-factory-route.test.js', runner: 'server', phase: '01-project-binding', status: 'required' },
  { id: 'MAP-08', path: 'tests/server/review-project-repositories.test.js', runner: 'server', phase: '01-project-binding', status: 'planned' },

  { id: 'SYNC-01', path: 'tests/server/review-github-sync.test.js', runner: 'server', phase: '02-github-sync', status: 'required' },
  { id: 'SYNC-02', path: 'tests/server/review-github-sync.test.js', runner: 'server', phase: '02-github-sync', status: 'required' },
  { id: 'SYNC-03', path: 'tests/server/review-identity.test.js', runner: 'server', phase: '02-github-sync', status: 'required' },
  { id: 'SYNC-04', path: 'tests/server/review-identity.test.js', runner: 'server', phase: '02-github-sync', status: 'required' },
  { id: 'SYNC-05', path: 'tests/server/review-identity.test.js', runner: 'server', phase: '02-github-sync', status: 'required' },
  { id: 'SYNC-06', path: 'tests/server/review-store.test.js', runner: 'server', phase: '02-github-sync', status: 'required' },
  { id: 'SYNC-07', path: 'tests/server/review-github-sync.test.js', runner: 'server', phase: '02-github-sync', status: 'planned' },
  { id: 'SYNC-08', path: 'tests/server/review-github-sync.test.js', runner: 'server', phase: '02-github-sync', status: 'required' },
  { id: 'SYNC-09', path: 'tests/server/review-github-sync.test.js', runner: 'server', phase: '02-github-sync', status: 'required' },
  { id: 'SYNC-10', path: 'tests/server/review-github-sync.test.js', runner: 'server', phase: '02-github-sync', status: 'planned' },
  { id: 'SYNC-11', path: 'tests/server/review-github-sync.test.js', runner: 'server', phase: '02-github-sync', status: 'planned' },

  { id: 'WATCH-01', path: 'tests/server/review-watcher.test.js', runner: 'server', phase: '03-watcher', status: 'required' },
  { id: 'WATCH-02', path: 'tests/server/review-watcher.test.js', runner: 'server', phase: '03-watcher', status: 'required' },
  { id: 'WATCH-03', path: 'tests/server/review-watcher.test.js', runner: 'server', phase: '03-watcher', status: 'required' },
  { id: 'WATCH-04', path: 'tests/server/review-watcher.test.js', runner: 'server', phase: '03-watcher', status: 'required' },
  { id: 'WATCH-05', path: 'tests/server/review-watcher.test.js', runner: 'server', phase: '03-watcher', status: 'required' },
  { id: 'WATCH-06', path: 'tests/server/review-watcher.test.js', runner: 'server', phase: '03-watcher', status: 'required' },
  { id: 'WATCH-07', path: 'tests/server/review-watcher.test.js', runner: 'server', phase: '03-watcher', status: 'required' },
  { id: 'WATCH-08', path: 'tests/server/review-watcher.test.js', runner: 'server', phase: '03-watcher', status: 'planned' },
  { id: 'WATCH-RATE-01', path: 'tests/server/review-watcher.test.js', runner: 'server', phase: '03-watcher', status: 'required' },
  { id: 'WATCH-RATE-02', path: 'tests/server/review-watcher.test.js', runner: 'server', phase: '03-watcher', status: 'required' },
  { id: 'WATCH-RATE-03', path: 'tests/server/review-store.test.js', runner: 'server', phase: '03-watcher', status: 'required' },
  { id: 'WATCH-RATE-04', path: 'tests/server/review-watcher.test.js', runner: 'server', phase: '03-watcher', status: 'required' },
  { id: 'WATCH-RATE-05', path: 'tests/server/review-watcher.test.js', runner: 'server', phase: '03-watcher', status: 'required' },
  { id: 'WATCH-RACE-01', path: 'tests/server/review-watcher.test.js', runner: 'server', phase: '03-watcher', status: 'required' },
  { id: 'WATCH-RACE-02', path: 'tests/engine/race/review-run-fencing.sh', runner: 'engine', phase: '03-watcher', status: 'required' },
  { id: 'WATCH-RACE-03', path: 'tests/server/review-watcher-race.test.js', runner: 'server', phase: '03-watcher', status: 'planned' },
  { id: 'WATCH-RACE-04', path: 'tests/server/review-watcher-race.test.js', runner: 'server', phase: '03-watcher', status: 'planned' },

  { id: 'ANALYZE-01', path: 'tests/server/review-analysis-contract.test.js', runner: 'server', phase: '04-analysis', status: 'required' },
  { id: 'ANALYZE-02', path: 'tests/server/review-analysis-contract.test.js', runner: 'server', phase: '04-analysis', status: 'required' },
  { id: 'ANALYZE-03', path: 'tests/server/review-analysis-contract.test.js', runner: 'server', phase: '04-analysis', status: 'required' },
  { id: 'ANALYZE-04', path: 'tests/server/review-analysis-contract.test.js', runner: 'server', phase: '04-analysis', status: 'required' },
  { id: 'ANALYZE-05', path: 'tests/server/review-analysis-contract.test.js', runner: 'server', phase: '04-analysis', status: 'required' },
  { id: 'ANALYZE-06', path: 'tests/server/review-analysis-contract.test.js', runner: 'server', phase: '04-analysis', status: 'required' },
  { id: 'ANALYZE-07', path: 'tests/server/review-analysis-contract.test.js', runner: 'server', phase: '04-analysis', status: 'required' },
  { id: 'ANALYZE-08', path: 'tests/server/review-analysis-contract.test.js', runner: 'server', phase: '04-analysis', status: 'required' },
  { id: 'ANALYZE-09', path: 'tests/server/review-analysis-contract.test.js', runner: 'server', phase: '04-analysis', status: 'planned' },

  { id: 'TRANSLATE-01', path: 'tests/server/review-translator-contract.test.js', runner: 'server', phase: '05-translation', status: 'required' },
  { id: 'TRANSLATE-02', path: 'tests/server/review-translator-contract.test.js', runner: 'server', phase: '05-translation', status: 'required' },
  { id: 'TRANSLATE-03', path: 'tests/server/review-translator-contract.test.js', runner: 'server', phase: '05-translation', status: 'required' },
  { id: 'TRANSLATE-04', path: 'tests/server/review-translator-contract.test.js', runner: 'server', phase: '05-translation', status: 'required' },
  { id: 'TRANSLATE-05', path: 'tests/server/review-translator-contract.test.js', runner: 'server', phase: '05-translation', status: 'required' },
  { id: 'TRANSLATE-06', path: 'tests/server/review-translator-contract.test.js', runner: 'server', phase: '05-translation', status: 'required' },
  { id: 'TRANSLATE-07', path: 'tests/server/review-translator-contract.test.js', runner: 'server', phase: '05-translation', status: 'required' },
  { id: 'TRANSLATE-08', path: 'tests/server/review-translator-contract.test.js', runner: 'server', phase: '05-translation', status: 'planned' },

  { id: 'GATE-01', path: 'tests/server/review-state-machine.test.js', runner: 'server', phase: '06-human-gates', status: 'planned' },
  { id: 'GATE-02', path: 'tests/server/review-state-machine.test.js', runner: 'server', phase: '06-human-gates', status: 'planned' },
  { id: 'GATE-03', path: 'tests/server/review-state-machine.test.js', runner: 'server', phase: '06-human-gates', status: 'required' },
  { id: 'GATE-04', path: 'tests/server/review-service.test.js', runner: 'server', phase: '06-human-gates', status: 'planned' },
  { id: 'GATE-05', path: 'tests/server/review-state-machine.test.js', runner: 'server', phase: '06-human-gates', status: 'required' },
  { id: 'GATE-06', path: 'tests/server/review-state-machine.test.js', runner: 'server', phase: '06-human-gates', status: 'required' },
  { id: 'GATE-07', path: 'tests/server/review-state-machine.test.js', runner: 'server', phase: '06-human-gates', status: 'required' },
  { id: 'GATE-08', path: 'tests/server/review-state-machine.test.js', runner: 'server', phase: '06-human-gates', status: 'required' },
  { id: 'GATE-09', path: 'tests/server/review-api.test.js', runner: 'server', phase: '06-human-gates', status: 'planned' },

  { id: 'RUN-01', path: 'tests/engine/integration/review-isolation.sh', runner: 'engine', phase: '07-run-state', status: 'required' },
  { id: 'RUN-02', path: 'tests/engine/integration/review-isolation.sh', runner: 'engine', phase: '07-run-state', status: 'required' },
  { id: 'RUN-03', path: 'tests/server/review-state-machine.test.js', runner: 'server', phase: '07-run-state', status: 'required' },
  { id: 'RUN-04', path: 'tests/server/review-recovery.test.js', runner: 'server', phase: '07-run-state', status: 'required' },
  { id: 'RUN-05', path: 'tests/server/review-recovery.test.js', runner: 'server', phase: '07-run-state', status: 'planned' },
  { id: 'RUN-06', path: 'tests/server/review-recovery.test.js', runner: 'server', phase: '07-run-state', status: 'planned' },
  { id: 'RUN-07', path: 'tests/server/review-store.test.js', runner: 'server', phase: '07-run-state', status: 'planned' },
  { id: 'RUN-08', path: 'tests/server/review-store.test.js', runner: 'server', phase: '07-run-state', status: 'required' },

  { id: 'ISOLATE-01', path: 'tests/engine/integration/review-isolation.sh', runner: 'engine', phase: '08-runtime-isolation', status: 'required' },
  { id: 'ISOLATE-02', path: 'tests/engine/integration/review-isolation.sh', runner: 'engine', phase: '08-runtime-isolation', status: 'required' },
  { id: 'ISOLATE-03', path: 'tests/engine/integration/review-isolation.sh', runner: 'engine', phase: '08-runtime-isolation', status: 'planned' },
  { id: 'ISOLATE-04', path: 'tests/engine/integration/review-isolation.sh', runner: 'engine', phase: '08-runtime-isolation', status: 'planned' },
  { id: 'ISOLATE-05', path: 'tests/engine/integration/review-isolation.sh', runner: 'engine', phase: '08-runtime-isolation', status: 'planned' },
  { id: 'ISOLATE-06', path: 'tests/server/review-recovery.test.js', runner: 'server', phase: '08-runtime-isolation', status: 'planned' },
  { id: 'ISOLATE-07', path: 'tests/engine/integration/review-isolation.sh', runner: 'engine', phase: '08-runtime-isolation', status: 'planned' },

  { id: 'SEC-01', path: 'tests/server/review-build-agent.test.js', runner: 'server', phase: '09-execution-security', status: 'planned' },
  { id: 'SEC-02', path: 'tests/server/review-build-agent.test.js', runner: 'server', phase: '09-execution-security', status: 'planned' },
  { id: 'SEC-03', path: 'tests/server/review-build-agent.test.js', runner: 'server', phase: '09-execution-security', status: 'planned' },
  { id: 'SEC-04', path: 'tests/server/review-recovery.test.js', runner: 'server', phase: '09-execution-security', status: 'planned' },
  { id: 'SEC-05', path: 'tests/engine/contract/review-agent-envelope.sh', runner: 'engine', phase: '09-execution-security', status: 'planned' },
  { id: 'SEC-06', path: 'tests/server/review-recovery.test.js', runner: 'server', phase: '09-execution-security', status: 'planned' },
  { id: 'SEC-07', path: 'tests/server/review-model-adapter.test.js', runner: 'server', phase: '09-execution-security', status: 'required' },
  { id: 'SEC-08', path: 'tests/server/review-model-adapter.test.js', runner: 'server', phase: '09-execution-security', status: 'planned' },
  { id: 'SEC-09', path: 'tests/server/review-model-adapter.test.js', runner: 'server', phase: '09-execution-security', status: 'planned' },
  { id: 'SEC-10', path: 'tests/engine/contract/review-agent-envelope.sh', runner: 'engine', phase: '09-execution-security', status: 'planned' },
  { id: 'SEC-COOKIE-01', path: 'tests/server/gateway-cookie-boundary.test.js', runner: 'server', phase: '09-execution-security', status: 'required' },
  { id: 'SEC-COOKIE-02', path: 'tests/server/gateway-cookie-boundary.test.js', runner: 'server', phase: '09-execution-security', status: 'required' },
  { id: 'SEC-COOKIE-03', path: 'tests/server/gateway-cookie-boundary.test.js', runner: 'server', phase: '09-execution-security', status: 'required' },
  { id: 'SEC-COOKIE-04', path: 'tests/server/gateway-cookie-boundary.test.js', runner: 'server', phase: '09-execution-security', status: 'required' },
  { id: 'SEC-COOKIE-05', path: 'tests/server/gateway-cookie-boundary.test.js', runner: 'server', phase: '09-execution-security', status: 'required' },
  { id: 'SEC-VERIFY-01', path: 'tests/server/review-recovery.test.js', runner: 'server', phase: '09-execution-security', status: 'required' },

  { id: 'VERIFY-01', path: 'tests/server/review-recovery.test.js', runner: 'server', phase: '10-verification', status: 'required' },
  { id: 'VERIFY-02', path: 'tests/server/review-recovery.test.js', runner: 'server', phase: '10-verification', status: 'required' },
  { id: 'VERIFY-03', path: 'tests/server/review-recovery.test.js', runner: 'server', phase: '10-verification', status: 'required' },
  { id: 'VERIFY-04', path: 'tests/server/review-state-machine.test.js', runner: 'server', phase: '10-verification', status: 'planned' },
  { id: 'VERIFY-05', path: 'tests/server/review-recovery.test.js', runner: 'server', phase: '10-verification', status: 'required' },
  { id: 'VERIFY-06', path: 'tests/engine/integration/review-verify.sh', runner: 'engine', phase: '10-verification', status: 'required' },

  { id: 'FRESH-01', path: 'tests/server/review-publish-git.test.js', runner: 'server', phase: '11-freshness', status: 'planned' },
  { id: 'FRESH-02', path: 'tests/server/review-service.test.js', runner: 'server', phase: '11-freshness', status: 'planned' },
  { id: 'FRESH-03', path: 'tests/server/review-service.test.js', runner: 'server', phase: '11-freshness', status: 'planned' },
  { id: 'FRESH-04', path: 'tests/server/review-publish.test.js', runner: 'server', phase: '11-freshness', status: 'planned' },
  { id: 'FRESH-05', path: 'tests/server/review-publish.test.js', runner: 'server', phase: '11-freshness', status: 'planned' },
  { id: 'FRESH-06', path: 'tests/server/review-publish.test.js', runner: 'server', phase: '11-freshness', status: 'planned' },
  { id: 'FRESH-07', path: 'tests/server/review-state-machine.test.js', runner: 'server', phase: '11-freshness', status: 'planned' },
  { id: 'FRESH-08', path: 'tests/server/review-store.test.js', runner: 'server', phase: '11-freshness', status: 'required' },

  { id: 'PUBLISH-01', path: 'tests/server/review-publish.test.js', runner: 'server', phase: '12-publication', status: 'required' },
  { id: 'PUBLISH-02', path: 'tests/server/review-publish.test.js', runner: 'server', phase: '12-publication', status: 'required' },
  { id: 'PUBLISH-03', path: 'tests/server/review-publish-git.test.js', runner: 'server', phase: '12-publication', status: 'required' },
  { id: 'PUBLISH-04', path: 'tests/server/review-publish-git.test.js', runner: 'server', phase: '12-publication', status: 'required' },
  { id: 'PUBLISH-05', path: 'tests/server/review-publish-git.test.js', runner: 'server', phase: '12-publication', status: 'required' },
  { id: 'PUBLISH-06', path: 'tests/server/review-publish.test.js', runner: 'server', phase: '12-publication', status: 'required' },
  { id: 'PUBLISH-07', path: 'tests/server/review-publish-git.test.js', runner: 'server', phase: '12-publication', status: 'required' },
  { id: 'PUBLISH-08', path: 'tests/server/review-publish.test.js', runner: 'server', phase: '12-publication', status: 'planned' },
  { id: 'PUBLISH-09', path: 'tests/server/review-publish.test.js', runner: 'server', phase: '12-publication', status: 'planned' },

  { id: 'UI-01', path: 'tests/web/projects-review-link.test.js', runner: 'web', phase: '13-interface', status: 'planned' },
  { id: 'UI-02', path: 'tests/web/review-chip-model.test.js', runner: 'web', phase: '13-interface', status: 'required' },
  { id: 'UI-03', path: 'tests/web/review-chip-model.test.js', runner: 'web', phase: '13-interface', status: 'required' },
  { id: 'UI-04', path: 'tests/web/review-chip-model.test.js', runner: 'web', phase: '13-interface', status: 'required' },
  { id: 'UI-05', path: 'tests/web/review-chip-model.test.js', runner: 'web', phase: '13-interface', status: 'required' },
  { id: 'UI-06', path: 'tests/web/reviews-sse.browser.test.js', runner: 'web', phase: '13-interface', status: 'planned' },
  { id: 'UI-07', path: 'tests/web/review-store.test.js', runner: 'web', phase: '13-interface', status: 'required' },
  { id: 'UI-08', path: 'tests/web/reviews-view.component.test.js', runner: 'web', phase: '13-interface', status: 'required' },
  { id: 'UI-09', path: 'tests/web/review-scope.test.js', runner: 'web', phase: '13-interface', status: 'planned' },
  { id: 'UI-10', path: 'tests/web/review-scope.test.js', runner: 'web', phase: '13-interface', status: 'planned' },
  { id: 'UI-11', path: 'tests/web/review-store.test.js', runner: 'web', phase: '13-interface', status: 'planned' },
  { id: 'UI-SEC-01', path: 'tests/web/reviews-view.component.test.js', runner: 'web', phase: '13-interface', status: 'required' },
  { id: 'UI-SEC-02', path: 'tests/web/review-markdown.test.js', runner: 'web', phase: '13-interface', status: 'required' },
  { id: 'API-SEC-01', path: 'tests/server/review-auth.test.js', runner: 'server', phase: '13-interface', status: 'required' },
  { id: 'API-SEC-02', path: 'tests/server/review-api.test.js', runner: 'server', phase: '13-interface', status: 'required' },
  { id: 'API-SEC-03', path: 'tests/web/review-store.test.js', runner: 'web', phase: '13-interface', status: 'required' },

  { id: 'QUEUE-01', path: 'tests/server/review-service.test.js', runner: 'server', phase: '14-queue-recovery', status: 'required' },
  { id: 'QUEUE-02', path: 'tests/server/review-scheduler.test.js', runner: 'server', phase: '14-queue-recovery', status: 'planned' },
  { id: 'QUEUE-03', path: 'tests/server/review-scheduler.test.js', runner: 'server', phase: '14-queue-recovery', status: 'planned' },
  { id: 'QUEUE-04', path: 'tests/server/review-scheduler.test.js', runner: 'server', phase: '14-queue-recovery', status: 'planned' },
  { id: 'QUEUE-05', path: 'tests/server/review-service.test.js', runner: 'server', phase: '14-queue-recovery', status: 'required' },
  { id: 'QUEUE-06', path: 'tests/server/review-scheduler.test.js', runner: 'server', phase: '14-queue-recovery', status: 'planned' },
  { id: 'QUEUE-07', path: 'tests/server/review-scheduler.test.js', runner: 'server', phase: '14-queue-recovery', status: 'planned' },
  { id: 'QUEUE-08', path: 'tests/server/review-recovery.test.js', runner: 'server', phase: '14-queue-recovery', status: 'planned' },
  { id: 'RECOVER-01', path: 'tests/server/review-recovery.test.js', runner: 'server', phase: '14-queue-recovery', status: 'planned' },
  { id: 'RECOVER-RACE-01', path: 'tests/server/review-recovery.test.js', runner: 'server', phase: '14-queue-recovery', status: 'required' },
].map((entry) => Object.freeze(entry)));

// Эти файлы относятся к review-функции, но для них нет отдельной канонической
// строки manifest: они усиливают уже учтённый критерий либо проверяют инфраструктуру
// без собственного ordinary ID. Они всё равно обязаны оставаться в общем runner.
const supplementaryReviewTests = Object.freeze([
  Object.freeze({
    path: 'tests/server/review-project-api.test.js',
    runner: 'server',
    purpose: 'API Project binding и атомарная блокировка rebind во время review-run',
  }),
  Object.freeze({
    path: 'tests/server/review-degraded.test.js',
    runner: 'server',
    purpose: 'fail-closed facade при ошибке инициализации review-модуля',
  }),
  Object.freeze({
    path: 'tests/server/claude-mcp-secret.test.js',
    runner: 'server',
    purpose: 'внутренняя permission capability не попадает в argv Claude',
  }),
]);

const ordinaryIdPattern = /\b[A-Z][A-Z0-9]*(?:-[A-Z]+)*-[0-9]{2}\b/g;

async function text(relative) {
  return readFile(path.join(root, relative), 'utf8');
}

function runnerAcceptsPath(runner, relative) {
  if (runner === 'server') return /^tests\/server\/[^/]+\.test\.js$/.test(relative);
  if (runner === 'web') return /^tests\/web\/[^/]+\.test\.js$/.test(relative);
  if (runner === 'docs') return /^tests\/docs\/[^/]+\.test\.mjs$/.test(relative);
  if (runner === 'engine') {
    return /^tests\/engine\/(?:characterization|unit|contract|integration|race)\/[^/]+\.sh$/.test(relative);
  }
  return false;
}

function declaredTestNames(source, runner) {
  if (runner === 'engine') {
    return source
      .split('\n')
      .filter((line) => /^\s*(?:assert_[a-z_]+|test_(?:ok|fail))\b/.test(line));
  }

  const names = [];
  const declaration = /^\s*(?:await\s+)?(?:test|it|describe|[A-Za-z_$][\w$]*\.test)\s*\(\s*(["'`])/;
  for (const line of source.split('\n')) {
    const match = declaration.exec(line);
    if (!match) continue;
    const quote = match[1];
    const start = match.index + match[0].length;
    let value = '';
    let escaped = false;
    for (let cursor = start; cursor < line.length; cursor += 1) {
      const char = line[cursor];
      if (escaped) {
        value += char;
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        names.push(value);
        break;
      } else {
        value += char;
      }
    }
  }
  return names;
}

function declarationHasId(declarations, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactId = new RegExp(`(^|[^A-Z0-9-])${escaped}(?=$|[^A-Z0-9-])`);
  return declarations.some((name) => exactId.test(name));
}

async function walk(relative) {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await walk(child));
    else result.push(child);
  }
  return result;
}

function isReviewSpecificTest(relative) {
  return relative === 'tests/docs/review-test-manifest.test.mjs'
    || /^tests\/server\/review-[^/]+\.test\.js$/.test(relative)
    || /^tests\/server\/(?:gateway-cookie-boundary|claude-mcp-secret)\.test\.js$/.test(relative)
    || /^tests\/web\/reviews?-[^/]+\.test\.js$/.test(relative)
    || /^tests\/engine\/(?:contract|integration|race)\/review-[^/]+\.sh$/.test(relative);
}

const reviewReleaseReadiness = Object.freeze({
  plannedIds: Object.freeze(manifest.filter((entry) => entry.status === 'planned').map((entry) => entry.id)),
  get ready() {
    return this.plannedIds.length === 0;
  },
});

test('RB-01: manifest полностью и честно связывает план с исполняемыми review-тестами', async () => {
  const [plan, runAll, serverPackage, webPackage, engineRunner] = await Promise.all([
    text('docs/cockpit/pr-review-fix-plan.md'),
    text('tests/run-all.sh'),
    text('server/package.json'),
    text('web/package.json'),
    text('tests/engine/run-offline.sh'),
  ]);
  assert.match(runAll, /tests\/docs\/\*\.test\.mjs/);
  assert.match(runAll, /tests\/engine\/run-offline\.sh/);
  assert.match(runAll, /--prefix "\$PROJECT_ROOT\/server" test/);
  assert.match(runAll, /--prefix "\$PROJECT_ROOT\/web" test/);
  assert.match(serverPackage, /tests\/server\/\*\.test\.js/);
  assert.match(webPackage, /tests\/web\/\*\.test\.js/);
  for (const directory of ['characterization', 'unit', 'contract', 'integration', 'race']) {
    assert.match(engineRunner, new RegExp(`FACTORY_TESTS_HOME/${directory}`));
  }

  const planIds = [...new Set(plan.match(ordinaryIdPattern) ?? [])]
    .filter((id) => !id.startsWith('READY-'))
    .sort();
  const manifestIds = manifest.map((entry) => entry.id).sort();
  assert.deepEqual(manifestIds, planIds, 'каждый ordinary ID плана должен иметь ровно одну запись');

  const seenIds = new Set();
  const sourceCache = new Map();
  for (const entry of manifest) {
    assert.equal(seenIds.has(entry.id), false, `дублируется ${entry.id}`);
    seenIds.add(entry.id);
    assert.doesNotMatch(entry.id, /^READY-/, 'READY-* — производный критерий, а не test ID');
    assert.ok(['planned', 'required'].includes(entry.status), `${entry.id}: неизвестный статус`);
    assert.match(entry.phase, /^\d{2}-[a-z0-9-]+$/, `${entry.id}: отсутствует этап`);
    assert.ok(runnerAcceptsPath(entry.runner, entry.path), `${entry.id}: путь не входит в runner`);

    if (entry.status === 'planned') continue;
    assert.equal((await stat(path.join(root, entry.path))).isFile(), true, entry.path);
    let source = sourceCache.get(entry.path);
    if (source === undefined) {
      source = await text(entry.path);
      sourceCache.set(entry.path, source);
    }
    const declarations = declaredTestNames(source, entry.runner);
    assert.ok(
      declarationHasId(declarations, entry.id),
      `${entry.id} отсутствует в имени настоящего test/subtest ${entry.path}`,
    );
    assert.doesNotMatch(source, /\b(?:test|describe|it)\.skip\s*\(/, `${entry.path} содержит skip`);
  }

  const allTestFiles = await walk('tests');
  const discovered = allTestFiles.filter(isReviewSpecificTest).sort();
  const catalogued = [...new Set([
    ...manifest.map((entry) => entry.path).filter((relative) => discovered.includes(relative)),
    ...supplementaryReviewTests.map((entry) => entry.path),
  ])].sort();
  assert.deepEqual(catalogued, discovered, 'каждый существующий review-specific test-файл каталогизирован');

  for (const entry of supplementaryReviewTests) {
    assert.ok(runnerAcceptsPath(entry.runner, entry.path), entry.path);
    assert.equal((await stat(path.join(root, entry.path))).isFile(), true, entry.path);
  }
});

test('release readiness: planned запрещаются только явным release-gate', () => {
  if (process.env.COCKPIT_REVIEW_RELEASE_GATE !== '1') {
    assert.equal(
      reviewReleaseReadiness.ready,
      reviewReleaseReadiness.plannedIds.length === 0,
    );
    return;
  }
  assert.deepEqual(
    reviewReleaseReadiness.plannedIds,
    [],
    `review-функция не готова к release; planned: ${reviewReleaseReadiness.plannedIds.join(', ')}`,
  );
});

export {
  manifest as reviewTestManifest,
  reviewReleaseReadiness,
  supplementaryReviewTests,
};
