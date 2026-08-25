import { compileVue, webFile } from './compile-vue.js';

export const TASK_MODAL_PATH = webFile('src/views/TaskModal.vue');

/**
 * Facade оставляет primitives настоящими, а dialog при необходимости подменяет:
 * cross-overlay тест проверяет порядок UI-context и не должен запускать второй focus trap.
 */
function uiFacadeStub(prefix, { stubDialog = false } = {}) {
  const componentImports = [
    ['UiButton', 'src/components/primitives/UiButton.vue'],
    ['UiDisclosureButton', 'src/components/composites/UiDisclosureButton.vue'],
    ['UiField', 'src/components/composites/UiField.vue'],
    ['UiFilePicker', 'src/components/composites/UiFilePicker.vue'],
    ['UiFormActions', 'src/components/composites/UiFormActions.vue'],
    ['UiIconButton', 'src/components/primitives/UiIconButton.vue'],
    ['UiInput', 'src/components/primitives/UiInput.vue'],
    ['UiSelect', 'src/components/primitives/UiSelect.vue'],
    ['UiSpinner', 'src/components/primitives/UiSpinner.vue'],
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
    ...imports,
    ...dialogStub,
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
export function compileTaskModal(prefix, { stubDialog = false } = {}) {
  return compileVue(TASK_MODAL_PATH, {
    stubs: {
      'vue-router': 'export const useRouter = () => ({ push() {} });',
      '../shared/api-client.js': `export const api = globalThis.${prefix}Api;`,
      '../composables/useUiContextSource.js': contextSourceStub(prefix),
      '../stores/ui.js': `export const useUiStore = globalThis.${prefix}UiStore;`,
      '../stores/tasks.js': `export const useTasksStore = globalThis.${prefix}TasksStore;`,
      '../stores/board.js': `export const useBoardStore = globalThis.${prefix}BoardStore;`,
      '../stores/analysis.js': `export const useAnalysisStore = globalThis.${prefix}AnalysisStore;`,
      '../stores/task-favorites.js': (
        `export const useTaskFavoritesStore = globalThis.${prefix}FavoritesStore;`
      ),
      '../stores/task-seen.js': `export const useTaskSeenStore = globalThis.${prefix}SeenStore;`,
      '../shared/format.js': [
        'export const liveTimerSec = (task) => task?.timerElapsed || 0;',
        'export const secToHMS = (value) => String(value ?? 0);',
      ].join('\n'),
      '../shared/md.js': 'export const mdToHtml = (value) => String(value || "");',
      '../shared/runner-display.js': [
        `export const providerLabel = (id) => {`,
        `  const helper = globalThis.${prefix}RunnerDisplay?.providerLabel;`,
        '  return helper ? helper(id) : String(id || "");',
        '};',
      ].join('\n'),
      '../ui': uiFacadeStub(prefix, { stubDialog }),
      './OpenDiffButton.vue': [
        'export default {',
        '  props: ["taskId"],',
        '  template: "<span></span>",',
        '};',
      ].join('\n'),
      './board/TaskFavoriteButton.vue': favoriteButtonStub(prefix),
    },
  });
}
