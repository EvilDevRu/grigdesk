import { compileVue, webFile } from './compile-vue.js';

const VIEW_PATH = webFile('src/views/PipelineView.vue');

function uiFacadeStub(prefix) {
  const componentImports = [
    ['UiButton', 'src/components/primitives/UiButton.vue'],
    ['UiDialog', 'src/components/overlays/UiDialog.vue'],
    ['UiDisclosureButton', 'src/components/composites/UiDisclosureButton.vue'],
    ['UiIconButton', 'src/components/primitives/UiIconButton.vue'],
    ['UiPopover', 'src/components/overlays/UiPopover.vue'],
    ['UiSpinner', 'src/components/primitives/UiSpinner.vue'],
    ['UiTextarea', 'src/components/primitives/UiTextarea.vue'],
  ];
  const imports = componentImports.map(([name, file]) => (
    `import ${name} from ${JSON.stringify(webFile(file))};`
  ));
  const names = componentImports.map(([name]) => name).join(', ');

  return [
    ...imports,
    `export { ${names} };`,
    `export const confirmDialog = (...args) => globalThis.${prefix}ConfirmDialog(...args);`,
    `export const alertDialog = (...args) => globalThis.${prefix}AlertDialog(...args);`,
  ].join('\n');
}

/**
 * PipelineView бандлится с настоящими UI-компонентами, а границы страницы остаются
 * управляемыми тестом. Так harness проверяет публичный facade без сетевых побочных эффектов.
 */
export function compilePipelineView(prefix) {
  return compileVue(VIEW_PATH, {
    stubs: {
      '../shared/apiClient.ts': `export const api = globalThis.${prefix}Api;`,
      '../composables/useSse.ts': [
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
      '../stores/ui.js': `export const useUiStore = globalThis.${prefix}UiStore;`,
      '../stores/tasks.js': `export const useTasksStore = globalThis.${prefix}TasksStore;`,
      '../stores/board.js': `export const useBoardStore = globalThis.${prefix}BoardStore;`,
      '../stores/companion.js': (
        `export const useCompanionStore = globalThis.${prefix}CompanionStore;`
      ),
      '../shared/md.ts': 'export const mdToHtml = (value) => String(value || "");',
      '../shared/sandbox.js': (
        'export const sandboxUrl = (port) => `http://sandbox.test:${port}`;'
      ),
      '../../../shared/agentActivity.ts': [
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
      '../ui': uiFacadeStub(prefix),
      './pipeline/FactoryGraph.vue': `export default globalThis.${prefix}FactoryGraph;`,
      './OpenDiffButton.vue': [
        'export default {',
        '  props: ["taskId"],',
        '  template: "<span></span>",',
        '};',
      ].join('\n'),
    },
  });
}
