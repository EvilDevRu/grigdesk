import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import ts from '../../../../web/node_modules/typescript/lib/typescript.js';
import { startLoadingBrowser } from './browser.mjs';

/**
 * Изолирует внешние ресурсы App и крупных экранов, сохраняя их настоящий шаблон и setup.
 * AppShell сохраняет настоящую геометрию; дочерние сетевые виджеты не открывают ресурсы.
 */
export async function startLargeBrowser(t) {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const ports = JSON.stringify(path.join(root, 'tests/web/fixtures/loading/largePorts.mjs'));
  const empty = 'export default { render: () => null };';
  const mocks = {
    'features/speech/provider.ts': `import { h } from 'vue';
      export const SpeechProvider = { setup: (_, { slots }) => () => h('div', {
        style: 'display:contents'
      }, slots.default?.()) };
      export const useDictationController = () => ({ acquire: () => ({
        state: { phase: 'idle', busy: false }, async release() {}
      }) });`,
    'composables/useSse.ts': `import { ref } from 'vue';
      export const useSse = () => ({ connected: ref(true) });
      export const sseSubscribe = () => () => {}; export const setSseEnabled = () => {};`,
    'shared/desktopSettings.ts': "export const currentDesktopMode = () => 'page';",
    'stores/tasks.ts': `export const useTasksStore = () => ({
      async load() { return {}; }, title() { return 'Синтетическая задача'; }
    });`,
    'stores/board.ts': `export { board as store } from ${ports};
      import { board } from ${ports}; export const useBoardStore = () => board;`,
    'stores/auth.ts': `import { auth } from ${ports}; export const useAuthStore = () => auth;`,
    'stores/shell.ts': `import { shell } from ${ports}; export const useShellStore = () => shell;`,
    'actions/analysis': `import { passive } from ${ports};
      export const useAnalysisStore = passive; export const startAnalysisPolling = () => {};
      export const analyzeTask = async () => {};`,
    'stores/analysis.ts': `export { passive as useAnalysisStore } from ${ports};`,
    'stores/taskFavorites.ts': `export { passive as useTaskFavoritesStore } from ${ports};`,
    'stores/taskShelf.ts': `export { passive as useTaskShelfStore } from ${ports};`,
    'stores/taskSeen.ts': `export { passive as useTaskSeenStore } from ${ports};`,
    'stores/system.ts': `export { passive as useSystemStore } from ${ports};`,
    'stores/settings.ts': `export { passive as useSettingsStore } from ${ports};`,
    'stores/videoSession.ts': `export { passive as useVideoSessionStore } from ${ports};`,
  };
  const appShell = await readFile(path.join(root, 'web/src/shared/layout/AppShell.vue'), 'utf8');
  const shellScript = appShell.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  const shellAst = ts.createSourceFile('AppShell.ts', shellScript, ts.ScriptTarget.Latest, true);

  for (const statement of shellAst.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier.text.endsWith('.vue')) {
      continue;
    }

    const relative = statement.moduleSpecifier.text;
    const filename = path.posix.normalize(path.posix.join('shared/layout', relative));

    mocks[filename] = empty;
  }

  delete mocks['shared/layout/AppShell.vue'];

  for (const [file, name] of Object.entries({
    providerInstall: 'useProviderInstallStore',
    phoneAccess: 'usePhoneAccessStore',
    notifyWatch: 'useNotifyWatchStore',
    grigdeskUpdate: 'useGrigDeskUpdateStore',
    dock: 'useDockStore',
  })) {
    mocks[`stores/${file}.ts`] = `export { passive as ${name} } from ${ports};`;
  }

  mocks['stores/providerInstall.ts'] += '\nexport const providerInstallVisibleWarnings = () => [];';

  mocks['stores/providers.ts'] = `export const useProvidersStore = () => ({
    providers: [], load() {}, loadUsage() {}, noteUsageConnection() {}, usage: {},
  });`;
  mocks['stores/plugins.ts'] = `export const usePluginsStore = () => ({
    loaded: true, list: [], railNav: [], toolsNav: [], dockNav: [],
    byId: () => ({ values: {} }), enabled: () => false, async load() {},
  });`;
  mocks['actions/inbox'] = `export { passive as useInboxStore } from ${ports};
    export const startInboxSummary = () => {}; export const stopInboxSummary = () => {};`;

  const raw = await readFile(path.join(root, 'web/src/App.vue'), 'utf8');
  const script = raw.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  const ast = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true);

  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }

    const relative = statement.moduleSpecifier.text;

    if (relative.endsWith('.vue') && !relative.includes('Loading') && !relative.includes('AppShell')) {
      mocks[relative.slice(2)] = empty;
    }
  }

  return startLoadingBrowser(t, {
    additionalMocks: mocks,
    entry: 'large.html',
    replies: {
      '/api/grigdesk-tasks': {
        revision: 1,
        trackerConfigured: true,
        tasks: [],
      },
      '/api/tasks': { tasks: [{
        task: 42,
        profile: 'fixture',
        daemonAlive: false,
        readOnly: false,
        result: 'completed',
      }] },
      '/api/tasks/42/graph': {
        daemonAlive: false,
        route: 'feature',
        readOnly: false,
        nodes: { build: ['agent', 'Реализация'] },
        pos: { build: [160, 50] },
        keys: { build: 'BUILD' },
        statuses: { build: 'done' },
        nodeMeta: { build: {} },
        progress: {
          done: 1,
          total: 1,
          current: null
        },
      },
    },
  });
}
