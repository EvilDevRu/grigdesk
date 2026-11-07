// Карточка «Процесс GrigDesk» в «Настройки → Сервер». Сервер под приложением GrigDesk не
// получает совета про deploy/install.sh: установщик запустил бы юнит рядом с ним. Старый
// сервер без поля mode (до рестарта) читается по прежнему признаку systemd.
import assert from 'node:assert/strict';
import test from 'node:test';

import { serverModeText } from '../../web/src/views/settings/serverMode.ts';

const SYSTEMD = {
  pill: 'Под управлением systemd',
  tone: 'ok',
  modeLine: 'демон systemd',
  hint: null,
  restartConfirm: 'Сервер выйдет, юнит systemd поднимет его сам.',
};
const MANUAL = {
  pill: 'Ручной запуск',
  tone: 'warn',
  modeLine: 'запущен вручную',
  hint: 'Ручной запуск — режим разработки. Чтобы демон поднимался сам, один раз выполни'
    + ' deploy/install.sh. Режимы не смешивать: ручной экземпляр держит порт,'
    + ' и юнит будет падать в цикле.',
  restartConfirm: 'Сервер запущен вручную — перезапустится через deploy/restart.sh.',
};

test('WB-01 desktop — тексты приложения без подсказки install.sh', () => {
  const text = serverModeText({
    systemd: false,
    mode: 'desktop',
  });

  assert.deepEqual(text, {
    pill: 'Под управлением приложения',
    tone: 'ok',
    modeLine: 'приложение GrigDesk',
    hint: null,
    restartConfirm: 'Сервер перезапустит приложение GrigDesk.',
  });
  assert.doesNotMatch(JSON.stringify(text), /install\.sh/u);
});

test('WB-02 нет поля mode — прежние тексты по systemd', () => {
  assert.deepEqual(serverModeText({ systemd: true }), SYSTEMD);
  assert.deepEqual(serverModeText({ systemd: false }), MANUAL);
  assert.deepEqual(serverModeText({}), MANUAL);
  assert.deepEqual(serverModeText(null), MANUAL);

  // Незнакомый режим будущего сервера тоже читается по прежнему признаку.
  assert.deepEqual(serverModeText({
    systemd: true,
    mode: 'будущий',
  }), SYSTEMD);
});

test('WB-03 manual и systemd — нынешние строки дословно', () => {
  assert.deepEqual(serverModeText({
    systemd: true,
    mode: 'systemd',
  }), SYSTEMD);
  assert.deepEqual(serverModeText({
    systemd: false,
    mode: 'manual',
  }), MANUAL);

  const first = serverModeText({ mode: 'manual' });

  first.pill = 'изменено вызывающим';
  assert.equal(serverModeText({ mode: 'manual' }).pill, 'Ручной запуск', 'тексты не разделяют объект');
});
