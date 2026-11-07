import path from 'node:path';

import { createAcpClient, initializeAcp } from '../src/lib/acp/client.ts';
import { spawnDeepSeekBinary } from '../src/lib/deepseek/binaryProcess.ts';
import { buildHarnessChildEnv } from '../src/lib/deepseek/env.ts';
import {
  resolveDeepSeekRuntimeAsync,
  verifyDeepSeekRuntimeDescriptorAsync,
} from '../src/lib/deepseek/runtimeProcess.ts';

interface ProbeArguments {
  bin: string;
  cwd: string;
  dshHome: string;
  launchDir: string;
  overlay: string;
  cacheDir: string;
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
    cacheDir: argumentValue(argv, '--cache-dir'),
  };
}

/**
 * Probe ограничивается metadata-handshake: он создаёт и сразу закрывает ACP-сессию,
 * но никогда не отправляет session/prompt и потому не расходует модельный запрос.
 */
async function runProbe(args: ProbeArguments) {
  const startedAt = Date.now();
  const runtime = await resolveDeepSeekRuntimeAsync({
    deepseekRuntimeMode: 'binary',
    deepseekBin: args.bin,
    deepseekCacheDir: args.cacheDir,
  });

  await verifyDeepSeekRuntimeDescriptorAsync(runtime);

  const owned = spawnDeepSeekBinary(runtime.command, [
    ...runtime.prefixArgs, '--profile', 'acp', '--patch', args.overlay,
  ], {
    cwd: args.launchDir,
    env: buildHarnessChildEnv({
      source: { ...process.env, HOME: args.dshHome },
      dshHome: args.dshHome,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const child = owned.child;
  let stderr = '';

  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${String(chunk)}`.slice(-16_384);
  });

  const client = createAcpClient(child);
  let sessionId = '';

  try {
    const initialized = await initializeAcp(client, 15000);
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
    await owned.stop();

    const processExit = await owned.closed;

    return {
      ok: true,
      packageId: runtime.metadata!.packageId,
      prefixArgs: runtime.prefixArgs,
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

    await owned.stop();

    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      probeStderr: stderr.trim(),
      probeElapsedMs: Date.now() - startedAt,
    });
  } finally {
    client.close();
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
