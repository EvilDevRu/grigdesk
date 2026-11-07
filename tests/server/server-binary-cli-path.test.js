import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildServerEnv } from '../../desktop/src/runtimeConfig.ts';
import { packagedLaunchEnvironment } from '../../server/src/lib/seaLaunch.ts';
import { discoverUserCliDirectories, userCliPath } from '../../shared/node/userCliPaths.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('SB08: user Node раньше bundled Node без дублей/поиска в cwd', () => {
  const result = userCliPath({
    installationBin: '/I/bin',
    bundledNode: '/R/runtime/node/bin/node',
    explicit: ['/user/node/bin'],
    saved: ['/user/node/bin'],
    defaults: ['/home/user/.local/bin'],
    inherited: '/usr/bin:/R/runtime/node/bin:.:',
    discovered: ['/home/user/.nvm/versions/node/v24.21.0/bin'],
  });

  assert.deepEqual(result.split(':'), [
    '/I/bin', '/user/node/bin', '/home/user/.local/bin', '/usr/bin',
    '/home/user/.nvm/versions/node/v24.21.0/bin', '/R/runtime/node/bin',
  ]);
});

/**
 * Одноразовый HOME с несколькими версиями nvm, мусорными именами и пользовательскими bin.
 * Настоящий домашний каталог и ~/.nvm машины в проверке не участвуют.
 */
async function nvmHome(t, versions) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'server-binary-cli-home-'));
  const home = path.join(base, 'home');
  const data = path.join(base, 'D');
  const nodeVersions = path.join(home, '.nvm/versions/node');

  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(nodeVersions, { recursive: true });

  for (const version of versions) {
    await mkdir(path.join(nodeVersions, version, 'bin'), { recursive: true });
  }

  return {
    base,
    home,
    data,
    nodeVersions,
  };
}

test('SB08-discovery: nvm сортируется численно, мусор и отсутствующие умолчания пропускаются', async (t) => {
  const fixture = await nvmHome(t, ['v24.9.0', 'v24.10.0', 'v22.1.0', 'v24.10.0-rc.1', 'system']);

  await writeFile(path.join(fixture.nodeVersions, 'v25.0.0'), 'не каталог');
  await mkdir(path.join(fixture.nodeVersions, 'v23.0.0'));
  await mkdir(path.join(fixture.home, '.local/bin'), { recursive: true });
  await mkdir(path.join(fixture.data, 'state/npm-global/bin'), { recursive: true });

  const result = await discoverUserCliDirectories({
    env: { GRIGDESK_CLI_PATH: `/explicit/a::relative/bin:/explicit/b/../c` },
    home: fixture.home,
    dataHome: fixture.data,
  });

  assert.deepEqual(result, {
    explicit: ['/explicit/a', '/explicit/c'],
    defaults: [path.join(fixture.home, '.local/bin'), path.join(fixture.data, 'state/npm-global/bin')],
    discovered: ['v24.10.0', 'v24.9.0', 'v22.1.0']
      .map((version) => path.join(fixture.nodeVersions, version, 'bin')),
  });
});

test('SB08-discovery: абсолютный NVM_DIR сильнее HOME, относительный игнорируется', async (t) => {
  const fixture = await nvmHome(t, ['v20.0.0']);
  const custom = path.join(fixture.base, 'custom nvm');

  await mkdir(path.join(custom, 'versions/node/v24.21.0/bin'), { recursive: true });

  const absolute = await discoverUserCliDirectories({
    env: { NVM_DIR: custom },
    home: fixture.home,
    dataHome: fixture.data,
  });
  const relative = await discoverUserCliDirectories({
    env: { NVM_DIR: 'custom nvm' },
    home: fixture.home,
    dataHome: fixture.data,
  });
  const missing = await discoverUserCliDirectories({
    env: { NVM_DIR: path.join(fixture.base, 'нет такого') },
    home: fixture.home,
    dataHome: fixture.data,
  });

  assert.deepEqual(absolute.discovered, [path.join(custom, 'versions/node/v24.21.0/bin')]);
  assert.deepEqual(relative.discovered, [path.join(fixture.nodeVersions, 'v20.0.0/bin')]);
  assert.deepEqual(missing, {
    explicit: [],
    defaults: [],
    discovered: [],
  });
});

test('SB08-discovery: обход только versions/node, EACCES явного каталога — именованный отказ', async () => {
  const listed = [];
  // Порт ФС записывает обход и отдаёт EACCES только явному каталогу:
  // так видно, что nvm читается одним уровнем, а права явного пути не теряются молча.
  const fileSystem = {
    async readdir(directory) {
      listed.push(directory);

      return directory === '/home/user/.nvm/versions/node' ? ['v24.21.0'] : [];
    },
    /**
     * EACCES получает только явный каталог, версии nvm существуют как каталоги.
     * Остальные пути отсутствуют: необязательные умолчания должны молча пропасть.
     */
    async stat(file) {
      if (file === '/denied/bin') {
        throw Object.assign(new Error('нет доступа'), { code: 'EACCES' });
      }

      if (file.startsWith('/home/user/.nvm/versions/node/')) {
        return { isDirectory: () => true };
      }

      throw Object.assign(new Error('нет файла'), { code: 'ENOENT' });
    },
  };
  const result = await discoverUserCliDirectories({
    env: { GRIGDESK_CLI_PATH: '/missing/explicit' },
    home: '/home/user',
    dataHome: '/D',
    fileSystem,
  });

  assert.deepEqual(result.explicit, ['/missing/explicit']);
  assert.deepEqual(result.discovered, ['/home/user/.nvm/versions/node/v24.21.0/bin']);
  assert.deepEqual(listed, ['/home/user/.nvm/versions/node']);
  await assert.rejects(() => discoverUserCliDirectories({
    env: { GRIGDESK_CLI_PATH: '/denied/bin' },
    home: '/home/user',
    dataHome: '/D',
    fileSystem,
  }), { code: 'cli_path_inaccessible' });
});

test('SB08: сохранённый Node выше умолчаний и найденных nvm, явный — выше сохранённого', () => {
  const result = userCliPath({
    installationBin: '/I/bin',
    bundledNode: '/R/runtime/node/bin/node',
    explicit: ['/explicit/bin'],
    saved: ['/saved/node/bin'],
    defaults: ['/home/user/.local/bin'],
    inherited: '/usr/bin:/bin',
    discovered: ['/home/user/.nvm/versions/node/v24.21.0/bin', '/saved/node/bin'],
  });

  assert.deepEqual(result.split(':'), ['/I/bin', '/explicit/bin', '/saved/node/bin',
    '/home/user/.local/bin', '/usr/bin', '/bin', '/home/user/.nvm/versions/node/v24.21.0/bin',
    '/R/runtime/node/bin']);
});

/**
 * Исполняемый файл фикстуры с явным режимом 0755.
 * Shebang-скрипты проверяют реальный поиск через PATH ребёнка, а не stub наличия.
 */
async function executable(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  await chmod(file, 0o755);
}

/**
 * Обёртка Node с меткой: shebang `env node` показывает, какой Node выбрал PATH.
 * Сама обёртка — fixture-ссылка к Node теста, пользовательский ~/.local/bin не трогается.
 */
async function markedNode(file, marker) {
  await executable(file, `#!/bin/sh\nFIXTURE_NODE=${marker} exec "${process.execPath}" "$@"\n`);
}

/**
 * Запускает команду так же, как исполнитель чата или движок: execFile с готовым env.
 * Отказ поиска возвращается значением, чтобы assertion называл фактический исход.
 */
function runCommand(command, args, env, cwd) {
  return new Promise((resolve) => {
    const options = {
      env,
      cwd,
      timeout: 20_000,
    };

    execFile(command, args, options, (error, stdout, stderr) => {
      resolve({
        code: error ? (error.code ?? 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

/**
 * Пакетная установка: I/bin, R со своим Node-меткой и nvm-only codex в одной из версий.
 * Возвращает пути фикстуры; GUI PATH сознательно не содержит каталогов пользователя.
 */
async function packagedCliFixture(t, { nvm = true } = {}) {
  const fixture = await nvmHome(t, nvm ? ['v24.9.0', 'v24.10.0'] : []);
  const installationBin = path.join(fixture.base, 'installation with space/bin');
  const node = path.join(fixture.base, 'D/runtimes/server/packages/id/runtime/node/bin/node');
  const outside = path.join(fixture.base, 'чужой cwd');
  const codex = '#!/usr/bin/env node\n'
    + 'process.stdout.write(JSON.stringify({ node: process.env.FIXTURE_NODE, cwd: process.cwd() }));\n';

  await mkdir(installationBin, { recursive: true });
  await mkdir(outside, { recursive: true });
  await markedNode(node, 'bundled');

  if (nvm) {
    await markedNode(path.join(fixture.nodeVersions, 'v24.9.0/bin/node'), 'user-24.9');
    await markedNode(path.join(fixture.nodeVersions, 'v24.10.0/bin/node'), 'user-24.10');
    await executable(path.join(fixture.nodeVersions, 'v24.9.0/bin/codex'), codex);
  }

  return {
    ...fixture,
    installationBin,
    node,
    outside,
  };
}

test('SB08-child: GUI PATH и nvm-only codex исполняются настоящим shebang из чужого cwd', async (t) => {
  for (const system of ['/usr/bin/node', '/bin/node', '/usr/bin/codex']) {
    assert.equal(existsSync(system), false, `системный ${system} исказил бы проверку nvm`);
  }

  const fixture = await packagedCliFixture(t);
  const cli = await discoverUserCliDirectories({
    env: {},
    home: fixture.home,
    dataHome: fixture.data,
  });
  const env = buildServerEnv({
    parent: {
      PATH: '/usr/bin:/bin',
      HOME: fixture.home,
      GRIGDESK_HOME: fixture.data,
    },
    dotenv: {},
    node: fixture.node,
    home: fixture.home,
    sea: true,
    cli: {
      ...cli,
      installationBin: fixture.installationBin,
      saved: [],
    },
  });
  const result = await runCommand('codex', [], env, fixture.outside);

  assert.equal(existsSync(path.join(fixture.home, '.local/bin/codex')), false);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { node: 'user-24.10', cwd: fixture.outside });
  assert.equal(env.PATH.split(':')[0], fixture.installationBin);
  assert.equal(env.PATH.split(':').at(-1), path.dirname(fixture.node));
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(env.npm_config_prefix, path.join(fixture.data, 'state/npm-global'));
});

test('SB08-child: сохранённый Node сильнее nvm, без nvm остаётся собственный Node', async (t) => {
  const fixture = await packagedCliFixture(t);
  const saved = path.join(fixture.base, 'saved node/bin');

  await markedNode(path.join(saved, 'node'), 'saved');

  const cli = await discoverUserCliDirectories({
    env: {},
    home: fixture.home,
    dataHome: fixture.data,
  });
  const withSaved = buildServerEnv({
    parent: { PATH: '/usr/bin:/bin', GRIGDESK_HOME: fixture.data },
    dotenv: {},
    node: fixture.node,
    home: fixture.home,
    sea: true,
    cli: {
      ...cli,
      installationBin: fixture.installationBin,
      saved: [saved],
    },
  });
  const empty = await packagedCliFixture(t, { nvm: false });
  const bare = buildServerEnv({
    parent: { PATH: '/usr/bin:/bin', GRIGDESK_HOME: empty.data },
    dotenv: {},
    node: empty.node,
    home: empty.home,
    sea: true,
    cli: {
      ...await discoverUserCliDirectories({
        env: {},
        home: empty.home,
        dataHome: empty.data,
      }),
      installationBin: empty.installationBin,
      saved: [],
    },
  });
  const probe = ['-e', 'process.stdout.write(String(process.env.FIXTURE_NODE))'];

  assert.equal((await runCommand('node', probe, withSaved, fixture.outside)).stdout, 'saved');
  assert.equal((await runCommand('codex', [], withSaved, fixture.outside)).code, 0);
  assert.equal((await runCommand('node', probe, bare, empty.outside)).stdout, 'bundled');
  assert.equal((await runCommand('codex', [], bare, empty.outside)).code, 'ENOENT');
});

/**
 * Снимок дерева R: пути, размеры и mtime без следования ссылкам.
 * Совпадение до и после доказывает, что Python/npm и запуск CLI не писали в R.
 */
async function treeSnapshot(directory) {
  const result = [];

  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    const info = await stat(file);

    result.push(`${path.relative(directory, file)}:${info.size}:${info.mtimeMs}`);
  }

  return result.sort();
}

/**
 * Дочерний Node исполняет файл сценария с готовым env, как процесс сервера.
 * Интерпретатор задан абсолютным путём: PATH проверяется только у внешних команд.
 */
async function nodeScript(fixture, name, text, env) {
  const file = path.join(fixture.base, name);

  await writeFile(file, text);

  const result = await runCommand(process.execPath, [file], env, fixture.outside);

  assert.equal(result.code, 0, result.stderr);

  return JSON.parse(result.stdout);
}

/**
 * Фабрика: настоящий routeLaunchEnv поверх env сервера и запуск CLI как у движка.
 * Ребёнок фабрики наследует PATH и не получает R/bin впереди I/bin.
 */
function factoryProbe(fixture, root) {
  const module = pathToFileURL(path.join(ROOT, 'server/src/lib/factoryRouteCli.ts')).href;
  const config = {
    rootDir: root,
    installationBin: fixture.installationBin,
    dataHome: fixture.data,
    routesDir: path.join(fixture.data, 'routes'),
    stateDir: path.join(fixture.data, 'state'),
    factoryControlDir: path.join(fixture.data, 'control'),
    factoryBin: path.join(root, 'engine/bin/factory'),
    factoryHome: path.join(root, 'engine'),
    profilesDir: path.join(fixture.data, 'profiles'),
    factoryConfigRoot: path.join(fixture.data, 'config'),
  };

  return [
    "import { spawnSync } from 'node:child_process';",
    `const { routeLaunchEnv } = await import(${JSON.stringify(module)});`,
    `const env = { ...process.env, ...routeLaunchEnv(${JSON.stringify(config)}) };`,
    "const run = spawnSync('codex', [], { env, encoding: 'utf8' });",
    'process.stdout.write(JSON.stringify({',
    '  status: run.status, error: run.error?.code ?? null, stdout: run.stdout,',
    '  path: env.PATH.split(":"), nodeBin: env.GRIGDESK_DEEPSEEK_NODE_BIN, execPath: process.execPath,',
    '}));',
  ].join('\n');
}

/**
 * PTY: настоящий spawnPty модуля терминала запускает login-shell фикстуры с codex.
 * Вывод PTY собирается до выхода; пауза в shell даёт helper дочитать master.
 */
function ptyProbe(fixture, shell) {
  const module = pathToFileURL(path.join(ROOT, 'server/src/modules/terminal/index.ts')).href;

  return [
    `const { spawnPty } = await import(${JSON.stringify(module)});`,
    `const child = spawnPty({ cols: 80, rows: 24, shell: ${JSON.stringify(shell)},`,
    `  home: ${JSON.stringify(fixture.outside)} });`,
    "let output = '';",
    "child.stdout.on('data', (chunk) => { output += chunk; });",
    "child.on('exit', (code) => process.stdout.write(JSON.stringify({ code, output })));",
  ].join('\n');
}

test('SB15: desktop/manual/unit/factory/PTY находят nvm-only codex одним PATH', async (t) => {
  const fixture = await packagedCliFixture(t);
  const root = path.resolve(path.dirname(fixture.node), '../../..');
  const envFile = path.join(fixture.data, '.env');
  const envText = 'NODE_EXTRA_CA_CERTS=/fixture/ca.pem\nNODE_OPTIONS=--require=/bad/fixture.cjs\n';

  await writeFile(envFile, envText);

  const before = await treeSnapshot(root);
  const gui = {
    HOME: fixture.home,
    PATH: '/usr/bin:/bin',
    GRIGDESK_HOME: fixture.data,
  };
  const launch = {
    root,
    installationBin: fixture.installationBin,
    home: fixture.home,
  };
  const manual = await packagedLaunchEnvironment({ ...launch, parent: gui });
  const unit = await packagedLaunchEnvironment({
    ...launch,
    parent: {
      ...gui,
      INVOCATION_ID: 'fixture-unit',
      JOURNAL_STREAM: '8:1',
    },
  });
  const desktop = buildServerEnv({
    parent: gui,
    dotenv: {},
    node: fixture.node,
    home: fixture.home,
    sea: true,
    cli: {
      ...await discoverUserCliDirectories({
        env: gui,
        home: fixture.home,
        dataHome: fixture.data,
      }),
      installationBin: fixture.installationBin,
      saved: [],
    },
  });

  for (const [name, env] of [['desktop', desktop], ['manual', manual], ['unit', unit]]) {
    const result = await runCommand('codex', [], env, fixture.outside);

    assert.equal(result.code, 0, `${name}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), { node: 'user-24.10', cwd: fixture.outside }, name);
    assert.equal(env.PATH.split(':')[0], fixture.installationBin, name);
    assert.equal(env.PATH.split(':').at(-1), path.dirname(fixture.node), name);
    assert.equal(env.PYTHONDONTWRITEBYTECODE, '1', name);
    assert.equal(env.npm_config_prefix, path.join(fixture.data, 'state/npm-global'), name);
    assert.equal(Object.hasOwn(env, 'NODE_OPTIONS'), false, name);
  }

  assert.equal(manual.NODE_EXTRA_CA_CERTS, '/fixture/ca.pem');

  const factory = await nodeScript(fixture, 'factory-probe.mjs', factoryProbe(fixture, root), manual);

  assert.deepEqual([factory.status, factory.error], [0, null]);
  assert.equal(JSON.parse(factory.stdout).node, 'user-24.10');
  assert.equal(factory.path[0], fixture.installationBin);
  assert.equal(factory.path.includes(path.join(root, 'bin')), false);
  assert.equal(factory.nodeBin, factory.execPath);

  const shell = path.join(fixture.base, 'pty-shell.sh');

  await executable(shell, '#!/bin/sh\ncodex\nsleep 1\n');

  const pty = await nodeScript(fixture, 'pty-probe.mjs', ptyProbe(fixture, shell), manual);

  assert.equal(pty.code, 0);
  assert.match(pty.output, /"node":"user-24\.10"/u);
  assert.deepEqual(await treeSnapshot(root), before);
  assert.equal(await readFile(envFile, 'utf8'), envText);
});
