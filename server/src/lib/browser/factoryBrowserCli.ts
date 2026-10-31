import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { FactoryStateAdapter } from '../../adapters/factoryState.ts';
import { RoutesStore } from '../../modules/routes/store.ts';
import {
  browserMailboxRequest, browserMailboxOnce, writeBrowserReady, readBrowserReady, readBrowserReadyDetails,
} from './browserMailbox.ts';
import type { MailboxContext } from './browserMailbox.ts';
import { parseBrowserRunProof, removeBrowserBinding } from './factoryBrowserBinding.ts';
import { createFactoryBrowserTrusted } from './factoryBrowserTrusted.ts';
import { publishFactoryBrowserBinding } from './factoryBrowserIdentity.ts';
import { requestBrowserSocket } from './browserSocket.ts';
import { nodeExecutable, runtimeKind, runtimeRoot } from '../runtimePaths.ts';

const FLAGS: Record<string, readonly string[]> = {
  key: [],
  mode: [],
  'read-roots': [],
  'evidence-root': [],
  request: ['--input-json'],
  relay: ['--control-root', '--state-dir', '--profiles-dir', '--routes-dir', '--task', '--stage',
    '--run-id', '--epoch', '--attempt-id', '--socket', '--parent-pid'],
  'publish-binding': ['--control-root', '--state-dir', '--profiles-dir', '--routes-dir',
    '--task', '--stage', '--run-id', '--epoch', '--attempt-id'],
  cleanup: ['--control-root', '--state-dir', '--profiles-dir', '--routes-dir',
    '--task', '--stage', '--run-id', '--epoch', '--attempt-id'],
};

/**
 * CLI принимает только пары флаг/значение известного режима без повторов.
 * Secret не является допустимым argv-флагом ни в одной ветке.
 */
export function parseBrowserCli(argv: readonly string[]) {
  const mode = argv[0] ?? '';
  const allowed = FLAGS[mode];
  const values = new Map<string, string>();

  if (!allowed || argv.length > 41) {
    throw new Error('browser_cli_invalid');
  }

  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index]!;
    const value = argv[index + 1];

    if (!allowed.includes(key) || values.has(key) || value === undefined || value.includes('\0')
      || value.length > 65536) {
      throw new Error('browser_cli_invalid');
    }

    values.set(key, value);
  }

  const required = (key: string) => {
    const value = values.get(key);

    if (!value) {
      throw new Error('browser_cli_invalid');
    }

    return value;
  };

  return {
    mode,
    values,
    required
  };
}

/**
 * Request context принадлежит процессу конкретного запуска, не JSON аргументу модели.
 * Nonce используется только для authenticated encrypted mailbox.
 */
export function browserMailboxContext(env: NodeJS.ProcessEnv): MailboxContext {
  const value = {
    stateDir: String(env.FACTORY_STATE ?? env.STATE_DIR ?? ''),
    task: String(env.FACTORY_RUN_TASK ?? ''),
    stage: String(env.FACTORY_RUN_STAGE ?? ''),
    runId: String(env.FACTORY_RUN_ID ?? ''),
    epoch: String(env.FACTORY_RUN_EPOCH ?? ''),
    nonce: String(env.FACTORY_BROWSER_NONCE ?? ''),
  };

  if (!path.isAbsolute(value.stateDir) || !/^[1-9][0-9]*$/u.test(value.task)
    || !/^[A-Z][A-Z0-9_]*$/u.test(value.stage) || !/^[A-Za-z0-9._-]{1,160}$/u.test(value.runId)
    || ['.', '..'].includes(value.runId) || !/^[1-9][0-9]*$/u.test(value.epoch)
    || !/^[a-f0-9]{64}$/u.test(value.nonce)) {
    throw new Error('browser_run_invalid');
  }

  return value;
}

/**
 * Token читается bounded pread из унаследованного regular FD9.
 * Offset соседнего FD7 не меняется; secret не сериализуется в runtime profile.
 */
export async function readBrowserPublisherToken(): Promise<string> {
  const handle = await open('/proc/self/fd/9', 'r');

  try {
    const stat = await handle.stat();

    if (!stat.isFile() || stat.size < 1 || stat.size > 4097) {
      throw new Error('browser_run_stale');
    }

    const bytes = Buffer.alloc(4098);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const text = bytes.subarray(0, bytesRead).toString('utf8');
    const value = text.endsWith('\n') ? text.slice(0, -1) : text;

    if (bytesRead !== stat.size || !value || value.length > 4096 || /[\r\n\0]/u.test(value)) {
      throw new Error('browser_run_stale');
    }

    return value;
  } finally {
    await handle.close();
  }
}

/**
 * Proof собирается только host ветками relay/publisher/cleanup после чтения FD9.
 * Paths являются отдельными параметрами и не попадают в tool response.
 */
async function hostContext(parsed: ReturnType<typeof parseBrowserCli>) {
  const required = parsed.required;
  const paths = {
    controlRoot: required('--control-root'),
    stateDir: required('--state-dir'),
    profilesDir: required('--profiles-dir'),
    routesDir: required('--routes-dir'),
  };

  if (!Object.values(paths).every((value) => path.isAbsolute(value) && !/[\r\n\0]/u.test(value))) {
    throw new Error('browser_cli_invalid');
  }

  const proof = parseBrowserRunProof({
    task: required('--task'),
    stage: required('--stage'),
    runId: required('--run-id'),
    epoch: required('--epoch'),
    attemptId: required('--attempt-id'),
    token: await readBrowserPublisherToken(),
  });

  return { paths, proof };
}

/**
 * Relay следит за своим parent identity и снимает очередь при остановке launcher.
 * После начального probe routing=grigdesk сохраняется даже при недоступном окне.
 */
async function relay(parsed: ReturnType<typeof parseBrowserCli>, env: NodeJS.ProcessEnv) {
  const { paths, proof } = await hostContext(parsed);
  const context = browserMailboxContext(env);
  const socket = parsed.required('--socket');
  const parent = Number(parsed.required('--parent-pid'));

  if (!path.isAbsolute(socket) || !Number.isSafeInteger(parent) || parent <= 1 || process.ppid !== parent
    || context.task !== proof.task || context.stage !== proof.stage || context.runId !== proof.runId
    || context.epoch !== proof.epoch || context.stateDir !== paths.stateDir) {
    throw new Error('browser_run_invalid');
  }

  const parentStat = () => readFile(`/proc/${parent}/stat`, 'utf8').then((value) => {
    const fields = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/u);

    return fields[19] ?? '';
  }).catch(() => '');
  const starttime = await parentStat();
  const controller = new AbortController();
  const stop = () => controller.abort();

  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  try {
    let mode: 'legacy' | 'grigdesk' = 'grigdesk';
    let evidenceRoot: string | null = null;

    try {
      const probe = await requestBrowserSocket(socket,
        {
          schema: 1,
          proof,
          input: { action: 'probe' }
        },
        AbortSignal.any([controller.signal, AbortSignal.timeout(750)])) as {
        mode?: string;
        evidenceRoot?: unknown;
      };

      if (probe?.mode === 'legacy') {
        mode = 'legacy';
      } else if (typeof probe?.evidenceRoot === 'string' && path.isAbsolute(probe.evidenceRoot)
        && !/[\r\n\0]/u.test(probe.evidenceRoot)) {
        evidenceRoot = probe.evidenceRoot;
      }
    } catch {
      // Неизвестный routing при обрыве сервера закрывается без внешнего fallback.
    }

    await writeBrowserReady(context, mode, evidenceRoot);

    if (mode === 'legacy') {
      return;
    }

    const seen = new Set<string>();

    while (!controller.signal.aborted && starttime && await parentStat() === starttime) {
      await browserMailboxOnce({
        context,
        seen,
        signal: controller.signal,
        invoke: (input) => requestBrowserSocket(socket, {
          schema: 1,
          proof,
          input
        }, controller.signal),
      });
      await delay(100, undefined, { signal: controller.signal });
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      throw error;
    }
  } finally {
    controller.abort();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

/**
 * Один library entry служит compiled helper и остаётся безопасным при unit import.
 * Ни один режим не загружает модель или не выполняет shell-команду из аргумента.
 */
async function runBrowserCli(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const parsed = parseBrowserCli(argv);

  if (parsed.mode === 'key') {
    process.stdout.write(randomBytes(32).toString('hex') + '\n');

    return;
  }

  if (parsed.mode === 'mode') {
    process.stdout.write(await readBrowserReady(browserMailboxContext(env)) + '\n');

    return;
  }

  if (parsed.mode === 'read-roots') {
    const root = runtimeRoot();
    const selected = runtimeKind() === 'packaged'
      ? [path.dirname(nodeExecutable()), path.join(root, 'server/runtime/helpers')]
      : [path.dirname(nodeExecutable()), ...['server/src', 'server/scripts', 'server/node_modules',
        'shared', 'deepseek', 'tools', 'b24'].map((name) => path.join(root, name))];
    const roots = [...new Set(selected.filter(existsSync).map((directory) => realpathSync(directory)))];

    if (roots.some((directory) => !/^\/[A-Za-z0-9_@+.,/=-]+$/u.test(directory))) {
      throw new Error('browser_runtime_invalid');
    }

    process.stdout.write(roots.join('\n') + '\n');

    return;
  }

  if (parsed.mode === 'evidence-root') {
    const ready = await readBrowserReadyDetails(browserMailboxContext(env));

    if (ready.mode !== 'grigdesk' || !ready.evidenceRoot) {
      throw new Error('browser_unavailable');
    }

    process.stdout.write(ready.evidenceRoot + '\n');

    return;
  }

  if (parsed.mode === 'request') {
    const context = browserMailboxContext(env);

    if (await readBrowserReady(context) !== 'grigdesk') {
      throw new Error('browser_disabled');
    }

    const input = JSON.parse(parsed.required('--input-json'));
    const result = await browserMailboxRequest({ context, input }) as Record<string, unknown>;
    const output = result?.format === 'grigdesk-work-content-v1'
      ? { ok: true, imagePath: result.imagePath } : result;
    const text = JSON.stringify(output);

    if (typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024
      || (result?.format === 'grigdesk-work-content-v1'
        && (typeof result.imagePath !== 'string' || !path.isAbsolute(result.imagePath)))) {
      throw new Error('browser_result_invalid');
    }

    process.stdout.write(text + '\n');

    return;
  }

  if (parsed.mode === 'relay') {
    await relay(parsed, env);

    return;
  }

  const { paths, proof } = await hostContext(parsed);

  if (parsed.mode === 'cleanup') {
    await removeBrowserBinding(paths.controlRoot, proof);

    return;
  }

  const state = new FactoryStateAdapter({
    stateDir: paths.stateDir,
    profilesDir: paths.profilesDir,
    routesDir: paths.routesDir,
    controlDir: paths.controlRoot,
  });
  const authority = {
    controlRoot: paths.controlRoot,
    trusted: createFactoryBrowserTrusted({
      state,
      routes: new RoutesStore({ baseDir: paths.routesDir }),
      projectExists: async () => true,
    }),
  };

  await publishFactoryBrowserBinding(authority, proof);
}

/**
 * Compiled entry не печатает argv, stack и содержимое запроса даже при исключении.
 * Ненулевой exit остаётся виден launcher без раскрытия run secret в relay.log.
 */
export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  try {
    await runBrowserCli(argv, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = /^(browser_[a-z_]+|outcome_unknown|access_revoked)$/u.test(message)
      ? message : 'browser_unavailable';

    process.stderr.write(code + '\n');
    process.exitCode = 1;
  }
}
