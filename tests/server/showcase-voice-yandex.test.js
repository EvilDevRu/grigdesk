// Облачный голос Yandex SpeechKit: готовность, разметка и запрос к поставщику.
//
// Поставщика подменяет местный HTTP-сервер: проверяется, ЧТО адаптер отправляет
// (ключ, каталог, голос, амплуа, темп, разметка), как склеивает потоковый ответ и
// как называет отказы. Ни один запрос из этих проверок наружу не уходит.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createYandexEngine, wavOf, yandexMarkup } from '../../server/src/lib/showcase/voice/yandex.ts';
import { YANDEX_VOICES } from '../../server/src/lib/showcase/voice/yandexCatalog.ts';

const DIRECTION = {
  tone: null, pace: null, emphasis: [], pauses: [], stresses: [],
};

/**
 * Синус в сырых отсчётах PCM 16 бит: по нему видно, что порции склеились без
 * потерь, а проверка на тишину различает звук и молчание.
 */
function pcmSine({ seconds = 0.5, amplitude = 8000 } = {}) {
  const samples = Math.round(48_000 * seconds);
  const buffer = Buffer.alloc(samples * 2);

  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * index) / 48_000));

    buffer.writeInt16LE(value, index * 2);
  }

  return buffer;
}

/**
 * Подменённый поставщик. Отдаёт то, что ему велели, и запоминает запрос: заголовки
 * и тело — единственное, по чему можно судить, что именно адаптер попросил.
 */
async function fakeProvider(t, respond) {
  const calls = [];
  const server = createServer((request, response) => {
    let body = '';

    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      calls.push({ headers: request.headers, body: JSON.parse(body) });

      const reply = respond(calls.length);

      response.writeHead(reply.status, { 'content-type': 'application/json', 'x-request-id': 'req-1' });
      response.end(reply.text);
    });
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
  }));

  const { port } = server.address();

  return { calls, endpoint: `http://127.0.0.1:${port}/tts/v3/utteranceSynthesis` };
}

function streamOf(pcm) {
  const half = Math.floor(pcm.length / 4) * 2;
  const chunks = [pcm.subarray(0, half), pcm.subarray(half)];

  return chunks
    .map((chunk) => JSON.stringify({ result: { audioChunk: { data: chunk.toString('base64') } } }))
    .join('\n');
}

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-yandex-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

test('каталог держит новые голоса v3 и называет тембр каждого', () => {
  const ids = YANDEX_VOICES.map((voice) => voice.id);

  for (const expected of ['marina', 'dasha', 'lera', 'masha', 'alexander', 'kirill', 'anton']) {
    assert.ok(ids.includes(expected), `нет голоса ${expected}`);
  }

  assert.ok(YANDEX_VOICES.every((voice) => voice.name && voice.timbre));
});

test('без ключа движок заблокирован и называет переменную .env', async () => {
  const engine = createYandexEngine({ apiKey: '', folderId: '' });
  const doctor = await engine.doctor();
  const voices = await engine.voices();

  assert.equal(doctor.status, 'blocked');
  assert.match(doctor.install, /COCKPIT_SHOWCASE_YANDEX_API_KEY/);
  assert.ok(voices.length > 5, 'голоса видны и до настройки — с причиной');
  assert.ok(voices.every((voice) => !voice.available && /ключ/i.test(voice.reason)));
});

test('разметка поставщика: ударение, пауза и акцент по смещениям', () => {
  const text = 'Фильтр сбрасывается одним нажатием.';
  const marked = yandexMarkup(text, {
    ...DIRECTION,
    stresses: [{ at: 7, vowel: 7 }],
    pauses: [{ at: 19, ms: 300 }, { at: 3, ms: 0 }],
    emphasis: [{ from: 0, to: 6 }],
  });

  assert.equal(marked, '**Фильтр** сбрасыв+ается sil<[300]> одним нажатием.');
  assert.equal(yandexMarkup(text, DIRECTION), text);
});

test('синтез уходит поставщику с ключом, голосом, амплуа и темпом, а звук склеивается в WAV', async (t) => {
  const root = await workspace(t);
  const pcm = pcmSine();
  const { calls, endpoint } = await fakeProvider(t, () => ({ status: 200, text: streamOf(pcm) }));
  const engine = createYandexEngine({ apiKey: 'secret-key', folderId: 'folder-1', endpoint });
  const candidate = await engine.synthesize(
    {
      canonicalText: 'Фильтр сбрасывается одним нажатием.',
      direction: { ...DIRECTION, tone: 'дружелюбно', pace: 'fast' },
      voiceRef: 'marina',
      language: 'ru',
    },
    { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
  );

  assert.equal(calls.length, 1);

  const [call] = calls;

  assert.equal(call.headers.authorization, 'Api-Key secret-key');
  assert.equal(call.headers['x-folder-id'], 'folder-1');
  assert.equal(call.headers['x-data-logging-enabled'], 'false');
  assert.deepEqual(call.body.hints, [{ voice: 'marina' }, { role: 'friendly' }, { speed: 1.2 }]);
  assert.equal(call.body.outputAudioSpec.rawAudio.sampleRateHertz, 48_000);
  assert.equal(call.body.unsafeMode, true);
  assert.equal(call.body.text, 'Фильтр сбрасывается одним нажатием.');

  assert.equal(candidate.format, 'wav');
  assert.equal(candidate.sampleRate, 48_000);
  assert.equal(candidate.engineRequestId, 'req-1');
  assert.deepEqual(candidate.ignoredDirections, []);

  const file = await readFile(candidate.temporaryFile);

  assert.equal(file.subarray(0, 4).toString(), 'RIFF');
  assert.equal(file.readUInt32LE(24), 48_000);
  assert.equal(file.length, 44 + pcm.length, 'обе порции склеены без потерь');
  assert.ok(file.subarray(44).equals(pcm));
});

test('голос без амплуа получает тон в список неприменённого, а не ошибку поставщика', async (t) => {
  const root = await workspace(t);
  const { calls, endpoint } = await fakeProvider(t, () => ({ status: 200, text: streamOf(pcmSine()) }));
  const engine = createYandexEngine({ apiKey: 'secret-key', folderId: '', endpoint });
  const candidate = await engine.synthesize(
    {
      canonicalText: 'Готово.',
      direction: { ...DIRECTION, tone: 'строго' },
      voiceRef: 'filipp',
      language: 'ru',
    },
    { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
  );

  assert.deepEqual(calls[0].body.hints, [{ voice: 'filipp' }]);
  assert.equal('x-folder-id' in calls[0].headers, false);
  assert.deepEqual(candidate.ignoredDirections, ['тон']);
  assert.equal(engine.capabilities('filipp').tone, false);
  assert.equal(engine.capabilities('marina').tone, true);
});

test('отказы поставщика названы словами: ключ, права, квота', async (t) => {
  const root = await workspace(t);
  const replies = [
    { status: 401, text: JSON.stringify({ code: 16, message: 'The token is invalid' }) },
    { status: 403, text: JSON.stringify({ code: 7, message: 'Permission denied' }) },
    { status: 429, text: JSON.stringify({ code: 8, message: 'Quota exceeded' }) },
  ];
  const { endpoint } = await fakeProvider(t, (index) => replies[index - 1]);
  const engine = createYandexEngine({ apiKey: 'bad', folderId: '', endpoint });
  const input = {
    canonicalText: 'Готово.', direction: DIRECTION, voiceRef: 'marina', language: 'ru',
  };
  const options = { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined };

  for (const expected of [/ключ/, /ролью|прав/, /квота/i]) {
    await assert.rejects(
      () => engine.synthesize(input, options),
      (error) => error.code === 'voice_failed' && expected.test(error.message),
    );
  }
});

test('тишина вместо речи — отказ, а не готовый звук', async (t) => {
  const root = await workspace(t);
  const silence = Buffer.alloc(48_000, 0);
  const { endpoint } = await fakeProvider(t, () => ({ status: 200, text: streamOf(silence) }));
  const engine = createYandexEngine({ apiKey: 'secret-key', folderId: '', endpoint });

  await assert.rejects(
    () => engine.synthesize(
      { canonicalText: 'Тихая фраза.', direction: DIRECTION, voiceRef: 'dasha', language: 'ru' },
      { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
    ),
    (error) => error.code === 'voice_failed' && /тишин/.test(error.message),
  );
});

test('обёртка WAV честно описывает отсчёты', () => {
  const pcm = pcmSine({ seconds: 0.1 });
  const wav = wavOf(pcm, 48_000);

  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1, 'моно');
  assert.equal(wav.readUInt16LE(34), 16, '16 бит');
  assert.equal(wav.readUInt32LE(40), pcm.length);
});
