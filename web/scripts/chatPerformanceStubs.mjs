// Внешние службы стенда не обращаются к рабочему API.
// Store, Markdown и компоненты остаются настоящими.
export const performanceStubs = new Map([
  ['web/src/router.ts', `
    export const router = { currentRoute: { value: { path: '/chats', meta: {} } } };
  `],
  ['web/src/stores/uiContext.ts', `
    export const useUiContextStore = () => ({
      capture: () => ({ routingScope: null, promptContext: { page: 'Чаты', path: '/chats' } }),
    });
  `],
  ['web/src/shared/notify.ts', `
    export const notify = () => {};
    export const closeSystemNotification = () => {};
  `],
  ['web/src/composables/useSse.ts', `
    export const sseSubscribe = (handler) => {
      window.__performanceSse = handler;
      return () => {};
    };
  `],
  ['web/src/stores/providers.ts', `
    const model = { id: 'fixture-model', name: 'Модель стенда', efforts: [], contextWindow: 200000 };
    const provider = { id: 'fixture-provider', name: 'Стенд', models: [model], color: '#88aacc' };
    const store = {
      providers: [provider], usage: {}, usageTransport: {},
      load: () => {},
      modelOf: () => ({ id: model.id, model, provider }),
      modesOf: () => [],
      visibleModels: () => [model],
    };
    export const useProvidersStore = () => store;
  `],
  ['web/src/stores/tasks.ts', 'export const useTasksStore = () => ({ load: async () => ({}) });'],
  ['web/src/stores/ui.ts', 'export const useUiStore = () => ({});'],
  ['web/src/stores/documentPreview.ts', 'export const useDocumentPreviewStore = () => ({});'],
  ['web/src/features/speech/provider.ts', `
    export const useDictationController = () => ({
      acquire: () => ({
        state: { phase: 'idle', busy: false, prompt: null, interim: '', notice: '' },
        release: async () => {},
      }),
    });
  `],
  ['web/src/shared/tools/launcher.ts', 'export const useToolLauncher = () => ({ openTool() {} });'],
  ['web/src/features/code/links.ts', `
    export const chatFileLinkHref = (value) => value;
    export const codeLinkFromClick = () => null;
    export const loadCodeRoots = () => Promise.resolve([]);
  `],
  ['web/src/views/chat/ChatWorkdir.vue', '<template><span /></template>'],
]);
