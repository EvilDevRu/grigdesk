import { readFile } from 'node:fs/promises';
import ts from '../../../../web/node_modules/typescript/lib/typescript.js';
import { compileVue, webFile } from '../../helpers/compile-vue.js';

/**
 * Захватывает назначение lazy-диалога из настоящего setup App без запуска оболочки.
 * Зависимости готовых экранов здесь не измеряются: отдельно монтируется настоящий loadingComponent.
 */
export async function captureSettingsModal(t, mount, flushPromises) {
  const raw = await readFile(webFile('src/App.vue'), 'utf8');
  const script = raw.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  const ast = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true);
  const control = {
    entry: null,
    auth: {
      authenticated: false,
      ready: false,
      watchUnauthorized() {},
      stopRecovery() {},
      async load() {}
    },
    shell: {
      initialized: false,
      present: false,
      status: 'none',
      async start() {},
      stop() {}
    },
    settings: {
      isOpen: false,
      dispose() {},
      setAuthenticated() {}
    },
  };
  const stubs = {
    './shared/asyncView.ts': `export const asyncView = (_loader, loadingComponent) => {
      globalThis.__loadingAppCapture.entry = loadingComponent;
      return { render: () => null };
    };`,
    './views/settings/SettingsModal.vue': 'export default { render: () => null };',
    './shared/desktopSettings.ts': "export const currentDesktopMode = () => 'page';",
    './features/speech/provider.ts': 'export const SpeechProvider = { render: () => null };',
    './composables/useSse.ts': `export const setSseEnabled = () => {};
      export const sseSubscribe = () => () => {};`,
  };

  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }

    const path = statement.moduleSpecifier.text;

    if (path.endsWith('.vue') && !path.includes('Loading')) {
      stubs[path] = 'export default { render: () => null };';
    }

    if (path.startsWith('./stores/')) {
      const field = path.includes('/auth.') ? 'auth' : path.includes('/shell.') ? 'shell' : 'settings';
      const exports = statement.importClause.namedBindings.elements.map((item) =>
        `export const ${item.name.text} = () => globalThis.__loadingAppCapture.${field};`);

      stubs[path] = exports.join('\n');
    }
  }

  globalThis.__loadingAppCapture = control;

  const App = await compileVue(webFile('src/App.vue'), { stubs });
  const wrapper = mount(App);

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__loadingAppCapture;
  });
  await flushPromises();

  return control.entry;
}
