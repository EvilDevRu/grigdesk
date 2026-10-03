import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

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

const requireBuild = createRequire(new URL('./deepseek-build/package.json', import.meta.url));

export const COMPOSITION_REVISION = 'cockpit-host-web-acp-v3';

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
]);

/**
 * YAML сохраняет upstream !!js как данные; выражения здесь не исполняются.
 * Удаляется browser roster, а серверные dual-face пакеты остаются в замыкании.
 */
export function runtimeYaml(): any {
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
 * Композиция убирает browser roster и автоматически монтируемый pi-ai.
 * Его пакет доступен только явному overlay; исходный YAML остаётся неизменным.
 */
export async function readRuntimeComposition(sourceDir: string): Promise<Record<string, any[]>> {
  const yaml = runtimeYaml();
  const layers: Record<string, any[]> = {};

  for (const bundle of ['base', 'web-app', 'acp-app']) {
    const original = yaml.load(await fs.readFile(
      path.join(sourceDir, `packages/bundle/${bundle}/cordis.patch.yml`), 'utf8',
    ));

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
  }

  return layers;
}

/**
 * Состав замыкается по manifests, peer, host-tsconfig и plugin-ресурсам presets.
 * Запись причины каждого включения позволяет проверять сокращение отдельно от сборки.
 */
export async function discoverRuntimeClosure(sourceDir: string): Promise<{
  packages: WorkspacePackage[];
  reasons: Record<string, string[]>;
  external: Record<string, Record<string, string>>;
}> {
  const index = await indexWorkspacePackages(sourceDir);
  const lock = runtimeYaml().load(await fs.readFile(path.join(sourceDir, 'pnpm-lock.yaml'), 'utf8'));
  const layers = await readRuntimeComposition(sourceDir);
  const queue: string[] = [];
  const reasons: Record<string, string[]> = {};
  const external: Record<string, Record<string, string>> = {};
  const packages = new Map<string, WorkspacePackage>();

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
    add(name, 'Cockpit server-owned overlay');
  }

  for (const name of ['base', 'web-app', 'acp-app', 'app-boot', 'cmdline',
    'launch-environment', 'http-proxy', 'typert-generator']) {
    add(`@deepseek-ai/dsh-${name}`, 'launcher / metadata compiler');
  }

  while (queue.length > 0) {
    const current = index.get(queue.shift()!)!;

    packages.set(current.name, current);

    const dependencies = { ...current.manifest.dependencies, ...current.manifest.peerDependencies };

    for (const [name, range] of Object.entries(dependencies)) {
      if (current.root.startsWith('packages/bundle/') && omitBundlePackage(name)) {
        continue;
      }

      if (index.has(name)) {
        add(name, `${current.name}: dependency/peer`);
      } else {
        const importer = lock.importers[current.root];
        const entry = importer?.dependencies?.[name] ?? importer?.devDependencies?.[name];
        const version = entry?.version?.split('(')[0];

        if (!version || version.startsWith('link:')) {
          throw new Error(`${current.name}: нет exact lock для ${name} ${range}`);
        }

        external[current.name] ??= {};
        external[current.name]![name] = version;
      }
    }

    if (current.name === '@deepseek-ai/node-addon-system') {
      add(`@deepseek-ai/node-addon-system-${process.platform}-${process.arch}`, 'native host addon');
    }

    const configPath = path.join(sourceDir, current.root, 'tsconfig.host.json');
    const fallback = path.join(sourceDir, current.root, 'tsconfig.json');
    let config: any;

    try {
      config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }

      try {
        config = JSON.parse(await fs.readFile(fallback, 'utf8'));
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw fallbackError;
        }
      }
    }

    for (const reference of config?.references ?? []) {
      const target = path.resolve(sourceDir, current.root, reference.path);
      const targetRoot = target.endsWith('.json') ? path.dirname(target) : target;
      const relative = path.relative(sourceDir, targetRoot);
      const targetPackage = [...index.values()].find((item) => item.root === relative);

      if (targetPackage && !omitBundlePackage(targetPackage.name)) {
        add(targetPackage.name, `${current.name}: host type reference`);
      }
    }

    if (current.name === '@deepseek-ai/dsh-agent-presets') {
      for (const preset of ['standard', 'minimal', 'cordis', 'ptc']) {
        const resource = `presets/${preset}/agent.cordis.yml`;

        addRows(runtimeYaml().load(await fs.readFile(
          path.join(sourceDir, current.root, resource), 'utf8',
        )), `${current.name}: ${resource}`);
      }
    }
  }

  return {
    packages: [...packages.values()].sort((a, b) => a.root.localeCompare(b.root)),
    reasons,
    external,
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
