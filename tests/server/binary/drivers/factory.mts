import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import type { BinaryIsolationPaths } from '../isolation.mts';
import { startDeepSeekLoopback } from '../../../helpers/deepseekLoopback.mts';
import { startGlmLoopback } from '../../../helpers/glmLoopback.mts';
import { writeGlmEgressGuard } from '../../../helpers/glmEgressGuard.mts';
import { deepSeekFactoryPort, glmDeps } from './providerPorts.mjs';

const execute = promisify(execFile);
const requirePayload = createRequire(import.meta.url);
const EXPORTS = [
  'createGlmAdapter', 'runGlmTurn', 'runDeepSeekWebTurn', 'runDeepSeekTurn',
  'prepareDeepSeekLaunch', 'startDeepSeekServer', 'glmCompatibilityIdentity',
  'runDeepSeekFactory', 'runGlmFactory',
];
const KEYS = {
  DEEPSEEK_API_KEY: 's26-synthetic-deepseek-key',
  ZAI_API_KEY: 's26-synthetic-zai-key',
  ZAI_CODING_API_KEY: 's26-synthetic-coding-plan-key',
};

/**
 * Driver принимает production-порты снаружи и не собирает исходники провайдера.
 * Настоящий payload загружается только по абсолютному пути выбранного R.
 */
export async function loadFactoryVerification(payload: string, binary: string): Promise<any> {
  assert.equal(path.isAbsolute(payload), true);

  const module = requirePayload(payload);
  const api = typeof module.loadPackagedVerification === 'function'
    ? await module.loadPackagedVerification(binary) : {};
  const missing = EXPORTS.filter((name) => typeof api?.[name] !== 'function');

  if (missing.length) {
    throw Object.assign(new Error(`В payload отсутствуют compiled exports: ${missing.join(', ')}`), {
      code: 'factory_verification_exports_missing',
    });
  }

  return api;
}

/**
 * Исполняемые фикстуры получают явный режим и не опираются на umask процесса.
 * Родительский каталог создаётся только внутри переданного одноразового корня.
 */
async function executable(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { mode: 0o755 });
}

/**
 * Stub systemd читает EnvironmentFile и собирает окружение с нуля, как transient-юнит.
 * Успех возвращается только после исполнения переданной команды, её снимок проверяется отдельно.
 */
function systemdStub(record: string): string {
  return [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    'const { spawnSync } = require("node:child_process");',
    'const args = process.argv.slice(2);',
    'if (args[0] === "--version") process.exit(0);',
    'const env = {};',
    'let command;',
    'let mode;',
    'for (const [index, arg] of args.entries()) {',
    '  if (arg.startsWith("--setenv=")) {',
    '    const pair = arg.slice(9);',
    '    env[pair.slice(0, pair.indexOf("="))] = pair.slice(pair.indexOf("=") + 1);',
    '  } else if (arg.startsWith("--property=EnvironmentFile=")) {',
    '    const file = arg.slice("--property=EnvironmentFile=".length);',
    '    mode = fs.statSync(file).mode & 0o777;',
    '    for (const line of fs.readFileSync(file, "utf8").trim().split("\\n")) {',
    '      const separator = line.indexOf("=");',
    '      env[line.slice(0, separator)] = JSON.parse(line.slice(separator + 1));',
    '    }',
    '  } else if (!arg.startsWith("--")) {',
    '    command = args.slice(index);',
    '    break;',
    '  }',
    '}',
    'if (!command) process.exit(64);',
    'const result = spawnSync(command[0], command.slice(1), { env, stdio: "ignore" });',
    `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, mode, status: result.status }));`,
    'process.exit(result.status ?? 1);',
    '',
  ].join('\n');
}

/**
 * Detached spawn сообщает о старте раньше закрытия команды, поэтому ждём артефакт ребёнка.
 * Ограниченное ожидание заканчивается ошибкой; отсутствие снимка не превращается в skip.
 */
async function readJsonEventually(file: string): Promise<any> {
  for (let poll = 0; poll < 100; poll += 1) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    await sleep(25);
  }

  throw new Error(`Команда не опубликовала снимок: ${file}`);
}

/**
 * Проверка transient-юнита должна исполнить команду с явно собранным env.
 * Синтетические секреты передаются только через закрытый EnvironmentFile.
 */
export async function unitEnvironmentProbe(root: string, launch: any): Promise<any> {
  const bin = path.join(root, 'unit-bin');
  const capture = path.join(root, 'child.json');
  const record = path.join(root, 'unit.json');
  const factoryBin = path.join(root, 'engine/bin/factory');
  const saved = { ...process.env };
  const config = {
    rootDir: path.join(root, 'installation'),
    installationBin: path.join(root, 'installation/bin'),
    dataHome: path.join(root, 'D'),
    stateDir: path.join(root, 'state'),
    routesDir: path.join(root, 'routes'),
    factoryConfigRoot: path.join(root, 'config'),
    factoryControlDir: path.join(root, 'control'),
    factoryHome: path.join(root, 'engine'),
    profilesDir: path.join(root, 'profiles'),
    deepseekBin: path.join(root, 'installation/bin/deepseek'),
    deepseekCacheDir: path.join(root, 'deepseek-cache'),
    prefsPath: path.join(root, 'prefs.json'),
    factoryBin,
  };

  await executable(path.join(bin, 'systemd-run'), systemdStub(record));
  await executable(factoryBin, [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({`,
    '  argv: process.argv.slice(2), env: process.env, marker: "unit-command-executed",',
    '}));',
    '',
  ].join('\n'));

  try {
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    process.env.SB26_AMBIENT_POISON = 'ambient-must-not-cross-systemd';
    Object.assign(process.env, KEYS, { GRIGDESK_GLM_API_MODE: 'api' });

    const result = await launch(config, { task: 26, args: ['route', 'start', '26'] });

    assert.equal(result.ok, true, result.message);

    const child = await readJsonEventually(capture);
    const unit = await readJsonEventually(record);
    const secretFile = path.join(config.stateDir, 'route-secrets.env');
    const secretNames = (await fs.readFile(secretFile, 'utf8')).trim().split('\n')
      .map((line) => line.split('=')[0]).sort();

    assert.equal(unit.status, 0);
    assert.deepEqual(child.argv, ['route', 'start', '26']);
    assert.equal(child.env.DEEPSEEK_API_KEY, KEYS.DEEPSEEK_API_KEY);
    assert.equal(child.env.ZAI_API_KEY, KEYS.ZAI_API_KEY);

    return {
      executed: child.marker === 'unit-command-executed',
      environmentFileMode: unit.mode,
      ambientInherited: Object.hasOwn(child.env, 'SB26_AMBIENT_POISON'),
      secretInArgv: Object.values(KEYS).some((value) => JSON.stringify(unit.args).includes(value)),
      secretNames,
      codingPlanInherited: Object.hasOwn(child.env, 'ZAI_CODING_API_KEY'),
    };
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!Object.hasOwn(saved, key)) {
        delete process.env[key];
      }
    }

    Object.assign(process.env, saved);
  }
}

/**
 * Dispatcher использует настоящий catalog resolver и runner_codex_run.
 * Тестовая resolve-функция задаёт единственную цепочку, invoke сохраняет исход CLI в артефактах.
 */
function codexDispatchScript(): string {
  return [
    'set -uo pipefail',
    'source "$FACTORY_HOME/lib/dispatcher.sh"',
    'source "$FACTORY_HOME/lib/runners/codex.sh"',
    'source "$FACTORY_HOME/lib/runners/catalog.sh"',
    'runner_codex_probe > "$SB26_ROOT/probe.txt" || exit $?',
    'runner_codex_catalog > "$SB26_ROOT/catalog/models.tsv" || exit $?',
    'sb26_selected_model=$(catalog_resolve "$SB26_ROOT/catalog" codex sol latest auto 1.0.0) || exit $?',
    'resolve() {',
    '  DISPATCH_RESOLVED_FAMILY=sol',
    '  DISPATCH_RESOLVED_MODEL=$sb26_selected_model',
    '  DISPATCH_FAMILY_FAILOVER=""',
    '  DISPATCH_CREDENTIAL_FINGERPRINT=s26-synthetic-account',
    '}',
    'invoke() {',
    '  runner_codex_run 26 "synthetic prompt" BUILD "$3" high 10 "$SB26_ROOT/run"',
    '  DISPATCH_INVOKE_RESULT=$(runner_codex_classify "$SB26_ROOT/run" "$?")',
    '  DISPATCH_INVOKE_STARTED=1',
    '}',
    'dispatcher_run_chain 26 BUILD codex "" 1000 resolve invoke > "$SB26_ROOT/run/events.jsonl"',
    'rc=$?',
    'printf "%s\\n%s\\n%s\\n" "$rc" "$DISPATCH_RESULT_KIND" "$DISPATCH_RESULT_MODEL"',
    'exit "$rc"',
  ].join('\n');
}

/**
 * Проверка CLI проходит через каталог и dispatcher настоящего движка.
 * Единственный codex расположен в одноразовом nvm, GUI PATH его не содержит.
 */
export async function codexDispatcherProbe(root: string, engine: string, environment: any): Promise<any> {
  const home = path.join(root, 'home');
  const nodeBin = path.join(home, '.nvm/versions/node/v24.21.0/bin');
  const runtime = path.join(root, 'R');
  const capture = path.join(root, 'codex.json');

  for (const directory of ['catalog', 'run', 'D', 'I/bin', 'home/.codex', 'R/runtime/node/bin']) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
  }

  await fs.symlink(process.execPath, path.join(runtime, 'runtime/node/bin/node'));
  await executable(path.join(nodeBin, 'node'), [
    '#!/bin/sh',
    `SB26_NODE_MARKER=nvm-node exec ${JSON.stringify(process.execPath)} "$@"`,
    '',
  ].join('\n'));
  await executable(path.join(nodeBin, 'codex'), [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'if (process.argv.includes("--version")) {',
    '  process.stdout.write("codex-cli 1.0.0\\n");',
    '} else {',
    '  const argv = process.argv.slice(2);',
    '  if (argv[0] !== "exec") process.exit(65);',
    `  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({`,
    '    argv, node: process.env.SB26_NODE_MARKER, marker: "s26-codex-executed",',
    '  }));',
    '  fs.writeFileSync(argv[argv.indexOf("-o") + 1], "s26-codex-final\\n");',
    '  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1,',
    '    cached_input_tokens: 0, output_tokens: 1 } }) + "\\n");',
    '}',
    '',
  ].join('\n'));
  await fs.writeFile(path.join(home, '.codex/models_cache.json'), JSON.stringify({
    models: [{
      slug: 'gpt-6.1-sol',
      priority: 1,
      visibility: 'list',
    }],
  }));

  const env = await environment({
    root: runtime,
    installationBin: path.join(root, 'I/bin'),
    parent: {
      HOME: home,
      PATH: '/usr/bin:/bin',
      GRIGDESK_HOME: path.join(root, 'D'),
    },
    home,
  });
  const result = await execute('/bin/bash', ['-c', codexDispatchScript()], {
    cwd: root,
    env: {
      ...env,
      FACTORY_HOME: engine,
      STATE_DIR: path.join(root, 'state'),
      FACTORY_STATE: path.join(root, 'state'),
      FACTORY_TESTING: '1',
      SB26_ROOT: root,
    },
    timeout: 20_000,
  });
  const [code, outcome, model] = result.stdout.trim().split('\n');
  const command = JSON.parse(await fs.readFile(capture, 'utf8'));

  assert.equal(await fs.readFile(path.join(root, 'run/last.md'), 'utf8'), 's26-codex-final\n');
  assert.ok(command.argv.includes('gpt-6.1-sol'));

  return {
    dispatched: code === '0' && outcome === 'ok',
    model,
    nodeMarker: command.node,
    cliMarker: command.marker,
    localAlias: await fs.lstat(path.join(home, '.local/bin/codex')).then(() => true, () => false),
    override: Object.hasOwn(env, 'GRIGDESK_CODEX_BIN'),
  };
}

/**
 * Engine получает только собственные физические корни и ordinary Node из R.
 * Модельные ключи добавляются отдельно только wrapper-у, host-примитивы работают под offline guard.
 */
function engineEnvironment(paths: BinaryIsolationPaths): Record<string, string> {
  return {
    PATH: `/usr/bin:/bin:${path.dirname(process.execPath)}`,
    HOME: paths.home,
    LANG: 'C.UTF-8',
    GRIGDESK_HOME: paths.data,
    FACTORY_HOME: path.join(paths.runtime, 'engine'),
    FACTORY_STATE: paths.state,
    STATE_DIR: paths.state,
    FACTORY_CONTROL_ROOT: paths.control,
    FACTORY_CONFIG_ROOT: path.join(paths.data, 'config'),
    FACTORY_PROFILES_DIR: paths.profiles,
    FACTORY_TESTING: '1',
    FACTORY_FORBID_LIVE: '1',
    NODE_BIN: process.execPath,
    GRIGDESK_DEEPSEEK_NODE_BIN: process.execPath,
  };
}

/**
 * Bash выполняет штатные библиотеки закреплённого engine, без исходников checkout.
 * Ошибка сохраняет stderr и код; синтетический capability не передаётся в argv процесса.
 */
async function engineShell(paths: BinaryIsolationPaths, script: string, env: Record<string, string> = {}) {
  return execute('/bin/bash', ['-c', [
    'set -uo pipefail',
    'source "$FACTORY_HOME/lib/multi-runner.sh"',
    'source "$FACTORY_HOME/lib/status-request.sh"',
    script,
  ].join('\n')], {
    cwd: paths.project,
    env: { ...engineEnvironment(paths), ...env },
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
}

/**
 * Identity и capability создают штатные генераторы движка, эпоха берётся из trusted record.
 * Provider получает только request transport; token остаётся в host-части driver.
 */
async function beginStage(paths: BinaryIsolationPaths, task: string) {
  const { stdout } = await engineShell(paths, [
    'pipeline_store_route_init "$SB26_TASK" BUILD || exit $?',
    'factory_control_init "$(_multi_new_token)" || exit $?',
    'sb26_run=$(_multi_new_id)',
    'sb26_token=$(_multi_new_token)',
    'sb26_active=$(run_state_active_file "$SB26_TASK" BUILD)',
    'sb26_epoch=$(_run_state_get "$sb26_active" EPOCH)',
    'sb26_epoch=$((${sb26_epoch:-0} + 1))',
    'run_state_begin "$SB26_TASK" BUILD "$sb26_run" "$sb26_epoch" "$sb26_token" || exit $?',
    'printf "%s\\n%s\\n%s\\n" "$sb26_run" "$sb26_epoch" "$sb26_token"',
  ].join('\n'), { SB26_TASK: task });
  const [runId, epoch, token] = stdout.trim().split('\n');

  assert.ok(runId && epoch && token);

  const runDir = path.join(paths.state, 'logs/runs', `t${task}`, 'BUILD', runId);
  const requestDir = path.join(runDir, 'control-requests');
  const env = {
    ...engineEnvironment(paths),
    GRIGDESK_PROVIDER_PREFS_PATH: path.join(paths.data, 'prefs.json'),
    GRIGDESK_DEEPSEEK_RUNTIME_MODE: 'binary',
    GRIGDESK_DEEPSEEK_BIN: paths.deepseek,
    GRIGDESK_DEEPSEEK_CACHE_DIR: paths.deepseekCache,
    DEEPSEEK_API_KEY: KEYS.DEEPSEEK_API_KEY,
    GRIGDESK_GLM_API_MODE: 'api',
    ZAI_API_KEY: KEYS.ZAI_API_KEY,
    FACTORY_RUN_TASK: task,
    FACTORY_RUN_STAGE: 'BUILD',
    FACTORY_RUN_ID: runId,
    FACTORY_RUN_EPOCH: epoch,
    FACTORY_STATUS_MODE: 'request',
    FACTORY_STATUS_REQUEST_DIR: requestDir,
  };

  await fs.mkdir(requestDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(runDir, 'prompt.md'), 'Проверь fixture и заверши этап статусным MCP.\n', {
    mode: 0o600,
  });

  return {
    task,
    runId,
    epoch,
    token,
    runDir,
    requestDir,
    env,
  };
}

type Stage = Awaited<ReturnType<typeof beginStage>>;

/**
 * Аргументы wrapper берут реальные пути и identity начатого engine run.
 * Пара модели и effort принадлежат статическому каталогу соответствующего provider.
 */
function factoryArguments(paths: BinaryIsolationPaths, stage: Stage, provider: string, mode: string) {
  return [
    '--bin', paths.deepseek, '--cache-dir', paths.deepseekCache,
    '--cwd', paths.project, '--run-dir', stage.runDir,
    '--runtime-home', path.join(stage.runDir, 'runtime'),
    '--prompt-file', path.join(stage.runDir, 'prompt.md'),
    '--model', provider === 'deepseek' ? '["deepseek-official","deepseek-v4-flash"]' : '["zai","glm-5.3"]',
    '--effort', provider === 'deepseek' ? 'off' : 'high',
    '--mode', mode === 'state-only' ? 'read-only' : 'workspace-write',
  ];
}

/**
 * Нужный tool берётся из фактического inventory запроса модели, а не угадывается по имени.
 * Аргументы проходят настоящий DSH tool pipeline, MCP и штатные stage-result/progress.
 */
function toolReply(payload: any, suffix: string, args: Record<string, unknown>, index: number) {
  const tool = payload.tools?.find((entry: any) => entry.function?.name === suffix)
    ?? payload.tools?.find((entry: any) => entry.function?.name === `mcp__factory-status__${suffix}`);

  assert.ok(tool, `Настоящий DSH не объявил инструмент ${suffix}`);

  return {
    deltas: [{ tool_calls: [{
      index: 0,
      id: `s26-call-${index}`,
      type: 'function',
      function: { name: tool.function.name, arguments: JSON.stringify(args) },
    }] }],
    finishReason: 'tool_calls',
  };
}

/**
 * Снимок содержит только synthetic engine ledger и trusted active record.
 * Равенство bytes доказывает отсутствие мутации после отвергнутого capability/epoch.
 */
async function stageSnapshot(paths: BinaryIsolationPaths, stage: Stage): Promise<string> {
  const files = [
    path.join(paths.state, `t${stage.task}.pipeline`),
    path.join(paths.control, 'runs', `t${stage.task}`, 'BUILD.active'),
  ];
  const contents = await Promise.all(files.map((file) => fs.readFile(file)));

  return createHash('sha256').update(Buffer.concat(contents)).digest('hex');
}

/**
 * Неверные capability и epoch проверяются до consume и сохраняют ledger неизменным.
 * Валидный consume коммитит результат; повтор возвращает 75, не создавая второй terminal.
 */
async function commitStage(paths: BinaryIsolationPaths, stage: Stage) {
  const requests = (await fs.readdir(stage.requestDir)).filter((name) => name.endsWith('.request'));
  const before = await stageSnapshot(paths, stage);
  const values = { ...stage.env, SB26_TOKEN: stage.token };
  const { stdout } = await engineShell(paths, [
    'status_request_consume_all "$FACTORY_RUN_TASK" BUILD "$FACTORY_RUN_ID" "$FACTORY_RUN_EPOCH"',
    '  wrong-synthetic-token "$FACTORY_STATUS_REQUEST_DIR"',
  ].join(' \\\n'), values).then(() => ({ stdout: '0' }), (error: any) => ({ stdout: String(error.code) }));
  const wrongTokenCode = Number(stdout);
  const wrongEpoch = await engineShell(paths, [
    'run_state_apply_progress "$FACTORY_RUN_TASK" BUILD "$FACTORY_RUN_ID"',
    '  "$((FACTORY_RUN_EPOCH + 1))" "$SB26_TOKEN" SIZE L',
  ].join(' \\\n'), values).then(() => 0, (error: any) => Number(error.code));
  const rejectedStateUnchanged = await stageSnapshot(paths, stage) === before;
  const committed = await engineShell(paths, [
    'status_request_consume_all "$FACTORY_RUN_TASK" BUILD "$FACTORY_RUN_ID"',
    '  "$FACTORY_RUN_EPOCH" "$SB26_TOKEN" "$FACTORY_STATUS_REQUEST_DIR" || exit $?',
    'pipeline_store_get "$FACTORY_RUN_TASK" BUILD',
    'pipeline_store_get "$FACTORY_RUN_TASK" SIZE',
    'run_state_apply_result "$FACTORY_RUN_TASK" BUILD "$FACTORY_RUN_ID"',
    '  "$FACTORY_RUN_EPOCH" "$SB26_TOKEN" done duplicate',
    'printf "%s\\n" "$?"',
  ].join('\n').replaceAll('\n  ', ' \\\n  '), values);
  const [result, progress, repeated] = committed.stdout.trim().split('\n');

  assert.equal(repeated, '75');
  assert.equal(requests.length, 2, 'Ровно progress и один terminal request');

  const activeFile = path.join(paths.control, 'runs', `t${stage.task}`, 'BUILD.active');
  const active = await fs.readFile(activeFile, 'utf8');

  return {
    stage: result,
    progress,
    wrongTokenCode,
    wrongEpochCode: wrongEpoch,
    rejectedStateUnchanged,
    resultCount: active.split('\n').filter((line) => line === 'RESULT=done').length,
    runId: stage.runId,
    epoch: stage.epoch,
  };
}

/**
 * Хэшируются payload и каждый ESM helper из поставленного каталога, не исходный checkout.
 * Полный verifier ELF дополнительно сверяет их и остальные файлы по защищённому index.
 */
async function runtimeSnapshot(paths: BinaryIsolationPaths): Promise<string> {
  const helpers = path.join(paths.runtime, 'server/runtime/helpers');
  const files = (await fs.readdir(helpers)).filter((name) => name.endsWith('.mjs'))
    .map((name) => path.join(helpers, name));
  const hash = createHash('sha256');

  files.push(path.join(paths.runtime, 'server/payload.cjs'));

  for (const file of files.sort()) {
    hash.update(path.relative(paths.runtime, file));
    hash.update(await fs.readFile(file));
  }

  return hash.digest('hex');
}

/**
 * Обе обёртки вызывают production runTurn из того же CJS; DI содержит лишь модельный стенд.
 * Наблюдатель видит host context до вызова, но не может заменить опции или результат хода.
 */
export async function executeFactoryTurn(api: any, provider: string, argv: string[], env: any, input: {
  endpoint: string;
  info?: any;
  guard?: string;
  emit?: (event: any) => void;
  observe?: (options: any) => void;
}): Promise<void> {
  const emit = input.emit ?? (() => {});

  if (provider === 'deepseek') {
    const run = deepSeekFactoryPort(api, input.endpoint);

    await api.runDeepSeekFactory(argv, env, {
      emit,
      runTurn: (options: any) => {
        input.observe?.(options);

        return run(options);
      },
    });

    return;
  }

  assert.equal(provider, 'glm');

  const deps = glmDeps(api, input.info, input.endpoint, input.guard, env, '["zai","glm-5.3"]');

  await api.runGlmFactory(argv, env, {
    emit,
    runTurn: (options: any) => {
      input.observe?.(options);

      return api.runGlmTurn(options, deps);
    },
  });
}

/**
 * DeepSeek wrapper вызывает compiled ACP runtime с подменой только модельного endpoint.
 * Ответ модели сам по себе оставляет engine running до принятия двух status requests.
 */
async function deepseekStageProbe(paths: BinaryIsolationPaths, api: any) {
  const stage = await beginStage(paths, '261');
  const mock = await startDeepSeekLoopback({ respond: async (payload, index) => {
    if (index === 0) {
      return toolReply(payload, 'stage_progress', { updates: [{ key: 'SIZE', value: 'M' }] }, index);
    }

    if (index === 1) {
      return toolReply(payload, 'stage_result', { result: 'done', comment: 'S26 статус DeepSeek' }, index);
    }

    return { deltas: [{ content: 'S26-DEEPSEEK-REPLY' }] };
  } });
  const events: any[] = [];
  let realHelpers = false;

  try {
    const argv = factoryArguments(paths, stage, 'deepseek', 'workspace-write');

    await executeFactoryTurn(api, 'deepseek', argv, stage.env, {
      endpoint: mock.endpoint,
      emit: (event: any) => events.push(event),
      observe: (options: any) => {
        const [status] = options.mcpServers;

        realHelpers = status.command === process.execPath && status.args.length === 1
          && status.args[0] === path.join(paths.runtime, 'server/runtime/helpers/factory-status-mcp.mjs')
          && options.config.rootDir === paths.runtime;
      },
    });

    const pending = await fs.readFile(path.join(paths.state, 't261.pipeline'), 'utf8');

    assert.match(pending, /^BUILD=running$/mu, 'Текст модели не подменяет host consume');
    assert.equal(await fs.readFile(path.join(stage.runDir, 'last.md'), 'utf8'), 'S26-DEEPSEEK-REPLY');
    assert.equal(events.filter((event) => event.event === 'result').length, 1);

    return {
      ...await commitStage(paths, stage),
      requests: mock.payloads.length,
      realHelpers,
    };
  } finally {
    await mock.stop();
  }
}

/**
 * Сценарий GLM проверяет headless-вопрос, обе файловые границы и настоящий status MCP.
 * Каждый вызов выбирается из живого inventory; результат инструмента приходит следующему prompt.
 */
function glmScenario(paths: BinaryIsolationPaths, mode: string) {
  const calls: Array<[string, Record<string, unknown>]> = [
    ['ask_user_question', { questions: [{ id: 's26', question: 'Синтетический вопрос' }] }],
    ['write', { file_path: path.join(paths.project, `s26-${mode}.txt`), content: 'S26-WORKSPACE-WRITE' }],
    ['write', { file_path: path.join(paths.fixtures, `outside-${mode}.txt`), content: 'OUTSIDE' }],
    ['stage_progress', { updates: [{ key: 'SIZE', value: 'M' }] }],
    ['stage_result', { result: 'done', comment: `S26 GLM ${mode}` }],
  ];

  return (payload: any, index: number): any => index < calls.length
    ? { kind: 'stream', ...toolReply(payload, calls[index]![0], calls[index]![1], index) }
    : { kind: 'stream', deltas: [{ content: `S26-GLM-${mode}` }] };
}

/**
 * Наблюдатель читает реальные WS-кадры, сохраняя аргументы и результат оригинального emit.
 * Он не подменяет транспорт и позволяет связать hooks-alive с тем самым ходом wrapper-а.
 */
function observeGlmWire(paths: BinaryIsolationPaths) {
  const WebSocket = requirePayload(path.join(paths.runtime, 'server/node_modules/ws'));
  const original = WebSocket.prototype.emit;
  const events: any[] = [];

  WebSocket.prototype.emit = function (this: any, name: string, ...args: any[]) {
    if (name === 'message') {
      try {
        const frame = JSON.parse(String(args[0]));

        if (frame.type === 'item' && frame.value?.type === 'event') {
          events.push(frame.value.event);
        }
      } catch {}
    }

    return original.call(this, name, ...args);
  };

  return {
    events,
    restore: () => {
      WebSocket.prototype.emit = original;
    },
  };
}

/**
 * Описания hooks берутся из stderrSummary событий конкретного DSH хода.
 * Неразбираемый marker — ошибка стенда, текст финального ответа доказательством не служит.
 */
function hookDescriptors(events: any[]): any[] {
  return events.filter((event) => event.type === 'hook/result').flatMap((event) =>
    String(event.data?.stderrSummary ?? '').split('\n')
      .filter((line) => line.startsWith('GLM-POLICY '))
      .map((line) => JSON.parse(line.slice('GLM-POLICY '.length))));
}

/**
 * GLM wrapper и runTurn принадлежат одному payload, synthetic admission вычисляется из ELF.
 * Никакого replacement runTurn с готовым ответом или подсобной сборки провайдера здесь нет.
 */
async function glmStageProbe(paths: BinaryIsolationPaths, api: any, info: any, mode: string) {
  const stage = await beginStage(paths, mode === 'state-only' ? '262' : '263');
  const mock = await startGlmLoopback({
    expectedKey: KEYS.ZAI_API_KEY,
    respond: glmScenario(paths, mode),
  });
  const guard = await writeGlmEgressGuard(path.join(paths.fixtures, `glm-${mode}`));
  const events: any[] = [];
  const wire = observeGlmWire(paths);
  let realHelpers = false;

  try {
    await executeFactoryTurn(api, 'glm', factoryArguments(paths, stage, 'glm', mode), stage.env, {
      endpoint: mock.endpoint,
      info,
      guard,
      emit: (event: any) => events.push(event),
      observe: (options: any) => {
        const status = options.factoryContext.statusServer;

        realHelpers = status.command === process.execPath && status.args.length === 1
          && status.args[0] === path.join(paths.runtime, 'server/runtime/helpers/factory-status-mcp.mjs');
      },
    });

    const lastMessages = JSON.stringify(mock.requests.at(-1)?.payload.messages);
    const inside = path.join(paths.project, `s26-${mode}.txt`);
    const outside = path.join(paths.fixtures, `outside-${mode}.txt`);
    const hooks = hookDescriptors(wire.events);

    assert.equal(mock.requests.length, 6);
    assert.ok(mock.requests.every((request) => request.authorizationMatches && request.model === 'glm-5.3'));
    assert.equal(events.filter((event) => event.event === 'result').length, 1);
    assert.match(lastMessages, /Вопрос недоступен|denied|запрещ/iu);

    return {
      mode,
      ...await commitStage(paths, stage),
      hooksAlive: hooks.some((entry) => entry.marker === 'hooks-alive'),
      questionDenied: hooks.some((entry) => entry.kind === 'question' && entry.decision === 'deny'),
      writeSucceeded: await fs.readFile(inside, 'utf8').then((text) => text === 'S26-WORKSPACE-WRITE',
        () => false),
      outsideDenied: await fs.lstat(outside).then(() => false, () => true),
      requests: mock.requests.length,
      realHelpers,
      hookEvidence: hooks,
      toolEvidence: (mock.requests.at(-1)?.payload.messages as any[])
        ?.filter((message) => message.role === 'tool'),
    };
  } finally {
    wire.restore();
    await mock.stop();
  }
}

/**
 * Неподдержанный fanout отвергается штатным capability planner, policy — wrapper-ом.
 * Model port считает обращения: оба отказа обязаны предшествовать реальному runTurn.
 */
async function glmPreflightProbe(paths: BinaryIsolationPaths, api: any) {
  const requirements = path.join(paths.fixtures, 'fanout.env');

  await fs.writeFile(requirements, 'REQUIREMENTS_SCHEMA=1\nREQUIRED_CAPS=status,fanout\nDEGRADABLE_CAPS=\n');

  const plan = await engineShell(paths, [
    'source "$FACTORY_HOME/lib/runners/glm.sh"',
    'caps=$(runner_glm_capabilities | tr " " ",")',
    'execution_plan_build "$SB26_REQUIREMENTS" "$caps" ""',
  ].join('\n'), { SB26_REQUIREMENTS: requirements });
  const stage = await beginStage(paths, '264');
  const args = factoryArguments(paths, stage, 'glm', 'workspace-write');
  const index = args.indexOf('--mode');
  let requests = 0;

  args[index + 1] = 'full-access';

  await assert.rejects(api.runGlmFactory(args, stage.env, {
    emit: () => {},
    runTurn: async () => {
      requests += 1;

      throw new Error('Недопустимая policy достигла model port');
    },
  }), /режим не поддерживается/u);

  return {
    fanoutRejectedBeforeModel: /^PLAN_LEVEL=unavailable$/mu.test(plan.stdout)
      && /^PLAN_MISSING=fanout$/mu.test(plan.stdout) && requests === 0,
    policyRejectedBeforeModel: requests === 0,
  };
}

/**
 * Изоляция доказывается внутри того же namespace, где исполнились оба настоящих provider stage.
 * Отсутствие checkout/HOME и отдельных CLI проверяется ФС, host Node обязан сработать как tripwire.
 */
async function factoryIsolationProbe(paths: BinaryIsolationPaths, api: any, info: any) {
  const absent = (file: string) => fs.access(file).then(() => false, () => true);
  const sourceAbsent = await absent(paths.source);
  const hostHomeAbsent = await absent(paths.hostHome);

  assert.equal(sourceAbsent, true);
  assert.equal(hostHomeAbsent, true);
  assert.equal(await absent('/D/host-node-attempts'), true, 'Production не обращался к host Node');

  const deepseek = await deepseekStageProbe(paths, api);
  const glm = await glmStageProbe(paths, api, info, 'workspace-write');
  const engine = await engineShell(paths, 'printf "%s\\n" "$FACTORY_HOME"');
  const hostNodeCode = await execute('/host-bin/node', [], { env: { PATH: '' } })
    .then(() => 0, (error: any) => Number(error.code));

  assert.equal(await fs.readFile('/D/host-node-attempts', 'utf8'), 'called\n');
  assert.equal((await fs.stat(path.join(paths.runtime, 'schemas/analytics'))).isDirectory(), true);

  const tools = ['codex', 'glm', 'deepseek'];
  const separate = await Promise.all(tools.flatMap((name) => [
    absent(path.join(paths.installation, 'bin', name)),
    absent(path.join(paths.runtime, 'bin', name)),
  ]));

  return {
    sourceAbsent,
    hostHomeAbsent,
    hostNodeCode,
    physicalProfiles: await fs.realpath(paths.profiles) === paths.profiles
      && !(await fs.lstat(paths.profiles)).isSymbolicLink(),
    engineFromR: engine.stdout.trim() === path.join(paths.runtime, 'engine'),
    helpersFromR: deepseek.realHelpers && glm.realHelpers,
    externalDeepseek: await fs.realpath(paths.deepseek) === paths.deepseek
      && !paths.deepseek.startsWith(paths.runtime + '/'),
    separateCliAbsent: separate.every(Boolean),
    deepseek,
    glm,
  };
}

/**
 * Приёмка исполняется ordinary Node выбранного R внутри общего namespace B.
 * Каждый stage завершается через настоящий helper и engine consume; verifier закрывает index.
 */
export async function packagedFactoryProbe(paths: BinaryIsolationPaths, phase: string): Promise<any> {
  assert.equal(process.execPath, path.join(paths.runtime, 'runtime/node/bin/node'));

  const before = await runtimeSnapshot(paths);
  const api = await loadFactoryVerification(path.join(paths.runtime, 'server/payload.cjs'), paths.binary);
  const metadata = await execute(paths.deepseek, ['--runtime-info', '--json'], {
    env: { PATH: '' },
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  const info = JSON.parse(metadata.stdout);
  let report: any;

  if (phase === 'deepseek') {
    report = await deepseekStageProbe(paths, api);
  } else if (phase === 'glm') {
    const modes = [];

    for (const mode of ['state-only', 'workspace-write']) {
      modes.push(await glmStageProbe(paths, api, info, mode));
    }

    report = { modes, ...await glmPreflightProbe(paths, api) };
  } else if (phase === 'isolation') {
    report = await factoryIsolationProbe(paths, api, info);
  } else {
    throw new Error(`Неизвестная фаза S26: ${phase}`);
  }

  const verification = await execute(paths.binary, ['--verify', '--json'], {
    env: {
      HOME: paths.home,
      PATH: '',
      GRIGDESK_HOME: paths.data,
    },
    timeout: 30_000,
    maxBuffer: 65536,
  });

  assert.equal(JSON.parse(verification.stdout).ok, true);

  return { ...report, runtimeUnchanged: before === await runtimeSnapshot(paths) };
}

/**
 * Физический synthetic профиль использует собственный shared Git checkout и marker CLI.
 * Stand hooks не вызывают сеть/контейнеры, lifecycle-скрипты запрещают неожиданный запуск.
 */
async function prepareGateWorkspace(root: string, publish: any) {
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  const profiles = path.join(root, 'profiles');
  const profile = path.join(profiles, 'sample');
  const routes = path.join(root, 'routes');
  const bin = path.join(home, '.nvm/versions/node/v24.21.0/bin');
  const env = {
    HOME: home,
    PATH: '/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM: '1',
  };

  for (const directory of [home, repo, profile, routes, path.join(home, '.codex')]) {
    await fs.mkdir(directory, { recursive: true });
  }

  await execute('git', ['init', '-q', '-b', 'shared-main', repo], { env });
  await fs.writeFile(path.join(repo, 'fixture.txt'), 'Синтетический checkout ворот S26.\n');
  await execute('git', ['-C', repo, 'add', 'fixture.txt'], { env });
  await execute('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'fixture'], { env });
  await executable(path.join(bin, 'codex'), '#!/bin/sh\nprintf "codex-cli 1.0.0\\n"\n');

  for (const command of ['systemd-run', 'systemctl']) {
    await executable(path.join(bin, command), '#!/bin/sh\nexit 1\n');
  }

  await fs.writeFile(path.join(home, '.codex/models_cache.json'), JSON.stringify({
    models: [{
      slug: 'gpt-6.1-sol',
      priority: 1,
      visibility: 'list',
    }],
  }));
  await fs.writeFile(path.join(profile, 'graph.json'), '{"capabilities":["route-v2"]}\n');
  await fs.writeFile(path.join(profile, 'runners.env'), [
    'RUNNERS_SCHEMA=1', 'CONFIG_REVISION=1', 'RUNNERS_COVERAGE=required',
    'PROJECT_RUNNER_PRIMARY=codex', 'PROJECT_RUNNER_FAILOVER=',
    'MODEL_DEFAULT_CODEX_FAMILY=sol', 'MODEL_DEFAULT_CODEX_VERSION=latest',
    'MODEL_DEFAULT_CODEX_VARIANT=auto', 'MODEL_DEFAULT_CODEX_EFFORT=high', '',
  ].join('\n'));
  await fs.writeFile(path.join(profile, 'profile.sh'), [
    'PROFILE_NAME=sample', 'PROFILE_SERVICE_HOST=127.0.0.1',
    'profile_workspace_mode() { printf "shared\\n"; }',
    `profile_repositories() { printf 'app\\t%s\\t%s\\n' '${repo}' '${repo}'; }`,
    'profile_source_branch() { printf "shared-main\\n"; }',
    'profile_container() { printf "s26-synthetic-stand\\n"; }',
    'profile_stand_alive() { return 0; }',
    'profile_project_context() { printf \'%s\\n\' \'{"stack":["fixture"],"guardrails":[]}\'; }',
    'profile_service_ports() { printf "18830\\t18830\\n"; }',
    'profile_exclusive_resources() {',
    `  printf '%s\\n' 'stand:s26-synthetic-stand' 'workspace:${repo}'`,
    '}', '',
  ].join('\n'));

  for (const name of ['up.sh', 'down.sh']) {
    await executable(path.join(profile, name), '#!/bin/sh\nexit 97\n');
  }

  await publish(routes);

  return {
    home,
    repo,
    profiles,
    routes,
    bin,
  };
}

/**
 * Config имитирует реальные host paths текущего сервера, engine entrypoint остаётся штатным.
 * Managed R задаёт тот же runtime context, который payload выставляет без тестовой инъекции.
 */
function gateConfig(root: string, workspace: any, selection: any): any {
  return {
    dataHome: path.join(root, 'D'),
    routesDir: workspace.routes,
    stateDir: path.join(root, 'state'),
    factoryControlDir: path.join(root, 'control'),
    factoryConfigRoot: path.join(root, 'config'),
    profilesDir: workspace.profiles,
    rootDir: selection.runtimeRoot,
    factoryHome: selection.engineHome,
    factoryBin: selection.engineBin,
    installationBin: path.join(root, 'I/bin'),
    runtime: selection,
  };
}

/**
 * Поставленный Node и engine берутся из результата настоящего --prepare.
 * Nullable source/legacy сохраняет внешний physical root и не становится поколением для GC.
 */
function runtimeSelection(root: string, data: string, prepared?: any) {
  root = path.resolve(root);

  return {
    packageId: prepared?.packageId ?? null,
    runtimeRoot: root,
    engineHome: path.join(root, 'engine'),
    engineBin: path.join(root, 'engine/bin/factory'),
    node: prepared?.node ?? process.execPath,
    cacheDir: path.join(data, 'runtimes/server'),
  };
}

/**
 * Сравниваются immutable attempt/pins/route bytes, а terminal читается из настоящего ledger.
 * Authority pin находится по exact attempt внутри единственного физического control scope.
 */
async function gateEvidence(config: any, task: string, attempt: string) {
  const directory = path.join(config.factoryControlDir, 'protocol-v2/tasks', `t${task}`, 'attempts', attempt);
  const names = await fs.readdir(directory);
  const routePin = names.find((name) => name.startsWith('route-pin.') && name.endsWith('.json'));

  assert.ok(routePin);

  const files = ['attempt.json', 'pins.json', routePin];
  const hashes = await Promise.all(files.map(async (name) => createHash('sha256')
    .update(await fs.readFile(path.join(directory, name))).digest('hex')));
  const authorityRoot = path.join(config.factoryControlDir, 'server-runtimes');
  const scopes = await fs.readdir(authorityRoot);
  let authority: any;

  for (const scope of scopes) {
    const file = path.join(authorityRoot, scope, `${attempt}.json`);

    try {
      authority = JSON.parse(await fs.readFile(file, 'utf8'));
      break;
    } catch (error: any) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw error;
      }
    }
  }

  assert.ok(authority, 'Настоящая попытка обязана получить authority pin');

  return {
    directory,
    hashes,
    authority,
  };
}

/**
 * Старое A выходит на gate штатным CLI; миграционный resume nullable root закрепляет его до замены.
 * B коммитит ворота один раз, затем updated source выполняет rollback-resume того же engine A.
 */
async function gateCase(root: string, inputs: any, ports: any, origin: string) {
  const workspace = await prepareGateWorkspace(root, ports.publishGateRoutes);
  const data = path.join(root, 'D');
  const metadataB = await ports.probeServerBinary(inputs.binaryB);
  const preparedB = await ports.prepareServerBinary(inputs.binaryB, {
    home: data,
    expectPackageId: metadataB.packageId,
  });
  let preparedA: any;
  const originalEnv = { ...process.env };

  try {
    if (origin === 'binary-A') {
      const metadataA = await ports.probeServerBinary(inputs.binaryA);

      preparedA = await ports.prepareServerBinary(inputs.binaryA, {
        home: data,
        expectPackageId: metadataA.packageId,
      });
    }

    const aRoot = preparedA?.root ?? (origin === 'legacy-R' ? inputs.legacyRoot : inputs.sourceRoot);
    const selectionA = runtimeSelection(aRoot, data, preparedA);

    if (origin === 'legacy-R') {
      // Старый R не содержит schemas/analytics: прежний явный FACTORY_HOME указывает на source.
      // Его Node и runtime root сохраняются; новые payload defaults на v3 не распространяются.
      selectionA.engineHome = path.join(inputs.sourceRoot, 'engine');
      selectionA.engineBin = path.join(selectionA.engineHome, 'bin/factory');
      selectionA.node = path.join(aRoot, 'runtime/node/bin/node');
    }

    const selectionB = runtimeSelection(preparedB.root, data, preparedB);
    const configA = gateConfig(root, workspace, selectionA);
    const configB = gateConfig(root, workspace, selectionB);
    const task = '266';
    const ticketFile = path.join(root, 'ticket.json');

    for (const directory of [configA.stateDir, configA.factoryControlDir, configA.factoryConfigRoot]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    }

    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }

    Object.assign(process.env, {
      HOME: workspace.home,
      PATH: `${workspace.bin}:/usr/bin:/bin`,
      FACTORY_FORBID_LIVE: '0',
      NODE_BIN: selectionA.node,
      GRIGDESK_HOME: data,
      GIT_CONFIG_NOSYSTEM: '1',
    });
    await fs.writeFile(ticketFile, JSON.stringify({
      schema: 1,
      taskId: task,
      title: 'Синтетические ворота S26',
      description: 'Не выполнять модельные вызовы; сразу gate.',
      acceptanceCriteria: ['Сохранить immutable identity при смене сервера'],
      sourceUrl: 'https://example.invalid/fixture',
    }));

    const started = await ports.runRouteEngine(configA, ports.routeStartArgs(configA, {
      task,
      profile: 'sample',
      route: 'quick',
      ticketFile,
    }));

    assert.equal(started.ok, true, `${origin} start\n${JSON.stringify(started)}`);

    const pipeline = await fs.readFile(path.join(configA.stateDir, `t${task}.pipeline`), 'utf8');
    const attempt = /^ATTEMPT_ID=(a_[a-f0-9]{32})$/mu.exec(pipeline)?.[1];

    assert.ok(attempt);

    const identity = {
      task,
      profile: 'sample',
      attempt,
    };

    if (selectionA.packageId === null) {
      const migrated = await ports.runRouteEngine(configA, ports.routeResumeArgs(configA, identity));

      assert.equal(migrated.ok, true, `${origin} migration\n${migrated.stdout}\n${migrated.stderr}`);
    }

    if (preparedA) {
      await ports.releaseServerPreparation(inputs.binaryA, {
        home: data,
        packageId: preparedA.packageId,
        token: preparedA.preparationToken,
      });
      preparedA = undefined;
    }

    return await gateReplacement(root, inputs, ports, {
      origin,
      selectionA,
      configA,
      configB,
      identity,
      before: await gateEvidence(configA, task, attempt),
    });
  } finally {
    for (const [binary, prepared] of [[inputs.binaryA, preparedA], [inputs.binaryB, preparedB]]) {
      if (prepared) {
        await ports.releaseServerPreparation(binary, {
          home: data,
          packageId: prepared.packageId,
          token: prepared.preparationToken,
        });
      }
    }

    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }

    Object.assign(process.env, originalEnv);
  }
}

/**
 * Подготовленная команда B должна указывать на A до любого gate/resume effect.
 * GC запускается при незавершённой попытке и истёкшем retention, чтобы pin был необходим.
 */
async function gateReplacement(root: string, inputs: any, ports: any, context: any) {
  const { origin, selectionA, configA, configB, identity, before } = context;
  const gateArgs = ports.routeGateArgs(configB, {
    ...identity,
    node: 'gate_accept',
    decision: 'approved',
  });
  const preparedGate = await ports.prepareFactoryRouteLaunch(configB, gateArgs);
  const expectedBrowser = path.join(selectionA.runtimeRoot,
    selectionA.packageId === null ? 'server/src/lib/browser/factoryBrowserCli.ts'
      : 'server/runtime/helpers/factory-browser.mjs');

  if (origin === 'legacy-R') {
    assert.equal(preparedGate.config.runtimeHostEnv.GRIGDESK_BROWSER_HELPER, '');
  } else {
    assert.equal(preparedGate.config.runtimeHostEnv.GRIGDESK_BROWSER_NODE, selectionA.node);
    assert.equal(preparedGate.config.runtimeHostEnv.GRIGDESK_BROWSER_HELPER, expectedBrowser);
  }

  let gcRetainsA = origin !== 'binary-A';
  let gcReason: string | undefined;

  if (origin === 'binary-A') {
    const cacheDir = selectionA.cacheDir;
    const then = Date.UTC(2030, 0, 1);

    await ports.recordServerRuntimeUsage({
      cacheDir,
      packageId: 'c'.repeat(64),
      now: then,
    });
    await ports.recordServerRuntimeUsage({
      cacheDir,
      packageId: configB.runtime.packageId,
      now: then,
    });

    const gc = await ports.pruneServerCache({ cacheDir, now: then + 8 * 86400_000 });
    const retained = gc.retained.find((item: any) => item.packageId === selectionA.packageId);

    gcReason = retained?.reason;
    gcRetainsA = retained?.reason === 'attempt-pin' && !gc.deleted.includes(selectionA.packageId);

    assert.ok(gcRetainsA, JSON.stringify(gc));
  }

  const serverB = await acceptGateWithBinary(inputs.binaryB, configB, identity);

  assert.equal(serverB.httpStatus, 200);
  assert.equal(serverB.packageId, configB.runtime.packageId);

  const rollback = {
    ...configA,
    rootDir: inputs.sourceRoot,
    factoryHome: path.join(inputs.sourceRoot, 'engine'),
    factoryBin: path.join(inputs.sourceRoot, 'engine/bin/factory'),
  };

  delete rollback.runtime;

  const rollbackArgs = ports.routeResumeArgs(rollback, identity);
  const preparedRollback = await ports.prepareFactoryRouteLaunch(rollback, rollbackArgs);
  const rolledBack = await ports.runRouteEngine(rollback, rollbackArgs);

  assert.equal(rolledBack.ok, true, `${origin} rollback\n${JSON.stringify(rolledBack)}`);

  const after = await gateEvidence(configA, identity.task, identity.attempt);
  const results = path.join(after.directory, 'stage-results');
  const terminal = await Promise.all((await fs.readdir(results)).filter((name) => name.startsWith('event.'))
    .map(async (name) => JSON.parse(await fs.readFile(path.join(results, name), 'utf8'))));

    if (origin !== 'legacy-R') {
      const preflight = await ports.prepareFactoryRouteLaunch(configA,
        ['267', 'start', '--profile', 'sample']);

      assert.equal(preflight.config.runtimeHostEnv.GRIGDESK_BROWSER_NODE, selectionA.node);
      assert.ok(preflight.config.runtimeHostEnv.GRIGDESK_BROWSER_HELPER.includes('factory-browser'));

      if (selectionA.packageId !== null) {
        assert.ok(preflight.config.runtimeHostEnv.GRIGDESK_SERVER_RUNTIME_RESERVATION);
      }
    }

  return {
    origin,
    attempt: identity.attempt,
    attemptUnchanged: before.hashes[0] === after.hashes[0],
    catalogUnchanged: before.hashes.slice(1).join(':') === after.hashes.slice(1).join(':'),
    enginePinned: preparedGate.config.factoryBin === selectionA.engineBin
      && after.authority.engineBin === selectionA.engineBin,
    rollbackPinned: preparedRollback.config.factoryBin === selectionA.engineBin,
    gateResults: terminal.filter((event) => event.outcome === 'approved').length,
    hashes: after.hashes,
    engine: after.authority.engineBin,
    legacyExplicitEngine: origin === 'legacy-R',
    serverB,
    gcRetainsA,
    gcReason,
  };
}

/**
 * TCP-порт выделяется только на loopback и освобождается непосредственно перед spawn.
 * Системные службы и порты живого GrigDesk в этой фикстуре не используются.
 */
async function loopbackPort(): Promise<number> {
  const server = createServer();

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();

  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  return address.port;
}

/**
 * API текущего ELF получает ровно те state/control/profiles, с которыми остановился A.
 * Ключ CLI создаёт сам сервер внутри synthetic D; systemd-команды перекрыты own stubs.
 */
async function acceptGateWithBinary(binary: string, config: any, identity: any) {
  const port = await loopbackPort();
  const data = config.dataHome;
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: 'C.UTF-8',
    XDG_CACHE_HOME: path.join(data, 'xdg/cache'),
    XDG_CONFIG_HOME: path.join(data, 'xdg/config'),
    XDG_DATA_HOME: path.join(data, 'xdg/data'),
    GRIGDESK_HOME: data,
    GRIGDESK_HOST: '127.0.0.1',
    GRIGDESK_PORT: String(port),
    GRIGDESK_MOBILE_PORT: String(await loopbackPort()),
    GRIGDESK_ROUTES_DIR: config.routesDir,
    GRIGDESK_WINDOW_KEY_PATH: path.join(data, 'window-auth/window-key'),
    GRIGDESK_CLI_TOKEN_PATH: path.join(data, 'state/cli-token'),
    FACTORY_STATE_DIR: config.stateDir,
    FACTORY_CONTROL_ROOT: config.factoryControlDir,
    FACTORY_CONFIG_ROOT: config.factoryConfigRoot,
    FACTORY_PROFILES_DIR: config.profilesDir,
    FACTORY_FORBID_LIVE: '0',
    NODE_ENV: 'production',
  };
  const child = spawn(binary, ['--expect-package-id', config.runtime.packageId], {
    env,
    cwd: '/',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  let log = '';

  void exited.catch(() => {});
  child.stdout.on('data', (chunk) => {
    log = (log + String(chunk)).slice(-16_384);
  });
  child.stderr.on('data', (chunk) => {
    log = (log + String(chunk)).slice(-16_384);
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    let token = '';
    let packageId: string | undefined;

    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try {
        token = (await fs.readFile(path.join(data, 'state/cli-token'), 'utf8')).trim();

        const response = await fetch(base + '/api/system/version', {
          headers: { 'x-grigdesk-token': token },
          signal: AbortSignal.timeout(500),
        });

        if (response.status === 200) {
          const status: any = await response.json();

          packageId = status.running?.packageId;
          break;
        }
      } catch {}

      await sleep(25);
    }

    assert.equal(packageId, config.runtime.packageId, log);

    const response = await fetch(base + `/api/tasks/${identity.task}/gate/GATE_ACCEPT/approve`, {
      method: 'POST',
      headers: { 'x-grigdesk-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ profile: identity.profile, attempt: identity.attempt }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();

    assert.equal(response.status, 200, body + '\n' + log);
    await waitForNextGate(config, identity);

    return { httpStatus: response.status, packageId };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }

    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);

    try {
      assert.equal(await exited, 0, log);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Detached resume от API должен дойти до следующего настоящего human gate и выйти.
 * Ожидание читает trusted cursor, а не оптимистическую pipeline-проекцию HTTP handler-а.
 */
async function waitForNextGate(config: any, identity: any): Promise<void> {
  const runtime = path.join(config.factoryControlDir, 'protocol-v2/tasks', `t${identity.task}`,
    'attempts', identity.attempt, 'stage-results/runtime.json');
  const deadline = Date.now() + 30_000;
  let state: any;

  while (Date.now() < deadline) {
    state = JSON.parse(await fs.readFile(runtime, 'utf8'));

    if (state.runtime?.cursor?.currentNode === 'gate_plan' && state.runtime.cursor.state === 'paused') {
      const pipeline = await fs.readFile(path.join(config.stateDir, `t${identity.task}.pipeline`), 'utf8');

      if (/^ORCH_PID=$/mu.test(pipeline)) {
        return;
      }
    }

    await sleep(50);
  }

  throw new Error(`Продолжение B не достигло gate_plan: ${JSON.stringify(state)}`);
}

/**
 * Host-часть приёмки связывает source/legacy и оба настоящих ELF через общую папку данных.
 * Production-порты передаются тестом, поэтому driver не встраивает checkout в namespace bundle.
 */
export async function gateResumeProbe(root: string, inputs: any, ports: any): Promise<any> {
  const cases = [];

  for (const origin of ['binary-A', 'legacy-R', 'source']) {
    const directory = path.join(root, origin);

    await fs.mkdir(directory);

    try {
      cases.push(await gateCase(directory, inputs, ports, origin));
    } catch (error) {
      if (inputs.diagnostics) {
        for (const name of ['state', 'control', 'profiles']) {
          const target = path.join(inputs.diagnostics, origin, name);

          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.cp(path.join(directory, name), target, { recursive: true, force: true }).catch(() => {});
        }
      }

      throw error;
    }
  }

  return { cases, gcRetainsA: cases[0]!.gcRetainsA };
}

if (process.argv[2]?.startsWith('{')) {
  const paths = JSON.parse(process.argv[2]) as BinaryIsolationPaths;
  const phase = JSON.parse(await fs.readFile(path.join(paths.data, 's26-phase.json'), 'utf8'));
  const report = await packagedFactoryProbe(paths, phase);

  console.log('BINARY_REPORT ' + JSON.stringify(report));
}
