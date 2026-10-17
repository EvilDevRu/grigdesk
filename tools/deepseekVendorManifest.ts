// Снимок upstream хранит оригинальные байты и не является активным runtime.
// Подготовка отделена от публикации; патчи проверяются в отдельной копии.
// В Git лежат только manifest, патчи и лицензии; `upstream/` — игнорируемый кэш,
// который подготавливается по закреплённому commit и сверяется с manifest.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { sha256 } from '../shared/node/hash.ts';

const exec = promisify(execFile);

export const DEEPSEEK_UPSTREAM_REPOSITORY = 'https://github.com/deepseek-ai/deepseek-harness';

export interface VendorSelection {
  roots: { path: string; reason: string }[];
  versionFile: string;
  dependencyLockPath: string;
}

// Причина включения хранится у selected root и не повторяется в каждой записи файла.
interface VendorFile {
  path: string;
  gitBlob: string;
  sha256: string;
  mode: '100644' | '100755';
}

export interface MaterializeDeepSeekOptions {
  seedDir?: string;
  sourceDir?: string;
  fetchSource?: (commit: string, parent: string) => Promise<string>;
}

const MISSING_UPSTREAM = 'Исходники DeepSeek Harness не подготовлены: '
  + 'npm --prefix server run deepseek:prepare';

export interface DeepSeekVendorManifest {
  format: 1;
  repository: string;
  commit: string;
  version: string;
  selection: VendorSelection;
  files: VendorFile[];
  patches: { path: string; sha256: string }[];
  dependencyLock: { path: string; sha256: string };
  requiredGates: string[];
}

interface GitSelection {
  sourceDir: string;
  commit: string;
  selection: VendorSelection;
}

export interface DeepSeekSyncOptions {
  sourceDir: string;
  vendorDir: string;
  commit: string;
  selection: VendorSelection;
  stagingParent?: string;
  patchesDir?: string;
}

export interface PreparedDeepSeekSync {
  stagingDir: string;
  vendorDir: string;
  previousManifestHash: string | null;
  manifest: DeepSeekVendorManifest;
  diff: {
    added: string[];
    changed: string[];
    deleted: string[];
  };
}

/**
 * Пути manifest и Git не могут выходить из снимка или выбирать служебные каталоги.
 * Обратный слэш и управляющие символы отвергаются также на Unix ради переносимости.
 */
export function safeVendorPath(value: unknown): string {
  if (typeof value !== 'string' || !value || /[\\\x00-\x1f\x7f:]/u.test(value)
    || value.split('/').some((part) => !part || ['.', '..', '.git', 'node_modules'].includes(part))
    || path.posix.isAbsolute(value)) {
    throw new Error(`Небезопасный путь снимка: ${String(value)}`);
  }

  return value;
}

/**
 * Ни вход, ни место публикации не проходят через символическую ссылку.
 * Отсутствующий хвост разрешён для нового каталога, существующие предки проверяются.
 */
async function assertPlainPath(file: string): Promise<void> {
  const absolute = path.resolve(file);
  const parts = absolute.slice(path.parse(absolute).root.length).split(path.sep);
  let current = path.parse(absolute).root;

  for (const part of parts) {
    current = path.join(current, part);

    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new Error(`Символическая ссылка запрещена: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

/**
 * Обход сравнивает весь каталог, включая добавленные вручную файлы.
 * Ссылки и специальные файлы не превращаются в молча пропущенные зависимости.
 */
async function listFiles(root: string, prefix = ''): Promise<string[]> {
  await assertPlainPath(root);

  const output: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const name = safeVendorPath(prefix ? `${prefix}/${entry.name}` : entry.name);

    if (entry.isDirectory()) {
      output.push(...await listFiles(path.join(root, entry.name), name));
    } else if (entry.isFile()) {
      output.push(name);
    } else {
      throw new Error(`Ссылка или специальный файл в снимке: ${name}`);
    }
  }

  return output.sort();
}

/**
 * Версия manifest проверяется до использования его путей в файловых операциях.
 * Полный перечень, лицензии и identity lock обязательны даже для offline fixture.
 */
function decodeManifest(value: unknown): DeepSeekVendorManifest {
  const manifest = value as DeepSeekVendorManifest;

  if (!manifest || manifest.format !== 1 || manifest.repository !== DEEPSEEK_UPSTREAM_REPOSITORY
    || !/^[a-f0-9]{40}$/u.test(manifest.commit) || typeof manifest.version !== 'string'
    || !Array.isArray(manifest.files) || !Array.isArray(manifest.patches)
    || !Array.isArray(manifest.requiredGates) || !manifest.selection) {
    throw new Error('Некорректный manifest DeepSeek');
  }

  validateSelection(manifest.selection);

  const names = new Set<string>();

  for (const file of manifest.files) {
    safeVendorPath(file.path);

    if (names.has(file.path) || !/^[a-f0-9]{64}$/u.test(file.sha256)
      || !/^[a-f0-9]{40}$/u.test(file.gitBlob)
      || !['100644', '100755'].includes(file.mode)) {
      throw new Error('Некорректная запись manifest');
    }

    names.add(file.path);
  }

  for (const required of ['LICENSE', 'THIRD_PARTY_NOTICES.md', manifest.selection.versionFile]) {
    if (!names.has(required)) {
      throw new Error(`В manifest отсутствует ${required}`);
    }
  }

  const dependency = manifest.files.find((file) => file.path === manifest.selection.dependencyLockPath);

  if (!dependency || manifest.dependencyLock?.path !== dependency.path
    || manifest.dependencyLock.sha256 !== dependency.sha256) {
    throw new Error('Dependency lock identity не соответствует manifest');
  }

  const patchNames = new Set<string>();

  for (const patch of manifest.patches) {
    safeVendorPath(patch.path);

    if (patchNames.has(patch.path) || !patch.path.endsWith('.patch')
      || !/^[a-f0-9]{64}$/u.test(patch.sha256)) {
      throw new Error('Некорректная запись патча');
    }

    patchNames.add(patch.path);
  }

  return manifest;
}

/**
 * Перечень включения задаёт явные корни и причины, без glob или всего репозитория.
 * Метаданные добавляются независимо от выбранных пакетов, сохраняя provenance.
 */
function validateSelection(selection: VendorSelection): void {
  if (!selection || !Array.isArray(selection.roots) || !selection.roots.length) {
    throw new Error('Не заданы selected roots');
  }

  const names = new Set<string>();

  for (const root of selection.roots) {
    safeVendorPath(root.path);

    if (names.has(root.path) || typeof root.reason !== 'string' || !root.reason.trim()) {
      throw new Error('Selected root требует уникальный путь и причину');
    }

    names.add(root.path);
  }

  safeVendorPath(selection.versionFile);
  safeVendorPath(selection.dependencyLockPath);
}

/**
 * Manifest пишется с одной строкой на файл: diff обновления остаётся обозримым,
 * а порядок ключей совпадает с объектом в памяти, поэтому повторное чтение даёт тот же JSON.
 */
export function serializeDeepSeekManifest(manifest: DeepSeekVendorManifest): string {
  const placeholder = '\u0000files\u0000';
  const text = JSON.stringify(manifest, (key, value) => (key === 'files' ? placeholder : value), 2);
  const files = manifest.files.map((file) => `    ${JSON.stringify(file)}`).join(',\n');

  return `${text.replace(JSON.stringify(placeholder), `[\n${files}\n  ]`)}\n`;
}

/**
 * Метаданные проверяются без исходников: manifest, патчи, LICENSE и notices лежат в Git.
 * Каталог `upstream/` допустим, но не обязателен: это кэш, подготавливаемый по manifest.
 */
export async function verifyDeepSeekVendorMetadata(directory: string): Promise<DeepSeekVendorManifest> {
  await assertPlainPath(directory);

  const top = (await fs.readdir(directory)).sort();
  const allowed = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'upstream.lock.json',
    ...['patches', 'upstream'].filter((name) => top.includes(name))].sort();

  if (JSON.stringify(top) !== JSON.stringify(allowed)) {
    throw new Error('Состав верхнего уровня снимка изменён вручную');
  }

  for (const name of top) {
    await assertPlainPath(path.join(directory, name));
  }

  const manifest = decodeManifest(JSON.parse(await fs.readFile(
    path.join(directory, 'upstream.lock.json'), 'utf8',
  )));
  const patchFiles = top.includes('patches') ? await listFiles(path.join(directory, 'patches')) : [];

  if (JSON.stringify(patchFiles) !== JSON.stringify(manifest.patches.map((patch) => patch.path).sort())) {
    throw new Error('Состав патчей изменён вручную');
  }

  for (const patch of manifest.patches) {
    if (sha256(await fs.readFile(path.join(directory, 'patches', patch.path))) !== patch.sha256) {
      throw new Error(`Hash патча изменён вручную: ${patch.path}`);
    }
  }

  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    const file = manifest.files.find((file) => file.path === name)!;

    if (sha256(await fs.readFile(path.join(directory, name))) !== file.sha256) {
      throw new Error(`Лицензия или notice изменены: ${name}`);
    }
  }

  return manifest;
}

/**
 * Исходники сверяются с manifest целиком: состав, байты, исполняемый бит и версия.
 * Добавленный, удалённый или изменённый файл не может пройти как часть закреплённого commit.
 */
async function verifyUpstreamFiles(upstream: string, manifest: DeepSeekVendorManifest): Promise<void> {
  const actual = await listFiles(upstream);
  const expected = manifest.files.map((file) => file.path).sort();

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Состав снимка изменён вручную');
  }

  for (const file of manifest.files) {
    const target = path.join(upstream, file.path);
    const mode = (await fs.stat(target)).mode;

    if (sha256(await fs.readFile(target)) !== file.sha256
      || Boolean(mode & 0o111) !== (file.mode === '100755')) {
      throw new Error(`Hash или режим изменён вручную: ${file.path}`);
    }
  }

  const version = JSON.parse(await fs.readFile(
    path.join(upstream, manifest.selection.versionFile), 'utf8',
  )).version;

  if (version !== manifest.version) {
    throw new Error('Версия manifest не соответствует upstream version');
  }
}

/**
 * Проверка покрывает payload, режимы файлов, патчи и отдельные notices.
 * Никакой запуск runtime или установка зависимости здесь не выполняется.
 */
export async function verifyDeepSeekSnapshot(directory: string): Promise<DeepSeekVendorManifest> {
  const manifest = await verifyDeepSeekVendorMetadata(directory);
  const upstream = path.join(directory, 'upstream');

  try {
    await fs.lstat(upstream);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(MISSING_UPSTREAM);
    }

    throw error;
  }

  await verifyUpstreamFiles(upstream, manifest);

  return manifest;
}

/**
 * Первичный импорт не маскирует повреждённый или незарегистрированный прежний снимок.
 * Отсутствовать может только весь vendor directory, а не manifest внутри него.
 */
async function previousSnapshot(directory: string): Promise<DeepSeekVendorManifest | null> {
  await assertPlainPath(directory);

  try {
    await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }

  return verifyDeepSeekSnapshot(directory);
}

/**
 * Git tree читается по точному object id, рабочие файлы source-dir не используются.
 * До extraction отвергаются symlinks, submodules и небезопасные имена всего набора.
 */
async function selectedGitFiles(options: GitSelection): Promise<VendorFile[]> {
  const { stdout: resolved } = await exec('git', [
    '-C', options.sourceDir, 'rev-parse', '--verify', `${options.commit}^{commit}`,
  ]);

  if (resolved.trim() !== options.commit) {
    throw new Error('Source commit не соответствует полному SHA');
  }

  const { stdout } = await exec('git', ['-C', options.sourceDir, 'ls-tree', '-rz', options.commit], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const roots = [
    ...options.selection.roots,
    ...['LICENSE', 'THIRD_PARTY_NOTICES.md', options.selection.versionFile,
      options.selection.dependencyLockPath].map((name) => ({ path: name, reason: 'Метаданные upstream' })),
  ];
  const files: VendorFile[] = [];

  for (const row of stdout.split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t');
    const name = row.slice(tab + 1);
    const root = roots.find((root) => name === root.path || name.startsWith(`${root.path}/`));

    if (!root) {
      continue;
    }

    safeVendorPath(name);

    const [mode, kind, gitBlob] = row.slice(0, tab).split(' ');

    if (kind !== 'blob' || (mode !== '100644' && mode !== '100755')) {
      throw new Error(`Git tree содержит ссылку или submodule: ${name}`);
    }

    files.push({
      path: name,
      mode,
      gitBlob: gitBlob!,
      sha256: '',
    });
  }

  for (const root of roots) {
    if (!files.some((file) => file.path === root.path || file.path.startsWith(`${root.path}/`))) {
      throw new Error(`В upstream отсутствует обязательный путь: ${root.path}`);
    }
  }

  return files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

/**
 * Выбранные корни извлекаются из Git object, а каждый файл сверяется с его blob id.
 * Так `export-subst` или фильтры архива не могут незаметно изменить байты upstream.
 */
async function extractSelectedUpstream(options: GitSelection, destination: string): Promise<VendorFile[]> {
  const files = await selectedGitFiles(options);
  const archive = `${destination}.tar`;
  const roots = [...options.selection.roots.map((root) => root.path), 'LICENSE',
    'THIRD_PARTY_NOTICES.md', options.selection.versionFile, options.selection.dependencyLockPath];

  await fs.mkdir(destination);

  try {
    await exec('git', ['-C', options.sourceDir, 'archive', `--output=${archive}`, options.commit,
      '--', ...roots]);
    await exec('tar', ['-xf', archive, '-C', destination]);
  } finally {
    await fs.rm(archive, { force: true });
  }

  for (const file of files) {
    const bytes = await fs.readFile(path.join(destination, file.path));
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

    if (blob !== file.gitBlob) {
      throw new Error(`Git archive изменил байты upstream blob: ${file.path}`);
    }

    file.sha256 = sha256(bytes);
  }

  return files;
}

/**
 * Получаем именно запрошенный Git object, без checkout плавающей ветки.
 * Временный репозиторий создаётся внутри parent и удаляется вызывающим вместе с ним.
 */
export async function fetchDeepSeekUpstream(commit: string, parent: string): Promise<string> {
  const source = await fs.mkdtemp(path.join(parent, 'deepseek-source-'));

  await exec('git', ['init', '-q', source]);
  await exec('git', ['-C', source, 'fetch', '--depth', '1', '--no-tags',
    DEEPSEEK_UPSTREAM_REPOSITORY, commit], { maxBuffer: 4 * 1024 * 1024, timeout: 15 * 60_000 });

  return source;
}

/**
 * Локальный Git подходит источником, только если в нём есть сам закреплённый commit.
 * Иначе подготовка идёт по сети, а не по похожему дереву рабочей копии.
 */
async function hasCommit(sourceDir: string, commit: string): Promise<boolean> {
  try {
    const { stdout } = await exec('git', ['-C', sourceDir, 'rev-parse', '--verify', `${commit}^{commit}`]);

    return stdout.trim() === commit;
  } catch {
    return false;
  }
}

/**
 * Кэш считается готовым только при полном совпадении с manifest.
 * Отсутствие и любое расхождение означают одно: кэш нужно подготовить заново.
 */
async function upstreamMatches(upstream: string, manifest: DeepSeekVendorManifest): Promise<boolean> {
  try {
    await verifyUpstreamFiles(upstream, manifest);

    return true;
  } catch {
    return false;
  }
}

/**
 * Исходники upstream не хранятся в Git: по manifest подготавливается игнорируемый кэш.
 * Источник по порядку — проверенная копия (seed), локальный Git с commit или сеть.
 * Готовый кэш заменяется только целиком и только проверенной копией.
 */
export async function materializeDeepSeekSnapshot(
  vendorDir: string,
  options: MaterializeDeepSeekOptions = {},
): Promise<DeepSeekVendorManifest> {
  const directory = path.resolve(vendorDir);
  const manifest = await verifyDeepSeekVendorMetadata(directory);
  const upstream = path.join(directory, 'upstream');

  if (await upstreamMatches(upstream, manifest)) {
    return manifest;
  }

  const work = await fs.mkdtemp(path.join(path.dirname(directory), '.deepseek-upstream-'));

  try {
    const prepared = path.join(work, 'upstream');

    if (options.seedDir && await upstreamMatches(path.resolve(options.seedDir), manifest)) {
      await fs.cp(path.resolve(options.seedDir), prepared, { recursive: true });
    } else {
      const local = options.sourceDir && await hasCommit(options.sourceDir, manifest.commit);
      const sourceDir = local
        ? options.sourceDir!
        : await (options.fetchSource ?? fetchDeepSeekUpstream)(manifest.commit, work);
      const files = await extractSelectedUpstream({
        sourceDir,
        commit: manifest.commit,
        selection: manifest.selection,
      }, prepared);

      const identity = (list: VendorFile[]) => list
        .map((file) => `${file.path}:${file.mode}:${file.gitBlob}:${file.sha256}`).join('\n');

      if (identity(files) !== identity(manifest.files)) {
        throw new Error('Upstream commit не соответствует manifest DeepSeek');
      }
    }

    await verifyUpstreamFiles(prepared, manifest);
    await replaceUpstream(upstream, prepared, path.join(work, 'previous'), manifest);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }

  return verifyDeepSeekSnapshot(directory);
}

/**
 * Прежний кэш уходит в рабочий каталог и удаляется вместе с ним после замены.
 * Параллельная подготовка могла успеть раньше: проверенный чужой кэш не перезаписываем.
 */
async function replaceUpstream(
  upstream: string,
  prepared: string,
  previous: string,
  manifest: DeepSeekVendorManifest,
): Promise<void> {
  if (await upstreamMatches(upstream, manifest)) {
    return;
  }

  try {
    await fs.rename(upstream, previous);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    await fs.rename(prepared, upstream);
  } catch (error) {
    if (!await upstreamMatches(upstream, manifest)) {
      throw error;
    }
  }
}

/**
 * Патч проверяется и применяется лишь к сборочной копии вне рабочего Git checkout.
 * git apply не получает unsafe-paths; конфликт не может испортить исходный снимок.
 */
export async function checkDeepSeekPatches(directory: string, destination: string): Promise<void> {
  const manifest = await verifyDeepSeekSnapshot(directory);

  await assertPlainPath(destination);
  await fs.mkdir(destination);
  await fs.cp(path.join(directory, 'upstream'), destination, { recursive: true });
  await exec('git', ['init', '-q', destination]);

  for (const patch of manifest.patches) {
    const patchFile = path.resolve(directory, 'patches', patch.path);

    try {
      await exec('git', ['-C', destination, 'apply', '--check', '--', patchFile]);
      await exec('git', ['-C', destination, 'apply', '--', patchFile]);
    } catch {
      throw new Error(`Конфликт или небезопасный путь патча: ${patch.path}`);
    }
  }

  await fs.rm(path.join(destination, '.git'), { recursive: true, force: true });
}

/**
 * Подготовка возвращает reviewable candidate и перечень изменений, сохраняя старый снимок.
 * Даже для первого импорта проверяются лицензии, exact tree и последовательное применение патчей.
 */
export async function prepareDeepSeekSync(options: DeepSeekSyncOptions): Promise<PreparedDeepSeekSync> {
  if (!/^[a-f0-9]{40}$/u.test(options.commit ?? '')) {
    throw new Error('Для sync обязателен явный полный SHA commit');
  }

  validateSelection(options.selection);

  const vendorDir = path.resolve(options.vendorDir);
  const previous = await previousSnapshot(vendorDir);

  // Небезопасные пути и отсутствующие корни отвергаются до создания staging.
  await selectedGitFiles(options);

  const stagingParent = path.resolve(options.stagingParent ?? path.dirname(vendorDir));

  await assertPlainPath(stagingParent);
  await fs.mkdir(stagingParent, { recursive: true });

  const stagingDir = await fs.mkdtemp(path.join(stagingParent, '.deepseek-sync-'));

  try {
    const upstream = path.join(stagingDir, 'upstream');
    const files = await extractSelectedUpstream(options, upstream);
    const version = JSON.parse(await fs.readFile(
      path.join(upstream, options.selection.versionFile), 'utf8',
    )).version;

    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(version)) {
      throw new Error('Upstream version не определена');
    }

    const patches = path.join(stagingDir, 'patches');
    const patchSource = options.patchesDir ?? (previous ? path.join(vendorDir, 'patches') : undefined);

    const hasPatchSource = patchSource && await fs.lstat(patchSource).then(() => true, (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !options.patchesDir
        && previous?.patches.length === 0) {
        return false;
      }

      throw error;
    });

    if (hasPatchSource && patchSource) {
      await listFiles(patchSource);
      await fs.cp(patchSource, patches, { recursive: true });
    } else {
      await fs.mkdir(patches);
    }

    const patchFiles = await listFiles(patches);
    const dependency = files.find((file) => file.path === options.selection.dependencyLockPath)!;
    const manifest: DeepSeekVendorManifest = {
      format: 1,
      repository: DEEPSEEK_UPSTREAM_REPOSITORY,
      commit: options.commit,
      version,
      selection: structuredClone(options.selection),
      files,
      patches: await Promise.all(patchFiles.map(async (name) => ({
        path: name,
        sha256: sha256(await fs.readFile(path.join(patches, name))),
      }))),
      dependencyLock: { path: dependency.path, sha256: dependency.sha256 },
      requiredGates: previous?.requiredGates ?? ['snapshot-integrity', 'patch-apply'],
    };

    for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
      await fs.copyFile(path.join(upstream, name), path.join(stagingDir, name));
    }

    await fs.writeFile(path.join(stagingDir, 'upstream.lock.json'), serializeDeepSeekManifest(manifest));

    const patchCheck = `${stagingDir}-patch-check`;

    try {
      await checkDeepSeekPatches(stagingDir, patchCheck);
    } finally {
      await fs.rm(patchCheck, { recursive: true, force: true });
    }

    const oldFiles = new Map(previous?.files.map((file) => [file.path, `${file.mode}:${file.sha256}`]) ?? []);
    const newFiles = new Map(files.map((file) => [file.path, `${file.mode}:${file.sha256}`]));

    return {
      stagingDir,
      vendorDir,
      previousManifestHash: previous ? sha256(JSON.stringify(previous)) : null,
      manifest,
      diff: {
        added: [...newFiles.keys()].filter((name) => !oldFiles.has(name)),
        changed: [...newFiles.keys()].filter((name) => oldFiles.has(name)
          && oldFiles.get(name) !== newFiles.get(name)),
        deleted: [...oldFiles.keys()].filter((name) => !newFiles.has(name)),
      },
    };
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true });

    throw error;
  }
}

/**
 * Все доступные build/parity gates принадлежат репозиторию, а не флагам оператора.
 * Список предыдущего manifest запрещает потерять gate при удалении его программы.
 */
async function runAvailableGates(
  candidate: PreparedDeepSeekSync,
  runCompiledGate?: (candidate: PreparedDeepSeekSync) => Promise<void>,
): Promise<void> {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const gate = path.join(root, 'server/scripts/verifyDeepSeekCandidate.mts');
  const implemented = await fs.stat(gate).then(() => true, () => false);
  const required = candidate.manifest.requiredGates;

  if (required.some((name) => !['snapshot-integrity', 'patch-apply', 'compiled-parity'].includes(name))) {
    throw new Error('Неизвестный обязательный gate');
  }

  if (required.includes('compiled-parity') && !implemented) {
    throw new Error('Обязательный compiled-parity gate отсутствует');
  }

  if (implemented) {
    if (runCompiledGate) {
      await runCompiledGate(candidate);
    } else {
      const env = { ...process.env };

      delete env.NODE_TEST_CONTEXT;

      await exec(process.execPath, [gate, '--vendor-dir', candidate.stagingDir], {
        cwd: root,
        maxBuffer: 8 * 1024 * 1024,
        env,
      });
    }

    if (!required.includes('compiled-parity')) {
      required.push('compiled-parity');
      await fs.writeFile(path.join(candidate.stagingDir, 'upstream.lock.json'),
        serializeDeepSeekManifest(candidate.manifest));
    }
  }
}

/**
 * Публикация повторно сверяет старый и новый снимки под отдельным writer lock.
 * Runtime/current не затрагивается; ошибка rename восстанавливает прежнее дерево.
 */
export async function publishDeepSeekSync(
  candidate: PreparedDeepSeekSync,
  dependencies: { runCompiledGate?: (candidate: PreparedDeepSeekSync) => Promise<void> } = {},
): Promise<void> {
  const vendorDir = path.resolve(candidate.vendorDir);

  await assertPlainPath(vendorDir);
  await fs.mkdir(path.dirname(vendorDir), { recursive: true });

  const lock = `${vendorDir}.sync-lock`;
  const replacement = await fs.mkdtemp(path.join(path.dirname(vendorDir), '.deepseek-publish-'));
  const backup = path.join(replacement, 'previous');
  let locked = false;
  let previousMoved = false;
  let published = false;

  try {
    await fs.mkdir(lock);
    locked = true;

    const previous = await previousSnapshot(vendorDir);
    const hash = previous ? sha256(JSON.stringify(previous)) : null;

    if (hash !== candidate.previousManifestHash) {
      throw new Error('Снимок изменился после подготовки candidate');
    }

    const prepared = await verifyDeepSeekSnapshot(candidate.stagingDir);

    if (JSON.stringify(prepared) !== JSON.stringify(candidate.manifest)) {
      throw new Error('Manifest candidate изменён после подготовки');
    }

    await checkDeepSeekPatches(candidate.stagingDir, path.join(replacement, 'patch-check'));
    await runAvailableGates(candidate, dependencies.runCompiledGate);

    const next = path.join(replacement, 'next');

    await fs.cp(candidate.stagingDir, next, { recursive: true });
    await verifyDeepSeekSnapshot(next);

    const rechecked = await previousSnapshot(vendorDir);

    if ((rechecked ? sha256(JSON.stringify(rechecked)) : null) !== candidate.previousManifestHash) {
      throw new Error('Снимок изменился во время gate');
    }

    if (previous) {
      await fs.rename(vendorDir, backup);
      previousMoved = true;
    }

    try {
      await fs.rename(next, vendorDir);
      published = true;
    } catch (error) {
      if (previous) {
        await fs.rename(backup, vendorDir);
        previousMoved = false;
      }

      throw error;
    }
  } finally {
    if (locked) {
      await fs.rmdir(lock);
    }

    if (!previousMoved || published) {
      await fs.rm(replacement, { recursive: true, force: true });
    }
  }
}
