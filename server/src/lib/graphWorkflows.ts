import { execFile, spawn, type ChildProcess } from 'node:child_process';

export type GraphCommand = 'templates' | 'template' | 'template-save' | 'runs' | 'start-check' | 'start' | 'read' | 'result'
  | 'node' | 'input' | 'action' | 'claim' | 'settle' | 'model-open' | 'model-admit' | 'model-stop' | 'model-close';

export interface GraphCommandConfig {
  factoryBin: string;
  factoryControlDir: string;
  rootDir: string;
}

interface GraphReply {
  ok: boolean;
  data?: unknown;
  error?: string;
  field?: string;
  retryAt?: number;
}

export class GraphCommandError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field?: string;
  readonly retryAt?: number;

  constructor(status: number, code: string, field?: string, retryAt?: number) {
    super(code);
    this.status = status;
    this.code = code;
    this.field = field;
    this.retryAt = retryAt;
  }
}

/**
 * Отправляет приватные данные только через stdin короткой нативной команды.
 * Ошибка транспорта не превращается в принятый результат или новый запуск.
 * Detached-вызов идёт через spawn: execFile не передаёт detached в сессию процесса.
 */
export function graphCommand(config: GraphCommandConfig, command: GraphCommand,
  request: Record<string, unknown>, options?: { detached?: boolean }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const maxBuffer = command === 'claim' ? 4 * 1024 * 1024 : 1024 * 1024;
    const env = { ...process.env, FACTORY_CONTROL_ROOT: config.factoryControlDir };

    const finish = (error: { code?: number | string | null } | null, stdout: string) => {
      const code = typeof error?.code === 'number' ? error.code : error ? -1 : 0;
      let reply: GraphReply;

      try {
        reply = JSON.parse(stdout) as GraphReply;
      } catch {
        reject(new GraphCommandError(503, 'workflow_store_unavailable'));
        return;
      }
      if (code === 0 && reply?.ok === true) {
        resolve(reply.data);
        return;
      }
      const status = new Map([[44, 404], [65, 422], [75, 409]]).get(code) ?? 503;

      const knownStoreErrors = ['workflow_storage_invalid', 'workflow_admission_paused', 'active_workflow_limit',
        'graph_broken'];

      if (status === 503) {
        const allowed = reply?.error && knownStoreErrors.includes(reply.error);

        const retryAt = typeof reply.retryAt === 'number' && Number.isSafeInteger(reply.retryAt)
          && reply.retryAt > 0 && reply.retryAt <= Date.now() + 360_000 ? reply.retryAt : undefined;
        reject(new GraphCommandError(503, allowed ? reply.error! : 'workflow_store_unavailable',
          undefined, retryAt));
        return;
      }
      reject(new GraphCommandError(status, reply?.error ?? 'workflow_request_failed', reply?.field));
    };

    let child: ChildProcess;

    if (options?.detached === true) {
      child = spawn(config.factoryBin, ['graph-workflow', command], {
        cwd: config.rootDir,
        env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let settled = false;
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;

        if (Buffer.byteLength(stdout) > maxBuffer) {
          child.kill('SIGKILL');
        }
      });
      child.on('error', () => {
        clearTimeout(timer);

        if (!settled) {
          settled = true;
          finish({ code: -1 }, stdout);
        }
      });
      child.on('close', (code) => {
        clearTimeout(timer);

        if (!settled) {
          settled = true;
          finish(code === 0 ? null : { code: code ?? -1 }, stdout);
        }
      });
    } else {
      child = execFile(config.factoryBin, ['graph-workflow', command], {
        cwd: config.rootDir,
        env,
        maxBuffer,
        timeout: 10_000,
      }, (error, stdout) => {
        finish(error, stdout);
      });
    }

    child.stdin?.on('error', () => {
      // Callback команды сообщает итог при закрытии stdin дочерним процессом.
    });
    child.stdin?.end(JSON.stringify(request));
  });
}