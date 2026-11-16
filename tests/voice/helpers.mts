import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import type { TestContext } from 'node:test';

import { runWithStdin } from '../../voice/src/process.ts';
import { PIPER_PACKAGE, SILERO_PACKAGE } from '../../voice/src/local/catalogs.ts';
import type { LocalPackage } from '../../voice/src/local/catalogs.ts';

/**
 * Каждая проверка получает собственную папку под общим корнем артефактов.
 * Cleanup удаляет только эту папку после завершения принадлежащих тесту процессов.
 */
export async function fixtureRoot(t: TestContext): Promise<string> {
  const parent = path.join(process.env.GRIGDESK_ARTIFACTS_DIR
    ?? path.join(os.homedir(), '.grigdesk', 'artifacts'), 'voice-tests');

  await fs.mkdir(parent, { recursive: true });

  const root = await fs.mkdtemp(path.join(parent, 'case-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  return root;
}

/**
 * Считает SHA256 маленького файла фикстуры для проверяемого каталога.
 * Большие модели и внешняя сеть для получения pin не требуются.
 */
export function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Маленький корректный PCM WAV не зависит от установленного кодека или модели.
 * Проверка контейнера проходит на настоящих байтах, а не на строке имени файла.
 */
export function wavBytes(): Buffer {
  const wav = Buffer.alloc(46);

  wav.write('RIFF', 0);
  wav.writeUInt32LE(38, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(2, 40);
  wav.writeInt16LE(1000, 44);

  return wav;
}

/**
 * Барьер ждёт наблюдаемого эффекта, а не предполагаемой длительности IO.
 * Общий срок ограничивает неисправную фикстуру, не задаёт требование быстродействия.
 */
export async function eventually(check: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + 5000;

  while (!(await check())) {
    assert.ok(Date.now() < until, 'фикстура не достигла барьера за 5 с');
    await pause(10);
  }
}

/**
 * Сигнал фикстуры не переживает породившую его операцию: ранний успех тоже ошибка.
 * Таймер ограничивает неисправный барьер; исходная операция очищается вызывающим finally.
 */
export async function beforeCompletion<T>(signal: Promise<T>, producer: Promise<unknown>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      signal,
      producer.then(() => {
        throw new Error('Операция завершилась до сигнала фикстуры.');
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Сигнал фикстуры не получен за 5 с.')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Сетевой сервер умеет Range, отказ от Range и настоящий разрыв тела.
 * Разрыв инициирует тест лишь после появления префикса на диске клиента.
 */
export async function modelServer(t: TestContext, bytes: Buffer) {
  const ranges: string[] = [];
  let ignoreRange = false;
  let breakBody = false;
  let rejectedRequests = 0;
  let invalidRange = false;
  let destroyBody: (() => void) | undefined;

  const server = createServer((request, response) => {
    ranges.push(request.headers.range ?? '');

    if (rejectedRequests > 0) {
      rejectedRequests -= 1;
      response.writeHead(416, { 'content-range': `bytes */${bytes.length}` });
      response.end();

      return;
    }

    if (invalidRange && request.headers.range) {
      invalidRange = false;
      response.writeHead(206, { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` });
      response.end(bytes);

      return;
    }

    if (breakBody) {
      breakBody = false;
      response.writeHead(200, { 'content-length': bytes.length });
      response.write(bytes.subarray(0, 100));
      destroyBody = () => response.destroy();

      return;
    }

    const offset = ignoreRange ? 0 : Number(/bytes=(\d+)-/u.exec(request.headers.range ?? '')?.[1] ?? 0);

    if (offset >= bytes.length && offset > 0) {
      response.writeHead(416, { 'content-range': `bytes */${bytes.length}` });
      response.end();

      return;
    }

    response.writeHead(offset ? 206 : 200, {
      'content-length': bytes.length - offset,
      ...(offset ? { 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}),
    });
    response.end(bytes.subarray(offset));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/model`,
    ranges,
    ignoreRange() {
      ignoreRange = true;
    },
    breakNextBody() {
      breakBody = true;
    },
    rejectRequests(count: number) {
      rejectedRequests = count;
    },
    invalidNextRange() {
      invalidRange = true;
    },
    disconnect() {
      assert.ok(destroyBody, 'сервер начал тело');
      destroyBody();
    },
  };
}

/**
 * Модель и venv заменяются маленькими файлами, но installer и приёмка настоящие.
 * Fake executable проверяет staged пути и EOF stdin, а затем пишет корректный WAV.
 */
export async function localFixture(
  t: TestContext,
  engineId: 'piper' | 'silero',
  archiveLayout: 'bare' | 'dot' = 'bare',
) {
  const root = await fixtureRoot(t);
  const voiceDir = path.join(root, 'voice');
  const source = path.join(root, 'source');
  const pipLog = path.join(root, 'pip.log');
  const failPip = path.join(root, 'fail-pip');
  const silent = path.join(root, 'silent');
  const synthLog = path.join(root, 'synth.json');
  const model = Buffer.alloc(4096, 7);
  const config = Buffer.from('{}');

  await fs.mkdir(source);
  await fs.writeFile(path.join(root, 'piperSynth.py'), '# fixture\n');
  await fs.writeFile(path.join(root, 'sileroSynth.py'), '# fixture\n');

  let bytes: Buffer;
  let pkg: LocalPackage;

  if (engineId === 'piper') {
    await fs.writeFile(path.join(source, PIPER_PACKAGE.modelName), model);
    await fs.writeFile(path.join(source, PIPER_PACKAGE.configName), config);

    const archive = path.join(root, 'model.tar.gz');

    const names = [PIPER_PACKAGE.modelName, PIPER_PACKAGE.configName]
      .map((name) => archiveLayout === 'dot' ? `./${name}` : name);

    await runWithStdin('tar', ['-czf', archive, '-C', source, '--', ...names], {
      input: '', timeoutMs: 5000,
    });
    bytes = await fs.readFile(archive);
    pkg = {
      ...PIPER_PACKAGE,
      archiveSha256: digest(bytes),
      archiveBytes: bytes.length,
      modelSha256: digest(model),
      configSha256: digest(config),
    };
  } else {
    bytes = model;
    pkg = {
      ...SILERO_PACKAGE,
      fileSha256: digest(bytes),
      fileBytes: bytes.length,
    };
  }

  const network = await modelServer(t, bytes);

  pkg = { ...pkg, url: network.url };

  const versions = Object.fromEntries(pkg.requirements.map((item) => item.split('==')));
  const fakeSource = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    `const pipLog = ${JSON.stringify(pipLog)};`,
    `const failPip = ${JSON.stringify(failPip)};`,
    `const silent = ${JSON.stringify(silent)};`,
    `const synthLog = ${JSON.stringify(synthLog)};`,
    'if (args[0] === "-c") {',
    `  console.log(${JSON.stringify(JSON.stringify({ versions }))});`,
    '  process.exit(0);',
    '}',
    'if (args[0] === "-m" && args[1] === "pip") {',
    '  fs.appendFileSync(pipLog, "pip\\n");',
    '  if (fs.existsSync(failPip)) { fs.unlinkSync(failPip); process.exit(7); }',
    '  process.exit(0);',
    '}',
    'for (const flag of ["--model", "--config"]) {',
    '  const at = args.indexOf(flag);',
    '  if (at >= 0 && !fs.existsSync(args[at + 1])) { process.exit(8); }',
    '}',
    'let text = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { text += chunk; });',
    'process.stdin.on("end", () => {',
    '  if (!text) { process.exit(9); }',
    '  fs.writeFileSync(synthLog, JSON.stringify({ args, text }));',
    `  const wav = Buffer.from(${JSON.stringify(wavBytes().toString('base64'))}, "base64");`,
    '  fs.writeFileSync(args[args.indexOf("--out") + 1], wav);',
    '  console.log(JSON.stringify({ durationMs: 100, sampleRate: 24000, channels: 1,',
    '    peak: fs.existsSync(silent) ? 0 : 0.5 }));',
    '});',
  ].join('\n');

  const run: typeof runWithStdin = async (command, args, options) => {
    if (command === 'fixture-python3' && args[0] === '-m' && args[1] === 'venv') {
      const directory = args.at(-1)!;

      await fs.mkdir(path.join(directory, 'bin'), { recursive: true });
      await fs.writeFile(path.join(directory, 'bin/python'), fakeSource, { mode: 0o755 });

      return { stdout: '', stderr: '' };
    }

    return runWithStdin(command, args, options);
  };

  const spec = {
    package: pkg,
    voiceDir,
    fetch,
    run,
    scriptPath: async (name: string) => path.join(root, name),
    bootstrapPython: 'fixture-python3',
    log: () => undefined,
  };

  return {
    root,
    voiceDir,
    pkg,
    bytes,
    network,
    run,
    spec,
    pipLog,
    failPip,
    silent,
    synthLog,
  };
}
