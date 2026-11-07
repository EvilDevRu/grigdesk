// Helper16: неизменённые JS байты приходят по публичным установленным URL.
// Node hook подставляет только два host externals; product source не читается и не пересобирается.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from '../../../web/node_modules/typescript/lib/typescript.js';
import { singletonUrl } from './compile-vue.js';

const artifacts = '/home/evildev/.grigdesk/artifacts/studio3d-extraction';

/**
 * JS parser перечисляет настоящие import/export и literal import(), без regex по тексту.
 * Вычисляемый import не даёт fixture незаметно прочесть сеть или произвольный локальный путь.
 */
function importsOf(source, filename) {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imports = [];

  assert.deepEqual(tree.parseDiagnostics.map(item =>
    ts.flattenDiagnosticMessageText(item.messageText, ' ')), [], filename);

  /**
   * Обход сохраняет порядок literal edges, в том числе внутри функций динамической загрузки.
   * Несимвольный import останавливает fixture до исполнения product модуля.
   */
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      assert.equal(ts.isStringLiteralLike(node.moduleSpecifier), true);
      imports.push(node.moduleSpecifier.text);
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      assert.equal(node.arguments.length, 1, 'Нужен literal dynamic import');
      assert.equal(ts.isStringLiteralLike(node.arguments[0]), true, 'Нужен literal dynamic import');
      imports.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  }

  visit(tree);

  return imports;
}

/**
 * Оба entry разделяют native ESM cache и per-file HTTP/write promise, включая конкурентный спрос.
 * Source bytes не пересобираются; local mirror — только fixture исполнения Node в happy-dom.
 */
export async function createPackagedWebGraph(t, { host, descriptor, request }) {
  const directory = await mkdtemp(path.join(artifacts, 'installed-web-'));
  const directoryUrl = pathToFileURL(`${directory}${path.sep}`).href;
  const origin = globalThis.location?.origin ?? 'http://fixture.invalid';
  const entry = new URL(descriptor.entry, origin);
  const prefix = entry.pathname.slice(0, entry.pathname.lastIndexOf('/') + 1);
  const key = `installedStudioUi${process.pid}${Date.now()}${Math.random()}`;
  const uiFile = path.join(directory, '.fixture-host-ui.mjs');
  const files = new Map();
  const reads = [];
  const imports = [];
  const importErrors = [];
  let totalBytes = 0;

  globalThis[key] = host.ui;

  const names = Object.keys(host.ui).filter(name => /^[A-Za-z_$][\w$]*$/u.test(name)
    && name !== 'default');

  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n');
  await writeFile(uiFile, [
    `const ui = globalThis[${JSON.stringify(key)}];`,
    ...names.map(name => `export const ${name} = ui.${name};`),
  ].join('\n'));

  const hook = registerHooks({
    /**
     * Identity подменяется только для Vue/UI внутри собственной mirror generation.
     * Все relative imports разрешает штатный Node resolver по неизменённым bytes.
     */
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith(directoryUrl)) {
        if (specifier === 'vue') {
          return { url: singletonUrl('vue'), shortCircuit: true };
        }

        if (specifier === '@grigdesk/ui') {
          return { url: pathToFileURL(uiFile).href, shortCircuit: true };
        }
      }

      return nextResolve(specifier, context);
    },
  });

  t.after(async () => {
    hook.deregister();
    delete globalThis[key];
    await rm(directory, { recursive: true, force: true });
  });

  /**
   * Origin/generation и однократное canonical decoding проверяются до HTTP или записи mirror.
   * Dot/separator/вложенное кодирование не превращают URL в иной файл или поколение.
   */
  function publicUrl(raw) {
    const url = new URL(raw, entry);

    assert.equal(url.search, '');
    assert.equal(url.hash, '');

    if (url.protocol === 'file:') {
      const file = fileURLToPath(url);

      assert.equal(file.startsWith(`${directory}${path.sep}`), true);

      const relative = path.relative(directory, file).split(path.sep).map(encodeURIComponent).join('/');

      return new URL(prefix + relative, entry).pathname;
    }

    assert.equal(url.origin, entry.origin);
    assert.equal(url.pathname.startsWith(prefix), true);

    return url.pathname;
  }

  /**
   * Каждая module запись публикуется в cache только обещанием полностью записанного файла.
   * Загрузка соседей вынесена отдельно: cyclic imports не ждут собственный closure promise.
   */
  function fileFor(raw) {
    const url = new URL(publicUrl(raw), entry);
    const relative = url.pathname.slice(prefix.length).split('/').map(part => {
      const decoded = decodeURIComponent(part);

      assert.equal(!decoded || decoded.startsWith('.') || /[%/\\\x00-\x1f\x7f?#]/u.test(decoded), false);
      assert.equal(encodeURIComponent(decoded), part);

      return decoded;
    }).join('/');

    assert.match(relative, /\.m?js$/u);

    const existing = files.get(url.pathname);

    if (existing) {
      return existing;
    }

    assert.equal(files.size < 512, true, 'Слишком большой packaged module graph');

    const promise = Promise.resolve().then(async () => {
      const response = await request('GET', url.pathname);

      assert.equal(response.statusCode, 200, `${url.pathname}: ${response.body}`);
      assert.match(String(response.headers['content-type'] ?? ''), /javascript|ecmascript/u);

      const bytes = response.rawPayload;
      const file = path.join(directory, relative);
      const dependencies = importsOf(bytes.toString('utf8'), relative);

      totalBytes += bytes.length;
      assert.equal(totalBytes <= 64 * 1024 * 1024, true, 'Превышен лимит packaged JS fixture');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      reads.push({
        url: url.pathname,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      });

      return {
        file,
        url,
        dependencies,
      };
    });

    files.set(url.pathname, promise);
    void promise.catch(() => {
      if (files.get(url.pathname) === promise) {
        files.delete(url.pathname);
      }
    });

    return promise;
  }

  /**
   * Каждый спрос дожидается полного своего closure, разделяя только уже записанные files.
   * Это сохраняет циклы и concurrent background/panel без import отсутствующего shared chunk.
   */
  async function download(raw, visited = new Set()) {
    const url = publicUrl(raw);

    if (visited.has(url)) {
      return;
    }

    visited.add(url);

    const loaded = await fileFor(url);

    for (const dependency of loaded.dependencies) {
      if (dependency === 'vue' || dependency === '@grigdesk/ui') {
        continue;
      }

      assert.equal(dependency.startsWith('./') || dependency.startsWith('../'), true, dependency);
      await download(new URL(dependency, loaded.url).href, visited);
    }

    return loaded.file;
  }

  return {
    reads,
    imports,
    importErrors,
    publicUrl,
    /**
     * Два публичных externals возвращают exact host objects без скачивания копии SDK.
     * Product entry исполняется только после полного HTTP closure и сохраняет native module cache.
     */
    async load(url) {
      if (url === 'vue') {
        return host.vue;
      }
      if (url === '@grigdesk/ui') {
        return host.ui;
      }

      try {
        const file = await download(url);

        imports.push(url);

        return await import(pathToFileURL(file).href);
      } catch (error) {
        importErrors.push({
          url,
          message: error.message,
          stack: error.stack,
        });

        throw error;
      }
    },
  };
}
