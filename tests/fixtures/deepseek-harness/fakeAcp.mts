import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

interface Scenario {
  configOptions?: unknown[];
  // Необязательные опции после выбора модели: значение модели → configOptions.
  configByModel?: Record<string, unknown[]>;
  updates?: unknown[];
  stopReason?: string;
  delays?: Record<string, number>;
  permission?: {
    method?: string;
    toolCallId?: string;
    options?: Array<{ optionId: string; name: string; kind: string }>;
  };
  eof?: 'before_prompt_response' | 'after_session_new';
  errors?: Record<string, { code: number; message: string }>;
  promptError?: { code: number; message: string };
  waitForCancel?: boolean;
  hangOnClose?: boolean;
  ignoreTerm?: boolean;
  spawnSleepMarker?: string;
  sideEffectOnAllow?: string;
  redactMcpEnv?: boolean;
  mcpCalls?: Array<{
    server?: string;
    tool: string;
    arguments?: Record<string, unknown>;
    delayAfterMs?: number;
  }>;
}

function argumentValue(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : '';
  if (!value || value.startsWith('--')) throw new Error(`Не задан ${name}`);
  return value;
}

const scenario = JSON.parse(readFileSync(argumentValue('--scenario'), 'utf8')) as Scenario;
const logFile = argumentValue('--log');
let sessionId = 'fake-deepseek-session';
let reverseId = 10_000;
let sleeping: ReturnType<typeof spawn> | null = null;
let sessionMcpServers: any[] = [];
let sessionCwd = process.cwd();
const reverseWaiters = new Map<number, (message: unknown) => void>();
const pendingPrompts = new Set<number>();
const cancelledPrompts = new Set<number>();
// Сценарий graceful-shutdown обязан оставаться живым и после закрытия stdin.
const hangTimer = scenario.hangOnClose ? setInterval(() => {}, 1_000) : null;

function log(value: unknown) {
  appendFileSync(logFile, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function loggedMessage(message: any) {
  if (!scenario.redactMcpEnv || !Array.isArray(message?.params?.mcpServers)) return message;
  return {
    ...message,
    params: {
      ...message.params,
      mcpServers: message.params.mcpServers.map((server: any) => ({
        ...server,
        env: Array.isArray(server.env)
          ? server.env.map((entry: any) => ({ ...entry, value: '<redacted>' }))
          : server.env,
      })),
    },
  };
}

function send(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function later(method: string, callback: () => void) {
  const delay = Number(scenario.delays?.[method] || 0);
  if (delay > 0) setTimeout(callback, delay);
  else queueMicrotask(callback);
}

function stopSleep() {
  if (sleeping?.pid) {
    try { process.kill(-sleeping.pid, 'SIGTERM'); } catch { /* уже завершён */ }
  }
  sleeping = null;
}

async function runPrompt(id: number, params: any) {
  pendingPrompts.add(id);
  if (scenario.spawnSleepMarker) {
    sleeping = spawn('bash', ['-lc', `exec -a ${scenario.spawnSleepMarker} sleep 60`], {
      detached: true,
      stdio: 'ignore',
    });
    log({ kind: 'spawned', pid: sleeping.pid, marker: scenario.spawnSleepMarker });
  }
  for (const update of scenario.updates || []) {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update },
    });
  }
  if (scenario.mcpCalls?.length) {
    await runMcpCalls();
  }
  if (scenario.permission) {
    const requestId = reverseId++;
    const answer = new Promise((resolve) => reverseWaiters.set(requestId, resolve));
    send({
      jsonrpc: '2.0',
      id: requestId,
      method: scenario.permission.method || 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: scenario.permission.toolCallId || 'fake-tool-call' },
        options: scenario.permission.options || [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    const permissionResponse: any = await answer;
    log({ kind: 'permission_response', message: permissionResponse });
    if (scenario.sideEffectOnAllow
        && permissionResponse?.result?.outcome?.outcome === 'selected'
        && permissionResponse?.result?.outcome?.optionId === 'allow-once') {
      writeFileSync(scenario.sideEffectOnAllow, 'allowed\n', { mode: 0o600 });
    }
  }
  if (scenario.waitForCancel) return;
  if (cancelledPrompts.has(id)) return;
  if (scenario.eof === 'before_prompt_response') {
    process.stdout.end();
    return;
  }
  pendingPrompts.delete(id);
  if (scenario.promptError) {
    send({ jsonrpc: '2.0', id, error: scenario.promptError });
    return;
  }
  send({ jsonrpc: '2.0', id, result: { stopReason: scenario.stopReason || 'end_turn' } });
}

async function runMcpCalls() {
  const wanted = scenario.mcpCalls?.[0]?.server;
  const server = sessionMcpServers.find((candidate) => !wanted || candidate?.name === wanted);
  if (!server?.command) throw new Error(`MCP server not found: ${String(wanted || '<first>')}`);
  const extraEnv = Object.fromEntries((server.env || []).map((entry: any) => [entry.name, entry.value]));
  const child = spawn(server.command, server.args || [], {
    cwd: sessionCwd,
    env: { ...process.env, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<number, (message: any) => void>();
  let nextId = 1;
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_192); });
  const output = createInterface({ input: child.stdout! });
  output.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      const resolve = pending.get(Number(message.id));
      if (resolve) {
        pending.delete(Number(message.id));
        resolve(message);
      }
    } catch (error) {
      log({ kind: 'mcp_parse_error', error: String(error) });
    }
  });
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
      if (error) {
        pending.delete(id);
        reject(error);
      }
    });
  });
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'fake-dsh', version: '1' },
  });
  child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  await request('tools/list', {});
  for (const call of scenario.mcpCalls || []) {
    const response = await request('tools/call', {
      name: call.tool,
      arguments: call.arguments || {},
    });
    log({ kind: 'mcp_response', tool: call.tool, response });
    if (call.delayAfterMs) {
      await new Promise((resolve) => setTimeout(resolve, call.delayAfterMs));
    }
  }
  child.stdin!.end();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve();
    }, 2_000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (stderr) log({ kind: 'mcp_stderr', stderr });
}

function handle(message: any) {
  log({ kind: 'request', message: loggedMessage(message) });
  if (Object.hasOwn(message, 'id') && !message.method) {
    const waiter = reverseWaiters.get(Number(message.id));
    if (waiter) {
      reverseWaiters.delete(Number(message.id));
      waiter(message);
    }
    return;
  }
  const { id, method, params } = message;
  if (method === 'session/cancel') {
    stopSleep();
    log({ kind: 'cancelled', sessionId: params?.sessionId });
    for (const promptId of pendingPrompts) {
      cancelledPrompts.add(promptId);
      send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } });
    }
    pendingPrompts.clear();
    return;
  }
  if (!Object.hasOwn(message, 'id')) return;

  later(method, () => {
    if (scenario.errors?.[method]) {
      send({ jsonrpc: '2.0', id, error: scenario.errors[method] });
      return;
    }
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: 1,
        agentInfo: { name: 'fake-deepseek-acp', version: '0.0.1' },
        agentCapabilities: { sessionCapabilities: { close: {}, resume: {} } },
        authMethods: [],
      } });
    } else if (method === 'session/new' || method === 'session/resume') {
      sessionId = method === 'session/resume' ? String(params?.sessionId || sessionId) : sessionId;
      sessionMcpServers = Array.isArray(params?.mcpServers) ? params.mcpServers : [];
      sessionCwd = String(params?.cwd || process.cwd());
      send({ jsonrpc: '2.0', id, result: {
        sessionId,
        configOptions: scenario.configOptions || [],
      } });
      if (scenario.eof === 'after_session_new') process.stdout.end();
    } else if (method === 'session/set_config_option') {
      const byModel = params?.configId === 'model'
        ? scenario.configByModel?.[String(params?.value)]
        : undefined;

      send({
        jsonrpc: '2.0',
        id,
        result: { configOptions: byModel || scenario.configOptions || [] },
      });
    } else if (method === 'session/prompt') {
      void runPrompt(Number(id), params);
    } else if (method === 'session/close') {
      stopSleep();
      send({ jsonrpc: '2.0', id, result: {} });
      if (!scenario.hangOnClose) setImmediate(() => process.exit(0));
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
    }
  });
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  try { handle(JSON.parse(line)); } catch (error) { log({ kind: 'parse_error', error: String(error) }); }
});
lines.on('close', () => {
  stopSleep();
  if (!scenario.hangOnClose) process.exit(0);
});
process.on('SIGTERM', () => {
  stopSleep();
  if (!scenario.ignoreTerm) {
    if (hangTimer) clearInterval(hangTimer);
    process.exit(0);
  }
});
