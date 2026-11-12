import { compileVue, webFile } from './compile-vue.js';

export const TASK_MODAL_PATH = webFile('src/views/TaskModal.vue');

/**
 * Facade оставляет primitives настоящими, а dialog при необходимости подменяет:
 * cross-overlay тест проверяет порядок UI-context и не должен запускать второй focus trap.
 */
function uiFacadeStub(prefix, { stubDialog = false } = {}) {
  const componentImports = [
    ['UiPopover', 'src/components/overlays/UiPopover.vue'],
    ['UiButton', 'src/components/primitives/UiButton.vue'],
    ['UiCheckbox', 'src/components/primitives/UiCheckbox.vue'],
    ['UiChoiceList', 'src/components/composites/UiChoiceList.vue'],
    ['UiDisclosureButton', 'src/components/composites/UiDisclosureButton.vue'],
    ['UiField', 'src/components/composites/UiField.vue'],
    ['UiFilePicker', 'src/components/composites/UiFilePicker.vue'],
    ['UiFormActions', 'src/components/composites/UiFormActions.vue'],
    ['UiIconButton', 'src/components/primitives/UiIconButton.vue'],
    ['UiInput', 'src/components/primitives/UiInput.vue'],
    ['UiPaneHeader', 'src/components/composites/UiPaneHeader.vue'],
    ['UiSelect', 'src/components/primitives/UiSelect.vue'],
    ['UiSpinner', 'src/components/primitives/UiSpinner.vue'],
    ['UiLoadingState', 'src/components/feedback/UiLoadingState.vue'],
    ['UiTab', 'src/components/composites/UiTab.vue'],
    ['UiTabs', 'src/components/composites/UiTabs.vue'],
    ['UiTextarea', 'src/components/primitives/UiTextarea.vue'],
    ['UiTooltip', 'src/components/overlays/UiTooltip.vue'],
  ];
  if (!stubDialog) {
    componentImports.push(['UiDialog', 'src/components/overlays/UiDialog.vue']);
  }
  const imports = componentImports.map(([name, file]) => (
    `import ${name} from ${JSON.stringify(webFile(file))};`
  ));
  const names = componentImports.map(([name]) => name).join(', ');
  const dialogStub = stubDialog
    ? [
      'import { h } from "vue";',
      'export const UiDialog = {',
      '  inheritAttrs: false,',
      '  props: { open: Boolean },',
      '  setup(props, { attrs, slots }) {',
      '    return () => props.open ? h("section", attrs, slots.default?.()) : null;',
      '  },',
      '};',
    ]
    : [];

  return [
    "export * from './src/ui.ts';",
    ...imports,
    ...dialogStub,
    `export { t } from ${JSON.stringify(webFile('src/services/locale.ts'))};`,
    `export { useUiLayer } from ${JSON.stringify(webFile('src/composables/useUiLayer.ts'))};`,
    `export const showToast = (...args) => globalThis.${prefix}ShowToast?.(...args);`,
    `export { ${names} };`,
    `export const confirmDialog = (...args) => {`,
    `  const handler = globalThis.${prefix}ConfirmDialog;`,
    '  return handler ? handler(...args) : Promise.resolve(true);',
    '};',
  ].join('\n');
}

/**
 * Контекст включается только в сценариях, которым важен owner lifecycle.
 * Остальные тесты получают безвредный handle и не разделяют Pinia registry.
 */
function contextSourceStub(prefix) {
  return [
    'export function useUiContextSource(...args) {',
    `  const helper = globalThis.${prefix}ContextSource;`,
    '  if (helper) return helper(...args);',
    '  return { focus() {}, update() {}, blur() {} };',
    '}',
  ].join('\n');
}

/**
 * Product-кнопка остаётся границей harness, но сохраняет настоящий emit-контракт,
 * чтобы тест избранного проверял связь TaskModal со store, а не реализацию звезды.
 */
function favoriteButtonStub(prefix) {
  return [
    `const injected = globalThis.${prefix}FavoriteComponent;`,
    'export default injected || {',
    '  props: ["active", "pending", "taskTitle"],',
    '  emits: ["toggle"],',
    '  template: `<button',
    '    class="stub-modal-fav"',
    '    :aria-pressed="String(active)"',
    '    @click="$emit(\'toggle\')"',
    '  >{{ taskTitle }}</button>`,',
    '};',
  ].join('\n');
}

/**
 * TaskModal бандлится через общий TS-aware compiler и настоящий public UI facade.
 * Сеть, stores и дочерние product-компоненты остаются управляемыми каждым тестом.
 */
export function compileTaskModal(prefix, { stubDialog = false, compilerStubs = {} } = {}) {
  return compileVue(TASK_MODAL_PATH, {
    stubs: {
      'vue-router': `export const useRouter = () => globalThis.${prefix}Router || ({ push() {} });`,
      '../shared/shellClient.ts': [
        'export const isShellState = () => false;',
        `export const shellAction = (...args) => globalThis.${prefix}ShellAction?.(...args);`,
        'export const readShellState = async () => null;',
      ].join('\n'),
      '../shared/apiClient.ts': [
        `export const api = globalThis.${prefix}Api;`,
        `export { ApiError, failureText } from ${JSON.stringify(webFile('src/shared/apiClient.ts'))};`,
      ].join('\n'),
      '../composables/useUiContextSource.ts': contextSourceStub(prefix),
      '../composables/useSse.ts': [
        'export const sseSubscribe = (handler) =>',
        `  globalThis.${prefix}Subscribe?.(handler) || (() => {});`,
      ].join('\n'),
      '../stores/ui.ts': `export const useUiStore = globalThis.${prefix}UiStore;`,
      '../stores/tasks.ts': `export const useTasksStore = globalThis.${prefix}TasksStore;`,
      '../stores/board.ts': `export const useBoardStore = globalThis.${prefix}BoardStore;`,
      '../actions/analysis': [
        `export const useAnalysisStore = globalThis.${prefix}AnalysisStore;`,
        `export const analyzeTask = (...args) => globalThis.${prefix}AnalysisStore().analyze(...args);`,
        `export const readAnalysisDetail = (...args) =>`,
        `  globalThis.${prefix}AnalysisStore().detail(...args);`,
      ].join('\n'),
      '../shared/analysisApi.ts': [
        'export const analysisApi = {',
        `  clarifications: (id) => globalThis.${prefix}Api.get('/api/tasks/' + id + '/clarifications'),`,
        '  answer: (id, answers, text) =>',
        `    globalThis.${prefix}Api.post('/api/tasks/' + id + '/clarifications', { answers, text }),`,
        `  arbitrate: (id) => globalThis.${prefix}Api.post('/api/tasks/' + id + '/analysis/arbitrate', {}),`,
        '};',
      ].join('\n'),
      '../shared/grigdeskPersonalState.ts':
        'import { ref } from "vue"; export const grigdeskPersonalStateVersion = ref(1);',
      '../stores/taskFavorites.ts': (
        `export const useTaskFavoritesStore = globalThis.${prefix}FavoritesStore;`
      ),
      '../stores/taskShelf.ts': [
        `export const useTaskShelfStore = globalThis.${prefix}ShelfStore || (() => ({`,
        '  entries: [], rows: [], loaded: true, loading: false, error: null, pending: {},',
        '  isOnShelf: () => false, isPending: () => false,',
        '  async load() { return true; },',
        '  async toggle() { return true; }, async acknowledge() { return true; },',
        '}));',
      ].join('\n'),
      '../stores/plugins.ts': [
        `export const usePluginsStore = globalThis.${prefix}PluginsStore || (() => ({`,
        '  loaded: true, enabled: () => false, byId: () => null,',
        '}));',
      ].join('\n'),
      '../stores/taskSeen.ts': `export const useTaskSeenStore = globalThis.${prefix}SeenStore;`,
      '../features/speech/provider.ts': [
        'const fallbackController = {',
        '  acquire() {',
        '    return {',
        '      state: { phase: "idle", busy: false, prompt: null, notice: "" },',
        '      async start() { return false; }, async stop() {}, async cancel() {},',
        '      async release() {},',
        '    };',
        '  },',
        '};',
        'export const useDictationController = () =>',
        `  globalThis.${prefix}DictationController || fallbackController;`,
      ].join('\n'),
      '../shared/format.ts': [
        `export { formatDateTime, deadlineState } from ${JSON.stringify(webFile('src/shared/format.ts'))};`,
        'export const liveTimerSec = (task) => task?.timerElapsed || 0;',
        'export const secToHMS = (value) => String(value ?? 0);',
        // mmss повторён настоящим: тест прогресса триажа читает именно таймкод,
        // а не факт наличия подписи.
        'export const mmss = (value) => {',
        '  const sec = Math.max(0, Math.floor(Number(value) || 0));',
        '  const pad = (part) => String(part).padStart(2, "0");',
        '  return pad(Math.floor(sec / 60)) + ":" + pad(sec % 60);',
        '};',
      ].join('\n'),
      '../shared/md.ts': 'export const mdToHtml = (value) => String(value || "");',
      '../shared/runnerDisplay.ts': [
        `export const providerLabel = (id) => {`,
        `  const helper = globalThis.${prefix}RunnerDisplay?.providerLabel;`,
        '  return helper ? helper(id) : String(id || "");',
        '};',
      ].join('\n'),
      '../ui': (uiFacadeStub(prefix, { stubDialog })) +
        "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";",
      './OpenDiffButton.vue': [
        'export default {',
        '  props: ["taskId"],',
        '  template: "<span></span>",',
        '};',
      ].join('\n'),
      './board/TaskFavoriteButton.vue': favoriteButtonStub(prefix),
      ...compilerStubs,
    },
  });
}

/**
 * Пункт интерактивного чек-листа ищется по id, сохраняя свободу внутренней разметки.
 * Все тесты карточки используют одну границу строки с отметкой и действиями.
 */
export function taskChecklistItem(wrapper, id) {
  return wrapper.get(`[data-checklist-id="${id}"]`);
}
