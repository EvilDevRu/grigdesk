import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import { RoutesStore } from '../../../server/src/modules/routes/store.ts';
import { makeAgentNode } from '../../fixtures/routes-editor.mjs';
import { shellQuote } from '../../../shared/lib/shellQuote.ts';

const run = promisify(execFile);
export const STAND_PROFILE = 'launch-retry-demo';

/**
 * Управляемая копия отвечает только на probe и никогда не вызывает модель.
 * Файл hold-probe удерживает настоящий preflight до появления trusted identity.
 */
function cliScript(root) {
  return [
    '#!/bin/sh',
    'if [ "$1" != --version ]; then echo "Тестовая копия не выполняет модель" >&2; exit 91; fi',
    `while [ -f ${shellQuote(path.join(root, 'pipeline-fixture', 'hold-probe'))} ]; do sleep 0.1; done`,
    'echo "kimi, version 2.4.1"',
    '',
  ].join('\n');
}

/**
 * Два точных каталога позволяют проверяющему менять копию и барьер запуска.
 * HOME, .env, авторизация и весь root стенда не становятся writable roots агента.
 */
export async function writableStandRoots(root) {
  root = await realpath(root);

  const markerFile = path.join(root, 'pipeline-stand-seed.json');
  const stat = await lstat(markerFile);
  const marker = JSON.parse(await readFile(markerFile, 'utf8'));

  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600
    || marker.schema !== 1 || marker.root !== root) {
    throw new Error('Не подтверждён корень тестового стенда');
  }

  const directories = [path.join(root, 'home', 'fixture-npm', 'bin'), path.join(root, 'pipeline-fixture')];

  for (const directory of directories) {
    if (await realpath(directory) !== directory) {
      throw new Error('Тестовый writable root не должен проходить через symlink');
    }
  }

  return directories;
}

/**
 * Переключение копии пишет только в её bin, не требует записи всего HOME стенда.
 * Broken сохраняет исполняемый bin, но отвязывает его от declared entry npm-пакета.
 */
export async function setStandCli(root, mode) {
  const [binDirectory] = await writableStandRoots(root);
  const bin = path.join(binDirectory, 'kimi');
  const temporary = `${bin}.${process.pid}.tmp`;

  if (mode === 'broken') {
    await writeFile(temporary, cliScript(root), { mode: 0o700, flag: 'wx' });
  } else if (mode === 'ready') {
    await symlink('../lib/node_modules/@moonshot-ai/kimi-code/cli.sh', temporary);
  } else {
    throw new Error('Состояние CLI: broken или ready');
  }

  await rename(temporary, bin);
}

/**
 * Посев требует явного отдельного root, не копирует профили владельца и повторяем.
 * Маршрут начинается с ворот: успешный launch не запускает платную модель и публикацию.
 */
export async function seedPipelineStand({ root, fePort, apiPort, systemdRuntimeDir }) {
  root = await realpath(root);

  if (![fePort, apiPort].every((port) => Number.isInteger(port) && port >= 1024 && port <= 65535)) {
    throw new Error('Нужны действительные порты изолированного стенда');
  }

  const markerFile = path.join(root, 'pipeline-stand-seed.json');
  const profile = path.join(root, 'profiles', STAND_PROFILE);
  const home = path.join(root, 'home');
  const repository = path.join(root, 'pipeline-fixture', 'repository');
  const prefix = path.join(home, 'fixture-npm');
  const packageRoot = path.join(prefix, 'lib/node_modules/@moonshot-ai/kimi-code');
  const saved = await readFile(markerFile, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    return null;
  });

  if (!saved) {
    // Существующий профиль не принадлежит этому помощнику и не перезаписывается.
    await mkdir(path.dirname(profile), { recursive: true });
    await mkdir(profile);
    await writeFile(markerFile, JSON.stringify({ schema: 1, root }), { mode: 0o600, flag: 'wx' });
  } else if (JSON.parse(saved).root !== root) {
    throw new Error('Маркер другого стенда');
  }

  await Promise.all([
    mkdir(repository, { recursive: true }),
    mkdir(packageRoot, { recursive: true }),
    mkdir(path.join(prefix, 'bin'), { recursive: true }),
  ]);

  try {
    await realpath(path.join(repository, '.git'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    await run('git', ['init', '-q', '-b', 'main', repository]);
    await run('git', ['-C', repository, '-c', 'user.name=Fixture',
      '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Fixture']);
  }

  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@moonshot-ai/kimi-code',
    version: '2.4.1',
    bin: { kimi: 'cli.sh' },
  }));
  await writeFile(path.join(packageRoot, 'cli.sh'), cliScript(root), { mode: 0o700 });

  for (const name of ['.bashrc', '.bash_profile']) {
    const file = path.join(home, name);
    const previous = await readFile(file, 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      return '';
    });

    if (!previous.includes('# grigdesk-pipeline-stand-fixture')) {
      await writeFile(file, `${previous}\n# grigdesk-pipeline-stand-fixture\n`
        + `export PATH=${shellQuote(path.join(prefix, 'bin'))}:"$PATH"\n`, { mode: 0o600 });
    }
  }

  await setStandCli(root, 'ready');

  if (systemdRuntimeDir) {
    if (!path.isAbsolute(systemdRuntimeDir) || /[\r\n\0]/u.test(systemdRuntimeDir)) {
      throw new Error('Нужен абсолютный --systemd-runtime для пользовательской шины');
    }

    const file = path.join(root, '.env');
    const previous = await readFile(file, 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      return '';
    });
    const existing = /^XDG_RUNTIME_DIR=(.*)$/mu.exec(previous);

    if (existing && existing[1] !== systemdRuntimeDir) {
      throw new Error('Стенд уже настроен на другую пользовательскую шину');
    }
    if (!existing) {
      await writeFile(file, `${previous}\nXDG_RUNTIME_DIR=${systemdRuntimeDir}\n`, { mode: 0o600 });
    }
  }

  const hooks = [
    `PROFILE_NAME=${STAND_PROFILE}`,
    'PROFILE_SERVICE_HOST=127.0.0.1',
    `PROFILE_AGENT_CWD=${shellQuote(repository)}`,
    `PROFILE_TRIAGE_REPOS=${shellQuote(`demo:${repository}`)}`,
    "profile_workspace_mode() { printf 'shared\\n'; }",
    `profile_repositories() { printf 'demo\\t%s\\t%s\\n' ${shellQuote(repository)} `
      + `${shellQuote(repository)}; }`,
    "profile_source_branch() { printf 'main\\n'; }",
    "profile_stand_mode() { printf 'services\\n'; }",
    "profile_container() { printf 'pipeline-stand-fixture\\n'; }",
    'profile_stand_alive() { return 0; }',
    `profile_service_ports() { printf '${fePort}\\t${apiPort}\\n'; }`,
    'profile_project_context() { printf \'%s\\n\' \'{"stack":["fixture"],"guardrails":[]}\'; }',
    `profile_exclusive_resources() { printf '%s\\n' 'stand:pipeline-stand-fixture' `
      + `${shellQuote(`workspace:${repository}`)}; }`,
    '',
  ].join('\n');

  await writeFile(path.join(profile, 'profile.sh'), hooks);
  await writeFile(path.join(profile, 'dashboard.env'), `PROFILE_TITLE='Проверка повторного запуска'\n`);
  await writeFile(path.join(profile, 'runners.env'), [
    'RUNNERS_SCHEMA=1', 'CONFIG_REVISION=1', 'RUNNERS_COVERAGE=required',
    'PROJECT_RUNNER_PRIMARY=kimi', 'PROJECT_RUNNER_FAILOVER=',
    'MODEL_DEFAULT_KIMI_FAMILY=k3', 'MODEL_DEFAULT_KIMI_VERSION=latest', '',
  ].join('\n'));
  await writeFile(path.join(profile, 'graph.json'), JSON.stringify({ capabilities: ['route-v2'] }));

  const agent = makeAgentNode();
  const route = {
    schema: 2,
    kind: 'route',
    profile: STAND_PROFILE,
    id: 'retry-check',
    title: 'Проверка запуска без публикации',
    bootstrap: 'skip',
    entry: 'gate_accept',
    sequence: { main: ['gate_accept', 'build'], tail: [] },
    nodes: [{
      id: 'gate_accept',
      executor: 'gate',
      phase: 'main',
      runKey: 'GATE_ACCEPT',
      emits: [],
      on: { approved: { next: 'build' }, rejected: { stop: 'human' } },
    }, agent],
    escalation: [],
  };
  const scout = makeAgentNode({
    id: 'scout',
    phase: 'bootstrap',
    promptFile: 'bootstrap/prompts/scout.base.md',
    requiredContext: ['task', 'routeCatalog'],
    on: {
      done: { escalate: { routes: ['retry-check'] } },
      skipped: { stop: 'human' },
      failed: { stop: 'human' },
      exhausted: { stop: 'human' },
    },
  });
  const store = new RoutesStore({ baseDir: path.join(root, 'routes') });
  const published = await store.publishRoute(STAND_PROFILE, route.id, {
    route, prompts: { 'prompts/build.base.md': 'Тестовый этап: не запускать модель.' },
  });
  const current = await store.readCurrent(STAND_PROFILE).catch(() => null);
  const catalog = await store.publishCatalog(STAND_PROFILE, {
    catalog: {
      schema: 2,
      profile: STAND_PROFILE,
      routes: { [route.id]: published.routeHash },
      bootstrap: { file: 'bootstrap/scout.json' },
    },
    bootstrap: {
      schema: 2,
      kind: 'bootstrap',
      profile: STAND_PROFILE,
      id: 'scout',
      entry: 'scout',
      sequence: { bootstrap: ['scout'] },
      nodes: [scout],
      escalation: [{
        from: 'scout',
        allowedRoutes: ['retry-check'],
        requiresHumanWhenPinned: true,
      }],
    },
    prompts: { 'bootstrap/prompts/scout.base.md': 'Подтверди тестовый маршрут.' },
  }, { expectedCatalogHash: current?.catalogHash ?? null });

  return {
    profile: STAND_PROFILE,
    route: route.id,
    catalogHash: catalog.catalogHash,
    repository,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    root: { type: 'string' },
    'fe-port': { type: 'string' },
    'api-port': { type: 'string' },
    'systemd-runtime': { type: 'string' },
    'write-roots': { type: 'boolean' },
    cli: { type: 'string' },
  } });

  if (!values.root || !path.isAbsolute(values.root)) {
    throw new Error('Нужен явный абсолютный --root изолированного стенда');
  }

  if (values['write-roots']) {
    process.stdout.write(`${(await writableStandRoots(values.root)).join('\n')}\n`);
  } else {
    const result = values.cli
      ? await setStandCli(values.root, values.cli)
      : await seedPipelineStand({
        root: values.root,
        fePort: Number(values['fe-port']),
        apiPort: Number(values['api-port']),
        systemdRuntimeDir: values['systemd-runtime'],
      });

    process.stdout.write(`${JSON.stringify(result ?? { cli: values.cli })}\n`);
  }
}
