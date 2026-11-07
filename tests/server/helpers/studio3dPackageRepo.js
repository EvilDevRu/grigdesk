import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, lstat, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { git } from './pluginRepo.js';

const artifactRoot = '/home/evildev/.grigdesk/artifacts/studio3d-extraction/installer-runs';
const digest = (value) => createHash('sha256').update(value).digest('hex');
/**
 * Явно неверный opt-in падает до skip; рабочее дерево development не является export.
 * Никакого поиска P или source fallback нет.
 */
export async function studioPackageInput() {
  const raw = process.env.STUDIO3D_PACKAGE_DIR;

  if (raw === undefined) {
    return null;
  }

  assert.equal(path.isAbsolute(raw), true, 'STUDIO3D_PACKAGE_DIR должен быть абсолютным');
  assert.equal((await lstat(raw)).isDirectory(), true, 'Export должен быть обычным каталогом');

  const files = await payloadFiles(raw);
  const manifest = JSON.parse((await readFile(path.join(raw, 'plugin.json'))).toString());

  assert.equal(manifest.id, 'studio3d');
  assert.equal(manifest.version, '1.0.0');
  assert.equal(files.some((file) => /^(?:development|node_modules|sdk)(?:\/|$)/.test(file.path)), false);
  assert.equal(files.some((file) => ['package.json', 'package-lock.json'].includes(file.path)), false);

  return {
    root: raw,
    manifest,
    files
  };
}
/**
 * Снимок читает только ordinary files; SHA и executable mode позволяют сравнить
 * 1.0.0 с export байт-в-байт. После git init исключается лишь собственный root .git.
 */
async function payloadFiles(root, ignoreOwnGit = false) {
  const files = [];
  /**
   * Обходит обычные файлы собственного export без следования ссылкам.
   * Корневая .git исключается только у временного fixture repo.
   */

  async function visit(relative) {
    const absolute = path.join(root, relative);
    const info = await lstat(absolute);

    assert.equal(info.isSymbolicLink(), false, `Symlink запрещён: ${relative}`);

    if (info.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) {
        if (ignoreOwnGit && !relative && name === '.git') {
          continue;
        }

        await visit(path.posix.join(relative, name));
      }
    }
    else {
      assert.equal(info.isFile(), true, `Спецфайл запрещён: ${relative}`);
      files.push({
        path: relative,
        sha256: digest(await readFile(absolute)),
        executable: Boolean(info.mode & 0o111),
        bytes: info.size
      });
    }
  }

  await visit('');

  return files;
}
/**
 * Только свой временный repo получает commits/tags; проект C/P не меняется.
 * Первый тег точен, второй помечен как derived fixture, а не готовый пользовательский релиз.
 */
export async function studioPackageRepo(t, input) {
  await mkdir(artifactRoot, {
    recursive: true
  });

  const root = await mkdtemp(path.join(artifactRoot, 'repo-'));
  const work = path.join(root, 'work');
  const origin = path.join(root, 'origin.git');

  t.after(() => rm(root, {
    recursive: true, force: true
  }));
  await git(root, 'init', '-q', '-b', 'main', work);
  await git(work, 'config', 'user.name', 'GrigDesk Test');
  await git(work, 'config', 'user.email', 'grigdesk@example.invalid');
  await git(root, 'init', '-q', '--bare', origin);
  await git(work, 'remote', 'add', 'origin', origin);

  for (const file of input.files) {
    const target = path.join(work, file.path);

    await mkdir(path.dirname(target), {
      recursive: true
    });
    await writeFile(target, await readFile(path.join(input.root, file.path)), {
      mode: file.executable ? 0o755 : 0o644
    });
  }

  assert.deepEqual(await payloadFiles(work, true), input.files);
  /**
   * Создаёт тег только в собственном временном work/origin.
   * Проектные репозитории C/P этим helper не изменяются.
   */

  async function tag(version) {
    await git(work, 'add', '-A');
    await git(work, 'commit', '-q', '-m', `isolated fixture ${version}`);
    await git(work, 'tag', '-a', `v${version}`, '-m', `v${version}`);
    await git(work, 'push', '-q', 'origin', 'main', '--tags');

    return git(work, 'rev-parse', 'HEAD');
  }

  const exactSha = await tag('1.0.0');
  // Производственный bundle сохраняется полностью; wrapper живёт только во втором temp теге.
  await rename(path.join(work, 'server.mjs'), path.join(work, 'fixture-product-server.mjs'));
  await writeFile(path.join(work, 'fixture-generation.mjs'), [
    'export const version = "fixture-1.0.1";',
    'export const dependencyUrl = import.meta.url;',
  ].join('\n') + '\n');
  await writeFile(path.join(work, 'server.mjs'), [
    'import product from "./fixture-product-server.mjs";',
    'import { version, dependencyUrl } from "./fixture-generation.mjs";',
    'export default async function fixture(app, options) {',
    '  await product(app, options);',
    '  options.core.emit("fixture-installed-runtime", {',
    '    runtime: app.studio3d, lifecycle: options.lifecycle, entryUrl: import.meta.url,',
    '  });',
    '  const bridge = {};',
    '  options.core.emit("fixture-installed-control", { bridge });',
    '  if (!bridge.control) throw new Error("fixture_control_unavailable");',
    '  app.get("/fixture-stream", async (_request, reply) => {',
    '    const stream = bridge.control.openStream();',
    '    reply.type("model/gltf-binary").send(stream);',
    '    stream.write(Buffer.from("glTF"));',
    '  });',
    '  app.addHook("onClose", async () => {',
    '    await bridge.control.beforeClose?.();',
    '  });',
    '  app.get("/fixture-generation", async () => ({',
    '    version, dependencyUrl, entryUrl: import.meta.url,',
    '    nodeExecutable: options.core.environment().nodeExecutable,',
    '    workerUrl: app.studio3d.context?.library.analysis.workerUrl.href ?? null,',
    '  }));',
    '}',
  ].join('\n') + '\n');
  await rename(path.join(work, 'runtime/analysisWorker.mjs'),
    path.join(work, 'runtime/fixture-product-analysisWorker.mjs'));
  await writeFile(path.join(work, 'runtime/fixture-worker-generation.mjs'),
    'export const version = "fixture-worker-1.0.1";\n');
  await writeFile(path.join(work, 'runtime/analysisWorker.mjs'), [
    'import { existsSync, writeFileSync } from "node:fs";',
    'import path from "node:path";',
    'import { version } from "./fixture-worker-generation.mjs";',
    'process.stderr.write(version + "\\n");',
    'let parent = path.dirname(JSON.parse(process.argv[2]).sourcePath);',
    'for (let depth = 0; depth < 12; depth += 1) {',
    '  const flag = path.join(parent, ".fixture-hold-worker");',
    '  if (existsSync(flag)) {',
    '    writeFileSync(flag + ".pid", String(process.pid));',
    '    await new Promise(() => { setInterval(() => {}, 1000); });',
    '  }',
    '  if (path.dirname(parent) === parent) break;',
    '  parent = path.dirname(parent);',
    '}',
    'await import("./fixture-product-analysisWorker.mjs");',
  ].join('\n') + '\n');
  await writeFile(path.join(work, 'plugin.json'), JSON.stringify({
    ...input.manifest, version: '1.0.1'
  }, null, 2) + '\n');

  const derivedSha = await tag('1.0.1');
  const derived = await payloadFiles(work, true);
  const changes = derived.filter((file) => input.files.find((old) => old.path === file.path)?.sha256
    !== file.sha256);

  await writeFile(path.join(root, 'provenance.json'), JSON.stringify({
    exact: {
      version: '1.0.0',
      sha: exactSha,
      files: input.files,
      byteExactExport: true
    },
    derived: {
      version: '1.0.1',
      sha: derivedSha,
      changes,
      publishedProductRelease: false
    },
  }, null, 2) + '\n');

  return {
    root,
    work,
    origin,
    url: pathToFileURL(origin).href,
    exactSha,
    derivedSha,
    changes
  };
}
