import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import test from 'node:test';
import { build } from '../../web/node_modules/vite/dist/node/index.js';
import { transportHarness } from './helpers/compile-vue.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const streamPath = path.join(root, 'web/src/shared/speechStream.ts');
const workletPath = path.join(root, 'web/src/shared/speechPcmWorklet.ts');

/**
 * Сборка использует настоящий transport entry и штатный Vite worker plugin.
 * Все выходы остаются во временном каталоге, используемый стендом dist не затрагивается.
 */
async function builtWorklet() {
  assert.ok(existsSync(streamPath), 'нет TypeScript transport entry');
  assert.ok(existsSync(workletPath), 'нет TypeScript processor entry');

  const directory = await mkdtemp(path.join(tmpdir(), 'grigdesk-worklet-build-'));

  try {
    const entry = path.join(directory, 'entry.ts');

    await writeFile(entry, `export {createSpeechStream} from ${JSON.stringify(streamPath)};\n`);

    const result = await build({
      configFile: false,
      root: path.join(root, 'web'),
      base: './',
      logLevel: 'silent',
      build: {
        write: false,
        outDir: directory,
        rollupOptions: { input: entry, preserveEntrySignatures: 'strict' },
      },
    });

    assert.ok(!('on' in result), 'проверка не использует watch build');

    const bundle = Array.isArray(result) ? result[0] : result;

    assert.ok(bundle && 'output' in bundle);

    const output = bundle.output;
    const processor = output.find((item) => /speechPcmWorklet.*\.js$/.test(item.fileName));
    const transport = output.find((item) => item.type === 'chunk' && item.isEntry);

    assert.ok(processor, 'Vite обязан выпустить отдельный JavaScript processor');
    assert.ok(transport);

    for (const item of output) {
      const destination = path.join(directory, item.fileName);

      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, item.type === 'asset' ? item.source : item.code);
    }

    const code = await readFile(path.join(directory, processor.fileName), 'utf8');

    return {
      directory,
      code,
      processor: processor.fileName,
      transport: transport.fileName
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });

    throw error;
  }
}

test('WORKLET-js-exec', async (t) => {
  const built = await builtWorklet();

  t.after(() => rm(built.directory, { recursive: true, force: true }));

  const context = vm.createContext({
    sampleRate: 48000,
    AudioWorkletProcessor: class {
      port = {
        onmessage: null,
        messages: [] as Array<{ type: string; pcm?: ArrayBuffer }>,
        postMessage(message: { type: string; pcm?: ArrayBuffer }) {
          this.messages.push(message);
        },
      };
    },
    registerProcessor(name: string, Constructor: unknown) {
      Object.assign(context, { registeredName: name, Processor: Constructor });
    },
  });

  vm.runInContext(built.code, context);
  assert.equal(context.registeredName, 'grigdesk-speech-pcm16');

  const processor = new context.Processor();
  const muted = new Float32Array(128).fill(1);

  processor.process([[new Float32Array(4800).fill(0.75), new Float32Array(4800).fill(0.25)]], [[muted]]);

  const samples = new Int16Array(processor.port.messages[0].pcm);

  assert.equal(samples.length, 1600);
  assert.ok(samples.every((sample) => Math.abs(sample - 16383) <= 1));
  assert.ok(muted.every((sample) => sample === 0));

  const tail = new context.Processor();

  tail.process([[new Float32Array(480).fill(-0.5)]], [[new Float32Array(128)]]);
  tail.port.onmessage({ data: { type: 'flush' } });
  assert.deepEqual(Array.from(tail.port.messages, (message: { type: string }) => message.type),
    ['pcm', 'flushed']);
  assert.equal(new Int16Array(tail.port.messages[0].pcm).length, 160);

  const count = tail.port.messages.length;

  tail.process([[new Float32Array(4800).fill(0.5)]], [[new Float32Array(128)]]);
  assert.equal(tail.port.messages.length, count, 'после flush PCM прекращается');
});

test('WORKLET-default-url', async (t) => {
  const built = await builtWorklet();

  t.after(() => rm(built.directory, { recursive: true, force: true }));

  const transportUrl = pathToFileURL(path.join(built.directory, built.transport)).href;
  const { createSpeechStream } = await import(transportUrl);
  const harness = transportHarness();
  const opening = createSpeechStream(harness.config);
  const socket = harness.state.sockets[0];

  assert.ok(socket);
  socket.open();

  const start = JSON.parse(socket.sent[0]);

  socket.message({
    type: 'ready',
    protocolVersion: start.protocolVersion,
    audio: start.audio
  });

  const session = await opening;

  t.after(() => session.cancel());

  const audioContext = harness.state.contexts[0];

  assert.ok(audioContext);

  const loadedUrl = new URL(audioContext.loadedModules[0]);

  assert.equal(path.basename(loadedUrl.pathname), path.basename(built.processor));
  assert.equal(loadedUrl.pathname.endsWith('.ts'), false);
  assert.equal(await readFile(fileURLToPath(loadedUrl), 'utf8'), built.code);
});

test('WORKLET-host-types', () => {
  const config = path.join(root, 'web/tsconfig.audioWorklet.json');

  assert.ok(existsSync(config), 'нет отдельного host-проекта');

  for (const project of ['tsconfig.json', 'tsconfig.audioWorklet.json']) {
    const effective = JSON.parse(execFileSync(process.execPath, [
      path.join(root, 'web/node_modules/typescript/bin/tsc'),
      '-p', path.join(root, 'web', project), '--showConfig',
    ], { encoding: 'utf8' }));

    assert.ok(effective.files.some((file: string) => file.endsWith('/speechPcmWorklet.ts')));

    if (project === 'tsconfig.audioWorklet.json') {
      assert.deepEqual(effective.compilerOptions.types, []);
      assert.deepEqual(effective.compilerOptions.lib, ['es2022', 'es2023.array']);
    }
  }

  execFileSync(process.execPath, [path.join(root, 'web/node_modules/typescript/bin/tsc'),
    '-p', config, '--noEmit'], { stdio: 'pipe' });
});
