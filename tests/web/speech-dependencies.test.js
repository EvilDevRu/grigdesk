import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeSpeechInstallation } from '../../shared/media/speechInstallation.ts';
import { speechDependencyActions } from '../../web/src/features/settings/speechDependencies.ts';

/**
 * Дисковый и сетевой ответ используют тот же перечень зависимостей без свободной команды.
 * Поля старого установщика остаются допустимыми, неизвестный dependency отвергается.
 */
function installation(dependency, status = 'failed') {
  return {
    managed: true,
    installed: true,
    job: {
      id: 'fixture',
      operation: 'install',
      status,
      stage: 'verification',
      output: '',
      error: 'Ошибка установки',
      ...(dependency === undefined ? {} : { dependency }),
    },
  };
}

test('ffmpeg и ffprobe дают одну известную команду вместо содержимого fix', () => {
  const actions = speechDependencyActions([
    {
      name: 'ffmpeg (извлечение аудио/кадров)',
      ok: false,
      fix: 'rm -rf /; echo attack',
    },
    {
      name: 'ffprobe (длительность/метаданные)',
      ok: false,
      fix: 'произвольный текст',
    },
    {
      name: 'неизвестная зависимость',
      ok: false,
      fix: 'sudo что-нибудь',
    },
  ], installation());

  assert.deepEqual(actions, [{
    id: 'ffmpeg',
    package: 'ffmpeg',
    command: 'sudo apt install -y ffmpeg',
  }]);
});

test('Структурированная ошибка venv предлагает только пакет python3-venv', () => {
  assert.deepEqual(speechDependencyActions([], installation('python_venv')), [{
    id: 'python_venv',
    package: 'python3-venv',
    command: 'sudo apt install -y python3-venv',
  }]);
});

test('Перепроверенная зависимость и успешное задание не показывают старое действие', () => {
  const checks = [{
    name: 'ffmpeg (извлечение аудио/кадров)',
    ok: true,
    fix: '',
  }];

  assert.deepEqual(speechDependencyActions(checks, installation('ffmpeg')), []);
  assert.deepEqual(speechDependencyActions([], installation('python_venv', 'succeeded')), []);
  assert.deepEqual(speechDependencyActions([], null), []);
});

test('Отказ ffmpeg без диагностики и старые ответы декодируются безопасно', () => {
  assert.equal(speechDependencyActions([], installation('ffmpeg'))[0].command,
    'sudo apt install -y ffmpeg');
  assert.equal(decodeSpeechInstallation(installation()).job.dependency, undefined);
  assert.equal(decodeSpeechInstallation(installation('python_venv')).job.dependency, 'python_venv');
  assert.throws(() => decodeSpeechInstallation(installation('sudo malicious-command')), TypeError);
});
