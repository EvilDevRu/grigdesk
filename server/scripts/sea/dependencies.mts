import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { sha256File } from '../../../shared/node/hash.ts';
import { readNodeRuntime } from '../../../shared/node/nodeRuntime.ts';
import type { NodeRuntime } from '../../../shared/node/nodeRuntime.ts';

const execute = promisify(execFile);

export interface DependencyReport {
  node: string;
  abi: string;
  packages: Record<string, string>;
  native: string[];
}

export interface LicenseIndex {
  packages: Array<{
    name: string;
    version: string;
    license: string;
    files: string[];
    source?: string;
  }>;
}

/**
 * Раскрывает весь официальный runtime вместе с npm, заголовками и лицензиями.
 * SHA256 проверяется до tar; сеть и установленный Node источником байтов не служат.
 */
export async function extractRuntime(input: {
  archive: string;
  runtime: NodeRuntime;
  target: string;
}): Promise<void> {
  const runtime = readNodeRuntime(input.runtime, 'server runtime');

  if (await sha256File(input.archive) !== runtime.sha256) {
    throw new Error(`SHA256 архива Node не совпал: ${input.archive}`);
  }

  await mkdir(input.target, { recursive: true });
  await execute('tar', ['-xJf', input.archive, '-C', input.target, '--strip-components=1']);
}

/**
 * Проверяет установленные библиотеки и каждый присутствующий native binding своим Node.
 * Отчёт содержит ABI фактически запущенного интерпретатора, а не ABI машины сборки.
 */
export async function probeDependencies(stageRoot: string): Promise<DependencyReport> {
  const probe = fileURLToPath(new URL('./dependencyProbe.mts', import.meta.url));
  const result = await execute(path.join(stageRoot, 'runtime/node/bin/node'), [probe, stageRoot], {
    cwd: '/',
    env: { PATH: '/usr/bin:/bin' },
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });

  return JSON.parse(result.stdout) as DependencyReport;
}

/**
 * Удаляет промежуточные файлы node-gyp, сохраняя только загружаемые Release/*.node.
 * Обычные JS-каталоги build не затрагиваются; ELF лишается отладочных путей компилятора.
 */
export async function cleanNativeBuilds(stageRoot: string): Promise<void> {
  /**
   * Распознаёт node-gyp по config.gypi и не следует символическим ссылкам.
   * Объектные копии binding в obj.target не нужны загрузчику и удаляются вместе с Makefile.
   */
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return [];
        }

        throw error;
      },
    );

    if (path.basename(directory) === 'build' && entries.some((entry) => entry.name === 'config.gypi')) {
      for (const entry of entries) {
        if (entry.name !== 'Release') {
          await rm(path.join(directory, entry.name), { recursive: true, force: true });
        }
      }

      const release = path.join(directory, 'Release');
      const outputs = await readdir(release, { withFileTypes: true }).catch(() => []);

      for (const output of outputs) {
        const file = path.join(release, output.name);

        if (output.isFile() && output.name.endsWith('.node')) {
          if ((await readFile(file)).subarray(0, 4).equals(Buffer.from('\x7fELF'))) {
            await execute('strip', ['--strip-debug', file]);
          }
        } else {
          await rm(file, { recursive: true, force: true });
        }
      }

      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        await visit(path.join(directory, entry.name));
      }
    }
  }

  await visit(path.join(stageRoot, 'server/node_modules'));
}

/**
 * Собирает поставляемые npm-пакеты по структуре node_modules, включая вложенные.
 * Произвольные package.json внутри ресурсов библиотеки пакетами не считаются.
 */
async function dependencyDirectories(directory: string, boundary: string): Promise<string[]> {
  const packages: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  });

  for (const entry of entries) {
    if (entry.name.startsWith('.') || !entry.isDirectory()) {
      continue;
    }

    const packageDirectory = path.join(directory, entry.name);
    const physical = await realpath(packageDirectory);

    if (!physical.startsWith(`${boundary}${path.sep}`)) {
      throw new Error(`Пакет ссылается за пределы staging: ${packageDirectory}`);
    }

    if (entry.name.startsWith('@')) {
      packages.push(...await dependencyDirectories(packageDirectory, boundary));
    } else {
      packages.push(packageDirectory);
      packages.push(...await dependencyDirectories(path.join(packageDirectory, 'node_modules'), boundary));
    }
  }

  return packages;
}

/**
 * Копирует полные тексты лицензий production-библиотек и npm с индексом состава.
 * SPDX в package.json без текста лицензии не считается завершённой поставкой.
 */
export async function collectLicenses(stageRoot: string,
  options: { fallbackFile?: string } = {}): Promise<LicenseIndex> {
  const boundary = await realpath(stageRoot);
  const directory = path.join(stageRoot, 'licenses');

  await mkdir(directory, { recursive: true });
  await copyFile(path.join(stageRoot, 'runtime/node/LICENSE'), path.join(directory, 'NODE.txt'));

  const packages = await dependencyDirectories(path.join(stageRoot, 'server/node_modules'), boundary);
  const npmDirectory = path.join(stageRoot, 'runtime/node/lib/node_modules/npm');

  if (await lstat(path.join(npmDirectory, 'package.json')).catch(() => null)) {
    packages.push(npmDirectory);
    packages.push(...await dependencyDirectories(path.join(npmDirectory, 'node_modules'), boundary));
  }

  const index: LicenseIndex = { packages: [] };

  for (const packageDirectory of packages.sort()) {
    const manifest = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      license?: string;
    };
    const texts = (await readdir(packageDirectory)).filter((name) => (
      /^(licen[cs]e|copying)([.-]|$)/i.test(name)
    ));

    const files: string[] = [];
    const destination = path.join(directory, 'npm',
      `${manifest.name.replaceAll('/', '__')}@${manifest.version}`);
    let licenseSource: string | undefined;

    await mkdir(destination, { recursive: true });

    if (texts.length === 0) {
      const fallbackFile = options.fallbackFile ?? fileURLToPath(
        new URL('../../build/licenses/npm-fallbacks.json', import.meta.url),
      );
      const fallback = JSON.parse(await readFile(fallbackFile, 'utf8').catch(() => '{"packages":[]}')) as {
        packages: Array<{
          name: string;
          version: string;
          license: string;
          file: string;
          sha256: string;
          source: string;
        }>;
      };
      const entry = fallback.packages.find((item) => item.name === manifest.name
        && item.version === manifest.version && item.license === manifest.license);

      if (!entry || entry.file !== path.basename(entry.file)) {
        throw new Error(`Нет текста лицензии пакета ${manifest.name}@${manifest.version}`);
      }

      const source = path.join(path.dirname(fallbackFile), entry.file);

      if (await sha256File(source) !== entry.sha256) {
        throw new Error(`SHA256 текста лицензии не совпал: ${entry.file}`);
      }

      await copyFile(source, path.join(destination, 'LICENSE.txt'));
      await copyFile(path.join(packageDirectory, 'package.json'), path.join(destination, 'PACKAGE.json'));
      files.push(path.relative(stageRoot, path.join(destination, 'LICENSE.txt')));
      files.push(path.relative(stageRoot, path.join(destination, 'PACKAGE.json')));
      licenseSource = entry.source;
    }

    for (const text of texts.sort()) {
      const target = path.join(destination, text);

      await copyFile(path.join(packageDirectory, text), target);
      files.push(path.relative(stageRoot, target).split(path.sep).join('/'));
    }

    index.packages.push({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license ?? 'SEE INCLUDED LICENSE',
      files,
      ...(licenseSource ? { source: licenseSource } : {}),
    });
  }

  await writeFile(path.join(directory, 'THIRD-PARTY.json'), JSON.stringify(index, null, 2) + '\n');

  return index;
}

export interface InstallDependenciesInput {
  sourceRoot: string;
  stageRoot: string;
  cacheDir: string;
  run?: (file: string, args: string[], options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer: number;
  }) => Promise<unknown>;
}

/**
 * Собирает внешние импорты runtime из AST, пропуская type-only декларации.
 * Поиск ограничен явно переданными каталогами продукта; сборочные инструменты не входят.
 */
export async function runtimeSpecifiers(root: string, directories: readonly string[]): Promise<string[]> {
  const specifiers = new Set<string>();

  /**
   * Учитывает пакеты по имени npm, а builtin и относительные пути исключает.
   * Подпуть scoped-пакета относится к его исходной записи dependencies.
   */
  function record(specifier: string): void {
    if (specifier.startsWith('.') || specifier.startsWith('/') || isBuiltin(specifier)) {
      return;
    }

    const parts = specifier.split('/');

    specifiers.add(parts.slice(0, specifier.startsWith('@') ? 2 : 1).join('/'));
  }

  /**
   * Находит статические импорты и обычный require/import с литеральным пакетом.
   * Комментарии и строки с похожим текстом не становятся зависимостями.
   */
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const onlyTypes = clause?.isTypeOnly || (!clause?.name && bindings
        && ts.isNamedImports(bindings) && bindings.elements.length > 0
        && bindings.elements.every((binding) => binding.isTypeOnly));

      if (!onlyTypes) {
        record(node.moduleSpecifier.text);
      }
    }

    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      record(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  }

  /**
   * Обходит собственные исходники без node_modules, кэшей и данных.
   * Каждый файл разбирается независимо, код при проверке не исполняется.
   */
  async function scan(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);

      if (entry.isDirectory() && !['node_modules', '.git', '.cache'].includes(entry.name)) {
        await scan(file);
      } else if (entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name)) {
        visit(ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true));
      }
    }
  }

  for (const directory of directories) {
    await scan(path.join(root, directory));
  }

  return [...specifiers].sort();
}

/**
 * Прямой импорт пакета требует прямой production dependency.
 * Случайная транзитивная установка или devDependency контракт поставки не заменяет.
 */
export function assertRuntimeDependencies(manifest: { dependencies?: Record<string, string> },
  specifiers: readonly string[]): void {
  const missing = specifiers.filter((name) => !Object.hasOwn(manifest.dependencies ?? {}, name));

  if (missing.length > 0) {
    throw new Error(`Не объявлены runtime dependencies: ${missing.join(', ')}`);
  }
}

/**
 * Выполняет production npm ci в отдельном staging закреплённым Node/npm.
 * Cache, HOME и npm config вынесены за R; native сборки используют заголовки своего Node.
 */
export async function installDependencies(input: InstallDependenciesInput): Promise<void> {
  const source = path.resolve(input.sourceRoot);
  const stage = path.resolve(input.stageRoot);
  const cache = path.resolve(input.cacheDir);

  if (stage === source || source.startsWith(`${stage}${path.sep}`)
    || stage.startsWith(path.join(source, 'server/node_modules') + path.sep)
    || stage === path.join(source, 'server/node_modules')
    || stage === path.join(source, 'server')) {
    throw new Error('Для dependencies нужен отдельный staging');
  }

  if (cache === stage || cache.startsWith(`${stage}${path.sep}`)) {
    throw new Error('npm cache должен находиться за пределами staging');
  }

  const server = path.join(stage, 'server');
  const runtime = path.join(stage, 'runtime/node');

  await mkdir(server, { recursive: true });
  await mkdir(input.cacheDir, { recursive: true });
  await mkdir(path.join(input.cacheDir, 'build-home'), { recursive: true });
  await writeFile(path.join(input.cacheDir, 'build-home/global.npmrc'), '');

  for (const file of ['package.json', 'package-lock.json']) {
    await copyFile(path.join(source, 'server', file), path.join(server, file));
  }

  const manifestFile = path.join(server, 'package.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));

  manifest.allowScripts = {
    'cpu-features@0.0.10': true,
    'ssh2@1.17.0': true,
  };
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

  const compilerFlags = [
    `-ffile-prefix-map=${source}=/grigdesk-source`,
    `-ffile-prefix-map=${cache}=/grigdesk-build`,
    `-ffile-prefix-map=${stage}=/grigdesk-release`,
    '-g0',
  ].join(' ');

  await (input.run ?? execute)(path.join(runtime, 'bin/node'), [
    path.join(runtime, 'lib/node_modules/npm/bin/npm-cli.js'),
    'ci', '--omit=dev', '--prefer-offline', '--no-audit', '--no-fund',
  ], {
    cwd: server,
    env: {
      PATH: `${path.join(runtime, 'bin')}:/usr/bin:/bin`,
      HOME: path.join(input.cacheDir, 'build-home'),
      NODE_ENV: 'production',
      PYTHONDONTWRITEBYTECODE: '1',
      CFLAGS: compilerFlags,
      CXXFLAGS: compilerFlags,
      npm_config_cache: path.resolve(input.cacheDir),
      npm_config_userconfig: '/dev/null',
      npm_config_globalconfig: path.join(input.cacheDir, 'build-home/global.npmrc'),
      npm_config_nodedir: runtime,
      npm_config_fetch_retries: '2',
      npm_config_fetch_retry_mintimeout: '30000',
      npm_config_fetch_retry_maxtimeout: '30000',
      npm_config_fetch_timeout: '30000',
    },
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
  });
}
