import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { build } from '../../../server/node_modules/esbuild/lib/main.js';
import {
  routeGateArgs,
  routeResumeArgs,
  routeStartArgs,
  runRouteEngine,
  spawnRouteEngine,
} from '../../../server/src/lib/factoryRouteCli.ts';
import { prepareFactoryRouteLaunch } from '../../../server/src/lib/factoryLaunch.ts';
import { packagedLaunchEnvironment } from '../../../server/src/lib/seaLaunch.ts';
import { pruneServerCache, recordServerRuntimeUsage } from '../../../server/src/binary/prune.ts';
import {
  prepareServerBinary,
  probeServerBinary,
  releaseServerPreparation,
} from '../../../shared/node/serverBinaryRuntime.ts';
import { RoutesStore } from '../../../server/src/modules/routes/store.ts';
import { initializeDeepSeekAcp } from '../../../server/src/lib/deepseek/nativeSettingsRpc.ts';
import { makeCatalogInput } from '../../fixtures/routes-editor.mjs';
import { isolatedBinary } from './isolation.mts';
import {
  codexDispatcherProbe,
  executeFactoryTurn,
  gateResumeProbe,
  loadFactoryVerification,
  unitEnvironmentProbe,
} from './drivers/factory.mts';

const SOURCE = fileURLToPath(new URL('../../../', import.meta.url));
const RUN = path.resolve(SOURCE, '..');

/**
 * Все самостоятельные проверки получают отдельный HOME внутри одноразового корня.
 * Cleanup касается только созданных тестом файлов, установленное приложение не используется.
 */
async function fixture(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'server-s26-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  return root;
}

test('SB26-driver-graph: driver не встраивает production source и относительные externals', async () => {
  const result = await build({
    entryPoints: ['tests/server/binary/drivers/factory.mts'],
    absWorkingDir: SOURCE,
    write: false,
    metafile: true,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'external',
    logLevel: 'silent',
  });
  const forbidden = Object.keys(result.metafile.inputs).filter((file) =>
    /(?:^|\/)(?:server\/(?:src|scripts)|deepseek\/src)\//u.test(file.replaceAll('\\', '/')));
  const externalPaths = Object.values(result.metafile.outputs).flatMap((output) => output.imports)
    .filter((item) => item.external && (item.path.startsWith('.') || path.isAbsolute(item.path)));

  assert.deepEqual(forbidden, []);
  assert.deepEqual(externalPaths, []);
});

test('SB26-exports: отсутствие compiled wrapper отклоняется до модельной сети', async (t) => {
  const root = await fixture(t);
  const payload = path.join(root, 'payload.cjs');

  await fs.writeFile(payload, 'exports.loadPackagedVerification = async () => ({});\n');

  await assert.rejects(loadFactoryVerification(payload, '/I/bin/grigdesk-server'), {
    code: 'factory_verification_exports_missing',
  });
});

test('SB26-acp-startup: один initialize включает холодный запуск, ошибки не повторяются', async () => {
  const calls: any[] = [];
  const reply = { protocolVersion: 1 };
  const client = {
    closed: false,
    notify: () => {},
    close: () => {},
    request: async (method: string, params?: unknown, timeoutMs?: number) => {
      calls.push({
        method,
        params,
        timeoutMs,
      });

      return reply;
    },
  };

  assert.equal(await initializeDeepSeekAcp(client), reply);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'initialize');
  assert.equal(calls[0].timeoutMs, 120_000);

  for (const message of ['ACP timeout: initialize', 'ACP timeout: session/prompt', 'invalid parameters']) {
    let attempts = 0;
    const error = new Error(message);

    await assert.rejects(initializeDeepSeekAcp({
      ...client,
      request: async () => {
        attempts += 1;

        throw error;
      },
    }), (actual: unknown) => actual === error);
    assert.equal(attempts, 1, 'Ошибочный handshake не отправляется повторно');
  }

  const controller = new AbortController();

  controller.abort();
  await assert.rejects(initializeDeepSeekAcp(client, controller.signal), { name: 'AbortError' });
  assert.equal(calls.length, 1, 'Отмена до запуска не пишет stdin');
});

test('SB26-driver-ports: CJS spies подтверждают wrapper, prepareLaunch и GLM admission', async (t) => {
  const root = await fixture(t);
  const payload = path.join(root, 'ports.cjs');
  const overlay = path.join(root, 'launch.yml');

  await fs.writeFile(overlay, '# native fixture overlay\n');
  await fs.writeFile(payload, [
    'const calls = [];',
    'const api = { calls };',
    'for (const name of ["createGlmAdapter", "runDeepSeekWebTurn", "startDeepSeekServer"]) {',
    '  api[name] = () => { calls.push(name); };',
    '}',
    'api.prepareDeepSeekLaunch = async () => {',
    '  calls.push("prepareDeepSeekLaunch");',
    `  return { overlayPath: ${JSON.stringify(overlay)}, opaqueHandle: "preserved" };`,
    '};',
    'api.runDeepSeekTurn = async (options) => {',
    '  calls.push("runDeepSeekTurn");',
    `  const config = { deepseekCacheDir: ${JSON.stringify(root)} };`,
    '  const launch = await options.deps.prepareLaunch({ config,',
    '    runtime: { kind: "binary", metadata: { packageId: "a".repeat(64) } } });',
    '  if (launch.opaqueHandle !== "preserved") throw new Error("opaque handle lost");',
    '};',
    'api.runDeepSeekFactory = async (_argv, _env, deps) => {',
    '  calls.push("runDeepSeekFactory");',
    '  await deps.runTurn({ message: "fixture" });',
    '};',
    'api.glmCompatibilityIdentity = (inputs, mode) => {',
    '  calls.push("glmCompatibilityIdentity:" + mode + ":" + inputs.llmPiAi);',
    '  return "synthetic-admission";',
    '};',
    'api.runGlmFactory = async (_argv, _env, deps) => {',
    '  calls.push("runGlmFactory");',
    '  await deps.runTurn({ factory: true });',
    '};',
    'api.runGlmTurn = async (options, deps) => {',
    '  if (!options.factory || deps.admission[0].compatibility !== "synthetic-admission") {',
    '    throw new Error("admission wiring lost");',
    '  }',
    '  calls.push("runGlmTurn:" + deps.modelEndpoint);',
    '};',
    'exports.loadPackagedVerification = async (binary) => {',
    '  calls.push("configure:" + binary);',
    '  return api;',
    '};',
  ].join('\n'));

  const api = await loadFactoryVerification(payload, '/I/bin/fixture');

  await executeFactoryTurn(api, 'deepseek', [], {}, { endpoint: 'http://127.0.0.1:1' });
  await executeFactoryTurn(api, 'glm', [], {}, {
    endpoint: 'http://127.0.0.1:2',
    info: { glm: { inputs: { llmPiAi: 'test-plugin' } } },
    guard: path.join(root, 'guard.mjs'),
  });

  assert.deepEqual(api.calls, [
    'configure:/I/bin/fixture', 'runDeepSeekFactory', 'runDeepSeekTurn', 'prepareDeepSeekLaunch',
    'glmCompatibilityIdentity:api:test-plugin', 'runGlmFactory', 'runGlmTurn:http://127.0.0.1:2',
  ]);
});

test('SB26-unit-env: systemd-run исполняет команду и получает ключи только файлом', async (t) => {
  const root = await fixture(t);
  const report = await unitEnvironmentProbe(root, spawnRouteEngine);

  assert.equal(report.executed, true, 'настоящая detached command обязана исполниться');
  assert.equal(report.environmentFileMode, 0o600);
  assert.equal(report.ambientInherited, false);
  assert.equal(report.secretInArgv, false);
  assert.deepEqual(report.secretNames, ['DEEPSEEK_API_KEY', 'ZAI_API_KEY']);
  assert.equal(report.codingPlanInherited, false);
});

test('SB26-codex-path: GUI PATH находит nvm-only codex через catalog и dispatcher', async (t) => {
  const root = await fixture(t);
  const report = await codexDispatcherProbe(root, path.join(SOURCE, 'engine'), packagedLaunchEnvironment);

  assert.equal(report.dispatched, true, 'dispatcher обязан исполнить CLI, а не только probe');
  assert.equal(report.model, 'gpt-6.1-sol');
  assert.equal(report.nodeMarker, 'nvm-node');
  assert.equal(report.cliMarker, 's26-codex-executed');
  assert.equal(report.localAlias, false);
  assert.equal(report.override, false);
});

/**
 * Namespace принадлежит общей фикстуре B; A выбирает только phase тестового driver.
 * Явные ELF обязательны, чтение установленной поставки и скрытый build отсутствуют.
 */
async function packagedPhase(t: TestContext, phase: string): Promise<any> {
  const candidate = process.env.GRIGDESK_TEST_SERVER_BINARY;
  const deepseekBinary = process.env.GRIGDESK_TEST_DEEPSEEK_BINARY;

  assert.ok(candidate, 'Для S26 нужен явный GRIGDESK_TEST_SERVER_BINARY');
  assert.ok(deepseekBinary, 'Для S26 нужен явный GRIGDESK_TEST_DEEPSEEK_BINARY');

  const built = JSON.parse(await fs.readFile(path.join(RUN, 'release/build-result.json'), 'utf8'));
  const sha256 = await hashFile(candidate);

  assert.equal(sha256, built.sha256, 'Приёмка требует текущий candidate SHA');

  const fixture = await isolatedBinary(t, { candidate, deepseekBinary });

  await fs.writeFile(path.join(fixture.data, 's26-phase.json'), JSON.stringify(phase));

  const report = await fixture.run(path.join(import.meta.dirname, 'drivers/factory.mts'), {
    timeoutMs: 240_000,
  });

  assert.equal(await hashFile(candidate), sha256, 'ELF не должен смениться во время приёмки');
  assert.equal(fixture.paths.packageId, built.packageId);
  await fs.writeFile(path.join(RUN, `s26-${phase}.json`), JSON.stringify({
    sha256,
    packageId: built.packageId,
    deepseekSha256: await hashFile(deepseekBinary),
    ...report,
  }, null, 2));

  return report;
}

/**
 * Потоковое хеширование не держит ELF целиком в памяти сторожа.
 * SHA фиксирует конкретные bytes кандидата до и после процесса namespace.
 */
async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');

  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

test('SB26-deepseek: настоящие progress/result принимаются engine, неправильный token отвергнут', {
  timeout: 260_000,
}, async (t) => {
  const report = await packagedPhase(t, 'deepseek');

  assert.equal(report.stage, 'done', 'только status MCP завершает настоящий этап DeepSeek');
  assert.equal(report.progress, 'M');
  assert.equal(report.wrongTokenCode, 74);
  assert.equal(report.wrongEpochCode, 73);
  assert.equal(report.rejectedStateUnchanged, true);
  assert.ok(report.requests >= 3);
  assert.equal(report.resultCount, 1);
  assert.equal(report.realHelpers, true);
  assert.equal(report.runtimeUnchanged, true);
});

test('SB26-glm: оба режима ФС завершают этап, политика и вопрос не обходят host', {
  timeout: 260_000,
}, async (t) => {
  const report = await packagedPhase(t, 'glm');

  assert.deepEqual(report.modes?.map((item: any) => item.mode), ['state-only', 'workspace-write']);

  for (const mode of report.modes ?? []) {
    assert.equal(mode.stage, 'done');
    assert.equal(mode.progress, 'M');
    assert.equal(mode.hooksAlive, true);
    assert.equal(mode.questionDenied, true);
    assert.equal(mode.writeSucceeded, mode.mode === 'workspace-write');
    assert.equal(mode.outsideDenied, true);
    assert.equal(mode.resultCount, 1);
    assert.equal(mode.realHelpers, true);
  }

  assert.equal(report.fanoutRejectedBeforeModel, true);
  assert.equal(report.policyRejectedBeforeModel, true);
  assert.equal(report.runtimeUnchanged, true);
});

test('SB26-isolation: provider stages используют только R, физические profiles и внешний DSH ELF', {
  timeout: 260_000,
}, async (t) => {
  const report = await packagedPhase(t, 'isolation');

  assert.equal(report.sourceAbsent, true);
  assert.equal(report.hostHomeAbsent, true);
  assert.equal(report.hostNodeCode, 97);
  assert.equal(report.physicalProfiles, true);
  assert.equal(report.engineFromR, true);
  assert.equal(report.helpersFromR, true);
  assert.equal(report.externalDeepseek, true);
  assert.equal(report.separateCliAbsent, true);
  assert.equal(report.runtimeUnchanged, true);
});

/**
 * Gate-only маршрут публикуется настоящим immutable store, bootstrap пропускается по контракту.
 * Ворота и terminal проходят полный factory CLI; fixture не заменяет engine entrypoint.
 */
async function publishGateRoutes(directory: string): Promise<void> {
  const content = makeCatalogInput();
  const route: any = content.routes.quick.route;
  const gate = route.nodes.find((node: any) => node.id === 'gate_accept');

  assert.ok(gate);

  const secondGate = {
    ...structuredClone(gate),
    id: 'gate_plan',
    runKey: 'GATE_PLAN',
    on: { approved: { stop: 'done' }, rejected: { stop: 'human' } },
  };

  gate.on = { approved: { next: 'gate_plan' }, rejected: { stop: 'human' } };
  route.nodes = [gate, secondGate];
  route.entry = 'gate_accept';
  route.sequence = { main: ['gate_accept', 'gate_plan'], tail: [] };
  route.bootstrap = 'skip';

  const store = new RoutesStore({ baseDir: directory });
  const published = await store.publishRoute('sample', 'quick', { route, prompts: {} });

  await store.publishCatalog('sample', {
    catalog: {
      schema: 2,
      profile: 'sample',
      routes: { quick: published.routeHash },
      bootstrap: { file: 'bootstrap/scout.json' },
    },
    bootstrap: content.bootstrap,
    prompts: content.bootstrapPrompts,
  }, { expectedCatalogHash: null });
}

test('SB26-gates: настоящий factory сохраняет pin A и attempt/catalog при B и rollback', {
  timeout: 360_000,
}, async (t) => {
  const root = await fixture(t);
  const candidate = process.env.GRIGDESK_TEST_SERVER_BINARY;

  assert.ok(candidate, 'Нужен явный текущий candidate B');

  const built = JSON.parse(await fs.readFile(path.join(RUN, 'release/build-result.json'), 'utf8'));
  const sha256 = await hashFile(candidate);

  assert.equal(sha256, built.sha256);

  const report = await gateResumeProbe(root, {
    binaryB: candidate,
    binaryA: path.join(RUN, 'release/candidate-A/grigdesk-server'),
    legacyRoot: path.join(RUN, 'build-cache/baseline-release'),
    sourceRoot: SOURCE,
    diagnostics: path.join(RUN, 's26-gates-debug'),
  }, {
    prepareServerBinary,
    probeServerBinary,
    releaseServerPreparation,
    runRouteEngine,
    prepareFactoryRouteLaunch,
    routeGateArgs,
    routeResumeArgs,
    routeStartArgs,
    pruneServerCache,
    recordServerRuntimeUsage,
    publishGateRoutes,
  });

  assert.equal(await hashFile(candidate), sha256);
  await fs.writeFile(path.join(RUN, 's26-gates.json'), JSON.stringify({
    sha256,
    packageId: built.packageId,
    ...report,
  }, null, 2));

  assert.deepEqual(report.cases?.map((item: any) => item.origin), ['binary-A', 'legacy-R', 'source']);

  for (const item of report.cases ?? []) {
    assert.equal(item.attemptUnchanged, true);
    assert.equal(item.catalogUnchanged, true);
    assert.equal(item.enginePinned, true);
    assert.equal(item.rollbackPinned, true);
    assert.equal(item.gateResults, 1);
  }

  assert.equal(report.gcRetainsA, true, 'GC удерживает A именно по незавершённой попытке');
});
