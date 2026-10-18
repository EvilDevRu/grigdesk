import { execFile } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const STAGE_PROGRESS = fileURLToPath(new URL('../../engine/lib/stage-progress.sh', import.meta.url));
const STAGE_RESULT = fileURLToPath(new URL('../../engine/lib/stage-result.sh', import.meta.url));
const FACTORY_HOME = path.dirname(path.dirname(STAGE_PROGRESS));

interface RunContext {
  task: string;
  stage: string;
  runId: string;
  epoch: string;
  requestDir: string;
  stateDir: string;
}

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function runContext(env: NodeJS.ProcessEnv): RunContext {
  const task = String(env.FACTORY_RUN_TASK || '');
  const stage = String(env.FACTORY_RUN_STAGE || '');
  const runId = String(env.FACTORY_RUN_ID || '');
  const epoch = String(env.FACTORY_RUN_EPOCH || '');
  const requestDir = String(env.FACTORY_STATUS_REQUEST_DIR || '');
  const stateDir = String(env.FACTORY_STATE || env.STATE_DIR || '');
  if (!/^[0-9]+$/.test(task)
      || !/^[A-Z][A-Z0-9_]*$/.test(stage)
      || !/^[A-Za-z0-9._-]+$/.test(runId)
      || !/^[1-9][0-9]*$/.test(epoch)
      || env.FACTORY_STATUS_MODE !== 'request'
      || !path.isAbsolute(stateDir)
      || !path.isAbsolute(requestDir)) {
    throw new Error('factory status context invalid');
  }
  const expected = path.join(stateDir, 'logs', 'runs', `t${task}`, stage, runId, 'control-requests');
  if (path.resolve(requestDir) !== path.resolve(expected)) {
    throw new Error('factory status request directory mismatch');
  }
  return { task, stage, runId, epoch, requestDir, stateDir };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const names = new Set(allowed);
  return Object.keys(value).every((key) => names.has(key));
}

function text(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max) {
    throw new Error(`${label} invalid`);
  }
  return value;
}

function stringList(value: unknown, label: string, maxItems = 128): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} invalid`);
  return value.map((item, index) => text(item, 20_000, `${label}[${index}]`));
}

function childEnvironment(context: RunContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME || '',
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || '',
    TZ: process.env.TZ || '',
    FACTORY_HOME,
    FACTORY_STATE: context.stateDir,
    STATE_DIR: context.stateDir,
    FACTORY_RUN_TASK: context.task,
    FACTORY_RUN_STAGE: context.stage,
    FACTORY_RUN_ID: context.runId,
    FACTORY_RUN_EPOCH: context.epoch,
    FACTORY_STATUS_MODE: 'request',
    FACTORY_STATUS_REQUEST_DIR: context.requestDir,
  };
  const resultCheck = process.env.FACTORY_STAGE_RESULT_CHECK;
  if (resultCheck && path.isAbsolute(resultCheck) && !resultCheck.includes('\0')) {
    env.FACTORY_STAGE_RESULT_CHECK = resultCheck;
  }
  return env;
}

async function invoke(script: string, args: string[], context: RunContext) {
  try {
    const { stdout, stderr } = await execFileAsync(script, args, {
      cwd: context.stateDir,
      env: childEnvironment(context),
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      shell: false,
    });
    return {
      content: [{ type: 'text', text: String(stdout || stderr || 'ok').trim().slice(0, 2_000) || 'ok' }],
      structuredContent: { ok: true },
    };
  } catch (error) {
    const detail = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
    const code = typeof detail.code === 'number' ? detail.code : 1;
    const message = String(detail.stderr || detail.stdout || detail.message || 'status command failed')
      .trim().slice(-2_000);
    return {
      content: [{ type: 'text', text: message || `status command failed (${code})` }],
      structuredContent: { ok: false, exitCode: code },
      isError: true,
    };
  }
}

async function stageProgress(argumentsValue: unknown, context: RunContext) {
  if (!record(argumentsValue) || !exactKeys(argumentsValue, ['updates'])
      || !Array.isArray(argumentsValue.updates)
      || argumentsValue.updates.length < 1 || argumentsValue.updates.length > 64) {
    throw new Error('stage_progress arguments invalid');
  }
  const pairs: string[] = [];
  for (const [index, update] of argumentsValue.updates.entries()) {
    if (!record(update) || !exactKeys(update, ['key', 'value'])) {
      throw new Error(`stage_progress updates[${index}] invalid`);
    }
    const key = text(update.key, 80, `updates[${index}].key`);
    const value = text(update.value, 20_000, `updates[${index}].value`);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`updates[${index}].key invalid`);
    pairs.push(key, value);
  }
  return invoke(STAGE_PROGRESS, [
    '--task', context.task,
    '--stage', context.stage,
    '--run-id', context.runId,
    '--epoch', context.epoch,
    ...pairs,
  ], context);
}

async function stageResult(argumentsValue: unknown, context: RunContext) {
  const allowed = [
    'result', 'comment', 'failureOwner', 'findings', 'deferredFindings',
    'findingAnchors', 'reviewed',
  ];
  if (!record(argumentsValue) || !exactKeys(argumentsValue, allowed)) {
    throw new Error('stage_result arguments invalid');
  }
  const result = text(argumentsValue.result, 16, 'result');
  if (!['done', 'skipped', 'failed'].includes(result)) throw new Error('result invalid');
  const comment = text(argumentsValue.comment ?? '', 20_000, 'comment');
  const failureOwner = argumentsValue.failureOwner === undefined
    ? ''
    : text(argumentsValue.failureOwner, 120, 'failureOwner');
  const findings = stringList(argumentsValue.findings, 'findings');
  const deferred = stringList(argumentsValue.deferredFindings, 'deferredFindings');
  const anchors = stringList(argumentsValue.findingAnchors, 'findingAnchors');
  const reviewed = stringList(argumentsValue.reviewed, 'reviewed');
  const args = [
    '--task', context.task,
    '--stage', context.stage,
    '--run-id', context.runId,
    '--epoch', context.epoch,
  ];
  if (failureOwner) args.push('--failure-owner', failureOwner);
  for (const finding of findings) args.push('--finding', finding);
  for (const finding of deferred) args.push('--finding-deferred', finding);
  for (const anchor of anchors) args.push('--finding-anchor', anchor);
  for (const item of reviewed) args.push('--reviewed', item);
  args.push(result, comment);
  return invoke(STAGE_RESULT, args, context);
}

const tools = [
  {
    name: 'stage_progress',
    description: 'Обновить проверяемый прогресс текущего Factory-этапа.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['updates'],
      properties: {
        updates: {
          type: 'array', minItems: 1, maxItems: 64,
          items: {
            type: 'object', additionalProperties: false, required: ['key', 'value'],
            properties: { key: { type: 'string' }, value: { type: 'string' } },
          },
        },
      },
    },
  },
  {
    name: 'stage_result',
    description: 'Зафиксировать единственный терминальный результат текущего Factory-этапа.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['result'],
      properties: {
        result: { type: 'string', enum: ['done', 'skipped', 'failed'] },
        comment: { type: 'string' },
        failureOwner: { type: 'string' },
        findings: { type: 'array', items: { type: 'string' } },
        deferredFindings: { type: 'array', items: { type: 'string' } },
        findingAnchors: { type: 'array', items: { type: 'string' } },
        reviewed: { type: 'array', items: { type: 'string' } },
      },
    },
  },
];

function send(id: unknown, result?: unknown, error?: { code: number; message: string }): void {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0', id,
    ...(error ? { error } : { result }),
  })}\n`);
}

async function handle(message: RpcRequest): Promise<void> {
  const method = String(message.method || '');
  if (!Object.hasOwn(message, 'id')) return;
  if (message.jsonrpc !== '2.0') {
    send(message.id, undefined, { code: -32600, message: 'Invalid Request' });
    return;
  }
  if (method === 'initialize') {
    send(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'grigdesk-deepseek-status', version: '1' },
    });
    return;
  }
  if (method === 'ping') {
    send(message.id, {});
    return;
  }
  if (method === 'tools/list') {
    send(message.id, { tools });
    return;
  }
  if (method !== 'tools/call' || !record(message.params)) {
    send(message.id, undefined, { code: -32601, message: 'Method not found' });
    return;
  }
  try {
    const context = runContext(process.env);
    const name = String(message.params.name || '');
    const argumentsValue = message.params.arguments ?? {};
    if (name === 'stage_progress') send(message.id, await stageProgress(argumentsValue, context));
    else if (name === 'stage_result') send(message.id, await stageResult(argumentsValue, context));
    else send(message.id, undefined, { code: -32602, message: 'Unknown tool' });
  } catch (error) {
    send(message.id, {
      content: [{ type: 'text', text: String((error as Error)?.message || error).slice(0, 1_000) }],
      structuredContent: { ok: false },
      isError: true,
    });
  }
}

let tail = Promise.resolve();
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  tail = tail.then(async () => {
    try {
      await handle(JSON.parse(line) as RpcRequest);
    } catch {
      send(null, undefined, { code: -32700, message: 'Parse error' });
    }
  });
});
input.on('close', () => {
  void tail.finally(() => process.exit(0));
});
