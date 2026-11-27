import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { VendorSelection } from './deepseekVendorManifest.ts';

export interface ClosureRequirement {
  owner: string;
  kind: 'dependency' | 'peer' | 'yaml' | 'generated' | 'native' | 'dynamic';
  target: string;
}

/**
 * Проверка замыкания сообщает все отсутствующие входы одним отказом.
 * Динамическая ссылка допускается только при явно доказанном разрешении.
 */
export function assertRuntimeClosure(
  available: ReadonlySet<string>,
  requirements: readonly ClosureRequirement[],
): void {
  const missing = requirements.filter((requirement) => !available.has(requirement.target));

  if (missing.length > 0) {
    throw new Error(missing.map(({ owner, kind, target }) => `${owner}: ${kind} → ${target}`).join('\n'));
  }
}

export const COMPOSITION_REVISION = 'grigdesk-host-web-acp-v5';

export const RUNTIME_WORKER_PACKAGES: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-session-persistence-jsonl',
]);

export const HOST_OVERLAY_PACKAGES = [
  '@deepseek-ai/dsh-hooks-claude-code',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-llm-pi-ai',
] as const;

const OMITTED_BUNDLE_PACKAGES = new Set([
  '@deepseek-ai/dsh-web-frontend',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-resources',
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-hmr',
  '@deepseek-ai/dsh-cordis-client-runner',
  '@deepseek-ai/dsh-host-directory-picker-auto',
  '@deepseek-ai/dsh-host-directory-picker-native',
  '@deepseek-ai/dsh-message-quotes',
]);

/**
 * YAML сохраняет upstream !!js как данные; выражения здесь не исполняются.
 * Удаляется browser roster, а серверные dual-face пакеты остаются в замыкании.
 */
export function runtimeYaml(dependencyDirectory?: string): any {
  const requireBuild = createRequire(dependencyDirectory
    ? path.join(dependencyDirectory, 'package.json')
    : new URL('../build/runtime-deps/package.json', import.meta.url));
  const yaml = requireBuild('js-yaml');
  const expression = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    construct: (value: string) => ({ __jsExpr: value }),
    predicate: (value: any) => typeof value?.__jsExpr === 'string',
    represent: (value: any) => value.__jsExpr,
  });

  return {
    load: (value: string) => yaml.load(value, { schema: yaml.JSON_SCHEMA.extend(expression) }),
    dump: (value: unknown) => yaml.dump(value, { schema: yaml.JSON_SCHEMA.extend(expression) }),
  };
}

function omitBundlePackage(name: string): boolean {
  return name.startsWith('@deepseek-ai/dsh-client-ui-') || OMITTED_BUNDLE_PACKAGES.has(name);
}

/**
 * Поддерживает одиночный слой и список из manifest пакета в порядке объявления.
 * Имя ресурса разрешается внутри своего bundle, поэтому manifest не читает соседние файлы.
 */
async function bundlePatchFiles(directory: string): Promise<string[]> {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  const patch = manifest.dsh?.bundle?.patch ?? './cordis.patch.yml';
  const files = Array.isArray(patch) ? patch : [patch];

  if (!files.length || files.some((file) => typeof file !== 'string'
    || !/^(?:\.\/)?(?:[\w.-]+\/)*[\w.-]+\.ya?ml$/u.test(file) || file.split('/').includes('..'))) {
    throw new Error(`Некорректное объявление dsh.bundle.patch: ${directory}`);
  }

  return files;
}

/**
 * Host-проект выбирается так же, как при компиляции.
 * Пакет с одними ресурсами может обойтись без обоих проектов.
 */
async function hostProject(sourceDir: string, root: string) {
  for (const name of ['tsconfig.host.json', 'tsconfig.json']) {
    const file = path.posix.join(root, name);

    try {
      return { file, config: JSON.parse(await fs.readFile(path.join(sourceDir, file), 'utf8')) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return null;
}

/**
 * Закрытый GLM preset строится из единственной штатной декларации standard.
 * Сохраняем соседние пресеты и порядок слоёв, чтобы они не меняли поведение DeepSeek.
 */
function addGlmPreset(patches: any[]): void {
  const inserts = patches.filter((patch) => Array.isArray(patch.insert)).map((patch) => patch.insert);
  const rows = inserts.flat();

  if (!rows.some((row) => row.id === 'agent-preset-registry')) {
    return;
  }

  const standard = rows.filter((row) => row.id === 'preset-standard');

  if (standard.length !== 1 || standard[0].name !== '@deepseek-ai/dsh-agent-preset'
    || standard[0].config?.id !== 'standard' || !Array.isArray(standard[0].config.plugins)
    || rows.some((row) => row.id === 'preset-grigdesk-glm')) {
    throw new Error('Web bundle требует одну штатную декларацию preset-standard');
  }

  const original = standard[0];
  const insert = inserts.find((group) => group.includes(original));

  insert.splice(insert.indexOf(original) + 1, 0, {
    ...original,
    id: 'preset-grigdesk-glm',
    config: {
      ...original.config,
      id: 'grigdesk-glm',
      name: 'GLM GrigDesk',
      plugins: glmForegroundPreset(original.config.plugins),
    },
  });
}

/**
 * Композиция убирает browser roster и автоматически монтируемый pi-ai.
 * Его пакет доступен только явному overlay; исходный YAML остаётся неизменным.
 */
export async function readRuntimeComposition(
  sourceDir: string,
  dependencyDirectory?: string,
): Promise<Record<string, any[]>> {
  const yaml = runtimeYaml(dependencyDirectory);
  const layers: Record<string, any[]> = {};

  for (const bundle of ['base', 'web-app', 'acp-app']) {
    const directory = path.join(sourceDir, 'packages/bundle', bundle);
    const original = [];

    for (const file of await bundlePatchFiles(directory)) {
      const entries = yaml.load(await fs.readFile(path.join(directory, file), 'utf8'));

      if (!Array.isArray(entries)) {
        throw new Error(`Слой bundle не содержит список patches: ${bundle}/${file}`);
      }

      original.push(...entries);
    }

    layers[bundle] = original.map((patch: any) => {
      if (!Array.isArray(patch.insert)) {
        return patch;
      }

      const rows = patch.insert.map((row: any) => {
        if (row.name === '@deepseek-ai/dsh-host-directory-picker-auto') {
          return { ...row, name: '@deepseek-ai/dsh-host-directory-picker-browse' };
        }

        return row;
      });

      return { ...patch, insert: rows.filter((row: any) => !omitBundlePackage(row.name ?? '')) };
    });

    if (bundle === 'web-app') {
      addGlmPreset(layers[bundle]);
    }
  }

  return layers;
}

/**
 * Состав замыкается по manifests, peer, host-tsconfig и plugin-ресурсам presets.
 * Запись причины каждого включения позволяет проверять сокращение отдельно от сборки.
 */
export async function discoverRuntimeClosure(
  sourceDir: string,
  dependencyDirectory?: string,
): Promise<{
  packages: WorkspacePackage[];
  reasons: Record<string, string[]>;
  external: Record<string, Record<string, string>>;
}> {
  const index = await indexWorkspacePackages(sourceDir);
  const lockFile = await fs.readFile(path.join(sourceDir, 'pnpm-lock.yaml'), 'utf8');
  const lock = runtimeYaml(dependencyDirectory).load(lockFile);
  const layers = await readRuntimeComposition(sourceDir, dependencyDirectory);
  const queue: string[] = [];
  const reasons: Record<string, string[]> = {};
  const external: Record<string, Record<string, string>> = {};
  const packages = new Map<string, WorkspacePackage>();
  const byRoot = new Map([...index.values()].map((item) => [item.root, item]));

  /**
   * Имя plugin subpath разрешается к единственному workspace package.
   * Причины сохраняются даже для уже поставленного в очередь пакета.
   */
  const add = (name: string, reason: string): void => {
    const packageName = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]!;

    if (!index.has(packageName)) {
      throw new Error(`${reason}: отсутствует workspace package ${packageName}`);
    }

    if (!reasons[packageName]) {
      reasons[packageName] = [];
      queue.push(packageName);
    }

    if (!reasons[packageName]!.includes(reason)) {
      reasons[packageName]!.push(reason);
    }
  };
  /**
   * Имена plugins извлекаются из вложенных групп и patches без исполнения !!js.
   * Это учитывает presets, которые Loader монтирует только при создании сессии.
   */
  const addRows = (value: any, reason: string): void => {
    if (!value || typeof value !== 'object') {
      return;
    }

    if (typeof value.name === 'string' && value.name.startsWith('@deepseek-ai/')) {
      add(value.name, reason);
    }

    for (const child of Object.values(value)) {
      addRows(child, reason);
    }
  };

  addRows(layers, 'host YAML composition');

  for (const name of HOST_OVERLAY_PACKAGES) {
    add(name, 'GrigDesk server-owned overlay');
  }

  for (const name of ['base', 'web-app', 'acp-app', 'app-boot', 'cmdline',
    'launch-environment', 'http-proxy', 'typert-generator']) {
    add(`@deepseek-ai/dsh-${name}`, 'launcher / metadata compiler');
  }

  while (queue.length > 0) {
    const current = index.get(queue.shift()!)!;

    packages.set(current.name, current);

    const dependencies = {
      ...current.manifest.dependencies,
      ...current.manifest.peerDependencies,
      ...Object.fromEntries(Object.entries(current.manifest.devDependencies ?? {})
        .filter(([name]) => name.startsWith('@types/'))),
    };
    const importer = lock.importers[current.root];

    for (const [name, range] of Object.entries(dependencies)) {
      if (omitBundlePackage(name)) {
        continue;
      }

      const entry = importer?.dependencies?.[name] ?? importer?.devDependencies?.[name];
      const reference = entry?.version;

      if (typeof reference === 'string' && reference.startsWith('link:')) {
        const root = path.posix.normalize(path.posix.join(current.root, reference.slice(5)));
        const linked = byRoot.get(root);

        if (!linked || linked.name !== name) {
          throw new Error(`${current.name}: неверная workspace link для ${name}`);
        }

        add(linked.name, `${current.name}: pnpm workspace link`);
      } else if (index.has(name)) {
        add(name, `${current.name}: dependency/peer`);
      } else {
        const version = reference?.split('(')[0];

        if (!version) {
          throw new Error(`${current.name}: нет exact lock для ${name} ${range}`);
        }

        external[current.name] ??= {};
        external[current.name]![name] = version;
      }
    }

    if (current.name === '@deepseek-ai/node-addon-system') {
      for (const target of ['linux-x64', 'linux-arm64', 'darwin-arm64']) {
        add(`@deepseek-ai/node-addon-system-${target}`, 'native host addon');
      }
    }

    const project = await hostProject(sourceDir, current.root);

    for (const reference of project?.config.references ?? []) {
      const target = path.resolve(sourceDir, current.root, reference.path);

      if (path.basename(target) === 'tsconfig.client.json') {
        continue;
      }

      const targetRoot = target.endsWith('.json') ? path.dirname(target) : target;
      const relative = path.relative(sourceDir, targetRoot);
      const targetPackage = byRoot.get(relative);

      if (targetPackage && (!omitBundlePackage(targetPackage.name)
        || target.endsWith('tsconfig.host.json'))) {
        add(targetPackage.name, `${current.name}: host type reference`);
      }
    }
  }

  return {
    packages: [...packages.values()].sort((a, b) => a.root.localeCompare(b.root)),
    reasons,
    external,
  };
}

/**
 * Перечисляет каталоги компиляции и каждый унаследованный tsconfig в source snapshot.
 * Обход повторяется для полного upstream tree перед подготовкой candidate.
 */
export async function discoverRuntimeSelection(
  sourceDir: string,
  dependencyDirectory?: string,
): Promise<VendorSelection> {
  const requireBuild = createRequire(dependencyDirectory
    ? path.join(dependencyDirectory, 'package.json')
    : new URL('../build/runtime-deps/package.json', import.meta.url));
  const ts = requireBuild('typescript');
  const closure = await discoverRuntimeClosure(sourceDir, dependencyDirectory);
  const roots = new Map(closure.packages.map(({ root, name }) => [root, closure.reasons[name]!.join('; ')]));
  const visited = new Set<string>();

  /**
   * Extends разрешается относительно содержащего проекта и удерживается внутри source tree.
   * В selection попадают и родительские конфиги вложенных workspace-пакетов.
   */
  const includeConfig = async (file: string, config?: any): Promise<void> => {
    if (visited.has(file)) {
      return;
    }

    visited.add(file);

    const parsed = config === undefined
      ? ts.parseConfigFileTextToJson(file, await fs.readFile(path.join(sourceDir, file), 'utf8'))
      : { config };

    if (parsed.error) {
      throw new Error(`Не удалось прочитать tsconfig ${file}: ${parsed.error.messageText}`);
    }

    roots.set(file, 'Конфигурация TypeScript для host runtime');

    for (const spec of [parsed.config.extends ?? []].flat()) {
      if (typeof spec !== 'string' || !spec.startsWith('.')) {
        throw new Error(`Неизвестный tsconfig extends: ${file}`);
      }

      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));

      if (target.startsWith('../') || !target.endsWith('.json')) {
        throw new Error(`Неизвестный tsconfig extends: ${file}`);
      }

      await includeConfig(target);
    }
  };

  for (const { root } of closure.packages) {
    const project = await hostProject(sourceDir, root);

    if (project) {
      await includeConfig(project.file, project.config);
    }
  }

  roots.set('native/system', 'Исходники и скрипт сборки нативного модуля для трёх целей');
  roots.set('pnpm-workspace.yaml', 'Опись workspace и патчей внешних пакетов');

  const workspace = runtimeYaml(dependencyDirectory).load(await fs.readFile(
    path.join(sourceDir, 'pnpm-workspace.yaml'), 'utf8',
  ));

  for (const patch of Object.values<string>(workspace.patchedDependencies ?? {})) {
    if (!/^patches\/[\w@.-]+\.patch$/u.test(patch)) {
      throw new Error('Некорректное имя патча внешней зависимости');
    }

    roots.set(patch, 'Патч внешней зависимости из pnpm-workspace.yaml');
  }

  const files = [...roots.keys()].sort();
  const selected = files.filter((file) => !files
    .some((parent) => file.startsWith(parent + '/')));

  return {
    roots: selected.map((file) => ({
      path: file,
      reason: roots.get(file)!,
    })),
    versionFile: 'package.json',
    dependencyLockPath: 'pnpm-lock.yaml',
  };
}

export interface WorkspacePackage {
  name: string;
  root: string;
  manifest: Record<string, any>;
}

/**
 * Индекс включает исходные workspace-пакеты без npm и без чтения частного home.
 * Повтор имени запрещён: иначе provenance зависел бы от порядка обхода.
 */
export async function indexWorkspacePackages(sourceDir: string): Promise<Map<string, WorkspacePackage>> {
  const result = new Map<string, WorkspacePackage>();

  /**
   * Рекурсивный обход сохраняет исходные относительные пути каждого package.
   * Installed dependencies и test fixtures не становятся workspace packages.
   */
  const visit = async (relative: string): Promise<void> => {
    const absolute = path.join(sourceDir, relative);
    const entries = await fs.readdir(absolute, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === 'package.json') {
        const manifest = JSON.parse(await fs.readFile(path.join(absolute, entry.name), 'utf8'));

        if (typeof manifest.name === 'string') {
          if (result.has(manifest.name)) {
            throw new Error(`Повтор workspace package: ${manifest.name}`);
          }

          result.set(manifest.name, {
            name: manifest.name,
            root: relative,
            manifest,
          });
        }
      }

      if (entry.isDirectory() && !['node_modules', 'tests', 'test', '.git'].includes(entry.name)) {
        await visit(path.join(relative, entry.name));
      }
    }
  };

  for (const root of ['vendor', 'packages', 'native/system']) {
    try {
      await visit(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return result;
}

/**
 * Копия закреплённого standard меняет только foreground-контракт делегирования GLM.
 * Точная пара строк обязательна: изменение upstream не должно молча вернуть фон.
 */
export function glmForegroundPreset(rows: any[]): any[] {
  let count = 0;

  /**
   * Сохраняет дерево закреплённого preset и заменяет только два известных инструмента.
   * Копирование исключает изменение standard для остальных потребителей runtime.
   */
  const visit = (row: any): any => {
    if (!row || typeof row !== 'object') {
      return row;
    }

    if (Array.isArray(row)) {
      return row.map(visit);
    }

    const next = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, visit(value)]));

    if (['tool-subagent', 'tool-subagent-fork'].includes(row.id)) {
      count += 1;
      next.config = {
        ...row.config,
        modelSelection: false,
        modelDiscovery: false,
        grigdeskForeground: true,
        maxDepth: 3,
      };
    }

    return next;
  };
  const result = visit(rows);

  if (count !== 2) {
    throw new Error('GLM preset требует ровно spawn и fork закреплённого standard');
  }

  return result;
}
