import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

type Migration = readonly [previous: string, next: string, exports: readonly string[]];

const root = new URL('../../', import.meta.url);
const migrations: readonly Migration[] = [
  [
    'web/src/shared/arbiter-run.js',
    'web/src/shared/arbiterRun.ts',
    ['arbiterRunLabel', 'nodeIsArbitrated'],
  ],
  [
    'web/src/shared/board-activity.js',
    'web/src/shared/boardActivity.ts',
    ['boardActivity', 'boardTaskIds'],
  ],
  [
    'web/src/shared/board-task-list.js',
    'web/src/shared/boardTaskList.ts',
    [
      'boardComposition',
      'boardTaskListResetKey',
      'matchesBoardTask',
      'selectBoardTasks',
      'unifiedBoardTasks',
    ],
  ],
  [
    'web/src/shared/chat-model-run.js',
    'web/src/shared/chatModelRun.ts',
    ['lastModelRun', 'modelRunView'],
  ],
  [
    'web/src/shared/chat-title.js',
    'web/src/shared/chatTitle.ts',
    [
      'applyGeneratedChatTitle',
      'chatTitleFromMessage',
      'firstMessageTitle',
      'provisionalChatTitle',
      'shouldRequestChatTitle',
    ],
  ],
  [
    'web/src/shared/chat-visibility.js',
    'web/src/shared/chatVisibility.ts',
    ['chatVisibility', 'createChatVisibilityRegistry'],
  ],
  [
    'web/src/shared/diff.js',
    'web/src/shared/diff.ts',
    ['lineDiff', 'splitRows', 'unifiedDiff'],
  ],
  [
    'web/src/shared/factory-debug.js',
    'web/src/shared/factoryDebug.ts',
    ['FACTORY_DEBUG_LEVELS', 'factoryDebugPayload'],
  ],
  [
    'web/src/shared/graph-geom.js',
    'web/src/shared/graphGeom.ts',
    [
      'MARKS',
      'START_DOT',
      'computeViewBox',
      'edgePath',
      'layoutGraphPositions',
      'nodeGeom',
      'nodeLabelLines',
    ],
  ],
  [
    'web/src/shared/graph-stall.js',
    'web/src/shared/graphStall.ts',
    ['graphStallView'],
  ],
  [
    'web/src/shared/grigdesk-update.js',
    'web/src/shared/grigdeskUpdate.ts',
    [
      'ACTIVE_UPDATE_STATES',
      'BLOCK_REASON_LABELS',
      'PACKAGE_UPDATE_STAGE_LABELS',
      'UPDATE_STAGE_LABELS',
      'UPDATE_STAGE_SHORT_LABELS',
      'blockReasonLabel',
      'grigDeskUpdateTone',
    ],
  ],
  [
    'web/src/shared/nav-badges.js',
    'web/src/shared/navBadges.ts',
    ['aggregateNavBadges', 'chatNavBadge', 'inboxNavBadge', 'pipelineNavBadge', 'shelfNavBadge'],
  ],
  [
    'web/src/shared/pipeline-nav-badge.js',
    'web/src/shared/pipelineNavBadge.ts',
    ['pipelineBadgeSummary', 'pipelineTopbarItems'],
  ],
  [
    'web/src/shared/rewind-note.js',
    'web/src/shared/rewindNote.ts',
    ['buildRewindNote', 'rewindQuestionsOf'],
  ],
  [
    'web/src/shared/route-layout.js',
    'web/src/shared/routeLayout.ts',
    ['layoutRoute'],
  ],
  [
    'web/src/shared/sandbox.js',
    'web/src/shared/sandbox.ts',
    ['sandboxUrl'],
  ],
  [
    'web/src/features/documents/links.js',
    'web/src/features/documents/links.ts',
    [
      'documentLinkFromClick',
      'documentRefAssetHref',
      'documentRefRouteHref',
      'documentRouteHref',
      'documentScope',
      'documentScopeOfSource',
      'parseDocumentHref',
      'parseDocumentRouteHref',
    ],
  ],
  [
    'web/src/features/providers/providerUsage.js',
    'web/src/features/providers/providerUsage.ts',
    [
      'clockOf',
      'localizeUsageBar',
      'localizeUsageResource',
      'providerStatusHint',
      'providerUsageView',
      'resetAt',
      'resetIn',
    ],
  ],
  [
    'web/src/features/providers/providerUsageActions.js',
    'web/src/features/providers/providerUsageActions.ts',
    ['prepareUsageControl', 'usageControlConfirmation'],
  ],
  [
    'web/src/features/providers/usageWatch.js',
    'web/src/features/providers/usageWatch.ts',
    ['createUsageWatch'],
  ],
  [
    'web/src/stores/device.js',
    'web/src/stores/device.ts',
    ['WAKE_LOCK_KEY', 'useDeviceStore'],
  ],
  [
    'web/src/stores/diff.js',
    'web/src/stores/diff.ts',
    ['useDiffStore'],
  ],
  [
    'web/src/stores/dock.js',
    'web/src/stores/dock.ts',
    [
      'DEFAULT_DOCK_WIDTH',
      'DOCK_EXPANDED_KEY',
      'DOCK_TOOL_KEY',
      'DOCK_WIDTH_KEY',
      'MIN_DOCK_WIDTH',
      'clampDockWidth',
      'useDockStore',
    ],
  ],
  [
    'web/src/stores/hotkeys.js',
    'web/src/stores/hotkeys.ts',
    ['DEFAULT_HOTKEYS', 'HOTKEYS_KEY', 'useHotkeysStore', 'validateHotkeyOverrides'],
  ],
  [
    'web/src/stores/ui-context.js',
    'web/src/stores/uiContext.ts',
    ['UI_CONTEXT_LIMITS', 'createUiContextRegistry', 'useUiContextStore'],
  ],
];

test('25 модулей доступны по новым путям с прежними экспортами', async () => {
  assert.equal(migrations.length, 25);

  for (const [previous, next] of migrations) {
    assert.equal(existsSync(new URL(next, root)), true, `Ожидается TypeScript-модуль: ${next}`);
    assert.equal(existsSync(new URL(previous, root)), false, `Старый путь должен исчезнуть: ${previous}`);
  }

  for (const [, next, exports] of migrations) {
    const module: unknown = await import(new URL(next, root).href);

    assert.ok(module !== null && typeof module === 'object', next);
    assert.deepEqual(Object.keys(module).sort(), exports.toSorted(), next);
  }
});
