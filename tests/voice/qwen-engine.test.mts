import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { beforeCompletion, wavBytes } from './helpers.mts';

import { createQwenEngine } from '../../voice/src/engines/qwen.ts';

interface Seen {
  auth: string | undefined;
  audioAuth: string | undefined;
  body: Record<string, unknown>;
}

/**
 * Поддельный сервис TTS: слушает на 127.0.0.1:0, отвечает на POST синтеза JSON-ом
 * с адресом аудио и отдаёт сами байты на GET. Значение 'AUTO' в поле url заменяется
 * реальным адресом этого сервера после старта — тестам не нужен порт заранее.
 */
async function fakeService(
  audio: Buffer,
  respond: (seen: Seen) => { status: number; payload: unknown },
  audioStatus = 200,
): Promise<{
  url: string;
  seen: Seen;
  close(): Promise<void>;
}> {
  const seen: Seen = {
    auth: undefined,
    audioAuth: undefined,
    body: {},
  };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.url === '/api/v1/services/aigc/multimodal-generation/generation') {
        seen.auth = request.headers.authorization;
        seen.body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;

        const answer = respond(seen);
        const payload = JSON.parse(JSON.stringify(answer.payload)) as {
          output?: { audio?: { url?: string } };
        };

        if (payload.output?.audio?.url === 'AUTO') {
          payload.output.audio.url = `http://127.0.0.1:${
            (server.address() as { port: number }).port
          }/audio.wav`;
        }

        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));

        return;
      }

      if (request.url === '/audio.wav') {
        seen.audioAuth = request.headers.authorization;
        response.writeHead(audioStatus, { 'content-type': 'audio/wav' });
        response.end(audioStatus === 200 ? audio : undefined);

        return;
      }

      response.writeHead(404);
      response.end('not found');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('voice-qwen-voices-содержат-русский-и-cherry', async () => {
  const engine = createQwenEngine({
    apiKey: 'sk-test',
    baseUrl: 'http://127.0.0.1:1',
    fetch,
  });
  const voices = await engine.voices();
  const cherry = voices.find((voice) => voice.id === 'Cherry');

  assert.ok(cherry, 'голос Cherry есть');
  assert.ok(cherry.languages.includes('ru'), 'у Cherry есть русский');
  assert.ok(voices.length >= 40, 'каталог полный');
});

test('voice-qwen-doctor-без-ключа-заблокирован', async () => {
  const engine = createQwenEngine({
    apiKey: null,
    baseUrl: 'http://127.0.0.1:1',
    fetch,
  });
  const doctor = await engine.doctor();

  assert.equal(doctor.status, 'blocked');
  assert.match(doctor.install, /GRIGDESK_VOICE_QWEN_API_KEY/u);
});

test('voice-qwen-generate-полный-цикл', async (t) => {
  const audio = Buffer.alloc(46);

  audio.write('RIFF', 0);
  audio.writeUInt32LE(38, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(24000, 24);
  audio.writeUInt32LE(48000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(2, 40);
  audio.writeInt16LE(1000, 44);

  const fake = await fakeService(audio, () => ({
    status: 200,
    payload: { output: { audio: { url: 'AUTO' } } },
  }));

  t.after(async () => fake.close());

  const engine = createQwenEngine({
    apiKey: 'sk-test',
    baseUrl: fake.url,
    fetch,
  });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'voice-qwen-'));

  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const out = path.join(dir, 'a.wav');
  const result = await engine.synthesize(
    {
      text: 'прив+ет',
      voiceRef: 'Cherry',
      language: 'ru',
    },
    { outputFile: out, format: 'wav' },
  );

  assert.equal(fake.seen.auth, 'Bearer sk-test');
  assert.equal((fake.seen.body as { model?: string }).model, 'qwen3-tts-flash');
  assert.equal(
    ((fake.seen.body as { input?: { text?: string; voice?: string } }).input ?? {}).text,
    'привет',
    'в облако ушёл канонический текст без +',
  );
  assert.equal(
    ((fake.seen.body as { input?: { voice?: string } }).input ?? {}).voice,
    'Cherry',
  );
  assert.deepEqual(fake.seen.body, {
    model: 'qwen3-tts-flash',
    input: {
      text: 'привет',
      voice: 'Cherry',
      language_type: 'Russian',
    },
  });
  assert.equal(fake.seen.audioAuth, undefined, 'GET аудио без Authorization');
  assert.deepEqual(readFileSync(out), audio);
  assert.equal(result.format, 'wav');
  assert.deepEqual(result.ignoredDirections, ['ударения']);
});

test('voice-qwen-отказ-401-маскирует-ключ', async (t) => {
  const fake = await fakeService(Buffer.of(0), () => ({ status: 401, payload: { message: 'sk-secret123' } }));

  t.after(async () => fake.close());

  const engine = createQwenEngine({
    apiKey: 'sk-secret123',
    baseUrl: fake.url,
    fetch,
  });

  await assert.rejects(
    engine.synthesize(
      {
        text: 'привет',
        voiceRef: 'Cherry',
        language: 'ru',
      },
      { outputFile: '/tmp/never.wav', format: 'wav' },
    ),
    (error: Error) => {
      assert.match(error.message, /HTTP 401/u);
      assert.ok(!String(error).includes('sk-secret123'), 'ключ не светится в ошибке');

      return true;
    },
  );
});

test('voice-qwen-аудио-404-ошибка-скачивания', async (t) => {
  const fake = await fakeService(
    Buffer.of(0),
    () => ({ status: 200, payload: { output: { audio: { url: 'AUTO' } } } }),
    404,
  );

  t.after(async () => fake.close());

  const engine = createQwenEngine({
    apiKey: 'sk-test',
    baseUrl: fake.url,
    fetch,
  });

  await assert.rejects(
    engine.synthesize(
      {
        text: 'привет',
        voiceRef: 'Cherry',
        language: 'ru',
      },
      { outputFile: '/tmp/never.wav', format: 'wav' },
    ),
    /HTTP 404/u,
  );
});

test('voice-qwen-нет-url-аудио-ошибка', async (t) => {
  const fake = await fakeService(Buffer.of(0), () => ({ status: 200, payload: { output: {} } }));

  t.after(async () => fake.close());

  const engine = createQwenEngine({
    apiKey: 'sk-test',
    baseUrl: fake.url,
    fetch,
  });

  await assert.rejects(
    engine.synthesize(
      {
        text: 'привет',
        voiceRef: 'Cherry',
        language: 'ru',
      },
      { outputFile: '/tmp/never.wav', format: 'wav' },
    ),
    /не вернул адрес аудио/u,
  );
});

test('voice-qwen-длинный-текст-отказ-до-сети', async () => {
  const engine = createQwenEngine({
    apiKey: 'sk-test',
    baseUrl: 'http://127.0.0.1:1',
    fetch: async () => {
      throw new Error('сеть не должна вызываться при превышении лимита');
    },
  });

  await assert.rejects(
    engine.synthesize(
      {
        text: 'а'.repeat(601),
        voiceRef: 'Cherry',
        language: 'ru',
      },
      { outputFile: '/tmp/never.wav', format: 'wav' },
    ),
    /длиннее предела/u,
  );
});

test('voice-qwen-ровно-600-символов-допустимы', async (t) => {
  const fake = await fakeService(wavBytes(), () => ({
    status: 200,
    payload: { output: { audio: { url: 'AUTO' } } },
  }));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'voice-qwen-boundary-'));

  t.after(async () => fake.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const engine = createQwenEngine({
    apiKey: 'synthetic',
    baseUrl: fake.url,
    fetch,
  });

  await engine.synthesize({
    text: 'а'.repeat(600),
    voiceRef: 'Cherry',
    language: 'ru',
  },
    { outputFile: path.join(dir, 'out.wav'), format: 'wav' });
  assert.deepEqual(readFileSync(path.join(dir, 'out.wav')), wavBytes());
});

test('voice-qwen-транспортная-ошибка-не-раскрывает-ключ', async () => {
  const key = 'sk-synthetic-private';
  const engine = createQwenEngine({
    apiKey: key,
    baseUrl: 'http://127.0.0.1:1',
    fetch: async () => {
      throw new Error(`Authorization: Bearer ${key}`);
    },
  });

  await assert.rejects(engine.synthesize({
    text: 'привет',
    voiceRef: 'Cherry',
    language: 'ru',
  },
    { outputFile: '/never-written.wav', format: 'wav' }), (error: Error) => {
    assert.ok(!String(error).includes(key));

    return true;
  });
});

for (const stalled of ['post', 'audio'] as const) {
  test(`voice-qwen-срок-охватывает-${stalled}-body-и-сохраняет-прежний-файл`,
    { timeout: 10000 }, async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'voice-qwen-stall-'));
    const output = path.join(dir, 'out.wav');

    writeFileSync(output, 'previous');
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    const controller = new AbortController();
    const requests: string[] = [];
    let reached!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let attempt: Promise<unknown> | undefined;

    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      request.resume();
      request.on('end', () => {
        if (request.url === '/audio') {
          response.writeHead(200, { 'content-type': 'audio/wav' });
          response.write('RIFF');
          reached();

          return;
        }

        response.writeHead(200, { 'content-type': 'application/json' });

        if (stalled === 'post') {
          response.write('{');
          reached();

          return;
        }

        const port = (server.address() as { port: number }).port;

        response.end(JSON.stringify({ output: { audio: { url: `http://127.0.0.1:${port}/audio` } } }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const port = (server.address() as { port: number }).port;
    const engine = createQwenEngine({
      apiKey: 'synthetic',
      baseUrl: `http://127.0.0.1:${port}`,
      fetch,
    });

    attempt = engine.synthesize({
      text: 'привет',
      voiceRef: 'Cherry',
      language: 'ru',
    },
      {
        outputFile: output,
        timeoutMs: 2000,
        signal: controller.signal,
      });

    try {
      await beforeCompletion(bodyStarted, attempt);
      assert.deepEqual(requests, stalled === 'post'
        ? ['/api/v1/services/aigc/multimodal-generation/generation']
        : ['/api/v1/services/aigc/multimodal-generation/generation', '/audio']);
      await assert.rejects(attempt, /Истёк срок запроса Qwen/u);
    } finally {
      controller.abort();
      server.closeAllConnections();
      await attempt.catch(() => undefined);
    }

    assert.equal(readFileSync(output, 'utf8'), 'previous');
    assert.deepEqual(readdirSync(dir), ['out.wav']);
  });
}

test('voice-qwen-не-отправляет-темп-и-инструкцию-и-отчитывается', async (t) => {
  const fake = await fakeService(wavBytes(), () => ({
    status: 200,
    payload: { output: { audio: { url: 'AUTO' } } },
  }));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'voice-qwen-directions-'));

  t.after(async () => fake.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = await createQwenEngine({
    apiKey: 'synthetic',
    baseUrl: fake.url,
    fetch,
  }).synthesize(
    {
      text: 'прив+ет',
      voiceRef: null,
      language: null,
    },
    {
      outputFile: path.join(dir, 'out.wav'),
      pace: 'fast',
      instruction: 'эмоционально',
    },
  );

  assert.deepEqual(fake.seen.body, {
    model: 'qwen3-tts-flash',
    input: {
      text: 'привет',
      voice: 'Cherry',
      language_type: 'Auto',
    },
  });
  assert.deepEqual(result.ignoredDirections, ['темп', 'ударения', 'инструкция']);
});
