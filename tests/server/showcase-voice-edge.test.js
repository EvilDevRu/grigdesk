// Облачный голос Microsoft Edge TTS: каталог, разметка, протокол и отказы.
//
// Поставщика подменяют местные серверы: HTTP отдаёт список голосов, WebSocket
// играет протокол чтения вслух и запоминает, ЧТО адаптер прислал (подпись в
// адресе, заголовки браузера, SSML с темпом и высотой). Ни один запрос из этих
// проверок наружу не уходит. Звук фикстуры — настоящий MP3 от ffmpeg: адаптер
// раскодирует его тем же ffmpeg, что и ответ поставщика.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  audioOfFrame,
  createEdgeEngine,
  edgePieces,
  edgeRatePercent,
  edgeSecMsGec,
  edgeSsml,
} from '../../server/src/lib/showcase/voice/edge.ts';
import {
  EDGE_DEFAULT_VOICE_ID,
  EDGE_VOICE_TUNING,
  EDGE_VOICES_SNAPSHOT,
  edgeVoiceLabel,
  edgeVoiceReads,
  parseEdgeVoiceList,
  sortEdgeVoices,
} from '../../server/src/lib/showcase/voice/edgeCatalog.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { WebSocketServer } = requireFromServer('ws');

const run = promisify(execFile);

const DIRECTION = {
  tone: null, pace: null, emphasis: [], pauses: [], stresses: [],
};

// Живой список поставщика в его форме: три голоса читают русский, один — нет.
const LIVE_LIST = [
  row('af-ZA-AdriNeural', 'Female', 'af-ZA'),
  row('ru-RU-SvetlanaNeural', 'Female', 'ru-RU'),
  row('en-US-AvaMultilingualNeural', 'Female', 'en-US'),
  row('fr-FR-RemyMultilingualNeural', 'Male', 'fr-FR'),
  row('ru-RU-DmitryNeural', 'Male', 'ru-RU'),
];

function row(ShortName, Gender, Locale) {
  return {
    Name: `Microsoft Server Speech Text to Speech Voice (${Locale}, ${ShortName.slice(Locale.length + 1)})`,
    ShortName,
    Gender,
    Locale,
    SuggestedCodec: 'audio-24khz-48kbitrate-mono-mp3',
    FriendlyName: `Microsoft ${ShortName} Online (Natural)`,
    Status: 'GA',
  };
}

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-edge-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

/**
 * MP3 фикстуры: синус слышимой громкости или тишина той же длины. Настоящий файл
 * нужен, потому что адаптер раскодирует ответ ffmpeg и меряет пик по отсчётам.
 */
async function mp3Of(root, { silent = false, seconds = 0.5 } = {}) {
  const file = path.join(root, silent ? 'silence.mp3' : 'tone.mp3');
  const source = silent
    ? `anullsrc=r=24000:cl=mono:d=${seconds}`
    : `sine=frequency=440:duration=${seconds}`;

  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', source,
    '-ar', '24000', '-ac', '1', '-b:a', '48k',
    file,
  ]);

  return readFile(file);
}

// Двоичный кадр протокола: два байта длины заголовков, заголовки, звук.
function audioFrame(requestId, audio) {
  const headers = Buffer.from(
    `X-RequestId:${requestId}\r\nContent-Type:audio/mpeg\r\nX-StreamId:1\r\nPath:audio\r\n`,
    'utf8',
  );
  const length = Buffer.alloc(2);

  length.writeUInt16BE(headers.length, 0);

  return Buffer.concat([length, headers, audio]);
}

function textFrame(requestId, pathName, body) {
  return `X-RequestId:${requestId}\r\nContent-Type:application/json; charset=utf-8\r\n`
    + `Path:${pathName}\r\n\r\n${body}`;
}

function boundary(type, text, startMs, durationMs) {
  return {
    Type: type,
    Data: {
      Offset: Math.round(startMs * 10_000),
      Duration: Math.round(durationMs * 10_000),
      text: { Text: text },
    },
  };
}

function metadataOf(...records) {
  return { Metadata: records };
}

/**
 * Подменённый поставщик: список голосов по HTTP и речь по WebSocket на одном
 * порту. Запоминает рукопожатия и присланный SSML — единственное, по чему видно,
 * что именно адаптер попросил. Поведение задаётся сценарием на каждое соединение.
 */
async function fakeProvider(t, {
  list = LIVE_LIST,
  listStatus = 200,
  audio,
  metadataFrames = [],
  behave,
} = {}) {
  const connections = [];
  const server = createServer((request, response) => {
    if (request.url.startsWith('/voices/list')) {
      response.writeHead(listStatus, { 'content-type': 'application/json' });
      response.end(JSON.stringify(list));

      return;
    }

    response.writeHead(404);
    response.end();
  });
  const sockets = new WebSocketServer({ server });

  sockets.on('connection', (socket, request) => {
    const record = { url: request.url, headers: request.headers, ssml: '', config: '' };
    const index = connections.push(record);
    const plan = behave?.(index) ?? 'speak';
    const responseAudio = (typeof audio === 'function' ? audio(index) : audio) ?? Buffer.alloc(0);
    const responseMetadata = typeof metadataFrames === 'function'
      ? metadataFrames(index)
      : metadataFrames;

    if (plan === 'drop') {
      socket.terminate();

      return;
    }

    socket.on('message', (data) => {
      const message = data.toString('utf8');
      const headerEnd = message.indexOf('\r\n\r\n');
      const head = message.slice(0, headerEnd);
      const requestId = /X-RequestId:(\w+)/.exec(head)?.[1] ?? '';

      if (head.includes('Path:speech.config')) {
        record.config = message.slice(headerEnd + 4);

        return;
      }

      record.ssml = message.slice(headerEnd + 4);

      if (plan === 'reject') {
        socket.close(1007, 'SSML is invalid');

        return;
      }

      socket.send(textFrame(requestId, 'turn.start', '{}'));

      for (const metadata of responseMetadata) {
        socket.send(textFrame(
          requestId,
          'audio.metadata',
          typeof metadata === 'string' ? metadata : JSON.stringify(metadata),
        ));
      }

      const half = Math.floor(responseAudio.length / 2);

      if (plan === 'partial-drop') {
        socket.send(audioFrame(requestId, responseAudio.subarray(0, half)), () => {
          socket.terminate();
        });

        return;
      }

      socket.send(audioFrame(requestId, responseAudio.subarray(0, half)));
      socket.send(audioFrame(requestId, responseAudio.subarray(half)));
      socket.send(audioFrame(requestId, Buffer.alloc(0)));
      socket.send(textFrame(requestId, 'turn.end', '{}'));
    });
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    sockets.close();
    server.close(resolve);
  }));

  const { port } = server.address();

  return {
    connections,
    voiceListUrl: `http://127.0.0.1:${port}/voices/list?trustedclienttoken=test`,
    socketUrl: `ws://127.0.0.1:${port}/edge/v1?TrustedClientToken=test`,
  };
}

function engineOf(provider, extra = {}) {
  return createEdgeEngine({
    enabled: true,
    voiceListUrl: provider.voiceListUrl,
    socketUrl: provider.socketUrl,
    ...extra,
  });
}

function wavSamples(file) {
  assert.equal(file.subarray(0, 4).toString(), 'RIFF');
  assert.equal(file.readUInt32LE(24), 24_000, 'частота поставщика');
  assert.equal(file.readUInt16LE(22), 1, 'моно');

  return (file.length - 44) / 2;
}

test('подпись Sec-MS-GEC совпадает с эталонной реализацией и живёт пять минут', () => {
  assert.equal(
    edgeSecMsGec(1_757_600_000_000),
    '5EE1363E67CAEA6318B039C6C8050303700FCF894E161DFCA29777B8F73CBDC4',
  );
  assert.equal(edgeSecMsGec(1_757_600_299_900), edgeSecMsGec(1_757_600_300_000));
  assert.notEqual(edgeSecMsGec(1_757_600_000_000), edgeSecMsGec(1_757_600_300_000));
});

test('темп и высота уходят в единицах поставщика, текст экранируется', () => {
  assert.equal(edgeRatePercent(1.12), '+12%');
  assert.equal(edgeRatePercent(0.7), '-30%');
  assert.equal(edgeRatePercent(1), '+0%');

  const ssml = edgeSsml('fr-FR-RemyMultilingualNeural', 'Меньше <5 & больше>', { rate: 1.12, pitchHz: -1 });

  assert.match(ssml, /<voice name='fr-FR-RemyMultilingualNeural'>/);
  assert.match(ssml, /<prosody pitch='-1Hz' rate='\+12%' volume='\+0%'>/);
  assert.ok(ssml.includes('Меньше &lt;5 &amp; больше&gt;'), 'служебные знаки XML экранированы');
  assert.ok(!ssml.includes('<break'), 'ничего, кроме голоса и просодии, внутрь не кладётся');
});

test('реплика режется в позициях пауз и по пределу байтов, тишина не теряется', () => {
  const text = 'Первая часть. Вторая часть. Третья часть.';
  const pieces = edgePieces(text, [{ at: 13, ms: 400 }, { at: 41, ms: 900 }, { at: 27, ms: 0 }]);

  assert.deepEqual(pieces, [
    { text: 'Первая часть.', silenceAfterMs: 400 },
    { text: 'Вторая часть. Третья часть.', silenceAfterMs: 900 },
  ]);

  // Пауза в самом начале — тишина перед речью, а не потерянное указание.
  assert.deepEqual(edgePieces('Готово.', [{ at: 0, ms: 300 }]), [
    { text: '', silenceAfterMs: 300 },
    { text: 'Готово.', silenceAfterMs: 0 },
  ]);

  // Длинный текст делится по концу предложения так, чтобы каждая часть влезла.
  const long = 'Первое предложение подлиннее. Второе предложение тоже. Третье короче.';
  const byBytes = edgePieces(long, [], 70);

  assert.ok(byBytes.length >= 2, 'текст длиннее предела разрезан');
  assert.ok(byBytes.every((piece) => Buffer.byteLength(piece.text, 'utf8') <= 70));
  assert.ok(byBytes.every((piece) => /[.!?]$/.test(piece.text)), 'разрез — по концу предложения');
  assert.equal(byBytes.map((piece) => piece.text).join(' '), long);
});

test('каталог: живой список фильтруется по языку, утверждённый голос первым', () => {
  const parsed = parseEdgeVoiceList(LIVE_LIST);

  assert.equal(parsed.length, 5);
  assert.deepEqual(
    parsed.map((voice) => voice.name),
    ['Adri', 'Svetlana', 'Ava', 'Remy', 'Dmitry'],
    'имя диктора без локали и суффиксов',
  );

  const readable = sortEdgeVoices(parsed.filter((voice) => edgeVoiceReads(voice, 'ru')), 'ru');

  assert.deepEqual(
    readable.map((voice) => voice.id),
    [EDGE_DEFAULT_VOICE_ID, 'ru-RU-DmitryNeural', 'ru-RU-SvetlanaNeural', 'en-US-AvaMultilingualNeural'],
    'утверждённый голос, затем родные, затем многоязычные',
  );
  assert.equal(edgeVoiceLabel(readable[0]), 'Remy (мужской, fr-FR, многоязычный)');
  assert.equal(edgeVoiceLabel(readable[2]), 'Svetlana (женский, ru-RU)');

  assert.deepEqual(EDGE_VOICE_TUNING[EDGE_DEFAULT_VOICE_ID], { rate: 1.12, pitchHz: -1 });
  assert.ok(EDGE_VOICES_SNAPSHOT.every((voice) => edgeVoiceReads(voice, 'ru')));
  assert.equal(EDGE_VOICES_SNAPSHOT[0].id, EDGE_DEFAULT_VOICE_ID);
  assert.throws(() => parseEdgeVoiceList({ voices: [] }), /массив/);
});

test('выключенный настройкой движок заблокирован, голоса видны с причиной', async () => {
  const engine = createEdgeEngine({ enabled: false });
  const doctor = await engine.doctor();
  const voices = await engine.voices();

  assert.equal(doctor.status, 'blocked');
  assert.match(doctor.install, /COCKPIT_SHOWCASE_EDGE_TTS/);
  assert.equal(voices.length, EDGE_VOICES_SNAPSHOT.length);
  assert.ok(voices.every((voice) => !voice.available && /выключен/.test(voice.reason)));
  assert.equal(voices[0].id, EDGE_DEFAULT_VOICE_ID);
});

test('без ответа поставщика движок заблокирован словами, а синтез отказывает до сети', async (t) => {
  const root = await workspace(t);
  const provider = await fakeProvider(t, { listStatus: 503 });
  const engine = engineOf(provider);
  const doctor = await engine.doctor();

  assert.equal(doctor.status, 'blocked');
  assert.match(doctor.reason, /недоступно.*503/);
  assert.match(doctor.install, /speech\.platform\.bing\.com/);

  const voices = await engine.voices();

  assert.ok(voices.length > 5, 'голоса из снимка видны и без сети');
  assert.ok(voices.every((voice) => !voice.available));

  await assert.rejects(
    () => engine.synthesize(
      { canonicalText: 'Готово.', direction: DIRECTION, voiceRef: EDGE_DEFAULT_VOICE_ID, language: 'ru' },
      { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
    ),
    (error) => error.code === 'voice_unavailable',
  );
  assert.equal(provider.connections.length, 0);
});

test('синтез: подпись в адресе, заголовки браузера, темп и высота утверждённого голоса, WAV', async (t) => {
  const root = await workspace(t);
  const audio = await mp3Of(root);
  const provider = await fakeProvider(t, { audio });
  const engine = engineOf(provider);
  const doctor = await engine.doctor();

  assert.equal(doctor.status, 'ready');
  assert.match(doctor.reason, /читающих русский: 4/);

  const voices = await engine.voices();

  assert.deepEqual(voices.map((voice) => voice.available), [true, true, true, true]);
  assert.equal(voices[0].id, EDGE_DEFAULT_VOICE_ID, 'утверждённый голос — первый, им говорит новый ролик');

  const candidate = await engine.synthesize(
    {
      canonicalText: 'Фильтр сбрасывается одним нажатием.',
      direction: { ...DIRECTION, tone: 'дружелюбно', emphasis: [{ from: 0, to: 6 }] },
      voiceRef: EDGE_DEFAULT_VOICE_ID,
      language: 'ru',
    },
    { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
  );

  assert.equal(provider.connections.length, 1);

  const [connection] = provider.connections;
  const url = new URL(connection.url, 'ws://127.0.0.1');

  assert.match(url.searchParams.get('Sec-MS-GEC') ?? '', /^[0-9A-F]{64}$/);
  assert.match(url.searchParams.get('Sec-MS-GEC-Version') ?? '', /^1-\d+\.\d+\.\d+\.\d+$/);
  assert.match(url.searchParams.get('ConnectionId') ?? '', /^[0-9a-f]{32}$/);
  assert.equal(connection.headers.origin, 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold');
  assert.match(connection.headers['user-agent'], /Edg\/\d+/);
  assert.match(connection.headers.cookie, /^muid=[0-9A-F]{32};$/);
  assert.match(connection.config, /audio-24khz-48kbitrate-mono-mp3/);
  assert.match(connection.config, /"wordBoundaryEnabled":"true"/);
  assert.match(connection.ssml, /<voice name='fr-FR-RemyMultilingualNeural'>/);
  assert.match(connection.ssml, /pitch='-1Hz' rate='\+12%'/, 'утверждённая настройка: +12 % и −1 Гц');
  assert.match(connection.ssml, /Фильтр сбрасывается одним нажатием\./);

  assert.equal(candidate.format, 'wav');
  assert.equal(candidate.sampleRate, 24_000);
  assert.match(candidate.engineRequestId, /^[0-9a-f]{32}$/);
  assert.deepEqual(candidate.ignoredDirections, ['тон', 'акценты'], 'неподдержанное названо, не потеряно');
  assert.equal('speechTiming' in candidate, false, 'нет metadata — есть WAV без вымышленных меток');

  const samples = wavSamples(await readFile(candidate.temporaryFile));

  assert.ok(
    samples > 24_000 * 0.4 && samples < 24_000 * 0.7,
    `полсекунды речи, получено ${samples} отсчётов`,
  );
});

test('все WordBoundary и SentenceBoundary переводятся из 100 нс в общую шкалу', async (t) => {
  const root = await workspace(t);
  const provider = await fakeProvider(t, {
    audio: await mp3Of(root),
    metadataFrames: [
      metadataOf(
        boundary('WordBoundary', 'Замок', 12.3456, 87.6544),
        boundary('WordBoundary', 'замок', 200.25, 99.75),
      ),
      metadataOf(
        boundary('SentenceBoundary', 'Замок &amp; замок.', 0, 400),
        { Type: 'SessionEnd', Data: {} },
      ),
    ],
  });
  const candidate = await engineOf(provider).synthesize(
    {
      canonicalText: 'Замок & замок.',
      direction: DIRECTION,
      voiceRef: EDGE_DEFAULT_VOICE_ID,
      language: 'ru',
    },
    { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
  );

  assert.deepEqual(candidate.speechTiming, {
    source: 'edge',
    words: [
      { text: 'Замок', startMs: 12.3456, endMs: 100 },
      { text: 'замок', startMs: 200.25, endMs: 300 },
    ],
    segments: [{ text: 'Замок & замок.', startMs: 0, endMs: 400 }],
  });
  assert.equal(provider.connections.length, 1);
  assert.ok(wavSamples(await readFile(candidate.temporaryFile)) > 24_000 * 0.4);
});

test('ступень темпа умножает утверждённый темп, у голоса без настройки — от нуля', async (t) => {
  const root = await workspace(t);
  const provider = await fakeProvider(t, { audio: await mp3Of(root) });
  const engine = engineOf(provider);
  const options = { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined };

  await engine.synthesize(
    {
      canonicalText: 'Готово.',
      direction: { ...DIRECTION, pace: 'fast' },
      voiceRef: EDGE_DEFAULT_VOICE_ID,
      language: 'ru',
    },
    options,
  );
  await engine.synthesize(
    {
      canonicalText: 'Готово.',
      direction: { ...DIRECTION, pace: 'slowest' },
      voiceRef: 'ru-RU-SvetlanaNeural',
      language: 'ru',
    },
    options,
  );

  assert.match(provider.connections[0].ssml, /rate='\+34%'/, '1,12 × 1,2');
  assert.match(provider.connections[1].ssml, /pitch='\+0Hz' rate='-30%'/);
  assert.match(provider.connections[1].ssml, /<voice name='ru-RU-SvetlanaNeural'>/);
  assert.equal(engine.capabilities(EDGE_DEFAULT_VOICE_ID).engineVersion, 'edge-tts-1-rate112-pitch-1');
  assert.equal(engine.capabilities('ru-RU-SvetlanaNeural').engineVersion, 'edge-tts-1');
  assert.equal(engine.capabilities(EDGE_DEFAULT_VOICE_ID).pace, true);
  assert.equal(engine.capabilities(EDGE_DEFAULT_VOICE_ID).pause, true);
  assert.equal(
    engine.capabilities(EDGE_DEFAULT_VOICE_ID).stress,
    false,
    'Edge custom SSML недоступен: знак ударения нельзя обещать как применённый',
  );
});

test('пауза — отдельный запрос на каждую часть и тишина между ними в отсчётах', async (t) => {
  const root = await workspace(t);
  const provider = await fakeProvider(t, {
    audio: await mp3Of(root),
    metadataFrames: (index) => [metadataOf(boundary(
      'WordBoundary',
      index === 1 ? 'Первая' : 'Вторая',
      index === 1 ? 100 : 50,
      100,
    ))],
  });
  const engine = engineOf(provider);
  const candidate = await engine.synthesize(
    {
      canonicalText: 'Первая часть. Вторая часть.',
      direction: { ...DIRECTION, pauses: [{ at: 13, ms: 1000 }] },
      voiceRef: EDGE_DEFAULT_VOICE_ID,
      language: 'ru',
    },
    { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
  );

  assert.equal(provider.connections.length, 2);
  assert.match(provider.connections[0].ssml, />Первая часть\.</);
  assert.match(provider.connections[1].ssml, />Вторая часть\.</);
  assert.deepEqual(candidate.ignoredDirections, []);

  const file = await readFile(candidate.temporaryFile);
  const samples = wavSamples(file);

  // Две части по полсекунды и секунда тишины между ними.
  assert.ok(samples > 24_000 * 1.9 && samples < 24_000 * 2.2, `получено ${samples} отсчётов`);

  // Середина файла — внутри вставленной тишины: там нули.
  const middle = 44 + Math.floor(samples / 2) * 2;

  assert.ok(file.subarray(middle - 2000, middle + 2000).every((byte) => byte === 0));

  const pauseSamples = 24_000;
  const decodedPieceSamples = (samples - pauseSamples) / 2;
  const secondPieceAtMs = (decodedPieceSamples + pauseSamples) * 1000 / 24_000;

  assert.deepEqual(candidate.speechTiming, {
    source: 'edge',
    words: [
      { text: 'Первая', startMs: 100, endMs: 200 },
      { text: 'Вторая', startMs: secondPieceAtMs + 50, endMs: secondPieceAtMs + 150 },
    ],
    segments: [],
  });
});

test('обрыв соединения повторяется, отвергнутая разметка — нет', async (t) => {
  const root = await workspace(t);
  const audio = await mp3Of(root);
  const dropping = await fakeProvider(t, { audio, behave: (index) => (index === 1 ? 'drop' : 'speak') });
  const input = {
    canonicalText: 'Готово.', direction: DIRECTION, voiceRef: EDGE_DEFAULT_VOICE_ID, language: 'ru',
  };
  const options = { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined };
  const candidate = await engineOf(dropping).synthesize(input, options);

  assert.equal(dropping.connections.length, 2, 'после обрыва — второе соединение');
  assert.equal(candidate.format, 'wav');

  const rejecting = await fakeProvider(t, { audio, behave: () => 'reject' });

  await assert.rejects(
    () => engineOf(rejecting).synthesize(input, options),
    (error) => error.code === 'voice_failed' && /разметк/.test(error.message),
  );
  assert.equal(rejecting.connections.length, 1, 'отказ по разметке не повторяется');
});

test('partial retry отбрасывает и звук, и metadata неудачной попытки', async (t) => {
  const root = await workspace(t);
  const audio = await mp3Of(root);
  const provider = await fakeProvider(t, {
    audio,
    behave: (index) => (index === 1 ? 'partial-drop' : 'speak'),
    metadataFrames: (index) => [metadataOf(boundary(
      'WordBoundary',
      index === 1 ? 'призрак' : 'Готово',
      20,
      100,
    ))],
  });
  const candidate = await engineOf(provider).synthesize(
    {
      canonicalText: 'Готово.',
      direction: DIRECTION,
      voiceRef: EDGE_DEFAULT_VOICE_ID,
      language: 'ru',
    },
    { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
  );
  const samples = wavSamples(await readFile(candidate.temporaryFile));

  assert.equal(provider.connections.length, 2);
  assert.deepEqual(candidate.speechTiming?.words, [
    { text: 'Готово', startMs: 20, endMs: 120 },
  ]);
  assert.ok(samples > 24_000 * 0.4 && samples < 24_000 * 0.7, 'в WAV только успешная попытка');
});

test('битые или выходящие за WAV metadata не ломают звук и не повторяют TTS', async (t) => {
  const root = await workspace(t);
  const audio = await mp3Of(root);
  const options = { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined };
  const input = {
    canonicalText: 'Готово.',
    direction: DIRECTION,
    voiceRef: EDGE_DEFAULT_VOICE_ID,
    language: 'ru',
  };
  const malformed = await fakeProvider(t, { audio, metadataFrames: ['{'] });
  const malformedCandidate = await engineOf(malformed).synthesize(input, options);
  const outside = await fakeProvider(t, {
    audio,
    metadataFrames: [metadataOf(boundary('WordBoundary', 'Готово', 1000, 100))],
  });
  const outsideCandidate = await engineOf(outside).synthesize(input, options);

  assert.equal('speechTiming' in malformedCandidate, false);
  assert.equal('speechTiming' in outsideCandidate, false);
  assert.equal(malformed.connections.length, 1);
  assert.equal(outside.connections.length, 1);
  assert.ok(wavSamples(await readFile(malformedCandidate.temporaryFile)) > 24_000 * 0.4);
  assert.ok(wavSamples(await readFile(outsideCandidate.temporaryFile)) > 24_000 * 0.4);
});

test('тишина вместо речи — отказ, а не готовый звук', async (t) => {
  const root = await workspace(t);
  const provider = await fakeProvider(t, { audio: await mp3Of(root, { silent: true }) });

  await assert.rejects(
    () => engineOf(provider).synthesize(
      {
        canonicalText: 'Тихая фраза.', direction: DIRECTION, voiceRef: EDGE_DEFAULT_VOICE_ID, language: 'ru',
      },
      { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
    ),
    (error) => error.code === 'voice_failed' && /тишин/.test(error.message),
  );
});

test('двоичный кадр: звук после заголовков, кадр без звука — конец потока', () => {
  const frame = audioFrame('abc', Buffer.from([1, 2, 3]));

  assert.deepEqual([...audioOfFrame(frame)], [1, 2, 3]);
  assert.equal(audioOfFrame(audioFrame('abc', Buffer.alloc(0))).length, 0);
  assert.equal(audioOfFrame(Buffer.from([0])), null);

  const other = Buffer.from('Path:other\r\n', 'utf8');
  const length = Buffer.alloc(2);

  length.writeUInt16BE(other.length, 0);
  assert.equal(audioOfFrame(Buffer.concat([length, other, Buffer.from([9])])), null);
});
