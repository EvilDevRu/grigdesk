import { compileVue, webFile } from './compile-vue.js';

const VIEW_PATH = webFile('src/views/PipelineView.vue');

/**
 * Сохраняет настоящие controls, заменяя только внешние диалоги тестовыми ответами.
 * Перевод и подсказки используют те же сервисы, что рабочий интерфейс.
 */
function uiFacadeStub(prefix) {
  const componentImports = [
    ['UiButton', 'src/components/primitives/UiButton.vue'],
    ['UiDialog', 'src/components/overlays/UiDialog.vue'],
    ['UiDisclosureButton', 'src/components/composites/UiDisclosureButton.vue'],
    ['UiIconButton', 'src/components/primitives/UiIconButton.vue'],
    ['UiLoadingState', 'src/components/feedback/UiLoadingState.vue'],
    ['UiPopover', 'src/components/overlays/UiPopover.vue'],
    ['UiSpinner', 'src/components/primitives/UiSpinner.vue'],
    ['UiSelectableRow', 'src/components/composites/UiSelectableRow.vue'],
    ['UiTextarea', 'src/components/primitives/UiTextarea.vue'],
    ['UiTab', 'src/components/composites/UiTab.vue'],
    ['UiTabs', 'src/components/composites/UiTabs.vue'],
  ];
  const imports = componentImports.map(([name, file]) => (
    `import ${name} from ${JSON.stringify(webFile(file))};`
  ));
  const names = componentImports.map(([name]) => name).join(', ');

  return [
    "export * from './src/ui.ts';",
    ...imports,
    `export { ${names} };`,
    'export { t } from "./src/services/locale.ts";',
    `export const confirmDialog = (...args) => globalThis.${prefix}ConfirmDialog(...args);`,
    `export const alertDialog = (...args) => globalThis.${prefix}AlertDialog(...args);`,
  ].join('\n');
}

/**
 * PipelineView бандлится с настоящими UI-компонентами, а границы страницы остаются
 * управляемыми тестом. Так harness проверяет публичный facade без сетевых побочных эффектов.
 */
export function compilePipelineView(prefix, { realGraph = false, expose = [] } = {}) {
  return compileVue(VIEW_PATH, {
    expose,
    stubs: {
      '../../stores/browser.ts': `
        export const useBrowserStore = () => ({
          available: false,
          preferences: { open: 'external', external: 'system', agents: false },
          control: async () => {},
        });
      `,
      '../shared/apiClient.ts': `export const api = globalThis.${prefix}Api;`
        + '\nexport { ApiError } from "./src/shared/apiClient.ts";',
      '../../shared/apiClient.ts': `export const api = globalThis.${prefix}Api;`
        + '\nexport { ApiError } from "./src/shared/apiClient.ts";',
      '../composables/useSse.ts': [
        'export const sseSubscribe = () => () => {};',
        'export function useSse(onEvent) {',
        `  globalThis.${prefix}SseHandler = onEvent;`,
        '  return { connected: { value: true } };',
        '}',
      ].join('\n'),
      '../composables/useUiContextSource.ts': [
        'export function useUiContextSource(...args) {',
        `  const helper = globalThis.${prefix}ContextSource;`,
        '  if (helper) return helper(...args);',
        '  return { focus() {}, update() {}, blur() {} };',
        '}',
      ].join('\n'),
      '../stores/ui.ts': `export const useUiStore = globalThis.${prefix}UiStore;`,
      '../stores/tasks.ts': `export const useTasksStore = globalThis.${prefix}TasksStore;`,
      '../stores/board.ts': `export const useBoardStore = globalThis.${prefix}BoardStore;`,
      '../shared/md.ts': 'export const mdToHtml = (value) => String(value || "");',
      '../shared/sandbox.ts': (
        'export const sandboxUrl = (port) => `http://sandbox.test:${port}`;'
      ),
      '../../../shared/pipeline/agentActivity.ts': [
        'export const agentActivityLabel = () => "";',
        'export function silenceReason(task, window) {',
        '  const silence = task?.silence;',
        '  if (!window || !silence || !Number.isFinite(silence.sec)',
        '    || silence.sec < window) return null;',
        '  const stage = String(silence.stage || "").toLowerCase();',
        '  return {',
        '    stage: silence.stage,',
        '    sec: silence.sec,',
        '    tool: silence.tool || null,',
        '    text: `${stage}: молчит ${Math.max(1, Math.floor(silence.sec / 60))} мин`,',
        '  };',
        '}',
      ].join('\n'),
      '../ui': (uiFacadeStub(prefix)) +
        "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";",
      ...(realGraph ? {} : {
        './pipeline/FactoryGraph.vue': `export default globalThis.${prefix}FactoryGraph;`,
      }),
      './OpenDiffButton.vue': [
        'export default {',
        '  props: ["taskId"],',
        '  template: "<span></span>",',
        '};',
      ].join('\n'),
    },
  });
}
