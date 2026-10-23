import assert from 'node:assert/strict';
import test from 'node:test';

import { exitMain } from '../desktop/helpers/exitMain.js';
import { desktopExitApp } from './helpers/desktopExitApp.js';
import { catalogMessage } from './helpers/i18nCatalog.js';

const snapshot = {
  chats: [{ chatKey: 'one', title: 'Чат <img src=x onerror=alert(1)>' }],
  pipelines: [{ task: '7', title: 'Задача "семь" <b>raw</b>' }],
};

/**
 * Ищем control по переводу из настоящего desktop.json, как делает пользователь.
 * Собственные строки не привязаны к внутреннему имени ключа нового модуля.
 */
async function button(h, label, locale = 'ru') {
  const text = (await catalogMessage('desktop', label))[locale];
  const element = [...h.dialogs().at(-1).querySelectorAll('button')]
    .find((entry) => entry.textContent.trim() === text);

  assert.ok(element, `К1/К16: доступна кнопка ${text}`);

  return new h.DOMWrapper(element);
}

for (const locale of ['ru', 'en']) {
  test(`UI01: реальные списки, checkbox и кнопки в ${locale}, имена остаются текстом`, async (t) => {
    const h = await desktopExitApp(t, { locale });

    await h.command('prompt', { snapshot });
    assert.equal(h.dialogs().length, 1, 'К1: в настоящем App появился диалог выхода');

    const dialog = h.dialogs()[0];

    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.ok(dialog.textContent.includes(snapshot.chats[0].title));
    assert.ok(dialog.textContent.includes(snapshot.pipelines[0].title));
    assert.match(dialog.textContent, /#?7/);
    assert.equal(dialog.querySelector('img'), null);
    assert.equal(dialog.querySelector('b'), null);
    assert.equal(dialog.closest('[data-ui-layer]')?.getAttribute('data-ui-layer'), 'confirm');
    assert.ok(dialog.querySelector('input[type="checkbox"]'));
    await button(h, 'Выйти', locale);
    await button(h, 'Отмена', locale);

    const remember = await catalogMessage('desktop', 'Запомнить');

    assert.ok(dialog.textContent.includes(remember[locale]));
    assert.equal(h.stops().length, 0, 'Показ вопроса не останавливает работу');
  });
}

for (const action of ['cancel', 'escape', 'confirm']) {
  test(`UI02: ${action}, Remember возвращается только с согласием`, async (t) => {
    const h = await desktopExitApp(t);

    await h.command('prompt', { snapshot });
    assert.equal(h.dialogs().length, 1, 'К2/К7: показан вопрос до решения человека');

    const checkbox = new h.DOMWrapper(h.dialogs()[0].querySelector('input[type="checkbox"]'));

    await checkbox.setValue(true);
    await h.command('prompt', { snapshot });
    assert.equal(h.dialogs()[0].querySelector('input[type="checkbox"]').checked, true);

    if (action === 'escape') {
      h.browser.document.dispatchEvent(new h.browser.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      }));
      await h.flushPromises();
    } else {
      await (await button(h, action === 'confirm' ? 'Выйти' : 'Отмена')).trigger('click');
    }

    const decision = await h.command('decision');

    assert.equal(decision.decision, action === 'confirm' ? 'confirm' : 'cancel');
    assert.equal(decision.remember === true, action === 'confirm');
    assert.equal(h.stops().length, 0, 'Решение само по себе не отправляет Stop');
  });
}

test('MAIN04/UI: второй close после dirty beforeunload снова проверяет работу и спрашивает', async (t) => {
  const h = await desktopExitApp(t, {
    active: { active: [], queued: [] },
    tasks: { tasks: [] },
  });
  const renderer = h.browser.grigdeskDesktopExit;
  const f = await exitMain(t, {
    dirtyPage: true,
    renderer: (command) => h.browser.grigdeskDesktopExit?.(command),
  });

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  assert.equal(f.window.close().defaultPrevented, true, 'К3/B1: main сначала проверяет активность');
  await f.settle();
  await h.flushPromises();
  assert.ok(f.calls.includes('unload-held'), 'Пустой close действительно удержан защитой правок');
  assert.equal(f.window.isDestroyed(), false);
  assert.equal(h.dialogs().length, 0, 'К3: без работы вопроса нет');
  assert.equal(f.calls.includes('server-stop'), false);
  assert.equal(h.stops().length, 0);

  const firstInspect = f.commands.find((command) => command.type === 'inspect');

  assert.ok(firstInspect, 'Первый close прошёл через настоящий renderer inspect');
  h.control.active = { active: [{ chatKey: 'one', runId: 'run-one' }], queued: [] };
  h.control.tasks = { tasks: [{
    task: '7',
    title: 'Новая работа',
    daemonAlive: true,
  }] };
  assert.equal(f.window.close().defaultPrevented, true);
  await f.settle();
  await h.flushPromises();

  const inspections = f.commands.filter((command) => command.type === 'inspect');

  assert.equal(inspections.length, 2, 'Каждый close заново читает состав работы');
  assert.notEqual(inspections[1].requestId, firstInspect.requestId);
  assert.equal(h.browser.grigdeskDesktopExit, renderer, 'Документ и renderer не перезагружались');
  assert.equal(h.dialogs().length, 1, 'К1: второй close показывает вопрос при появившейся работе');
  assert.ok(h.dialogs()[0].textContent.includes(h.control.titles.one));
  assert.ok(h.dialogs()[0].textContent.includes('Новая работа'));
  assert.match(h.dialogs()[0].textContent, /#?7/);
  assert.equal(f.calls.filter((call) => call === 'unload-held').length, 1,
    'Второй close удержан вопросом, до beforeunload дело не дошло');
  assert.equal(f.calls.includes('server-stop'), false);
  assert.equal(h.stops().length, 0);

  await (await button(h, 'Отмена')).trigger('click');
  t.mock.timers.tick(500);
  await f.settle();
  await h.flushPromises();
  assert.equal(h.dialogs().length, 0);
  assert.equal(f.window.isDestroyed(), false, 'К2: отмена второго close оставляет окно открытым');
  assert.equal(f.calls.includes('server-stop'), false);
  assert.equal(h.stops().length, 0);
});

test('UI03: spinner показан до Stop и переживает offline/401/showMachines/повтор', async (t) => {
  const h = await desktopExitApp(t);

  await h.command('prompt', { snapshot });
  assert.equal(h.dialogs().length, 1, 'К4: host живёт в корне настоящего App');
  await (await button(h, 'Выйти')).trigger('click');
  await h.command('decision');
  await h.command('stopping', { snapshot });

  const dialog = h.dialogs()[0];

  assert.equal(dialog.getAttribute('aria-busy'), 'true');
  assert.ok(dialog.querySelector('.ui-spinner'), 'Спиннер уже находится в DOM до Stop');
  assert.equal(h.stops().length, 0);

  const stopping = Promise.withResolvers();

  t.after(() => stopping.resolve(new Response('{}')));

  h.control.handlers['/api/tasks/7/stop'] = () => {
    assert.equal(h.dialogs()[0], dialog);
    assert.ok(dialog.querySelector('.ui-spinner'));

    return stopping.promise;
  };

  const stop = h.command('stop-pipelines', { snapshot });

  await h.flushPromises();
  assert.equal(h.stops().length, 1);
  h.shell.apply({
    ...h.snapshot,
    rev: 2,
    status: 'offline',
  });
  h.auth.authenticated = false;
  h.shell.showConnections = true;
  await h.flushPromises();
  assert.equal(h.dialogs()[0], dialog);
  h.browser.document.dispatchEvent(new h.browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new h.DOMWrapper(dialog.closest('.ui-dialog-overlay')).trigger('click');
  await h.command('stopping', { snapshot });
  assert.equal(h.dialogs()[0], dialog);
  stopping.resolve(new Response(JSON.stringify({ ok: true, outcome: 'stopped' })));
  await stop;
  assert.equal(h.dialogs()[0], dialog);
});

test('UI04: чужие, поздние и просроченные команды не показывают вопрос и не шлют Stop', async (t) => {
  const h = await desktopExitApp(t);

  await h.command('prompt', { snapshot });
  assert.equal(h.dialogs().length, 1, 'Активный запрос зарегистрирован до проверки чужих команд');
  await (await button(h, 'Отмена')).trigger('click');
  await h.command('decision');
  await h.command('cancel');
  await h.command('prompt', {
    snapshot,
    requestId: 'expired',
    expiresAt: Date.now() - 1,
  });
  await h.command('stop-pipelines', { snapshot, requestId: 'other' });
  await h.command('unknown', { snapshot });
  assert.equal(h.dialogs().length, 0);
  assert.equal(h.stops().length, 0);

  const next = { requestId: 'valid-next' };

  await h.command('prompt', { snapshot, ...next });
  await (await button(h, 'Выйти')).trigger('click');
  await h.command('decision', next);
  await h.command('stopping', { snapshot, ...next });
  await h.command('stop-pipelines', {
    snapshot,
    ...next,
    expiresAt: Date.now() - 1,
  });
  await h.command('stop-pipelines', { snapshot, requestId: 'other' });
  assert.equal(h.stops().length, 0, 'В stopping отдельно проверены deadline и identity команды');

});

for (const userAgent of [
  'Synthetic Browser',
  'Synthetic GrigDeskAndroid/1',
  'Synthetic GrigDeskSettings/1 GrigDeskWindow/surface',
]) {
  test(`UI04/barrier: документ ${userAgent} не регистрирует exit bridge`, async (t) => {
    const h = await desktopExitApp(t, { userAgent });

    assert.equal(h.browser.grigdeskDesktopExit, undefined);
    await h.command('stop-pipelines', { snapshot });
    assert.equal(h.dialogs().length, 0);
    assert.equal(h.stops().length, 0);
  });
}
