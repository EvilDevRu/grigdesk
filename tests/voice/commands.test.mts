import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { VoiceError } from '../../voice/src/contract.ts';
import { withAudioOutput } from '../../voice/src/audioFile.ts';
import { fixtureRoot, wavBytes } from './helpers.mts';

import { runVoice } from '../../voice/src/app.ts';
import type { VoiceIO } from '../../voice/src/app.ts';

interface Box {
  stdout: Array<string | Uint8Array>;
  stderr: string[];
}

/**
 * Собирает io с буферами вывода и запретом сети: любой fetch бросается.
 * engineStub подменяет фабрику движков на готовый piper с Ириной.
 */
function ioOf(box: Box, overrides: { engineStub?: 'piper-ready' } = {}): VoiceIO {
  return {
    env: { HOME: '/home/user' },
    getHome: () => '/home/user',
    scriptPath: async (name) => `/fixture/${name}`,
    readText: async () => {
      throw new Error('readText не ожидался');
    },
    readFile: async () => {
      throw new Error('readFile не ожидался');
    },
    writeFile: async () => {
      throw new Error('writeFile не ожидался');
    },
    writeStdout: async (value) => {
      box.stdout.push(value);
    },
    writeStderr: async (value) => {
      box.stderr.push(value);
    },
    fetch: async () => {
      throw new Error('сеть запрещена в тесте команд');
    },
    spawn: async () => {
      throw new Error('spawn не ожидался');
    },
    buildEngines: overrides.engineStub === 'piper-ready'
      ? () => [{
          id: 'piper',
          model: 'irina',
          defaultVoice: 'irina',
          name: 'Piper (локально)',
          kind: 'local' as const,
          capabilities: () => ({
            languages: ['ru'],
            pace: true,
            stress: false,
            pause: false,
            tone: false,
            emphasis: false,
            maxChars: 2000,
            formats: ['wav'],
          }),
          doctor: async () => ({
            status: 'ready' as const,
            reason: 'готов',
            install: '',
          }),
          voices: async () => [
            {
              id: 'irina',
              name: 'Ирина (женский)',
              languages: ['ru'],
              available: true,
              reason: '',
            },
          ],
          synthesize: async (_input, options) => ({
            file: options.outputFile,
            bytes: 4,
            format: 'wav',
            ignoredDirections: _input.text.includes('+') ? ['ударения'] : [],
          }),
        }]
      : undefined,
  };
}

function box(): Box {
  return { stdout: [], stderr: [] };
}

test('voice-commands-version', async () => {
  const b = box();
  const code = await runVoice(['version'], { version: '0.1.0' }, ioOf(b));

  assert.equal(code, 0);
  assert.match(String(b.stdout[0]), /^voice 0\.1\.0/u);
});

test('voice-commands-engines-без-ключа-показывает-причину', async () => {
  const b = box();
  const code = await runVoice(['engines'], { version: '0.1.0' }, ioOf(b));

  assert.equal(code, 0);

  const text = b.stdout.map(String).join('\n');

  assert.match(text, /qwen/u);
  assert.match(text, /нет ключа/iu);
  assert.match(text, /piper/u);
  assert.match(text, /silero/u);
});

test('voice-commands-models-json-содержит-qwen3-tts-flash', async () => {
  const b = box();
  const code = await runVoice(['models', '--json'], { version: '0.1.0' }, ioOf(b));
  const payload = JSON.parse(String(b.stdout[0])) as Array<{ id: string; model: string }>;

  assert.equal(code, 0);
  assert.ok(payload.some((item) => item.id === 'qwen' && item.model === 'qwen3-tts-flash'));
});

test('voice-commands-voices-qwen-содержит-русский', async () => {
  const b = box();
  const code = await runVoice(['voices', '--engine', 'qwen', '--json'], { version: '0.1.0' }, ioOf(b));
  const voices = JSON.parse(String(b.stdout[0])) as Array<{ id: string; languages: string[] }>;

  assert.equal(code, 0);
  assert.ok(voices.some((voice) => voice.id === 'Cherry' && voice.languages.includes('ru')));
});

test('voice-commands-generate-без-движка-и-ключа-код-1', async () => {
  const b = box();
  const code = await runVoice(['generate', '--text', 'привет'], { version: '0.1.0' }, ioOf(b));

  assert.equal(code, 1);
  assert.match(b.stderr.join('\n'), /нет готового движка/u);
});

test('voice-commands-неизвестный-engine-код-2', async () => {
  const b = box();
  const code = await runVoice(
    ['generate', '--engine', 'nope', '--text', 'привет'],
    { version: '0.1.0' },
    ioOf(b),
  );

  assert.equal(code, 2);
});

test('voice-commands-generate-из-файла-через-готовый-piper', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'voice-cmd-'));

  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const source = path.join(dir, 'text.txt');

  writeFileSync(source, 'прив+ет мир', 'utf8');

  const b = box();
  const out = path.join(dir, 'out.wav');
  const code = await runVoice(
    ['generate', '--engine', 'piper', '--file', source, '--out', out],
    { version: '0.1.0' },
    {
      ...ioOf(b),
      readFile: async (file: string) => {
      if (file === source) {
        return 'прив+ет мир';
      }

      throw new Error(`неожиданный файл ${file}`);
    },
      buildEngines: ioOf(b, { engineStub: 'piper-ready' }).buildEngines,
    },
  );

  assert.equal(code, 0);

  const report = JSON.parse(String(b.stdout[0])) as {
    engine: string;
    file: string;
    ignoredDirections: string[];
  };

  assert.equal(report.engine, 'piper');
  assert.equal(report.file, out);
  assert.deepEqual(report.ignoredDirections, ['ударения']);
});

test('voice-commands-generate-qwen-без-ключа-код-1-без-сети', async () => {
  const b = box();
  const code = await runVoice(
    ['generate', '--engine', 'qwen', '--text', 'привет'],
    { version: '0.1.0' },
    ioOf(b),
  );

  assert.equal(code, 1);
  assert.match(b.stderr.join('\n'), /нет ключа/iu);
});

test('voice-commands-install-неизвестный-движок-код-2', async () => {
  const b = box();
  const code = await runVoice(['install', 'nope'], { version: '0.1.0' }, ioOf(b));

  assert.equal(code, 2);
});

test('voice-commands-ключ-и-готовый-piper-выбирают-qwen', async () => {
  const b = box();
  const io = ioOf(b, { engineStub: 'piper-ready' });
  const config = {
    qwenService: 'model-studio' as const,
    qwenApiKey: 'synthetic',
    qwenBaseUrl: 'http://127.0.0.1:1',
    voiceDir: '/unused',
  };
  const local = io.buildEngines!(config, io)[0]!;
  const cloud = {
    ...local,
    id: 'qwen',
    kind: 'cloud' as const,
    model: 'qwen3-tts-flash',
    defaultVoice: 'Cherry',
  };
  const code = await runVoice(['generate', '--text', 'привет'], { version: '0.1.0' }, {
    ...io,
    env: { DASHSCOPE_API_KEY: 'synthetic' },
    buildEngines: () => [cloud, local],
  });

  assert.equal(code, 0);
  assert.equal(JSON.parse(String(b.stdout[0])).engine, 'qwen');
});


test('voice-cli-два-default-выхода-при-одних-часах-сохраняют-обе-реплики', async (t) => {
  const dir = await fixtureRoot(t);

  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 14) });
  t.mock.method(process, 'cwd', () => dir);

  const outputs = [box(), box()];
  const expected = [wavBytes(), wavBytes()];

  expected[1]!.writeInt16LE(2000, 44);

  const codes = await Promise.all(outputs.map((output, index) => {
    const io = ioOf(output, { engineStub: 'piper-ready' });
    const engines = io.buildEngines;

    assert.ok(engines);
    io.buildEngines = (config, ports) => engines(config, ports).map((engine) => ({
      ...engine,
      synthesize: async (_input, options) => ({
        ...await withAudioOutput(options.outputFile, async (file) => {
          writeFileSync(file, expected[index]!);
        }),
        ignoredDirections: [],
      }),
    }));

    return runVoice(['generate', '--engine', 'piper', '--text', `Реплика ${index}`],
      { version: '0.1.0' }, io);
  }));
  const reports = outputs.map((output) => JSON.parse(String(output.stdout[0])) as { file: string });

  assert.deepEqual(codes, [0, 0]);
  assert.notEqual(reports[0]!.file, reports[1]!.file);

  reports.forEach((report, index) => {
    assert.equal(path.dirname(report.file), dir);
    assert.match(path.basename(report.file), /^voice-2026-11-14T00-00-00-000Z-[a-f0-9-]+\.wav$/u);
    assert.deepEqual(readFileSync(report.file), expected[index]);
  });
});

for (const key of ['sk-synthetic\ninvalid', 'sk-synthetic-valid']) {
  test(`voice-cli-ошибка-ключа-${key.includes('\n') ? 'header' : 'transport'}-без-утечки`, async () => {
    const b = box();
    const code = await runVoice(['generate', '--engine', 'qwen', '--text', 'привет'],
      { version: '0.1.0' }, {
        ...ioOf(b),
        env: { DASHSCOPE_API_KEY: key },
        fetch: async () => {
          throw new Error(`Authorization: Bearer ${key}`);
        },
      });

    assert.equal(code, 1);
    assert.deepEqual(b.stdout, []);
    assert.ok(!b.stderr.join('\n').includes(key));
    assert.ok(!b.stderr.join('\n').includes('sk-synthetic'));
  });
}

for (const engine of ['qwen', 'piper', 'silero']) {
  test(`voice-cli-${engine}-mp3-отказ-до-эффектов`, async () => {
    const b = box();
    const code = await runVoice(['generate', '--engine', engine, '--text', 'привет',
      '--format', 'mp3'], { version: '0.1.0' }, ioOf(b));

    assert.equal(code, 2);
    assert.deepEqual(b.stdout, []);
  });
}

test('voice-cli-отказ-выбранного-облака-не-запускает-локальный-fallback', async () => {
  const b = box();
  const io = ioOf(b, { engineStub: 'piper-ready' });
  const config = {
    qwenService: 'model-studio' as const,
    qwenApiKey: 'synthetic',
    qwenBaseUrl: 'http://127.0.0.1:1',
    voiceDir: '/unused',
  };
  const local = io.buildEngines!(config, io)[0]!;
  let localCalls = 0;
  let cloudCalls = 0;
  const code = await runVoice(['generate', '--text', 'привет'], { version: '0.1.0' }, {
    ...io,
    buildEngines: () => [{
      ...local,
      id: 'qwen',
      synthesize: async () => {
        cloudCalls += 1;

        throw new VoiceError('Облако отказало.');
      },
    }, {
      ...local,
      synthesize: async () => {
        localCalls += 1;

        throw new Error('Не должно вызываться.');
      },
    }],
  });

  assert.equal(code, 1);
  assert.equal(cloudCalls, 1);
  assert.equal(localCalls, 0);
  assert.deepEqual(b.stdout, []);
});
