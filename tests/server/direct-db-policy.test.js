import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createToolbox } from '../../server/src/lib/executors/_ollama-tools.js';
import * as policy from '../../server/src/lib/executors/_directSshPolicy.ts';
import { claudeProviderSettingsArgs } from '../../server/src/lib/executors/claude.js';
import codex from '../../server/src/lib/executors/codex.js';

function evaluate(command, strict = false) {
  const operation = policy.evaluateDirectCommand || policy.evaluateDirectClientCommand;
  assert.equal(typeof operation, 'function', 'общий evaluator прямых клиентов ещё не реализован');
  const result = operation(command, { blockDirectDb: true, strictUnknownDbClient: strict });
  return typeof result === 'string' ? result : result?.verdict;
}

function claudeDbHookCommand(strict = false) {
  const args = claudeProviderSettingsArgs({
    blockDirectSsh: false,
    blockDirectDb: true,
    strictUnknownDbClient: strict,
  });
  const settingsIndex = args.indexOf('--settings');
  assert.notEqual(settingsIndex, -1, 'Claude не получил server-owned settings');
  const settings = JSON.parse(args[settingsIndex + 1]);
  const groups = Array.isArray(settings.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
  const hook = groups.flatMap((group) => group?.hooks || [])
    .find((entry) => entry?.type === 'command');
  assert.equal(
    typeof hook?.command,
    'string',
    'в argv Claude нет server-owned PreToolUse для прямых DB-клиентов',
  );
  return hook.command;
}

function runClaudeDbHook(command, strict = false) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', claudeDbHookCommand(strict)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`DB policy hook завершился с кодом ${code}: ${stderr}`));
        return;
      }
      const raw = stdout.trim();
      resolve(raw
        ? JSON.parse(raw).hookSpecificOutput?.permissionDecision || null
        : null);
    });
    child.stdin.end(JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command },
    }));
  });
}

function runCommandHook(hookCommand, command) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', hookCommand], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`command policy hook завершился с кодом ${code}: ${stderr}`));
        return;
      }
      const raw = stdout.trim();
      resolve(raw
        ? JSON.parse(raw).hookSpecificOutput?.permissionDecision || null
        : null);
    });
    child.stdin.end(JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command },
    }));
  });
}

test('внешние подключения трёх DB-клиентов блокируются', () => {
  const commands = [
    'mysql -h db.prod.internal app',
    'clickhouse-client --host analytics.prod.internal',
    'redis-cli -h cache.prod.internal GET key',
    'sudo env mysql --host=db.prod.internal app',
    "bash -lc 'redis-cli -u redis://cache.prod.internal/0 GET key'",
  ];

  assert.deepEqual(commands.map((command) => evaluate(command)), commands.map(() => 'deny'));
});

test('localhost и unix-сокеты DB-клиентов остаются разрешены', () => {
  const commands = [
    'mysql app',
    'mysql -h localhost app',
    'mysql -h 127.0.0.23 app',
    'mysql --socket /tmp/mysql.sock app',
    'clickhouse-client --host ::1',
    'clickhouse-client --socket /tmp/clickhouse.sock',
    'redis-cli GET key',
    'redis-cli -h localhost GET key',
    'redis-cli -s /tmp/redis.sock GET key',
    'redis-cli -u redis://[::1]:6379/0 GET key',
  ];

  assert.deepEqual(commands.map((command) => evaluate(command)), commands.map(() => 'allow'));
});

test('неразобранный DB-клиент блокируется только в строгом режиме', () => {
  const command = 'mysql -h "$DB_HOST" app';

  assert.deepEqual({
    defaultVerdict: evaluate(command, false),
    strictVerdict: evaluate(command, true),
  }, {
    defaultVerdict: 'unknown',
    strictVerdict: 'deny',
  });
});

test('Claude PreToolUse применяет host-aware DB-политику к вызову Bash', async () => {
  const decisions = await Promise.all([
    runClaudeDbHook('mysql -h db.prod.internal app'),
    runClaudeDbHook('mysql -h 127.0.0.1 app'),
    runClaudeDbHook('mysql -h "$DB_HOST" app', true),
  ]);

  assert.deepEqual(decisions, ['deny', null, 'deny']);
});

test('Codex process hook применяет host-aware DB-политику к вызову Bash', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-db-codex-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'codex-fixture');
  const trace = path.join(root, 'trace.jsonl');
  await copyFile(new URL('../fixtures/codex-app-server/rich-turn-0.149.0.mjs', import.meta.url), bin);
  await chmod(bin, 0o755);
  await codex.run({
    config: { codexBin: bin },
    env: {
      ...process.env,
      COCKPIT_CODEX_FIXTURE_TRACE: trace,
      COCKPIT_CODEX_FIXTURE_SCENARIO: 'commentary-only',
      COCKPIT_CODEX_FIXTURE_CLI_VERSION: '0.150.1',
      COCKPIT_CODEX_FIXTURE_EXPECT_HOOK: '1',
    },
    message: 'проверь команду',
    cwd: root,
    model: 'gpt-contract-0.149',
    effort: 'medium',
    permissionMode: 'bypassPermissions',
    providerSettings: {
      blockDirectSsh: false,
      blockDirectDb: true,
      strictUnknownDbClient: true,
    },
  });
  const messages = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  const argv = messages.find((entry) => entry.direction === 'process')?.argv || [];
  const hookConfig = argv.find((value) => String(value).startsWith('hooks.PreToolUse=')) || '';
  const hookCommand = hookConfig.match(/command\s*=\s*"([^"]+)"/)?.[1] || '';
  const decisions = hookCommand
    ? await Promise.all([
      runCommandHook(hookCommand, 'redis-cli -h cache.prod.internal GET key'),
      runCommandHook(hookCommand, 'redis-cli -h localhost GET key'),
    ])
    : [];

  assert.deepEqual({ hookInstalled: Boolean(hookCommand), decisions }, {
    hookInstalled: true,
    decisions: ['deny', null],
  });
});

test('Ollama блокирует внешний DB-клиент до обходящего режима прав и запуска Bash', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-db-ollama-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'bash-reached');
  let permissionCalls = 0;
  const toolbox = await createToolbox({
    cwd: root,
    roots: [root],
    permissionMode: 'bypassPermissions',
    blockDirectSsh: false,
    blockDirectDb: true,
    strictUnknownDbClient: true,
    onPermission: async () => {
      permissionCalls += 1;
      return { allow: true };
    },
  });
  const result = await toolbox.call({
    name: 'bash',
    args: {
      command: `mysql -h db.prod.internal >/dev/null 2>&1 || printf reached > ${marker}`,
    },
  });
  const markerText = await readFile(marker, 'utf8').catch(() => null);

  assert.deepEqual({
    blocked: result?.ok === false && /БД|DB|баз/iu.test(result?.text || ''),
    permissionCalls,
    markerText,
  }, {
    blocked: true,
    permissionCalls: 0,
    markerText: null,
  });
});

test('штатные алиасы клиентов не проходят мимо политики хоста', () => {
  const verdicts = [
    'mariadb -h prod.internal',
    'mariadb -h 127.0.0.1',
    'clickhouse client --host analytics.internal',
    'clickhouse client --host localhost',
    'clickhouse local --query "SELECT 1"',
    'valkey-cli -h cache.internal',
    'valkey-cli -u redis://localhost:6379',
    'clickhouse keeper-client',
  ].map((command) => [command, evaluate(command)]);

  assert.deepEqual(verdicts, [
    ['mariadb -h prod.internal', 'deny'],
    ['mariadb -h 127.0.0.1', 'allow'],
    ['clickhouse client --host analytics.internal', 'deny'],
    ['clickhouse client --host localhost', 'allow'],
    ['clickhouse local --query "SELECT 1"', 'allow'],
    ['valkey-cli -h cache.internal', 'deny'],
    ['valkey-cli -u redis://localhost:6379', 'allow'],
    ['clickhouse keeper-client', 'allow'],
  ]);
});

test('обёртки запуска не прячут DB-клиента от политики хоста', () => {
  const verdicts = [
    'timeout 5 mysql -h prod.internal',
    'timeout -k 2 10s clickhouse-client --host analytics.internal',
    'nice -n 5 mysql -h prod.internal',
    'ionice -c 2 -n 7 redis-cli -h cache.internal',
    'stdbuf -o0 mysql -h prod.internal',
    'setsid mysql -h prod.internal',
    'timeout 5 mysql -h 127.0.0.1',
    'nice -n 5 echo hi',
  ].map((command) => [command, evaluate(command)]);

  assert.deepEqual(verdicts, [
    ['timeout 5 mysql -h prod.internal', 'deny'],
    ['timeout -k 2 10s clickhouse-client --host analytics.internal', 'deny'],
    ['nice -n 5 mysql -h prod.internal', 'deny'],
    ['ionice -c 2 -n 7 redis-cli -h cache.internal', 'deny'],
    ['stdbuf -o0 mysql -h prod.internal', 'deny'],
    ['setsid mysql -h prod.internal', 'deny'],
    ['timeout 5 mysql -h 127.0.0.1', 'allow'],
    ['nice -n 5 echo hi', 'allow'],
  ]);
});
