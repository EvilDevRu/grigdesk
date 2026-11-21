import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, copyFile, chmod, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { goCandidate } from '../helpers/goCandidate.mts';
import { startHttpFixture } from '../tracker/helpers/httpFixture.mts';
import { childEnv, runProcess, syntheticHome } from '../tracker/helpers/processFixture.mts';

const executable = goCandidate('voice');
const fakePython = new URL('../../utilities/voice/testdata/python-fixture.py', import.meta.url);

/**
 * Устанавливает тестовый Python и модель по путям принятой generation Piper.
 * Голосовой процесс получит только эти файлы и синтетическое окружение.
 */
async function piperFixture() {
  const { home } = await syntheticHome();
  const directory = path.join(home, 'voice');
  const engine = path.join(directory, 'engines', 'piper');
  const runtime = path.join(engine, 'runtimes', 'fixture');
  const voice = path.join(engine, 'voices', 'irina');
  const python = path.join(runtime, 'bin', 'python');

  await mkdir(path.dirname(python), { recursive: true });
  await mkdir(voice, { recursive: true });
  await copyFile(fakePython, python);
  await chmod(python, 0o700);
  await symlink('runtimes/fixture', path.join(engine, 'venv'));
  await writeFile(path.join(voice, 'model.onnx'), 'fixture');
  await writeFile(path.join(voice, 'model.json'), '{}');
  await writeFile(path.join(voice, 'voice.json'), JSON.stringify({
    id: 'irina',
    name: 'Ирина',
    language: 'ru',
    timbre: 'женский',
    model: 'model.onnx',
    config: 'model.json',
    sampleRate: 22050,
  }));

  const requirements = {
    schemaVersion: 1,
    engineId: 'piper',
    requirements: ['piper-tts==1.8.0', 'onnxruntime==1.23.2'],
    requirementsIndexUrl: null,
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(requirements)).digest('hex');

  await writeFile(path.join(runtime, '.voice-runtime.json'), JSON.stringify({
    schemaVersion: 1,
    fingerprint,
  }));

  return {
    home,
    directory,
    env: childEnv(home, { PATH: '' }),
  };
}

test('VOICE-GO-PIPER: проверяет настоящий временный WAV и сохраняет прежний при отказе', async (t) => {
  const fixture = await piperFixture();
  const file = path.join(fixture.home, 'speech.wav');
  const text = path.join(fixture.home, 'source.txt');
  const args = ['generate', '--engine', 'piper', '--file', text, '--out', file, '--dir', fixture.directory];

  await writeFile(text, 'прив+ет мир');

  const success = await runProcess(t, executable, args, { env: fixture.env });

  assert.equal(success.code, 0, success.stderr.toString());

  const result = JSON.parse(success.stdout.toString());
  const original = await readFile(file);

  assert.equal(result.engine, 'piper');
  assert.equal(result.file, file);
  assert.equal(result.bytes, original.length);
  assert.deepEqual(result.ignoredDirections, ['ударения']);
  assert.equal(original.toString('ascii', 0, 4), 'RIFF');
  assert.equal(original.toString('ascii', 8, 12), 'WAVE');
  assert.equal(original.toString('ascii', 36, 40), 'data');
  assert.ok(original.readUInt32LE(40) > 0);

  const failed = await runProcess(t, executable, args, {
    env: { ...fixture.env, VOICE_FIXTURE_CORRUPT: '1' },
  });

  assert.equal(failed.code, 1);
  assert.equal(failed.stdout.length, 0);
  assert.deepEqual(await readFile(file), original);
});

/**
 * Возвращает четырёхотсчётный PCM16 mono 24 кГц для обоих локальных HTTP-приёмников.
 * Token Plan получает настоящий наблюдавшийся потоковый RIFF-заголовок.
 */
function sampleWav(streaming: boolean) {
  const data = Buffer.alloc(52);

  data.write('RIFF', 0);
  data.writeUInt32LE(streaming ? 0x7fffffbf : 44, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24);
  data.writeUInt32LE(48000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(streaming ? 0x7fffff9b : 8, 40);
  data.writeInt16LE(5100, 44);

  return data;
}

for (const service of ['model-studio', 'qwencloud-token']) {
  test(`VOICE-GO-QWEN: ${service} отправляет один POST и скачивает WAV без ключа`, async (t) => {
    const streaming = service === 'qwencloud-token';
    const token = streaming ? 'sk-sp-fixture' : 'fixture-key';
    const audio = await startHttpFixture(t, (_request, response) => {
      response.end(sampleWav(streaming));
    });
    const server = await startHttpFixture(t, (_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ output: { audio: { url: `${audio.baseUrl}/sample.wav` } } }));
    });
    const { home } = await syntheticHome();
    const file = path.join(home, 'cloud.wav');
    const env = childEnv(home, {
      PATH: '',
      GRIGDESK_VOICE_QWEN_API_KEY: token,
      GRIGDESK_VOICE_QWEN_BASE_URL: server.baseUrl,
    });
    const result = await runProcess(t, executable, [
      'generate', '--service', service, '--engine', 'qwen', '--text', 'з+амок', '--out', file,
      '--pace', 'slow', '--instruction', 'говори спокойно',
    ], { env });

    assert.equal(result.code, 0, result.stderr.toString());
    assert.equal(server.requests.length, 1);
    assert.equal(audio.requests.length, 1);

    const wire = server.requests[0]!;
    const body = JSON.parse(wire.body.toString());
    const stdout = JSON.parse(result.stdout.toString());

    assert.equal(wire.headers.authorization, `Bearer ${token}`);
    assert.equal(audio.requests[0]?.headers.authorization, undefined);
    assert.equal(wire.method, 'POST');
    assert.equal(stdout.service, service);
    assert.equal(stdout.file, file);
    assert.equal(stdout.bytes, 52);
    assert.deepEqual(await readFile(file), sampleWav(false));

    if (streaming) {
      assert.equal(wire.url, '/api/v1/services/audio/tts/SpeechSynthesizer');
      assert.equal(body.model, 'qwen-audio-3.0-tts-plus');
      assert.equal(body.input.text, 'за́мок');
      assert.equal(body.input.rate, 0.85);
      assert.deepEqual(body.input.language_hints, ['ru']);
      assert.match(body.input.instruction, /говори спокойно/);
      assert.equal(stdout.warnings.length, 1);
    } else {
      assert.equal(wire.url, '/api/v1/services/aigc/multimodal-generation/generation');
      assert.equal(body.model, 'qwen3-tts-flash');
      assert.deepEqual(body.input, {
        text: 'замок',
        voice: 'Cherry',
        language_type: 'Auto',
      });
      assert.deepEqual(stdout.ignoredDirections, ['темп', 'ударения', 'инструкция']);
    }
  });
}

test('VOICE-GO-SILERO: передаёт ударения и темп, отклоняет неподдерживаемый текст до Python', async (t) => {
  const { home } = await syntheticHome();
  const directory = path.join(home, 'voice');
  const engine = path.join(directory, 'engines', 'silero');
  const model = path.join(engine, 'models', 'v5_5_ru');
  const python = path.join(engine, 'venv', 'bin', 'python');
  const log = path.join(home, 'python.json');
  const output = path.join(home, 'silero.wav');

  await mkdir(path.dirname(python), { recursive: true });
  await mkdir(model, { recursive: true });
  await copyFile(fakePython, python);
  await chmod(python, 0o700);
  await writeFile(path.join(model, 'v5_5_ru.pt'), 'fixture');
  await writeFile(path.join(model, 'voice.json'), JSON.stringify({
    id: 'v5_5_ru',
    language: 'ru',
    sampleRate: 48000,
    file: 'v5_5_ru.pt',
    speakers: [{
      id: 'xenia',
      name: 'Ксения',
      timbre: 'женский',
    }],
  }));

  const env = childEnv(home, { PATH: '', VOICE_FIXTURE_RECORD: log });
  const args = ['generate', '--engine', 'silero', '--voice', 'xenia', '--dir', directory,
    '--out', output, '--pace', 'slow', '--text'];

  const bad = await runProcess(t, executable, [...args, 'проверка API 42'], { env });

  assert.equal(bad.code, 2);
  assert.match(bad.stderr.toString(), /API, 42/);
  await assert.rejects(readFile(log), { code: 'ENOENT' });
  await assert.rejects(readFile(output), { code: 'ENOENT' });

  const generated = await runProcess(t, executable, [...args, 'з+амок и зам+ок'], { env });

  assert.equal(generated.code, 0, generated.stderr.toString());

  const input = JSON.parse(await readFile(log, 'utf8'));

  assert.equal(input.text, 'з+амок и зам+ок');
  assert.equal(input.args[input.args.indexOf('--rate') + 1], 'slow');
  assert.equal(input.args[input.args.indexOf('--speaker') + 1], 'xenia');
  assert.equal((await readFile(output)).readUInt32LE(24), 48000);
});

for (const failure of [401, 200]) {
  test(`VOICE-GO-QWEN: ошибка ${failure} сохраняет файл и не повторяет POST`, async (t) => {
    const key = 'fixture-key-never-printed';
    const server = await startHttpFixture(t, (_request, response) => {
      response.writeHead(failure, { 'Content-Type': 'application/json' });
      response.end(failure === 401 ? JSON.stringify({ message: key }) : '{');
    });
    const { home } = await syntheticHome();
    const output = path.join(home, 'previous.wav');
    const env = childEnv(home, {
      PATH: '',
      GRIGDESK_VOICE_QWEN_API_KEY: key,
      GRIGDESK_VOICE_QWEN_BASE_URL: server.baseUrl,
    });

    await writeFile(output, sampleWav(false));

    const result = await runProcess(t, executable, [
      'generate', '--engine', 'qwen', '--text', 'проверка', '--out', output,
    ], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout.length, 0);
    assert.doesNotMatch(result.stderr.toString(), new RegExp(key));
    assert.deepEqual(server.requests.map((request) => request.method), ['POST']);
    assert.deepEqual(await readFile(output), sampleWav(false));
  });
}
