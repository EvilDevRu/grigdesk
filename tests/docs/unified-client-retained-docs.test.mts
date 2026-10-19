import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('W6: неизменённые контракты окна остаются в документации после перехода на трубу', async () => {
  const startup = await readFile(
    new URL('../../docs/grigdesk/web/desktop-startup.md', import.meta.url), 'utf8');
  const window = await readFile(
    new URL('../../docs/grigdesk/web/desktop-window.md', import.meta.url), 'utf8');

  for (const fact of ['## Заставка', 'SIGTERM', '## Второй экземпляр', '## Проверки']) {
    assert.ok(startup.includes(fact), fact);
  }
  for (const fact of ['## Установка и ярлык', 'GrigDeskSettings/1', 'storageProtection',
    'runAsNode', '## Сохранённые модули прежнего клиента', '## Команды проверок']) {
    assert.ok(window.includes(fact), fact);
  }
});


test('A12: выпуск нового приложения описывает client и существующий ключ без повышения версии', async () => {
  const release = await readFile(
    new URL('../../docs/grigdesk/mobile/release-check.md', import.meta.url), 'utf8');
  const transition = await readFile(
    new URL('../../docs/grigdesk/mobile/app-rename-transition.md', import.meta.url), 'utf8');

  assert.match(release, /:client:assembleRelease/);
  assert.doesNotMatch(release, /android\/app\/build/);
  assert.doesNotMatch(transition, /Release сверяет рост versionCode/);
  assert.match(transition, /grigdesk-mobile-release\.apk/);
});

test('D5: документация пакета описывает DW-P1 и DW-P5 после возврата проверок', async () => {
  const document = await readFile(
    new URL('../../docs/grigdesk/testing/desktop-window-package.md', import.meta.url), 'utf8');

  assert.match(document, /DW-P1/);
  assert.match(document, /DW-P5/);
  assert.match(document, /runtime\.json/);
  assert.match(document, /--grigdesk-url/);
  assert.doesNotMatch(document, /Node в renderer\nдополнительно проверяется dev E2E/);
});
