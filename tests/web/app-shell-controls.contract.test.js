import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const APP_SHELL_PATH = new URL('../../web/src/shared/layout/AppShell.vue', import.meta.url);
const PROVIDER_USAGE_PATH = new URL(
  '../../web/src/features/providers/ProviderUsageResources.vue',
  import.meta.url,
);
const PIPELINE_POPOVER_PATH = new URL(
  '../../web/src/features/pipeline/PipelineTopbarPopover.vue',
  import.meta.url,
);
const ACTIONS_PATH = new URL('../../web/src/styles/components/actions.css', import.meta.url);

test('AppShell использует public UI controls и DOM handle триггера инструментов', async () => {
  const [source, providerUsage, pipelinePopover, actions] = await Promise.all([
    readFile(APP_SHELL_PATH, 'utf8'),
    readFile(PROVIDER_USAGE_PATH, 'utf8'),
    readFile(PIPELINE_POPOVER_PATH, 'utf8'),
    readFile(ACTIONS_PATH, 'utf8'),
  ]);
  const publicUiImport = source.match(/import\s*\{([^}]*)\}\s*from '\.\.\/\.\.\/ui';/u);

  assert.ok(publicUiImport);
  assert.match(publicUiImport[1], /\bUiButton\b/u);
  assert.match(publicUiImport[1], /\bUiPressable\b/u);
  assert.equal([...source.matchAll(/<UiPressable\b/gu)].length, 4);
  assert.equal([...source.matchAll(/<UiButton\b/gu)].length, 5);
  assert.doesNotMatch(source, /<button\b/u);
  assert.match(source, /toolsTrigger\.value\?\.el\?\.getBoundingClientRect/u);
  assert.match(source, /toolsTrigger\.value\?\.el\?\.contains/u);
  assert.doesNotMatch(source, /\.pu-state button|\.ptip-go button|\.instbar button/u);
  assert.match(source, /data-context="topbar-popover-action"/u);
  assert.match(source, /data-context="topbar-popover-footer"/u);
  assert.match(source, /<BoardTimerPopover/u);
  assert.match(source, /:tasks="topbarTimerTasks"/u);
  assert.match(source, /:worked-today-hours="workedTodayHours"/u);
  assert.match(source, /:busy-task-id="timerActionTaskId"/u);
  assert.match(source, /@toggle-timer="toggleBoardTimer"/u);
  assert.match(source, /<PipelineTopbarPopover/u);
  assert.match(source, /:items="notifyWatch\.topbarItems"/u);
  assert.doesNotMatch(source, /:(?:running|stopped)-count=/u);
  assert.doesNotMatch(source, /:has-errors=/u);
  assert.match(source, /@open-pipeline="openPipeline"/u);
  assert.doesNotMatch(source, /<router-link[^>]*data-context="pipeline-topbar"/u);
  assert.match(source, /total: notifyWatch\.topbarItems\.length/u);
  assert.match(source, /v-if="topbarTimerTasks\.length && pipelineTopbar\.total"/u);
  assert.match(source, /useTasksStore/u);
  assert.match(source, /await taskStore\.timer\(task\.id, action\)/u);
  assert.match(source, /boardStore\.data\?\.today\?\.hours \?\? 0/u);
  assert.ok(
    source.indexOf('class="metric mono"') < source.indexOf('<BoardTimerPopover'),
    'индикатор таймеров должен стоять после динамических CPU/RAM',
  );
  assert.match(providerUsage, /data-context="topbar-popover-confirm"/u);
  assert.match(providerUsage, /data-context="topbar-popover-resource-link"/u);
  assert.match(pipelinePopover, /<UiPopover/u);
  assert.match(pipelinePopover, /data-context="pipeline-topbar"/u);
  assert.match(pipelinePopover, /pipeline-topbar-running">\{\{ runningCount \}\}/u);
  assert.match(pipelinePopover, /pipeline-topbar-waiting"[^>]*>\s*\{\{ waitingCount \}\}/u);
  assert.match(pipelinePopover, /pipeline-topbar-issues"[^>]*>\s*\{\{ issueCount \}\}/u);
  assert.match(pipelinePopover, /trigger-mode="both"/u);
  assert.match(pipelinePopover, /@click="openPipeline\(close\)"/u);
  assert.match(
    actions,
    /data-context='topbar-popover-action'\][^{]*\{[^}]*height:\s*28px;/u,
  );
  assert.match(
    actions,
    /data-context='topbar-popover-footer'\][^{]*\{[^}]*height:\s*30px;/u,
  );
  assert.match(
    actions,
    /data-context='topbar-popover-resource-link'\][^{]*\{[^}]*height:\s*auto;/u,
  );
  assert.match(
    actions,
    /data-context='topbar-popover-resource-link'\][^{]*\{[^}]*white-space:\s*normal;/u,
  );
  assert.match(
    actions,
    /data-context='board-timers-topbar'\][^{]*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/u,
  );
  assert.match(
    actions,
    /data-context='pipeline-topbar'\][^{]*\{[^}]*height:\s*28px;[^}]*background:\s*transparent;/u,
  );
  assert.match(actions, /data-context='topbar-timer-toggle'/u);
});
