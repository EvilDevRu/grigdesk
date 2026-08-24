import { compileVue, webFile } from './compile-vue.js';

const VIEW_PATH = webFile('src/views/PipelineView.vue');

function uiFacadeStub(prefix) {
  const componentImports = [
    ['UiButton', 'src/components/primitives/UiButton.vue'],
    ['UiDialog', 'src/components/overlays/UiDialog.vue'],
    ['UiDisclosureButton', 'src/components/composites/UiDisclosureButton.vue'],
    ['UiIconButton', 'src/components/primitives/UiIconButton.vue'],
    ['UiSpinner', 'src/components/primitives/UiSpinner.vue'],
    ['UiTextarea', 'src/components/primitives/UiTextarea.vue'],
    ['UiToggleButton', 'src/components/composites/UiToggleButton.vue'],
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
      '../shared/api-client.js': `export const api = globalThis.${prefix}Api;`,
      '../composables/useSse.js': 'export function useSse() {}',
      '../composables/useUiContextSource.js': [
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
      '../shared/format.js': [
        'export const liveTimerSec = () => 0;',
        'export const pipelineWorkSec = (timing) => timing?.workSec ?? null;',
        'export const secToHMS = (value) => String(value ?? 0);',
      ].join('\n'),
      '../shared/md.js': 'export const mdToHtml = (value) => String(value || "");',
      '../shared/sandbox.js': (
        'export const sandboxUrl = (port) => `http://sandbox.test:${port}`;'
      ),
      '../shared/agent-activity.js': 'export const agentActivityLabel = () => "";',
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
