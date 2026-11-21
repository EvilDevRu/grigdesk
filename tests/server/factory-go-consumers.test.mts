import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import routesModule from '../../server/src/modules/routes/index.ts';
import { RoutesStore } from '../../server/src/modules/routes/store.ts';
import { makeDraft } from '../fixtures/routes-editor.mjs';
import { expectAttempt, prepareCommandServer } from './helpers/factoryGoRuntime.mts';
import { buildHelper } from '../../server/scripts/sea/helpers.mts';
import { invokeFactoryStatusTool } from '../../server/src/lib/factory/statusPort.ts';
import { startBrowserSocket } from '../../server/src/lib/browser/browserSocket.ts';
import { prepareBrowserSocket } from '../../server/src/lib/browser/browserSocketDirectory.ts';
import { factoryBrowserOwner } from '../../server/src/lib/browser/factoryBrowserIdentity.ts';
import { browserRelaySocket } from '../../server/src/lib/browser/factoryBrowserRuntime.ts';
import { createFactoryBrowserTrusted } from '../../server/src/lib/browser/factoryBrowserTrusted.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const repo = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Завершение detached-процесса проверяется после terminal.
 * Launcher ещё может дописывать проекцию перед итоговой строкой журнала.
 */
async function expectLauncherExit(stateDir: string) {
  const launchLog = path.join(stateDir, 't71.launch.log');
  let exitLog = '';

  for (let probe = 0; probe < 100; probe += 1) {
    exitLog = await fs.readFile(launchLog, 'utf8');

    if (/(?:^|\n)rc=\d+\n?$/u.test(exitLog)) {
      break;
    }

    await delay(50);
  }

  assert.match(exitLog, /(?:^|\n)rc=0\n?$/u);
}

/**
 * Исполняемый шпион сохраняет argv и stdin для проверки маршрутизации вызовов.
 * Исходный поток поступает в реальный Go-кандидат без подмены ответа.
 */
async function makeSpy(root: string, candidate: string) {
  const bin = path.join(root, 'engine-spy');
  const callLog = path.join(root, 'calls.jsonl');
  const program = [
    '#!/bin/bash',
    'case "${1:-}" in',
    '  route) case " $* " in',
    '    *" editor-render "*|*" editor-step "*|*" editor-check "*)',
    '      input=$(mktemp -p "$PWD"); trap \'rm -f "$input"\' EXIT; cat >"$input";;',
    '  esac;;',
    'esac',
    'printf "%s\\t" "$(readlink -f "$0")" "$@" >> calls.jsonl',
    'printf "\\n" >> calls.jsonl',
    'if [[ -n "${input:-}" ]]; then',
    '  cat "$input" >> stdin.jsonl; printf "\\n" >> stdin.jsonl',
    `  "${candidate}" "$@" < "$input"`,
    'else',
    `  exec "${candidate}" "$@"`,
    'fi',
    '',
  ];

  program.splice(1, 0, `cd "${root}"`);
  await fs.writeFile(bin, program.join('\n'), { mode: 0o700 });

  return {
    bin,
    callLog,
    stdin: path.join(root, 'stdin.jsonl'),
  };
}

/**
 * Редактор использует собственные каталог, профиль и черновик.
 * HTTP-запросы проходят через обычный routes plugin.
 */
async function deployEditor(t: { after: (f: () => Promise<void>) => void },
  root: string, engineBin: string, engineHome: string) {
  const routesDir = path.join(root, 'routes');
  const profilesDir = path.join(root, 'profiles');
  const profile = path.join(profilesDir, 'sample');

  await fs.mkdir(path.join(profile, 'routes'), { recursive: true });
  await fs.writeFile(path.join(profile, 'graph.json'), '{}');

  const capabilities = {
    schema: 1,
    commands: [{
      id: 'project-check',
      label: 'Проверка',
      filesystem: ['state-only'],
    }],
    contextSections: [],
  };

  await fs.writeFile(path.join(profile, 'routes', 'editor-capabilities.json'), JSON.stringify(capabilities));

  const app = Fastify({ logger: false });

  t.after(() => app.close());
  await app.register(routesModule, {
    config: {
      routesDir,
      profilesDir,
      factoryBin: engineBin,
      factoryHome: engineHome,
      factoryEngineProtocol: 'go-v1',
    },
    prefs: {
      read: () => ({ projects: { sample: {} } }),
      write: () => {
        throw new Error('Редактор не должен менять prefs');
      },
    },
  });
  await app.ready();

  const store = new RoutesStore({ baseDir: routesDir });

  await store.switchEditorSource('sample', {
    mode: 'editor',
    expectedSourceRevision: 0,
    expectedCatalogHash: null,
  });

  const initial = makeDraft();
  const created = await app.inject({
    method: 'POST',
    url: '/api/routes/sample/drafts',
    payload: {
      kind: 'document',
      title: 'Черновик Go',
      baseCatalogHash: null,
      baseSourceRevision: 1,
      document: {
        routes: initial.routes,
        bootstrap: initial.bootstrap,
        bootstrapPrompts: initial.bootstrapPrompts,
        presentation: initial.presentation,
        provenance: initial.provenance,
      },
    },
  });

  assert.equal(created.statusCode, 201, created.body);

  return {
    app,
    store,
    draftUrl: `/api/routes/sample/drafts/${created.json().id}`,
  };
}

const stepBody = {
  expectedRevision: 1,
  cursor: {
    scope: 'route',
    routeId: 'quick',
    nodeId: 'build',
    terminal: false,
  },
  counters: {
    noResult: {},
    productFailure: {},
    rewinds: {},
  },
  outcome: 'done',
  failureOwner: null,
  selectedRouteId: null,
  pinned: false,
  humanApproved: false,
  stepIndex: 1,
};

test('Go-потребители редактора используют один движок для simulate и publish', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-go-consumers-'));

  t.after(() => fs.rm(root, { force: true, recursive: true }));

  const candidate = path.join(root, 'factory');

  execFileSync('go', ['build', '-trimpath', '-o', candidate, './utilities/factory/cmd/factory'], {
    cwd: repo,
  });

  const sha = createHash('sha256').update(await fs.readFile(candidate)).digest('hex');

  t.diagnostic(`factory ${candidate} SHA256=${sha}`);

  const spy = await makeSpy(root, candidate);
  const { app, store, draftUrl } = await deployEditor(t, root, spy.bin, path.join(root, 'engine'));
  const preview = await app.inject({
    method: 'POST',
    url: `${draftUrl}/preview`,
    payload: {
      expectedRevision: 1,
      scope: 'route',
      routeId: 'quick',
      nodeId: 'build',
      context: { task: { kind: 'audit' } },
    },
  });

  assert.equal(preview.statusCode, 200, preview.body);
  assert.ok(preview.json().text.length);

  const step = await app.inject({
    method: 'POST',
    url: `${draftUrl}/simulate/step`,
    payload: stepBody,
  });

  assert.equal(step.statusCode, 200, step.body);
  assert.equal(step.json().cursor.nodeId, 'check');

  const published = await app.inject({
    method: 'POST',
    url: `${draftUrl}/publish`,
    payload: {
      expectedRevision: 1,
      expectedCatalogHash: null,
      expectedSourceRevision: 1,
      operationId: '88888888-8888-4888-8888-888888888888',
    },
  });

  assert.equal(published.statusCode, 200, published.body);
  assert.equal(published.json().state, 'committed');
  assert.equal((await store.readCurrent('sample'))?.catalogHash, published.json().toCatalogHash);

  const recorded = await fs.readFile(spy.callLog, 'utf8').catch(() => '');

  assert.ok(recorded.length, 'HTTP редактор обошёл выбранный Go-движок');

  const calls = recorded.trim().split('\n').map((line) => line.trimEnd().split('\t'));

  assert.ok(calls.every(([binary, prefix]) => binary === spy.bin && prefix === 'route'));

  const operations = ['editor-render', 'editor-step', 'editor-capabilities', 'editor-check', 'catalog'];

  for (const operation of operations) {
    assert.ok(calls.some((call) => call.includes(operation)), operation);
  }

  const [, stdin] = (await fs.readFile(spy.stdin, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(stdin.catalogInput.profile, 'sample');
  assert.deepEqual(stdin.cursor, stepBody.cursor);
  t.diagnostic(JSON.stringify(calls));
});

test('Пустой выбранный движок даёт прежний отказ редактора', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-go-missing-'));

  t.after(() => fs.rm(root, { force: true, recursive: true }));

  const { app, store, draftUrl } = await deployEditor(t, root,
    path.join(root, 'missing'), path.join(root, 'engine'));
  const response = await app.inject({
    method: 'POST',
    url: `${draftUrl}/simulate/step`,
    payload: stepBody,
  });

  assert.equal(response.statusCode, 503, response.body);
  assert.deepEqual(response.json(), {
    error: 'routes_engine_unavailable', message: 'Движок предпросмотра временно недоступен.',
  });
  assert.equal(await store.readCurrent('sample'), null);
});

test('Два worker helper сохраняют отдельные writers одного status API', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-go-status-'));

  t.after(() => fs.rm(root, { force: true, recursive: true }));

  const candidate = path.join(root, 'factory');

  execFileSync('go', ['build', '-trimpath', '-o', candidate, './utilities/factory/cmd/factory'], {
    cwd: repo,
  });

  const a = path.join(root, 'generation-a');
  const b = path.join(root, 'generation-b');

  await fs.mkdir(a);
  await fs.mkdir(b);

  const spies = await Promise.all([makeSpy(a, candidate), makeSpy(b, candidate)]);
  const helper = await buildHelper({
    root: repo,
    manifestPath: path.join(repo, 'server/build/helpers.json'),
    id: 'factory-status-mcp',
    outDir: path.join(root, 'payload/server/runtime/helpers'),
    workDir: path.join(root, 'build'),
  });

  for (const [index, spy] of spies.entries()) {
    const state = index === 0 ? a : b;
    const runId = `r${String(index + 1).repeat(32)}`;
    const dir = path.join(state, 'logs', 'runs', 't71', 'BUILD', runId, 'control-requests');

    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    const env = {
      FACTORY_RUN_TASK: '71',
      FACTORY_RUN_STAGE: 'BUILD',
      FACTORY_RUN_ID: runId,
      FACTORY_RUN_ATTEMPT: `a_${String(index + 1).repeat(32)}`,
      FACTORY_RUN_EPOCH: '1',
      FACTORY_STATE: state,
      FACTORY_STATUS_MODE: 'request',
      FACTORY_STATUS_REQUEST_DIR: dir,
      FACTORY_STATUS_ENGINE_PROTOCOL: 'go-v1',
      FACTORY_STATUS_ENGINE_HOME: state,
      FACTORY_STATUS_BIN: spy.bin,
    };
    const progressData = { updates: [{ key: 'SIZE', value: 'M' }] };
    const resultData = { result: 'done', comment: 'Один' };

    if (index === 0) {
      const progress = await invokeFactoryStatusTool(env, 'stage_progress', progressData);

      assert.deepEqual(progress.structuredContent, { ok: true }, progress.content[0]?.text);

      const result = await invokeFactoryStatusTool(env, 'stage_result', resultData);

      assert.deepEqual(result.structuredContent, { ok: true }, result.content[0]?.text);
    } else {
      for (const [name, input] of [['stage_progress', progressData], ['stage_result', resultData]]) {
        const rpc = {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: input },
        };
        const reply = execFileSync(process.execPath, [helper.file], {
          env: {
            ...env,
            PATH: '/usr/bin:/bin',
            HOME: root,
          },
          input: JSON.stringify(rpc) + '\n',
          encoding: 'utf8',
          timeout: 5000,
        });
        const response = JSON.parse(reply);

        assert.deepEqual(response.result?.structuredContent, { ok: true }, reply);
      }
    }

    const calls = await fs.readFile(spy.callLog, 'utf8');
    const lines = calls.trim().split('\n');

    assert.equal(lines.length, 2);
    assert.ok(lines[0]?.startsWith(`${spy.bin}\tstage-progress\t`));
    assert.ok(lines[1]?.startsWith(`${spy.bin}\tstage-result\t`));
    assert.ok(lines.every((line) => line.includes(runId)));
    assert.equal((await fs.readdir(dir)).filter((file) => file.endsWith('.request')).length, 2);
    t.diagnostic(JSON.stringify({
      binary: spy.bin,
      runId,
      calls: lines,
    }));
  }
});

test('HTTP launch подтверждает короткий Go-запуск по журналу ворот', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-go-fast-launch-'));

  t.after(() => fs.rm(root, { force: true, recursive: true }));

  const candidate = path.join(root, 'factory');

  execFileSync('go', ['build', '-trimpath', '-o', candidate, './utilities/factory/cmd/factory'], {
    cwd: repo,
  });

  const fixture = await prepareCommandServer(t, root, candidate);
  const systemdRun = path.join(root, 'unit-bin/systemd-run');
  const script = await fs.readFile(systemdRun, 'utf8');

  assert.ok(script.includes('>/dev/null 2>&1 &'));
  await fs.writeFile(systemdRun, script.replace('>/dev/null 2>&1 &', '>/dev/null 2>&1'));
  await fs.writeFile(path.join(root, 'release-command'), '');

  const server = await fixture.open();
  const response = await server.inject({
    method: 'POST',
    url: '/api/tasks/71/launch',
    payload: {
      profile: 'demo-profile',
      route: 'command',
      title: 'Короткий маршрут',
      description: 'Команда успевает дойти до ворот',
      acceptanceCriteria: ['Одна проверка'],
      sourceUrl: 'https://example.test/tasks/71',
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().outcome, 'launched');

  const trusted = await fixture.adapter.readTrustedAttempt('71');

  assert.equal(response.json().attempt, trusted.attempt);
  assert.equal(trusted.cursor?.state, 'paused');
  assert.equal(trusted.cursor?.node, 'gate_accept');
  assert.equal(await fs.readFile(path.join(root, 'command.count'), 'utf8'), '1\n');
});

test('HTTP launch сохраняет ворота после закрытия и открытия сервера', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-go-http-'));

  t.after(() => fs.rm(root, { force: true, recursive: true }));

  const binDir = path.join(root, 'bin');

  await fs.mkdir(binDir);

  const candidate = path.join(binDir, 'factory');

  execFileSync('go', ['build', '-trimpath', '-o', candidate, './utilities/factory/cmd/factory'], {
    cwd: repo,
  });

  const spy = await makeSpy(root, candidate);
  const fx = await prepareCommandServer(t, root, spy.bin);
  const first = await fx.open();
  const started = await first.inject({
    method: 'POST',
    url: '/api/tasks/71/launch',
    payload: {
      profile: 'demo-profile',
      route: 'command',
      title: 'Проба маршрута',
      description: 'Локальный проект',
      acceptanceCriteria: ['Одна проверка'],
      sourceUrl: 'https://example.test/tasks/71',
    },
  });

  assert.equal(started.statusCode, 200, started.body);

  const launchLog = path.join(fx.config.stateDir, 't71.launch.log');
  const detail = () => fs.readFile(launchLog, 'utf8').catch(() => 'нет launch.log');
  const projection = await fs.readFile(path.join(fx.config.stateDir, 't71.pipeline'), 'utf8').catch(() => '');

  assert.equal(started.json().outcome, 'launched', [started.body, await detail(), projection].join('\n'));

  const attempt = started.json().attempt;

  await fs.writeFile(path.join(root, 'release-command'), '');

  const waiting = await expectAttempt(fx.adapter, (snapshot) => snapshot.cursor?.node === 'gate_accept');

  assert.equal(waiting.attempt, attempt);
  await first.close();

  const second = await fx.open();
  const decided = await second.inject({
    method: 'POST',
    url: '/api/tasks/71/gate/GATE_ACCEPT/approve',
    payload: {
      attempt,
      profile: 'demo-profile',
      comment: 'Одна проверка',
    },
  });

  assert.equal(decided.statusCode, 200, decided.body);
  assert.equal(decided.json().value, 'approved', decided.body);

  const terminal = await expectAttempt(fx.adapter, (snapshot) =>
    snapshot.terminal === 'completed' && snapshot.cursor?.stop === 'done');

  assert.equal(terminal.attempt, attempt);
  assert.equal(terminal.routeHash, waiting.routeHash);
  assert.equal(await fs.readFile(path.join(root, 'command.count'), 'utf8'), '1\n');

  await expectLauncherExit(fx.config.stateDir);

  const summary = await fx.adapter.getTaskSummary('71');
  const graph = await second.inject({ method: 'GET', url: '/api/tasks/71/graph' });
  const { registry } = await fx.adapter.readRegistry('71');

  assert.equal(graph.statusCode, 200, graph.body);
  assert.equal(summary.result, 'completed');
  assert.equal(registry.RESULT, 'completed');
  t.diagnostic(JSON.stringify({
    terminal: summary.result,
    summaryStall: summary.stall?.kind,
    graphStall: graph.json().stall?.kind,
  }));
  assert.equal(summary.stall, null);
  assert.equal(graph.json().stall, null);

  const calls = await fs.readFile(spy.callLog, 'utf8');

  assert.ok(calls.includes('\t71\tstart\t'), calls);
  assert.ok(calls.split('\n').some((line) =>
    line.includes('\t71\tgate\t') && line.includes('\t--commit-only\t')), calls);
  assert.ok(calls.includes('\t71\tresume\t'), calls);
  assert.equal(decided.json().resumed, true, decided.body);
  t.diagnostic(JSON.stringify({
    attempt,
    hash: terminal.routeHash,
    calls,
  }));
});

for (const provider of ['deepseek', 'glm', 'kimi', 'claude', 'codex'] as const) {
  const cli = provider !== 'deepseek' && provider !== 'glm';

  test(`${provider} после HTTP-ворот принимает один результат этапа`, {
    skip: cli ? process.platform !== 'linux' : !process.env.FACTORY_TEST_DEEPSEEK_BIN,
  }, (t) => exerciseNativeBrowser(t, provider));
}

test('Go запускает этап без browser capability при legacy mode', {
  skip: process.platform !== 'linux' || !process.env.FACTORY_TEST_DEEPSEEK_BIN,
}, (t) => exerciseNativeBrowser(t, 'deepseek', 'legacy'));

/**
 * Маршрут, ворота и relay общие для CLI и ACP.
 * Модели заменены тестовыми CLI или локальным endpoint.
 */
async function exerciseNativeBrowser(
  t: TestContext, provider: 'deepseek' | 'glm' | 'kimi' | 'claude' | 'codex',
  browserMode: 'grigdesk' | 'legacy' = 'grigdesk',
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-go-http-acp-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const binDir = path.join(root, 'bin');
  const candidate = path.join(binDir, 'factory');

  await fs.mkdir(binDir);
  execFileSync('go', ['build', '-trimpath', '-o', candidate, './utilities/factory/cmd/factory'], {
    cwd: repo,
  });

  const withBrowser = process.platform === 'linux';
  const expectBrowser = withBrowser && browserMode === 'grigdesk';
  const cli = provider !== 'deepseek' && provider !== 'glm';
  const selectedModels = {
    glm: '["zai","glm-5.3"]',
    deepseek: '["deepseek-official","deepseek-v4-pro"]',
    kimi: 'kimi-for-coding',
    claude: 'sonnet',
    codex: 'gpt-fixture',
  };
  const selectedModel = selectedModels[provider];
  const fx = await prepareCommandServer(t, root, candidate, true, withBrowser);
  const helper = await buildHelper({
    root: repo,
    manifestPath: path.join(repo, 'server/build/helpers.json'),
    id: 'factory-status-mcp',
    outDir: path.join(root, 'server/runtime/helpers'),
    workDir: path.join(root, 'helper-build'),
  });
  const scripts = path.join(root, 'server/scripts');
  const fixture = new URL(provider === 'glm'
    ? '../fixtures/serverBinary/factoryGoGlm.mts'
    : '../fixtures/serverBinary/factoryGoDeepSeek.mts', import.meta.url);
  let browserCalls = 0;

  if (withBrowser) {
    const browser = await buildHelper({
      root: repo,
      manifestPath: path.join(repo, 'server/build/helpers.json'),
      id: 'factory-browser',
      outDir: path.join(root, 'server/runtime/helpers'),
      workDir: path.join(root, 'helper-build'),
    });
    const catalog = path.join(root, 'server/build/helpers.json');

    await fs.mkdir(path.dirname(catalog), { recursive: true });
    await fs.writeFile(catalog, JSON.stringify({
      schema: 1,
      helpers: [{ id: 'factory-browser', entry: path.relative(root, browser.file) }],
    }));

    const socket = browserRelaySocket(fx.config.dataHome);
    const authority = {
      controlRoot: fx.config.factoryControlDir,
      trusted: createFactoryBrowserTrusted({
        state: fx.adapter,
        routes: new RoutesStore({ baseDir: fx.config.routesDir }),
        projectExists: async (profile) => profile === 'demo-profile',
      }),
    };

    await prepareBrowserSocket(socket);

    const relay = await startBrowserSocket({
      file: socket,
      owner: async (proof) => (await factoryBrowserOwner(authority, proof)).key,
      probe: () => ({ mode: browserMode, available: expectBrowser }),
      invoke: async (owner, input) => {
        assert.equal(owner, '71');
        assert.deepEqual(input, { action: 'list' });
        browserCalls += 1;

        return { tabs: [] };
      },
    });

    t.after(() => relay.close());

    if (cli) {
      await prepareCliBrowserFixture(
        root, fx.config.profilesDir, browser.file, provider, selectedModel, candidate,
      );
    }
  }

  await fs.mkdir(scripts, { recursive: true });

  if (provider === 'glm') {
    await prepareGlmBrowserFixture(t, fx.config.profilesDir, scripts);
  }

  if (!cli) {
    await fs.writeFile(path.join(scripts, `${provider}Runner.mts`), [
      "process.env.DEEPSEEK_API_KEY = 'synthetic-loopback-only';",
      `process.env.GRIGDESK_DEEPSEEK_TEST_COMPILED_MCP = ${JSON.stringify(helper.file)};`,
      `process.env.GRIGDESK_DEEPSEEK_TEST_EXPECT_BROWSER = '${expectBrowser ? '1' : '0'}';`,
      `await import(${JSON.stringify(fixture.href)});`,
    ].join('\n'));
  }

  const runtime = {
    deepseekBin: process.env.FACTORY_TEST_DEEPSEEK_BIN!,
    deepseekCacheDir: path.join(root, 'dsh-cache'),
  };
  const first = await fx.open(runtime);
  const started = await first.inject({
    method: 'POST',
    url: '/api/tasks/71/launch',
    payload: {
      profile: 'demo-profile',
      route: 'command',
      title: 'Offline ACP',
      description: 'Loopback готов перед запуском модели',
      acceptanceCriteria: ['Один результат'],
      sourceUrl: 'https://example.test/tasks/71',
    },
  });

  assert.equal(started.json().outcome, 'launched', started.body);
  await fs.writeFile(path.join(root, 'release-command'), '');

  const waiting = await expectAttempt(fx.adapter, (value) => value.cursor?.node === 'gate_accept');
  const settings = path.join(fx.config.factoryControlDir,
    'protocol-v2/tasks/t71/attempts', waiting.attempt, 'runner-settings');

  await fs.mkdir(settings, { mode: 0o700 });
  await fs.writeFile(path.join(settings, 'build.json'), JSON.stringify({
    schema: 1,
    identity: {
      task: '71',
      profile: 'demo-profile',
      attempt: waiting.attempt,
      node: 'build',
      stage: 'BUILD',
    },
    revision: 1,
    selection: {
      primary: null,
      parametersFor: provider,
      model: selectedModel,
      effort: null,
    },
    failover: null,
    receipt: {
      requestId: 'fixture-saved',
      state: 'saved',
      reason: '',
    },
  }), { mode: 0o600 });
  await first.close();

  const reopened = await fx.open(runtime);
  const approval = await reopened.inject({
    method: 'POST',
    url: '/api/tasks/71/gate/GATE_ACCEPT/approve',
  });

  assert.equal(approval.statusCode, 200, approval.body);

  const runs = path.join(fx.config.stateDir, 'logs/runs/t71/BUILD');

  if (!approval.json().resumed) {
    const ids = await fs.readdir(runs).catch(() => []);
    const files = [path.join(fx.config.stateDir, 't71.launch.log'),
      ...ids.map((id) => path.join(runs, id, 'stderr.log'))];
    const logs = await Promise.all(files.map((file) => fs.readFile(file, 'utf8').catch(() => '')));

    assert.fail([approval.body, ...logs].join('\n'));
  }

  const [run, ...duplicates] = await fs.readdir(runs);

  assert.ok(run);

  const proof = await expectAttempt(fx.adapter, (value) => value.terminal === 'completed', 30_000)
    .catch(async (error) => {
      const terminalLog = path.join(fx.config.stateDir, 't71.launch.log');
      const providerLog = path.join(runs, run, 'stderr.log');
      const retained = await Promise.all([terminalLog, providerLog]
        .map((file) => fs.readFile(file, 'utf8').catch(() => 'журнала нет')));

      throw new Error(retained.join('\n'), { cause: error });
    });

  assert.equal(duplicates.length, 0);
  assert.equal(proof.attempt, waiting.attempt);

  const requestCount = await fs.readFile(path.join(runs, run, 'loopback.count'), 'utf8');
  const events = await fs.readFile(path.join(runs, run, 'events.jsonl'), 'utf8');
  const startedModel = events.trim().split('\n').map((line) => JSON.parse(line))
    .find((row) => row.event === `${provider}_start`)?.model;

  const expectedCount = cli ? '0\n' : expectBrowser ? '4\n' : '3\n';

  assert.equal(requestCount, expectedCount);
  assert.equal(browserCalls, expectBrowser ? 1 : 0);
  assert.equal(await fs.readFile(path.join(root, 'command.count'), 'utf8'), '1\n');

  const { registry } = await fx.adapter.readRegistry('71');

  assert.equal(registry.SIZE, 'M');
  assert.equal(registry.BUILD, 'done');
  assert.equal(registry.BUILD_COMMENT, 'Ответ loopback принят фабрикой');

  await expectLauncherExit(fx.config.stateDir);
  await assert.rejects(fs.access(path.join(fx.config.factoryControlDir, 'runner-processes/t71.active')),
    { code: 'ENOENT' });
  await reopened.close();
  assert.equal(startedModel, selectedModel);
  t.diagnostic(JSON.stringify({
    attempt: proof.attempt,
    run,
    routeHash: proof.routeHash,
    hostRequests: Number(requestCount),
    browserCalls,
    engineResults: 1,
  }));
}

/**
 * Выполняет штатный browser CLI через точный scope тестового исполнителя.
 * Модель и её секреты заменены локальной подменой CLI.
 */
async function prepareCliBrowserFixture(
  root: string, profilesDir: string, browser: string,
  provider: 'kimi' | 'claude' | 'codex', model: string, factory: string,
) {
  const profile = path.join(profilesDir, 'demo-profile/runners.env');
  const home = path.join(root, '.kimi-code');

  await fs.writeFile(profile, (await fs.readFile(profile, 'utf8')).replace(
    'PROJECT_RUNNER_PRIMARY=deepseek', `PROJECT_RUNNER_PRIMARY=${provider}`,
  ));

  if (provider === 'kimi') {
    await fs.mkdir(home, { mode: 0o700 });
    await fs.writeFile(path.join(home, 'config.toml'), '[thinking]\neffort = "high"\n');
  }

  const binary = provider === 'codex'
    ? await prepareCodexBrowserFixture(root, profilesDir, factory) : path.join(root, 'unit-bin', provider);

  await fs.writeFile(binary, [
    '#!/usr/bin/env bash',
    'set -eu',
    'if [[ "$1" == --version ]]; then printf "2.1.63\\n"; exit; fi',
    '[[ "${FACTORY_BROWSER_ENABLED:-}" == 1 ]] || { echo "browser capability отсутствует" >&2; exit 89; }',
    ...(provider === 'codex' ? [
      'prompt=$(cat)',
      '[[ "$prompt" == *"request --input-json"* ]] || exit 90',
      '[[ "$*" == *"network = { enabled = false }"* ]] || exit 91',
      `[[ "$*" == *${JSON.stringify(path.dirname(browser))}* ]] || exit 92`,
    ] : ['[[ "$2" == *"request --input-json"* ]] || exit 90']),
    ...(provider === 'claude' ? [
      'while [[ $# -gt 0 && $1 != --settings ]]; do shift; done',
      `grep -F -- ${JSON.stringify(browser + ' request:*')} "$2" >/dev/null || exit 91`,
    ] : []),
    `${JSON.stringify(process.execPath)} ${JSON.stringify(browser)} request --input-json '{"action":"list"}'`,
    'run_dir="$FACTORY_STATE/logs/runs/t$FACTORY_RUN_TASK/$FACTORY_RUN_STAGE/$FACTORY_RUN_ID"',
    'printf "%s\\n" 0 > "$run_dir/loopback.count"',
    `printf "%s\\n" '${JSON.stringify({ event: provider + '_start', model })}'`,
    '"$FACTORY_STATUS_BIN" stage-progress --task 71 --stage BUILD --run-id "$FACTORY_RUN_ID"'
      + ' --epoch "$FACTORY_RUN_EPOCH" SIZE M',
    '"$FACTORY_STATUS_BIN" stage-result --task 71 --stage BUILD --run-id "$FACTORY_RUN_ID"'
      + ' --epoch "$FACTORY_RUN_EPOCH" done "Ответ loopback принят фабрикой"',
  ].join('\n') + '\n', { mode: 0o700 });
}

/**
 * Объявляет restricted Codex в доверенном профиле и подготавливает его layout.
 * Нативный файл проверяет resolver, сама модель остаётся подменой.
 */
async function prepareCodexBrowserFixture(root: string, profilesDir: string, factory: string) {
  const home = path.join(root, 'codex-runtime');
  const binary = path.join(home, 'bin/codex');
  const native = path.join(home, 'node_modules/@openai/codex-linux-fixture/vendor/local/bin/codex');
  const node = path.join(root, 'runtime/node/bin/node');

  for (const file of [binary, native, node]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
  }

  await fs.link(factory, native);
  await fs.copyFile(process.execPath, node);
  await fs.symlink(binary, path.join(root, 'unit-bin/codex'));
  await fs.appendFile(path.join(profilesDir, 'demo-profile/profile.sh'), String.raw`
RUNNER_CODEX_RESTRICT_SHARED_STAND=1
profile_agent_control_start() {
  export PROFILE_AGENT_CONTROL_DIR="$HOME/agent-control"
  mkdir -m 700 "$PROFILE_AGENT_CONTROL_DIR"
}
profile_agent_control_stop() {
  rmdir "$PROFILE_AGENT_CONTROL_DIR"
}
`);

  return binary;
}

/**
 * Использует metadata штатного GLM helper с тестовым ELF.
 * Недоступная metadata должна остановить маршрут до любого loopback запроса.
 */
async function prepareGlmBrowserFixture(t: TestContext, profilesDir: string, scripts: string) {
  const oldMode = process.env.GRIGDESK_GLM_API_MODE;
  const metadata = new URL('../../server/scripts/glmRuntimeInfo.mts', import.meta.url);
  const profile = path.join(profilesDir, 'demo-profile/runners.env');

  process.env.GRIGDESK_GLM_API_MODE = 'api';
  t.after(() => {
    if (oldMode === undefined) {
      delete process.env.GRIGDESK_GLM_API_MODE;
    } else {
      process.env.GRIGDESK_GLM_API_MODE = oldMode;
    }
  });

  await fs.writeFile(profile, (await fs.readFile(profile, 'utf8')).replace(
    'PROJECT_RUNNER_PRIMARY=deepseek', 'PROJECT_RUNNER_PRIMARY=glm',
  ));
  await fs.writeFile(path.join(scripts, 'glmRuntimeInfo.mts'), [
    `await import(${JSON.stringify(metadata.href)});`,
  ].join('\n'));
}
