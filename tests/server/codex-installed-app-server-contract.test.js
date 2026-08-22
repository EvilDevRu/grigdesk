// Сторож на обновление установленного Codex: схема app-server генерируется локально,
// без запуска модели, и фиксирует ровно тот transport, на который опирается Cockpit.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CODEX_BIN = process.env.COCKPIT_CODEX_BIN || 'codex';

function errorOutput(error) {
  return [error?.stderr, error?.stdout, error?.message]
    .filter((part) => typeof part === 'string' && part.trim())
    .map((part) => part.trim())
    .join('\n')
    .slice(0, 4000);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertMethod(source, method, version, schemaName) {
  assert.match(
    source,
    new RegExp(`"method"\\s*:\\s*"${escapeRegExp(method)}"`),
    `Codex ${version}: в ${schemaName} исчез метод ${method}`,
  );
}

function assertField(source, field, type, version, schemaName) {
  assert.match(
    source,
    new RegExp(`\\b${escapeRegExp(field)}\\s*:\\s*${escapeRegExp(type)}(?![\\w])`),
    `Codex ${version}: в ${schemaName} исчезло поле ${field}: ${type}`,
  );
}

function assertSchemaPattern(source, pattern, expectation, version, schemaName) {
  assert.match(
    source,
    pattern,
    `Codex ${version}: в ${schemaName} исчез контракт ${expectation}`,
  );
}

test('установленный Codex сохраняет необходимый app-server v2 контракт', {
  timeout: 30_000,
}, async (t) => {
  let version;
  try {
    const result = await execFileAsync(CODEX_BIN, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    version = String(result.stdout || result.stderr || '').trim() || 'неизвестной версии';
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return t.skip(`Codex CLI не установлен (${CODEX_BIN})`);
    }
    assert.fail(`Не удалось определить версию установленного Codex (${CODEX_BIN}): ${errorOutput(error)}`);
  }

  const schemaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-codex-app-server-contract-'));
  t.after(() => fs.rm(schemaDir, { recursive: true, force: true }));

  try {
    await execFileAsync(CODEX_BIN, ['app-server', 'generate-ts', '--out', schemaDir], {
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    assert.fail(
      `Codex ${version}: app-server generate-ts не смог сгенерировать схему: ${errorOutput(error)}`,
    );
  }

  async function schema(relativePath) {
    try {
      return await fs.readFile(path.join(schemaDir, relativePath), 'utf8');
    } catch (error) {
      assert.fail(`Codex ${version}: в generate-ts отсутствует ${relativePath}: ${error.message}`);
    }
  }

  const [clientRequest, clientNotification, serverNotification, initializeParams] = await Promise.all([
    schema('ClientRequest.ts'),
    schema('ClientNotification.ts'),
    schema('ServerNotification.ts'),
    schema('InitializeParams.ts'),
  ]);

  assertSchemaPattern(clientNotification, /"method"\s*:\s*"initialized"/, 'initialized',
    version, 'ClientNotification');

  for (const method of [
    'initialize',
    'thread/start',
    'thread/resume',
    'turn/start',
    'turn/interrupt',
  ]) {
    assertMethod(clientRequest, method, version, 'ClientRequest');
  }

  for (const method of [
    'item/started',
    'item/completed',
    'turn/completed',
    'item/agentMessage/delta',
    'item/reasoning/summaryTextDelta',
    'item/reasoning/summaryPartAdded',
    'item/reasoning/textDelta',
    'item/commandExecution/outputDelta',
    'item/fileChange/patchUpdated',
    'turn/diff/updated',
  ]) {
    assertMethod(serverNotification, method, version, 'ServerNotification');
  }

  const [
    itemStarted,
    itemCompleted,
    turnCompleted,
    agentMessageDelta,
    reasoningSummaryDelta,
    reasoningTextDelta,
    commandOutputDelta,
    fileChangePatch,
    turnDiff,
    fileUpdateChange,
    threadItem,
    threadStartParams,
    threadResumeParams,
    turnStartParams,
    userInput,
    sandboxMode,
    sandboxPolicy,
  ] = await Promise.all([
    schema('v2/ItemStartedNotification.ts'),
    schema('v2/ItemCompletedNotification.ts'),
    schema('v2/TurnCompletedNotification.ts'),
    schema('v2/AgentMessageDeltaNotification.ts'),
    schema('v2/ReasoningSummaryTextDeltaNotification.ts'),
    schema('v2/ReasoningTextDeltaNotification.ts'),
    schema('v2/CommandExecutionOutputDeltaNotification.ts'),
    schema('v2/FileChangePatchUpdatedNotification.ts'),
    schema('v2/TurnDiffUpdatedNotification.ts'),
    schema('v2/FileUpdateChange.ts'),
    schema('v2/ThreadItem.ts'),
    schema('v2/ThreadStartParams.ts'),
    schema('v2/ThreadResumeParams.ts'),
    schema('v2/TurnStartParams.ts'),
    schema('v2/UserInput.ts'),
    schema('v2/SandboxMode.ts'),
    schema('v2/SandboxPolicy.ts'),
  ]);

  assertField(initializeParams, 'capabilities', 'InitializeCapabilities | null', version,
    'InitializeParams');
  for (const [source, name] of [
    [threadStartParams, 'ThreadStartParams'],
    [threadResumeParams, 'ThreadResumeParams'],
  ]) {
    for (const field of ['model', 'cwd', 'approvalPolicy', 'sandbox', 'config']) {
      assertSchemaPattern(source, new RegExp(`\\b${field}\\?\\s*:`), field, version, name);
    }
  }
  assertField(threadResumeParams, 'threadId', 'string', version, 'ThreadResumeParams');

  assertField(turnStartParams, 'threadId', 'string', version, 'TurnStartParams');
  assertField(turnStartParams, 'input', 'Array<UserInput>', version, 'TurnStartParams');
  for (const field of ['cwd', 'approvalPolicy', 'sandboxPolicy', 'model', 'effort', 'summary']) {
    assertSchemaPattern(turnStartParams, new RegExp(`\\b${field}\\?\\s*:`), field, version,
      'TurnStartParams');
  }
  assertSchemaPattern(userInput, /"type"\s*:\s*"text"/, 'UserInput.type=text', version,
    'UserInput');
  assertField(userInput, 'text', 'string', version, 'UserInput');
  assertField(userInput, 'text_elements', 'Array<TextElement>', version, 'UserInput');
  assertSchemaPattern(sandboxMode, /"workspace-write"/, 'SandboxMode=workspace-write', version,
    'SandboxMode');
  for (const field of [
    'writableRoots', 'networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp',
  ]) {
    assertSchemaPattern(sandboxPolicy, new RegExp(`\\b${field}\\s*:`), field, version,
      'SandboxPolicy.workspaceWrite');
  }

  assertField(itemStarted, 'item', 'ThreadItem', version, 'ItemStartedNotification');
  assertField(itemCompleted, 'item', 'ThreadItem', version, 'ItemCompletedNotification');
  assertField(turnCompleted, 'turn', 'Turn', version, 'TurnCompletedNotification');

  for (const [source, name] of [
    [agentMessageDelta, 'AgentMessageDeltaNotification'],
    [reasoningSummaryDelta, 'ReasoningSummaryTextDeltaNotification'],
    [reasoningTextDelta, 'ReasoningTextDeltaNotification'],
    [commandOutputDelta, 'CommandExecutionOutputDeltaNotification'],
  ]) {
    assertField(source, 'delta', 'string', version, name);
  }

  assertField(fileChangePatch, 'changes', 'Array<FileUpdateChange>', version,
    'FileChangePatchUpdatedNotification');
  assertField(turnDiff, 'diff', 'string', version, 'TurnDiffUpdatedNotification');
  assertField(fileUpdateChange, 'path', 'string', version, 'FileUpdateChange');
  assertField(fileUpdateChange, 'kind', 'PatchChangeKind', version, 'FileUpdateChange');
  assertField(fileUpdateChange, 'diff', 'string', version, 'FileUpdateChange');

  for (const itemType of ['agentMessage', 'reasoning', 'commandExecution', 'fileChange']) {
    assert.match(
      threadItem,
      new RegExp(`"type"\\s*:\\s*"${itemType}"`),
      `Codex ${version}: ThreadItem больше не содержит ${itemType}`,
    );
  }
  assertField(threadItem, 'changes', 'Array<FileUpdateChange>', version, 'ThreadItem.fileChange');
});
