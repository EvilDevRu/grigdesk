import { spawn } from 'node:child_process';
import path from 'node:path';

import type { ChildProcess } from 'node:child_process';

import { createAcpClient, initializeKimiAcp } from '../src/lib/kimi/acpClient.ts';

interface ProbeArguments {
  bin: string;
  cwd: string;
  dshHome: string;
  launchDir: string;
  overlay: string;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function argumentValue(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : '';

  if (!value || value.startsWith('--')) {
    throw new Error(`Не задан обязательный аргумент ${name}`);
  }

  return path.resolve(value);
}

function parseArguments(argv: readonly string[]): ProbeArguments {
  return {
    bin: argumentValue(argv, '--bin'),
    cwd: argumentValue(argv, '--cwd'),
    dshHome: argumentValue(argv, '--home'),
    launchDir: argumentValue(argv, '--launch-dir'),
    overlay: argumentValue(argv, '--overlay'),
  };
}

function waitForExit(child: ChildProcess): Promise<ProcessExit> {
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

/**
 * Probe ограничивается metadata-handshake: он создаёт и сразу закрывает ACP-сессию,
 * но никогда не отправляет session/prompt и потому не расходует модельный запрос.
 */
async function runProbe(args: ProbeArguments) {
  const startedAt = Date.now();
  const child = spawn(args.bin, ['--profile', 'acp', '--patch', args.overlay], {
    cwd: args.launchDir,
    env: {
      ...process.env,
      DSH_HOME: args.dshHome,
      DSH_TELEMETRY_DISABLED: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = waitForExit(child);
  let stderr = '';

  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${String(chunk)}`.slice(-16_384);
  });

  const client = createAcpClient(child);
  let sessionId = '';

  try {
    const initialized = await initializeKimiAcp(client);
    const initializedAfterMs = Date.now() - startedAt;
    const created = await client.request('session/new', {
      cwd: args.cwd,
      mcpServers: [],
    }, 30_000) as {
      sessionId?: unknown;
      configOptions?: unknown;
    } | null;
    const sessionCreatedAfterMs = Date.now() - startedAt;

    sessionId = String(created?.sessionId || '');
    if (!sessionId) {
      throw new Error('DeepSeek ACP не вернул sessionId');
    }

    await client.request('session/close', { sessionId }, 15_000);
    client.close();

    const processExit = await Promise.race([
      exited,
      new Promise<ProcessExit>((resolve) => {
        const timer = setTimeout(() => resolve({ code: null, signal: null }), 8_000);
        timer.unref?.();
      }),
    ]);

    if (processExit.code === null && processExit.signal === null) {
      child.kill('SIGTERM');
    }

    return {
      ok: true,
      initialized,
      configOptions: created?.configOptions ?? null,
      initializedAfterMs,
      sessionCreatedAfterMs,
      processExit,
      stderr: stderr.trim(),
    };
  } catch (error) {
    if (sessionId) {
      await client.request('session/close', { sessionId }, 2_000).catch(() => {});
    }
    client.close();
    child.kill('SIGTERM');

    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      probeStderr: stderr.trim(),
      probeElapsedMs: Date.now() - startedAt,
    });
  }
}

async function main() {
  try {
    const result = await runProbe(parseArguments(process.argv.slice(2)));

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const detail = error as Error & {
      code?: unknown;
      probeElapsedMs?: unknown;
      probeStderr?: unknown;
    };

    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: {
        name: detail.name || 'Error',
        code: detail.code ?? null,
        message: detail.message || String(error),
      },
      elapsedMs: detail.probeElapsedMs ?? null,
      stderr: detail.probeStderr || '',
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

await main();
