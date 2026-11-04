import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AUDIO_PROBE_PY, preflight, preflightAsync } from '../../server/src/lib/media/preflight.ts';

/**
 * Импорт библиотеки всегда успешен, а декодер отдельно воспроизводит отказ PyAV.
 * WAV проверяется настоящим wave; модели и сторонние Python-пакеты не нужны.
 */
function decoderFixture(t, result) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'speech-audio-probe-'));
  const module = path.join(directory, 'faster_whisper');

  mkdirSync(module);
  writeFileSync(path.join(module, '__init__.py'), '');
  writeFileSync(path.join(module, 'audio.py'), `
import os
import wave

def decode_audio(audio, sampling_rate):
    with wave.open(audio, 'rb') as recording:
        assert recording.getnchannels() == 1
        assert recording.getsampwidth() == 2
        assert recording.getframerate() == sampling_rate == 16000
        assert recording.getnframes() == 1600
        assert recording.readframes(1600) == b'\\x00\\x00' * 1600
    result = os.environ['SPEECH_TEST_DECODE_RESULT']
    if result == 'incompatible':
        raise TypeError("open() got an unexpected keyword argument 'metadata_errors'")
    return [0.0] * (1600 if result == 'ok' else 0)
`);
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  return {
    ...process.env,
    PYTHONPATH: directory,
    PYTHONDONTWRITEBYTECODE: '1',
    SPEECH_TEST_DECODE_RESULT: result,
  };
}

/**
 * Системные инструменты считаются готовыми независимо от машины тестирования.
 * Python действительно запускает пробу и возвращает результат файлового декодера.
 */
function syncProbe(command, args, options) {
  return command === 'python3' ? spawnSync(command, args, options) : { status: 0 };
}

/**
 * Асинхронная проверка сохраняет настоящий lifecycle Python-процесса.
 * Поддельный ffmpeg завершается после подписки preflight на события.
 */
function asyncProbe(command, args, options) {
  if (command === 'python3') {
    return spawn(command, args, options);
  }

  const child = new EventEmitter();

  queueMicrotask(() => child.emit('close', 0));

  return child;
}

for (const result of ['ok', 'incompatible', 'empty']) {
  test(`Проба файлового аудио: ${result}, sync и async preflight`, async (t) => {
    const env = decoderFixture(t, result);
    const imported = spawnSync('python3', ['-c', 'import faster_whisper'], { env });
    const decoded = spawnSync('python3', [AUDIO_PROBE_PY], { env, encoding: 'utf8' });
    const options = {
      pythonPath: 'python3',
      env,
      pathExists: () => true,
    };
    const reports = [
      preflight({ ...options, spawn: syncProbe }),
      await preflightAsync({ ...options, spawn: asyncProbe }),
    ];

    assert.equal(imported.status, 0);
    assert.equal(decoded.status, result === 'ok' ? 0 : 1);
    assert.equal(decoded.stdout, '');

    if (result === 'incompatible') {
      assert.match(decoded.stderr, /unexpected keyword argument 'metadata_errors'/);
    }
    if (result === 'empty') {
      assert.match(decoded.stderr, /неверное число сэмплов/);
    }

    for (const report of reports) {
      assert.equal(report.ok, result === 'ok');
      assert.equal(report.checks[3].ok, result === 'ok');
      assert.equal(report.checks.slice(0, 3).every((check) => check.ok), true);
    }
  });
}
