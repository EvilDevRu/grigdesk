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
    import { onMounted, onUnmounted, ref } from 'vue';

    const connected = ref(true);
    const listeners = new Set();

    window.__performanceSse = (name, payload) => {
      for (const handler of listeners) {
        handler(name, payload);
      }
    };

    export const sseSubscribe = (handler) => {
      listeners.add(handler);

      return () => listeners.delete(handler);
    };

    export const useSse = (handler) => {
      let off;

      onMounted(() => {
        off = sseSubscribe((name, payload) => handler?.(name, payload));
      });
      onUnmounted(() => off?.());

      return { connected };
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
