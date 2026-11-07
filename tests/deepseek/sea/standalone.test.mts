import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { ensureTestDeepSeekBinary, ensureTestDeepSeekBinaryPair } from '../../helpers/deepseekBinary.mts';
import { sha256File } from '../../../shared/node/hash.ts';
import { createAcpClient } from '../../../server/src/lib/acp/client.ts';
import { glmCompatibilityIdentity } from '../../../server/src/lib/glm/contract.ts';
import { GLM_ADMISSION } from '../../../deepseek/src/runtime/glmCompatibility.ts';
import { startDeepSeekServer } from '../../../server/src/lib/deepseek/serverRuntime.ts';
import { runDeepSeekServerTurn } from '../../../server/src/lib/deepseek/serverTurn.ts';
import { startDeepSeekLoopback, writeDeepSeekLoopbackOverlay } from '../../helpers/deepseekLoopback.mts';

const run = promisify(execFile);

/**
 * Фикстура соблюдает physical layout JSONL backend: projectKey кодирует UTF-16 cwd.
 * Формула перенесена из session-persistence-jsonl/format.ts, без доступа к private home.
 */
function journalDirectory(root: string, cwd: string, id: string): string {
  let readable = '';
  let separatorRun = false;

  for (let index = 0; index < cwd.length; index += 1) {
    const character = cwd[index]!;

    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) {
        readable += '-';
      }

      separatorRun = true;
    } else {
      readable += character !== '~' && /^[A-Za-z0-9._-]$/u.test(character)
        ? character : `~${cwd.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }

  const slug = readable.replace(/^-+/u, '') || 'root';

  return path.join(root, `--${slug.slice(0, 251)}--`, id);
}

test('реальный ELF читает metadata после удаления source fixture без HOME, PATH или cache', {
  timeout: 900000,
}, async (t) => {
  const candidate = await ensureTestDeepSeekBinary();
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'standalone путь с пробелами '));
  const binary = path.join(scratch, 'deepseek');

  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  await fs.copyFile(candidate.binary, binary);

  const result = await run(binary, ['--runtime-info', '--json'], {
    cwd: scratch,
    env: { PATH: '' },
    timeout: 10000,
  });
  const info = JSON.parse(result.stdout);

  assert.equal(result.stderr, '');
  assert.equal(info.packageId, candidate.info.packageId);
  assert.equal(info.workerNode.version, '24.21.0');
  assert.notEqual(info.workerNode.abi, '', 'ABI worker получен из настоящего Node');
  assert.deepEqual(await fs.readdir(scratch), ['deepseek']);
  assert.equal((await fs.readdir(path.dirname(path.dirname(candidate.binary))))
    .some((name) => name.startsWith('source-')), false, 'Приватная source fixture уже удалена');
  assert.equal((await run(binary, ['-V'], { env: { PATH: '' }, timeout: 10000 })).stdout,
    `${info.upstreamVersion}\n`);
});

test('A/B сохраняют generation и compatibility, меняя версию, packageId и bytes ELF', {
  timeout: 900000,
}, async () => {
  const { a, b } = await ensureTestDeepSeekBinaryPair();

  assert.equal(a.info.buildId, b.info.buildId);
  assert.notEqual(a.info.binaryVersion, b.info.binaryVersion);
  assert.notEqual(a.info.packageId, b.info.packageId);
  assert.notEqual(await sha256File(a.binary), await sha256File(b.binary));

  const pluginA = a.info.glm.inputs.llmPiAi;
  const pluginB = b.info.glm.inputs.llmPiAi;

  assert.ok(pluginA, 'Candidate A включает GLM plugin');
  assert.ok(pluginB, 'Candidate B включает GLM plugin');
  assert.equal(glmCompatibilityIdentity({ ...a.info.glm.inputs, llmPiAi: pluginA }, 'api'),
    glmCompatibilityIdentity({ ...b.info.glm.inputs, llmPiAi: pluginB }, 'api'));
  assert.deepEqual(a.info.glm.admission, GLM_ADMISSION, 'Перенос не расширяет frozen admission');
});

test('SEA и обычный worker не исполняют NODE_OPTIONS preload, ACP стартует с пустым PATH', {
  timeout: 900000,
}, async (t) => {
  const candidate = await ensureTestDeepSeekBinary();
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'standalone-loader-'));
  const preload = path.join(scratch, 'preload.cjs');
  const sentinel = path.join(scratch, 'preload-ran');
  const home = path.join(scratch, 'home');

  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  await fs.mkdir(home);
  await fs.writeFile(preload, 'require("node:fs").writeFileSync(process.env.POISON_DESTINATION, "ran");'
    + 'throw new Error("untrusted preload executed");');

  const environment = {
    PATH: '',
    HOME: home,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    TMPDIR: scratch,
    NODE_OPTIONS: `--require ${JSON.stringify(preload)} --import ${new URL(`file://${preload}`).href}`,
    NODE_PATH: scratch,
    NODE_COMPILE_CACHE: path.join(scratch, 'compile-cache'),
    NODE_V8_COVERAGE: path.join(scratch, 'coverage'),
    POISON_DESTINATION: sentinel,
    NO_COLOR: '1',
  };
  const metadata = await run(candidate.binary, ['--runtime-info', '--json'], { env: environment });

  assert.equal(metadata.stderr, '');
  assert.equal(JSON.parse(metadata.stdout).packageId, candidate.info.packageId);

  const verified = await run(candidate.binary,
    ['--cache-dir', candidate.cacheDir, '--verify', '--json'], { env: environment, timeout: 30000 });

  assert.equal(verified.stderr, '');
  assert.equal(JSON.parse(verified.stdout).verified, true);
  await assert.rejects(run(candidate.binary, ['--runtime-info', '--json'], {
    env: { ...environment, NODE_REPL_EXTERNAL_MODULE: preload },
  }), (error: any) => {
    assert.equal(error.code, 9, 'Закреплённый Node отвергает REPL injection до запуска SEA');
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /NODE_REPL_EXTERNAL_MODULE.*kDisableNodeOptionsEnv/u);

    return true;
  });

  const child = spawn(candidate.binary, ['--cache-dir', candidate.cacheDir, '--profile', 'acp'], {
    cwd: scratch,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  const client = createAcpClient(child, { requestTimeoutMs: 30000 });
  let diagnostics = '';

  child.stderr!.on('data', (chunk) => {
    diagnostics = (diagnostics + String(chunk)).slice(-32768);
  });
  t.after(async () => {
    client.close();

    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }

    await exited;
  });

  const initialized = await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
  }) as Record<string, any>;

  assert.equal(initialized.protocolVersion, 1, diagnostics);
  assert.equal((await client.request('_grigdesk/settings/describe', {}) as any).writable, true);
  client.close();
  assert.equal(await exited, 0, diagnostics);
  await assert.rejects(fs.access(sentinel), { code: 'ENOENT' });

  // Сам Node SEA вправе записывать собственную instrumentation до входа в launcher.
  // Worker не наследует эти inputs: его entry и generation отсутствуют в coverage.
  const files = await fs.readdir(environment.NODE_V8_COVERAGE).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  });

  for (const file of files) {
    const coverage = JSON.parse(await fs.readFile(path.join(environment.NODE_V8_COVERAGE, file), 'utf8'));

    assert.equal(coverage.result.some((entry: { url: string }) =>
      entry.url.includes(candidate.cacheDir)), false);
  }
});

test('ELF возобновляет журнал каждой объявленной версии, v99 отвергает до model call', {
  timeout: 900000,
}, async (t) => {
  const candidate = await ensureTestDeepSeekBinary();
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'standalone-journal-'));
  const mock = await startDeepSeekLoopback();
  const generation = path.join(candidate.cacheDir, 'packages', candidate.info.packageId, 'generation');
  const rows = [
    {
      type: 'turn/start',
      seq: 0,
      time: 2,
      data: { turn: 1 },
    },
    {
      type: 'turn/end',
      seq: 1,
      time: 3,
      data: { turn: 1, reason: { kind: 'completed' } },
    },
  ];

  t.after(async () => {
    await mock.stop();
    await fs.rm(scratch, { recursive: true, force: true });
  });

  for (const version of [...candidate.info.journal.read, 99]) {
    const root = path.join(scratch, `v${version}`);
    const sessions = path.join(root, 'sessions');
    const home = path.join(root, 'home');
    const id = `codec-resume-v${version}`;
    const directory = journalDirectory(sessions, root, id);
    const original = path.join(directory, version === 0 ? 'session.jsonl' : `session.v${version}.jsonl`);
    const header = {
      type: 'session',
      version,
      id,
      cwd: root,
      createdAt: 1,
      delegationDepth: 0,
      ...(version >= 2 ? { isSeeded: false } : {}),
    };

    await fs.mkdir(directory, { recursive: true });
    await fs.mkdir(home);
    await fs.writeFile(original, [header, ...rows].map((row) => JSON.stringify(row)).join('\n') + '\n');

    const before = await fs.readFile(original, 'utf8');
    const document = path.join(root, 'settings.yaml');

    await fs.writeFile(document, '{}\n');

    const overlay = await writeDeepSeekLoopbackOverlay({
      root,
      artifact: generation,
      endpoint: mock.endpoint,
      document,
    });

    await fs.appendFile(overlay, '- id: session-persistence-jsonl\n  config:\n'
      + `    root: ${JSON.stringify(sessions)}\n    compression: none\n`);

    let diagnostics = '';
    const spawnBinary = ((command: string, args: readonly string[], input: SpawnOptions) => {
      const child = spawn(command, ['--cache-dir', candidate.cacheDir, ...args], input);

      child.stderr?.on('data', (chunk) => {
        diagnostics = (diagnostics + String(chunk)).slice(-32768);
      });

      return child;
    }) as typeof spawn;
    /**
     * Настоящий web-процесс получает только явный cache prefix, без подмены транспорта.
     * Хвост stderr раскрывает причину startup failure и не сохраняет auth URL.
     */
    const startServer: typeof startDeepSeekServer = async (options) => {
      try {
        return await startDeepSeekServer({ ...options, spawnProcess: spawnBinary });
      } catch (error) {
        const safe = diagnostics.replace(/token=\S+/gu, 'token=<redacted>');

        throw new Error(`${(error as Error).message}\n${safe}`);
      }
    };
    const prompt = () => runDeepSeekServerTurn({
      bin: candidate.binary,
      overlayPath: overlay,
      cwd: root,
      env: {
        PATH: '',
        HOME: home,
        DSH_HOME: home,
        TMPDIR: scratch,
        DSH_TELEMETRY_DISABLED: '1',
        DEEPSEEK_API_KEY: 'synthetic-loopback-key',
      },
      message: 'Продолжи существующий фикстурный журнал.',
      sessionId: id,
      model: '["deepseek-official","deepseek-v4-flash"]',
      effort: 'off',
      signal: AbortSignal.timeout(60000),
      startServer,
    });
    const calls = mock.payloads.length;

    if (version === 99) {
      await assert.rejects(prompt, /v99|newer|unsupported/iu);
      assert.equal(mock.payloads.length, calls, 'Неизвестный codec не допускает запрос к модели');
      assert.equal(await fs.readFile(original, 'utf8'), before);
    } else {
      const result = await prompt();
      const current = path.join(directory, `session.v${candidate.info.journal.write}.jsonl`);
      const persisted = (await fs.readFile(current, 'utf8')).trim().split('\n').map((row) => JSON.parse(row));

      assert.equal(result.sessionId, id, `v${version}: продолжена исходная сессия`);
      assert.equal(result.reply, 'loopback-ok');
      assert.equal(mock.payloads.length, calls + 1);
      assert.equal(persisted[0].version, candidate.info.journal.write);
      assert.ok(persisted.some((row) => row.type === 'turn/start' && row.data.turn === 2),
        `v${version}: восстановлен номер предыдущего хода`);

      if (version !== candidate.info.journal.write) {
        assert.equal(await fs.readFile(original, 'utf8'), before, 'Историческая generation неизменна');
      }
    }
  }
});
