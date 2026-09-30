// Адаптер локального голоса Qwen3-TTS: каталог, готовность, дикторы и синтез.
//
// Движок подменяется исполняемым файлом с известным поведением: проверяются
// правила адаптера — как он объявляет неготовность (в том числе невидимую
// видеокарту), как зовёт скрипт и что делает с его ответом. Настоящая модель
// весит четыре гигабайта и здесь не нужна.
import assert from 'node:assert/strict';
import test from 'node:test';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createQwenEngine,
  qwenInstruct,
  readInstalledQwenModels,
} from '../../server/src/lib/showcase/voice/qwen.ts';
import { QWEN_VOICES } from '../../server/src/lib/showcase/voice/qwenCatalog.ts';

const DIRECTION = {
  tone: null, pace: null, emphasis: [], pauses: [], stresses: [],
};

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-qwen-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

/**
 * Подменённый python: на проверку окружения печатает заданную пару «пакет CUDA»,
 * в резидентном режиме отвечает на каждый запрос заданными фактами по каждой
 * реплике либо выходит с заданным кодом ещё до первого ответа — так выглядит
 * нехватка видеопамяти на чтении модели. Запрос из более чем `oomAbove` реплик
 * получает ответ «не хватило видеопамяти» вместо фактов. Аргументы и запросы
 * записываются в файлы — так видно, ЧЕМ адаптер зовёт движок и ЧТО ему отдаёт.
 */
async function fakePython(root, {
  probe = '1 1',
  facts = '{"durationMs": 2100, "sampleRate": 24000, "channels": 1, "peak": 0.5}',
  exitCode = 0,
  oomAbove = 0,
} = {}) {
  const file = path.join(root, 'python');
  const calls = path.join(root, 'calls.txt');
  const stdin = path.join(root, 'stdin.txt');

  await writeFile(
    file,
    `#!/usr/bin/env python3
import json, sys
args = sys.argv[1:]
open(${JSON.stringify(calls)}, 'a').write(' '.join(args) + '\\n')
if args[:1] == ['-c']:
    ${probe === null
      ? "sys.stderr.write('ModuleNotFoundError: torch\\n'); sys.exit(1)"
      : `print(${JSON.stringify(probe)}); sys.exit(0)`}
if ${exitCode} != 0:
    sys.stderr.write('не хватило видеопамяти\\n')
    sys.exit(${exitCode})
print('Warning: flash-attn is not installed', flush=True)
for line in sys.stdin:
    if not line.strip():
        continue
    open(${JSON.stringify(stdin)}, 'a').write(line)
    request = json.loads(line)
    if ${oomAbove} and len(request['items']) > ${oomAbove}:
        print(json.dumps({'id': request['id'], 'error': 'не хватило видеопамяти', 'code': 'oom'}), flush=True)
        continue
    results = []
    for item in request['items']:
        open(item['out'], 'wb').write(b'RIFF')
        results.append(json.loads('${facts}'))
    print(json.dumps({'id': request['id'], 'results': results}), flush=True)
`,
    'utf8',
  );
  await chmod(file, 0o755);

  return { python: file, calls, stdin };
}

async function installModel(modelsDir, overrides = {}) {
  const pack = { ...QWEN_VOICES[0], ...overrides };
  const modelDir = path.join(modelsDir, pack.id);

  await mkdir(modelDir, { recursive: true });
  await writeFile(path.join(modelDir, 'voice.json'), JSON.stringify({
    schemaVersion: 1,
    id: pack.id,
    name: pack.name,
    language: 'ru',
    revision: pack.revision,
    sampleRate: pack.sampleRate,
    speakers: pack.speakers,
  }), 'utf8');
}

function engineAt(root, python) {
  return createQwenEngine({ python, modelsDir: path.join(root, 'qwen') });
}

test('каталог Qwen закрепляет ревизию, суммы, размеры и дикторов', () => {
  const pack = QWEN_VOICES[0];

  assert.equal(pack.engineId, 'qwen');
  assert.match(pack.revision, /^[0-9a-f]{40}$/, 'ревизия репозитория закреплена');
  assert.match(pack.baseUrl, /^https:\/\/huggingface\.co\/.*\/resolve\/[0-9a-f]{40}\/$/);
  assert.equal(pack.modelBytes, 4_520_159_586);
  assert.ok(pack.engineBytes > 1_000_000_000, 'движок с CUDA весит гигабайты, и это названо');
  assert.ok(pack.speakers.length >= 9, 'модель несёт девять дикторов');
  assert.equal(pack.speakers[0].id, 'vivian', 'контрольную фразу произносит первый диктор');

  for (const file of pack.files) {
    assert.ok(file.bytes > 0, `${file.path}: размер известен`);
    assert.ok(
      /^[0-9a-f]{64}$/.test(file.sha256 ?? '') || /^[0-9a-f]{40}$/.test(file.gitBlobSha1 ?? ''),
      `${file.path}: есть sha256 или git blob sha1`,
    );
  }

  const tokenizer = pack.files.filter((file) => file.path.startsWith('speech_tokenizer/'));

  assert.ok(tokenizer.length >= 4, 'речевой токенизатор лежит в подкаталоге той же модели');
  assert.ok(
    pack.files.filter((file) => file.sha256).every((file) => file.bytes > 100_000_000),
    'sha256 — у файлов LFS, остальные сверяются по git blob',
  );
});

test('без установки движок объявляет себя неготовым и называет действие', async (t) => {
  const root = await workspace(t);
  const engine = engineAt(root, path.join(root, 'nowhere', 'python'));
  const doctor = await engine.doctor();

  assert.equal(doctor.status, 'blocked');
  assert.match(doctor.reason, /не установлен/);
  assert.match(doctor.install, /кнопкой/);
  assert.match(doctor.install, /видеокарта/i);
  assert.deepEqual(await engine.voices(), []);
});

test('окружение без torch, без qwen_tts и без видеокарты названы своими причинами', async (t) => {
  const cases = [
    [null, /torch/],
    ['0 1', /qwen_tts/],
    ['1 0', /Видеокарта не видна.*CUDA/],
  ];

  for (const [probe, expected] of cases) {
    const root = await workspace(t);
    const { python } = await fakePython(root, { probe });

    await installModel(path.join(root, 'qwen'));

    const doctor = await engineAt(root, python).doctor();

    assert.equal(doctor.status, 'blocked', String(probe));
    assert.match(doctor.reason, expected);
  }
});

test('движок без скачанной модели тоже неготов, а после установки и сброса кэша — готов', async (t) => {
  const root = await workspace(t);
  const { python } = await fakePython(root);
  const engine = engineAt(root, python);

  assert.match((await engine.doctor()).reason, /модель .* не скачана/);

  await installModel(path.join(root, 'qwen'));

  // Кэш готовности живёт минуту: без сброса событие «установлено» показало бы
  // прежний отказ.
  assert.equal((await engine.doctor()).status, 'blocked', 'кэш ещё держит прежний ответ');

  engine.forgetDoctor();

  const doctor = await engine.doctor();

  assert.equal(doctor.status, 'ready');
  assert.match(doctor.reason, /видеокарт/);
});

test('голосами становятся дикторы установленной модели, версия и ревизия — из манифеста', async (t) => {
  const root = await workspace(t);
  const { python } = await fakePython(root);
  const modelsDir = path.join(root, 'qwen');

  await installModel(modelsDir);

  assert.equal((await readInstalledQwenModels(modelsDir)).length, 1);

  const engine = engineAt(root, python);
  const voices = await engine.voices();

  assert.deepEqual(
    voices.map((voice) => voice.id),
    QWEN_VOICES[0].speakers.map((speaker) => speaker.id),
  );
  assert.ok(voices.every((voice) => voice.available));
  assert.match(voices[0].name, /женский|мужской/, 'тембр и родной язык названы рядом с именем');

  const own = engine.capabilities(null);

  assert.equal(own.engineVersion, 'qwen-qwen3-tts-1_7b-anchored');
  assert.equal(own.modelRevision, QWEN_VOICES[0].revision);
  assert.equal(own.tone, true, 'тон уходит указанием модели');
  assert.equal(own.stress, false, 'ударения без слуха не проверить — честно не поддержаны');
  assert.equal(own.unreadable, undefined, 'латиницу и цифры модель читает');
});

test('синтез зовёт скрипт резидентно, а диктора, текст и тон отдаёт запросом на stdin', async (t) => {
  const root = await workspace(t);
  const { python, calls, stdin } = await fakePython(root);

  await installModel(path.join(root, 'qwen'));

  const engine = engineAt(root, python);
  const candidate = await engine.synthesize(
    {
      canonicalText: 'Фильтр сбрасывается одним нажатием.',
      direction: { ...DIRECTION, tone: 'Спокойно и уверенно.' },
      voiceRef: 'ryan',
      language: 'ru',
    },
    { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
  );

  assert.equal(candidate.format, 'wav');
  assert.equal(candidate.sampleRate, 24_000);
  assert.deepEqual(candidate.ignoredDirections, [], 'тон поддержан');
  await access(candidate.temporaryFile);

  const argv = await readFile(calls, 'utf8');

  assert.match(argv, /--model-dir .*qwen\/qwen3-tts-1_7b/);
  assert.match(argv, /--serve/);
  assert.doesNotMatch(argv, /ryan/, 'диктор реплики уходит запросом, а не аргументом');
  assert.doesNotMatch(argv, /Фильтр/, 'реплика не попадает в командную строку');

  const [request] = (await readFile(stdin, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(request.items.length, 1);
  assert.equal(request.items[0].text, 'Фильтр сбрасывается одним нажатием.');
  assert.equal(request.items[0].instruct, 'Спокойно и уверенно.');
  assert.equal(request.items[0].speaker, 'ryan');
  assert.equal(request.items[0].out, candidate.temporaryFile);
});

test('сеанс держит один процесс на задание, а тесный запрос из нескольких реплик дробится', async (t) => {
  const root = await workspace(t);
  const { python, calls, stdin } = await fakePython(root, { oomAbove: 2 });

  await installModel(path.join(root, 'qwen'));

  const session = await engineAt(root, python).openSession();

  assert.equal(session.batch, null, 'сцены идут в процесс по одной: ёмкость батча — на кандидатов');

  const phrases = ['Первая реплика.', 'Вторая реплика.', 'Третья реплика.'];
  const candidates = await session.synthesize(
    phrases.map((canonicalText) => ({
      canonicalText, direction: DIRECTION, voiceRef: 'ryan', language: 'ru',
    })),
    { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
  );

  assert.equal(candidates.length, 3);
  assert.equal(new Set(candidates.map((item) => item.temporaryFile)).size, 3, 'файлы не совпадают');

  for (const candidate of candidates) {
    await access(candidate.temporaryFile);
  }

  await session.synthesize(
    [{ canonicalText: 'Четвёртая реплика.', direction: DIRECTION, voiceRef: 'ryan', language: 'ru' }],
    { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
  );
  await session.close();

  const requests = (await readFile(stdin, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

  // Три реплики одним запросом не влезли в память: батч разделён на две и одну,
  // и в том же порядке; четвёртая ушла тем же процессом.
  assert.deepEqual(
    requests.map((request) => request.items.map((item) => item.text)),
    [phrases, phrases.slice(0, 2), phrases.slice(2), ['Четвёртая реплика.']],
  );
  assert.equal(
    (await readFile(calls, 'utf8')).split('\n').filter((line) => line.includes('--serve')).length,
    1,
    'процесс с моделью поднят один раз на весь сеанс',
  );
});

test('отказ реплики внутри сеанса называется словами, а не тишиной', async (t) => {
  const root = await workspace(t);
  // Память не хватает на любой запрос: и на батч, и на одиночную реплику.
  const { python, stdin } = await fakePython(root, { oomAbove: -1 });

  await installModel(path.join(root, 'qwen'));

  const session = await engineAt(root, python).openSession();

  t.after(() => session.close());

  // Батч из двух дробится до одиночной, а одиночная не влезает — это уже отказ,
  // и вторую половину адаптер не пробует.
  await assert.rejects(
    () => session.synthesize(
      [
        { canonicalText: 'Длинная реплика.', direction: DIRECTION, voiceRef: 'ryan', language: 'ru' },
        { canonicalText: 'Ещё длиннее.', direction: DIRECTION, voiceRef: 'ryan', language: 'ru' },
      ],
      { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
    ),
    (error) => error.code === 'voice_failed' && /видеопамят.*закройте программы/.test(error.message),
  );

  const requests = (await readFile(stdin, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

  assert.deepEqual(
    requests.map((request) => request.items.map((item) => item.text)),
    [['Длинная реплика.', 'Ещё длиннее.'], ['Длинная реплика.']],
  );
});

test('указание модели: пустой тон не передаётся, темп — только после замера', () => {
  assert.equal(qwenInstruct(DIRECTION), null);
  assert.equal(qwenInstruct({ ...DIRECTION, tone: '   ' }), null);
  assert.equal(qwenInstruct({ ...DIRECTION, tone: 'Радостно.' }), 'Радостно.');
  assert.equal(qwenInstruct({ ...DIRECTION, pace: 'slow' }), null, 'темп не измерен — не обещаем');
});

test('нехватка видеопамяти называется словами и действием, а не хвостом трассировки', async (t) => {
  const root = await workspace(t);
  const { python } = await fakePython(root, { exitCode: 3 });

  await installModel(path.join(root, 'qwen'));

  await assert.rejects(
    () => engineAt(root, python).synthesize(
      {
        canonicalText: 'Большая фраза.',
        direction: DIRECTION,
        voiceRef: 'vivian',
        language: 'ru',
      },
      { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
    ),
    (error) => error.code === 'voice_failed' && /видеопамят.*закройте программы/.test(error.message),
  );
});

test('тишина вместо речи — отказ, а не готовый звук', async (t) => {
  const root = await workspace(t);
  const { python } = await fakePython(root, {
    facts: '{"durationMs": 2100, "sampleRate": 24000, "channels": 1, "peak": 0.0}',
  });

  await installModel(path.join(root, 'qwen'));

  await assert.rejects(
    () => engineAt(root, python).synthesize(
      {
        canonicalText: 'Тихая фраза.',
        direction: DIRECTION,
        voiceRef: 'vivian',
        language: 'ru',
      },
      { outputDir: path.join(root, 'out'), deadlineMs: 30_000, signal: undefined },
    ),
    (error) => error.code === 'voice_failed' && /тишин/.test(error.message),
  );
});
