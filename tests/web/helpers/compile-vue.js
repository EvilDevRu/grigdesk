// Единый TS-aware compiler для component tests. Он бандлит локальный граф .vue/.ts,
// а Vue/Pinia оставляет внешними singleton-модулями из web/node_modules.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from '../../../web/node_modules/esbuild/lib/main.js';
import { compileScript, parse } from '../../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js';

const REPO_ROOT = path.resolve(new URL('../../..', import.meta.url).pathname);
const WEB_ROOT = path.join(REPO_ROOT, 'web');
const SINGLETONS = new Map([
  ['vue', path.join(WEB_ROOT, 'node_modules/vue/index.mjs')],
  ['pinia', path.join(WEB_ROOT, 'node_modules/pinia/dist/pinia.mjs')],
  ['vue-router', path.join(WEB_ROOT, 'node_modules/vue-router/dist/vue-router.mjs')],
]);
let nonce = 0;

function vuePlugin() {
  return {
    name: 'cockpit-vue-sfc',
    setup(builder) {
      builder.onResolve({ filter: /\.vue$/ }, (args) => ({
        path: path.isAbsolute(args.path) ? args.path : path.resolve(args.resolveDir, args.path),
        namespace: 'cockpit-vue',
      }));
      builder.onLoad({ filter: /\.vue$/, namespace: 'cockpit-vue' }, async (args) => {
        const source = await readFile(args.path, 'utf8');
        const parsed = parse(source, { filename: args.path });
        if (parsed.errors.length) {
          throw new Error(parsed.errors.map((error) => error instanceof Error ? error.message : String(error)).join('\n'));
        }
        const descriptor = parsed.descriptor;
        const compiled = compileScript(descriptor, {
          id: `data-v-test-${nonce += 1}`,
          inlineTemplate: true,
        });
        return {
          contents: compiled.content,
          loader: descriptor.scriptSetup?.lang === 'ts' || descriptor.script?.lang === 'ts' ? 'ts' : 'js',
          resolveDir: path.dirname(args.path),
        };
      });
    },
  };
}

function dependencyPlugin(stubs) {
  return {
    name: 'cockpit-test-dependencies',
    setup(builder) {
      for (const [specifier, singletonPath] of SINGLETONS) {
        builder.onResolve({ filter: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }, () => ({
          path: pathToFileURL(singletonPath).href,
          external: true,
        }));
      }
      for (const [specifier, contents] of Object.entries(stubs)) {
        builder.onResolve({ filter: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }, () => ({
          path: specifier,
          namespace: 'cockpit-stub',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'cockpit-stub' }, () => ({ contents, loader: 'js' }));
      }
    },
  };
}

/**
 * @param {string} filename абсолютный путь к SFC
 * @param {{stubs?: Record<string, string>}} options
 */
export async function compileVue(filename, { stubs = {} } = {}) {
  const result = await build({
    entryPoints: [filename],
    absWorkingDir: WEB_ROOT,
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    plugins: [dependencyPlugin(stubs), vuePlugin()],
    logLevel: 'silent',
  });
  const code = result.outputFiles[0]?.text;
  if (!code) throw new Error(`esbuild не вернул модуль для ${filename}`);
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${nonce += 1}`;
  return (await import(url)).default;
}

/** Бандлит обычный JS/TS entry тем же resolver-ом, что и Vue component tests. */
export async function compileModule(filename, { stubs = {} } = {}) {
  const result = await build({
    entryPoints: [filename],
    absWorkingDir: WEB_ROOT,
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    plugins: [dependencyPlugin(stubs), vuePlugin()],
    logLevel: 'silent',
  });
  const code = result.outputFiles[0]?.text;
  if (!code) throw new Error(`esbuild не вернул модуль для ${filename}`);
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${nonce += 1}`;
  return import(url);
}

export function webFile(relativePath) {
  return path.join(WEB_ROOT, relativePath);
}

export function singletonUrl(name) {
  const file = SINGLETONS.get(name);
  if (!file) throw new Error(`Неизвестный singleton: ${name}`);
  return pathToFileURL(file).href;
}
