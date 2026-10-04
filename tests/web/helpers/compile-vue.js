// Единый TS-aware compiler для component tests. Он бандлит локальный граф .vue/.ts,
// а Vue/Pinia оставляет внешними singleton-модулями из web/node_modules.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
// Тяжёлые библиотеки не включаются в каждую тестовую сборку чата.
// В component tests подсветка и схемы подменяются явными загрузчиками.
const LAZY_EXTERNALS = ['mermaid', 'shiki', 'shiki/*'];

let nonce = 0;

// Data-URL навсегда оставляет в ESM cache и сам base64-код, и очень длинный
// идентификатор модуля. Короткий file: URL удерживает только загруженный модуль;
// исходник после import уже не нужен.
async function importCompiled(code) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cockpit-vue-test-'));
  const filename = path.join(directory, `module-${process.pid}-${nonce += 1}.mjs`);

  try {
    await writeFile(filename, code, 'utf8');
    return await import(pathToFileURL(filename).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

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
        if (Object.hasOwn(stubs, specifier)) {
          continue;
        }

        builder.onResolve({ filter: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }, () => ({
          path: pathToFileURL(singletonPath).href,
          external: true,
        }));
      }
      for (const [specifier, contents] of Object.entries(stubs)) {
        const filter = new RegExp(
          `^${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
        );

        builder.onResolve({ filter }, () => ({
          path: specifier,
          namespace: 'cockpit-stub',
        }));
        // resolveDir нужен стабам, которые реэкспортируют кусок настоящего модуля:
        // без него esbuild некуда разрешать пути из подменённого кода.
        builder.onLoad(
          {
            filter,
            namespace: 'cockpit-stub',
          },
          () => ({ contents, loader: 'js', resolveDir: WEB_ROOT }),
        );
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
    external: LAZY_EXTERNALS,
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
  return (await importCompiled(code)).default;
}

/**
 * Бандлит обычный JS/TS entry тем же resolver-ом, что и компонентные проверки.
 * Тяжёлые lazy imports остаются внешними; тест задаёт их результат явным loader-ом.
 */
export async function compileModule(filename, { stubs = {} } = {}) {
  const result = await build({
    entryPoints: [filename],
    absWorkingDir: WEB_ROOT,
    bundle: true,
    external: LAZY_EXTERNALS,
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
  return importCompiled(code);
}

export function webFile(relativePath) {
  return path.join(WEB_ROOT, relativePath);
}

export function singletonUrl(name) {
  const file = SINGLETONS.get(name);
  if (!file) throw new Error(`Неизвестный singleton: ${name}`);
  return pathToFileURL(file).href;
}
