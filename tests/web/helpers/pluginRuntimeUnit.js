import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileModule, webFile } from './compile-vue.js';
import { installUiBrowser } from './ui-components.js';
import { descriptor } from './pluginModuleContract.js';

export const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Runtime и публичный UI собираются одним графом, поэтому сравниваются настоящие ссылки.
 * Отсутствие нового модуля даёт assertion, ошибки компиляции не маскируются как RED.
 */
export async function runtimeFixture(t, modules = ['loader', 'styles']) {
  const browser = await installUiBrowser(t);
  const { PropertySymbol } = await import('../../../web/node_modules/happy-dom/lib/index.js');
  const createElement = browser.document.createElement.bind(browser.document);

  // Выключаем только сетевую загрузку CSS: обычный disableCSSFileLoading сам выдаёт error.
  // Links остаются в DOM, а load/error доставляет сценарий после проверки cleanup/abort.
  t.mock.method(browser.document, 'createElement', (...args) => {
    const element = createElement(...args);

    if (element instanceof browser.HTMLLinkElement) {
      element[PropertySymbol.evaluateCSS] = false;
    }

    return element;
  });

  const previousScriptElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLScriptElement');

  Object.defineProperty(globalThis, 'HTMLScriptElement', {
    value: browser.HTMLScriptElement,
    configurable: true,
  });
  t.after(() => {
    if (previousScriptElement) {
      Object.defineProperty(globalThis, 'HTMLScriptElement', previousScriptElement);
    } else {
      delete globalThis.HTMLScriptElement;
    }
  });

  const directory = await mkdtemp(path.join(os.tmpdir(), 'plugin-runtime-unit-'));

  t.after(() => rm(directory, { recursive: true, force: true }));

  for (const name of modules) {
    const filename = webFile(`src/pluginRuntime/${name}.ts`);
    const present = await access(filename).then(() => true, () => false);

    assert.equal(present, true, `Не реализован оконный контракт: pluginRuntime/${name}.ts`);
  }

  const filename = path.join(directory, 'entry.ts');
  const exports = modules.map((name) =>
    `export * from ${JSON.stringify(webFile(`src/pluginRuntime/${name}.ts`))};`);

  exports.push(`export * as ui from ${JSON.stringify(webFile('src/ui.ts'))};`);
  exports.push(`export * as vue from 'vue';`);
  await writeFile(filename, exports.join('\n'));

  const runtime = await compileModule(filename);

  return { ...runtime, browser };
}

/**
 * Подмена стоит только на нативном import: проверки identity выполняет продукт.
 * Каждый вызов записывается, чтобы отказ карты доказуемо предшествовал исполнению entry.
 */
export function importer(runtime, component = { render: () => null }, overrides = {}) {
  const calls = [];
  /**
   * Нативный import получает только заранее объявленные модули сценария.
   * Ошибка карты не должна незаметно открыть исполняемый entry.
   */
  const importModule = async (url) => {
    calls.push(url);

    if (Object.hasOwn(overrides, url)) {
      return await overrides[url]();
    }
    if (url === 'vue') {
      return runtime.vue;
    }
    if (url === '@grigdesk/ui') {
      return runtime.ui;
    }
    if (url === descriptor.entry) {
      return { default: component };
    }

    throw new Error(`Необъявленный import фикстуры: ${url}`);
  };

  return { calls, importModule };
}

/**
 * Ручной resolve не запускает сеть или браузерную очередь задач.
 * Нужен для воспроизведения позднего ответа уже отменённой панели.
 */
export function deferred() {
  let resolve;
  const promise = new Promise((done) => {
     resolve = done; 
  });

  return { promise, resolve };
}
