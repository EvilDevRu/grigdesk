import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import {
  configureDarwinProcessHelper, darwinFactoryToolEnvironment,
} from '../../../shared/node/processIdentity.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import type { AccessConfig } from './accessProfiles/types.ts';
import type { InboxTriageTarget } from './inbox/triage.ts';
import { getExecutor, loadGraphExecutor } from './executors/index.ts';
import { createGraphModelCatalog, supportsGraphModel, type WorkflowModelCatalog } from './graphWorkflowCatalog.ts';
import {
  captureExecutorAccess, executorWithCapturedAccess, type ExecutorAccessInput,
} from './accessProfiles/adapter.ts';
import { runGraphModel, type GraphModelJob, type GraphModelResult } from './graphWorkflowExecutor.ts';
import { graphCommand, type GraphCommandConfig } from './graphWorkflows.ts';
import { withGraphLaunch } from './providerInstall/externalCliProcess.ts';
import { helperCommand, runtimeKind, runtimeRoot, type HelperCommand } from './runtimePaths.ts';
import { isDirectRun } from './helperEntry.ts';
import { prepareDarwinFactoryEnvironment } from './factoryDarwinRuntime.ts';

export type GraphModelHelperJob = GraphModelJob & {
  id: string;
  nodeId: string;
  generation: number;
  claimId: string;
  expiresAt: number;
};

interface HelperInput {
  job: GraphModelHelperJob;
  commandConfig: GraphCommandConfig;
  providerSettings: Record<string, Record<string, unknown>>;
  access: ExecutorAccessInput;
}

const HELPER_INPUT_LIMIT = 8 * 1024 * 1024;
const HELPER_OUTPUT_LIMIT = 64 * 1024;

/**
 * Владеет модельной выдачей графового конвейера и сохраняет её результат.
 * Процесс живёт в отдельной сессии и завершает работу даже после обрыва сервера.
 */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv[0] === '--probe') {
    process.stdout.write(JSON.stringify({ helper: 'graph-workflow-model', kind: runtimeKind() }) + '\n');
    return 0;
  }
  if (process.platform === 'darwin') {
    const tools = await darwinFactoryToolEnvironment({ root: runtimeRoot(), packaged: runtimeKind() === 'packaged' });

    await configureDarwinProcessHelper(tools.FACTORY_DARWIN_PROCESS_HELPER!,
      tools.FACTORY_DARWIN_PROCESS_HELPER_SHA256!);
  }
  const raw = await readLimitedStdin();

  if (raw === null) {
    return writeReply({ ok: false, error: 'request_limit' }) ? 65 : 1;
  }
  const input = parseHelperInput(raw);

  if (!input) {
    return writeReply({ ok: false, error: 'request_invalid' }) ? 65 : 1;
  }
  const { job, commandConfig: config, providerSettings, access } = input;

  if (process.platform === 'darwin') {
    Object.assign(process.env, await prepareDarwinFactoryEnvironment({
      root: runtimeRoot(), packaged: runtimeKind() === 'packaged',
      controlRoot: config.factoryControlDir, node: process.execPath,
    }));
  }
  const nonce = randomUUID();
  const abort = new AbortController();
  const onTerm = () => abort.abort();

  process.once('SIGTERM', onTerm);
  const remaining = Math.max(0, job.expiresAt - 60_000 - Date.now());
  const deadline = setTimeout(() => abort.abort(), remaining);
  let opened = false;
  let admitted = false;

  try {
    await graphCommand(config, 'model-open', {
      id: job.id, nodeId: job.nodeId, generation: job.generation,
      claimId: job.claimId, ownerNonce: nonce, ownerPid: process.pid,
    }, { detached: true });
    opened = true;
    const adapter = await loadGraphExecutor(job.modelRef.provider);
    const bound = adapter && supportsGraphModel(adapter) ? executorWithCapturedAccess(adapter, access) : null;
    const target: InboxTriageTarget = bound ? {
      ok: true,
      ref: job.modelRef,
      effort: job.modelRef.effort,
      executor: bound as InboxTriageTarget['executor'],
    } : { ok: false, error: 'model_unavailable' };
    const result = await runGraphModel(job, {
      config: config as unknown as Record<string, unknown>, signal: abort.signal, providerSettings,
      resolveTarget: async () => target,
      invoke: (action) => withGraphLaunch({
        signal: abort.signal,
        admit: async ({ pid }) => {
          await graphCommand(config, 'model-admit', {
            id: job.id, nodeId: job.nodeId, generation: job.generation,
            claimId: job.claimId, ownerNonce: nonce, scopePid: pid,
          });
          admitted = true;
        },
        stop: async () => {
          await graphCommand(config, 'model-stop', { id: job.id, claimId: job.claimId, ownerNonce: nonce });
        },
      }, action),
    });
    const settlement = 'rows' in result ? { rows: result.rows } : { errorCode: result.errorCode };
    const receipt = await graphCommand(config, 'model-close', {
      id: job.id, nodeId: job.nodeId, generation: job.generation,
      claimId: job.claimId, ownerNonce: nonce,
      closeKind: admitted ? 'scope_exit' : 'never_spawned', ...settlement,
    }) as { revision?: number };

    writeReply({ ok: true, committed: { id: job.id, revision: receipt.revision } });
    return 0;
  } catch {
    if (opened) {
      try {
        const receipt = await graphCommand(config, 'model-close', {
          id: job.id, nodeId: job.nodeId, generation: job.generation,
          claimId: job.claimId, ownerNonce: nonce,
          closeKind: admitted ? 'scope_exit' : 'never_spawned', errorCode: 'run_failed',
        }) as { revision?: number };

        writeReply({ ok: true, committed: { id: job.id, revision: receipt.revision } });
        return 0;
      } catch {
        // Нативная квитанция недоступна: закрытый транспортный отказ без текста входа.
      }
    }
    writeReply({ ok: false, error: 'graph_model_helper_failed' });
    return 78;
  } finally {
    clearTimeout(deadline);
    process.off('SIGTERM', onTerm);
  }
}

/**
 * Серверный запуск помощника отдельной сессией с передачей job только через stdin.
 * Поздняя квитанция обрабатывается промисом транспорта, отмена не вызывает settle.
 */
export async function runGraphModelJob(
  job: GraphModelHelperJob,
  signal: AbortSignal,
  config: GraphCommandConfig & AccessConfig & { modelsPath: string },
  providerSettings: Record<string, Record<string, unknown>>,
  ports: { catalog?: WorkflowModelCatalog; helper?: HelperCommand } = {},
): Promise<GraphModelResult | { committed: { id: string; revision?: number } }> {
  const adapter = await getExecutor(job.modelRef.provider);

  if (!adapter || !supportsGraphModel(adapter)) {
    return { errorCode: 'model_unavailable' };
  }

  const selection = await captureExecutorAccess(adapter, config);

  try {
    const modelRef = await (ports.catalog ?? createGraphModelCatalog(config)).resolve(job.modelRef);

    if (!modelRef) {
      return { errorCode: 'model_unavailable' };
    }
    signal.throwIfAborted();

    return await launchGraphHelper({ job: { ...job, modelRef }, commandConfig: config,
      providerSettings, access: selection.access }, signal, ports.helper);
  } finally {
    await selection.release();
  }
}

/**
 * Помощник получает точную модель и снимок доступа после чтения каталога.
 * Полезная нагрузка идёт только по приватному stdin и не пишется на диск.
 */
async function launchGraphHelper(input: HelperInput, signal: AbortSignal,
  helper = helperCommand('graph-workflow-model', []),
) {
  const config = input.commandConfig;
  const env: NodeJS.ProcessEnv = { ...process.env, FACTORY_CONTROL_ROOT: config.factoryControlDir };

  for (const key of ['FACTORY_RUN_TASK', 'FACTORY_RUN_STAGE', 'FACTORY_RUN_ID', 'FACTORY_RUN_EPOCH']) {
    delete env[key];
  }
  const child = spawn(helper.command, helper.args, {
    cwd: config.rootDir,
    env,
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  try {
    const reply = await new Promise<unknown>((resolve, reject) => {
      let stdout = '';
      const onAbort = () => child.kill('SIGTERM');

      signal.addEventListener('abort', onAbort, { once: true });
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;

        if (Buffer.byteLength(stdout) > HELPER_OUTPUT_LIMIT) {
          child.kill('SIGKILL');
          reject(new Error('graph_helper_limit'));
        }
      });
      child.on('error', () => reject(new Error('graph_helper_unavailable')));
      child.on('close', () => {
        signal.removeEventListener('abort', onAbort);

        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('graph_helper_silent'));
        }
      });
      child.stdin?.on('error', () => {
        // Итог сообщает close-обработчик при закрытии stdin дочерним процессом.
      });
      child.stdin?.end(JSON.stringify(input));
    });

    if (isRecord(reply) && isRecord(reply.committed) && typeof reply.committed.id === 'string') {
      return { committed: { id: reply.committed.id, revision: Number(reply.committed.revision) || undefined } };
    }
    return { errorCode: 'run_failed' };
  } catch {
    return { errorCode: 'run_failed' };
  }
}

async function readLimitedStdin(): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk as Buffer);

    total += buffer.length;
    if (total > HELPER_INPUT_LIMIT) {
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseHelperInput(raw: string): HelperInput | null {
  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || !isRecord(value.job) || !isRecord(value.commandConfig)
    || !isRecord(value.providerSettings) || !isRecord(value.access)
    || !isRecord(value.access.env) || !isRecord(value.access.snapshot)
    || !isRecord(value.access.profile) || !Array.isArray(value.access.keys)) {
    return null;
  }
  const job = value.job;
  const config = value.commandConfig;

  if (typeof job.id !== 'string' || typeof job.nodeId !== 'string'
    || typeof job.claimId !== 'string' || typeof job.expiresAt !== 'number'
    || typeof job.generation !== 'number' || !isRecord(job.modelRef)
    || (job.kind !== 'agent' && job.kind !== 'meetingTasks') || !Array.isArray(job.rows)) {
    return null;
  }
  if (typeof config.factoryBin !== 'string' || typeof config.factoryControlDir !== 'string'
    || typeof config.rootDir !== 'string') {
    return null;
  }
  return value as unknown as HelperInput;
}

function writeReply(value: Record<string, unknown>): boolean {
  const raw = JSON.stringify(value);

  if (Buffer.byteLength(raw) > HELPER_OUTPUT_LIMIT) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'response_limit' }) + '\n');
    return false;
  }
  process.stdout.write(raw + '\n');
  return true;
}

if (isDirectRun(import.meta.url)) {
  void main().then((code) => {
    process.exitCode = code;
  }).catch(() => {
    process.exitCode = 78;
  });
}