import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { assertRuntimeClosure } from './runtimeComposition.ts';
import type { ClosureRequirement, WorkspacePackage } from './runtimeComposition.ts';

const requireBuild = createRequire(new URL('./deepseek-build/package.json', import.meta.url));

export interface DynamicRuntimeReference {
  file: string;
  expression: string;
}

export interface LockedExternalDependency {
  name: string;
  version: string;
  integrity: string;
}

/**
 * Зависимости модельного плагина берутся из разрешённых записей upstream lock.
 * Диапазоны версий и отсутствующая integrity не становятся входами сборки.
 */
export function llmPiAiExternalDependencies(lock: Record<string, any>): LockedExternalDependency[] {
  const importer = lock.importers?.['packages/llm/llm-pi-ai'];
  const roots = Object.entries(importer?.dependencies ?? {}) as [string, { version: string }][];
  const queue = roots.filter(([, entry]) => !entry.version.startsWith('link:'))
    .map(([name, entry]) => [name, entry.version] as const);
  const visited = new Set<string>();
  const resolved = new Map<string, LockedExternalDependency>();

  if (queue.length === 0) {
    throw new Error('В upstream lock отсутствуют внешние зависимости llm-pi-ai');
  }

  for (let offset = 0; offset < queue.length; offset += 1) {
    const [name, reference] = queue[offset]!;
    const snapshotId = `${name}@${reference}`;

    if (visited.has(snapshotId)) {
      continue;
    }

    visited.add(snapshotId);

    const version = reference.split('(')[0]!;
    const packageId = `${name}@${version}`;
    const snapshot = lock.snapshots?.[snapshotId];
    const declaration = lock.packages?.[packageId];
    const integrity = declaration?.resolution?.integrity;

    if (!snapshot) {
      throw new Error(`Отсутствует upstream snapshot: ${snapshotId}`);
    }

    if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(version)
      || typeof integrity !== 'string' || !/^sha(?:256|384|512)-[A-Za-z0-9+/]+=*$/u.test(integrity)) {
      throw new Error(`Отсутствует exact версия или integrity: ${packageId}`);
    }

    if (declaration.requiresBuild || snapshot.requiresBuild) {
      throw new Error(`Замыкание llm-pi-ai требует нативной сборки: ${packageId}`);
    }

    resolved.set(packageId, {
      name,
      version,
      integrity,
    });

    const children = { ...snapshot.dependencies, ...snapshot.optionalDependencies };

    for (const [child, childReference] of Object.entries(children)) {
      if (typeof childReference !== 'string' || childReference.startsWith('link:')) {
        throw new Error(`Некорректная внешняя зависимость ${snapshotId}: ${child}`);
      }

      queue.push([child, childReference]);
    }
  }

  return [...resolved.values()].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, 'en'));
}

/**
 * AST проверяет dynamic import и createRequire-пути в реальных host-входах.
 * Browser face не участвует, а новая неизвестная ссылка должна получить отдельное обоснование.
 */
export async function scanDynamicRuntimeReferences(
  sourceDir: string,
  packages: readonly WorkspacePackage[],
  externalRoots: readonly string[] = [],
): Promise<DynamicRuntimeReference[]> {
  const ts = requireBuild('typescript');
  const output: DynamicRuntimeReference[] = [];
  const filenames = new Set<string>();

  for (const item of packages) {
    const host = path.join(sourceDir, item.root, 'tsconfig.host.json');
    const ordinary = path.join(sourceDir, item.root, 'tsconfig.json');
    const config = await fs.access(host).then(() => host, () => ordinary);

    if (!(await fs.access(config).then(() => true, () => false))) {
      continue;
    }

    const read = ts.readConfigFile(config, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(config));

    for (const filename of parsed.fileNames) {
      filenames.add(filename);
    }
  }

  /**
   * Внешний JS-пакет не имеет host tsconfig, поэтому его runtime-файлы обходятся явно.
   * Проверяется весь dist, включая ленивые загрузчики остальных shipped providers.
   */
  const collectExternalFiles = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await collectExternalFiles(filename);
      } else if (entry.isFile() && /\.[cm]?js$/u.test(entry.name)) {
        filenames.add(filename);
      }
    }
  };

  for (const relative of externalRoots) {
    await collectExternalFiles(path.join(sourceDir, relative));
  }

  for (const filename of filenames) {
    const content = await fs.readFile(filename, 'utf8');
    const source = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true);

    /**
     * Только динамические загрузчики требуют явной таблицы разрешения.
     * Статические импорты проверяет компилятор и Node при compiled smoke.
     */
    const visit = (node: any): void => {
      if (ts.isCallExpression(node) && node.arguments.length > 0) {
        const callee = node.expression.getText(source);
        const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword
          || callee === 'require' || callee === 'require.resolve' || callee === 'import.meta.resolve';

        if (dynamic && !ts.isStringLiteralLike(node.arguments[0])) {
          output.push({
            file: path.relative(sourceDir, filename).split(path.sep).join('/'),
            expression: node.getText(source),
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  return output.sort((a, b) => `${a.file}:${a.expression}`.localeCompare(`${b.file}:${b.expression}`));
}

/**
 * Каждая нелитеральная загрузка разрешается конкретной записью с причиной.
 * Новая ссылка upstream не наследует разрешение только из имени пакета.
 */
export function assertKnownDynamicReferences(
  references: readonly DynamicRuntimeReference[],
  known: readonly (DynamicRuntimeReference & { reason: string })[],
): void {
  const missing = references.filter((reference) => !known.some((entry) => entry.file === reference.file
    && entry.expression === reference.expression && entry.reason.trim().length > 0));

  if (missing.length > 0) {
    const diagnostics = missing.map(({ file, expression }) => `${file}: неизвестный dynamic ${expression}`);

    throw new Error(diagnostics.join('\n'));
  }
}

/**
 * Generated exports и native worker-файлы проверяются после компиляции, до упаковки.
 * Gate перечисляет все отсутствующие ресурсы, вместо первого позднего import failure.
 */
export async function verifyCompiledResources(
  root: string,
  packages: readonly WorkspacePackage[],
): Promise<void> {
  const requirements: ClosureRequirement[] = [];

  for (const item of packages) {
    /**
     * Host exports содержат также runtime-safe types.js и generated reflection.
     * Browser exports исключены выбранной композицией и не являются host capability.
     */
    const inspect = (value: any): void => {
      if (typeof value === 'string' && value.startsWith('./lib/')
        && /\.[cm]?js$/u.test(value) && !value.includes('*')
        && (!value.includes('client') || value.includes('remote-client'))) {
        requirements.push({
          owner: item.name,
          kind: value.includes('typert') ? 'generated' : 'dependency',
          target: path.posix.join(item.root, value),
        });
      } else if (value && typeof value === 'object') {
        for (const child of Object.values(value)) {
          inspect(child);
        }
      }
    };

    inspect(item.manifest.exports);

    if (['@deepseek-ai/dsh-code-runtime-worker-thread',
      '@deepseek-ai/dsh-workflow-worker-thread'].includes(item.name)) {
      requirements.push({
        owner: item.name,
        kind: 'generated',
        target: `${item.root}/lib/worker.cjs`,
      });
    }
  }

  const report = process.report!.getReport() as { header: { glibcVersionRuntime?: string } };
  const filename = process.platform === 'linux'
    ? `${report.header.glibcVersionRuntime ? 'glibc' : 'musl'}/system.node`
    : 'system.node';

  requirements.push({
    owner: '@deepseek-ai/node-addon-system',
    kind: 'native',
    target: `native/system/packages/${process.platform}-${process.arch}/bin/${filename}`,
  });

  const available = new Set<string>();

  for (const requirement of requirements) {
    if (await fs.access(path.join(root, requirement.target)).then(() => true, () => false)) {
      available.add(requirement.target);
    }
  }

  assertRuntimeClosure(available, requirements);
}
