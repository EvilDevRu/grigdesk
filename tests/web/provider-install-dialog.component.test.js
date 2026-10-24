import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { clientFixture, closeClientBrowser, card, job, snapshot } from './helpers/providerInstallFixture.js';
import { installFixture, current, start, completed } from '../server/helpers/providerInstallFixture.js';
import { ApiError } from '../../web/src/shared/apiClient.ts';

after(closeClientBrowser);

/**
 * Диалог получает настоящий store и публичные UI primitives в одном compiled graph.
 * Сеть и терминал подменены, вывод команды остаётся обычным недоверенным текстом.
 */
async function dialogFixture(t, activeJob, options = {}) {
  const fixture = await clientFixture(t, {
    ...options,
    dialog: true
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );

  fixture.store.applySnapshot(!activeJob ? snapshot() : activeJob.status === 'running'
    ? snapshot(activeJob, 3) : snapshot(null, 3, { claude: activeJob }));
  fixture.store.show('claude');

  const wrapper = mount(fixture.module.Dialog, {
    attachTo: fixture.browser.document.querySelector('#mount'),
    global: {
      plugins: [fixture.pinia],
      stubs: { teleport: true }
    },
  });

  t.after(() => wrapper.unmount());
  await flushPromises();

  return {
    ...fixture,
    wrapper,
    flushPromises
  };
}

/**
 * Доступное имя находит продуктовую кнопку независимо от внутреннего data-role.
 * В assert передаётся только число, чтобы happy-dom не сериализовал циклический узел.
 */
function button(wrapper, name) {
  const buttons = wrapper.findAll('button').filter((item) => name.test(
    item.attributes('aria-label') || item.text(),
  ));

  assert.equal(buttons.length, 1, `Нет единственной кнопки ${name}`);

  return buttons[0];
}

/**
 * Собственные причины берутся из настоящего сервиса, а не копируются из локалей.
 * Меняются только команды и discovery; PATH и durable state принадлежат temp-фикстуре.
 */
async function serverJob(t, options) {
  const server = await installFixture(t, options);
  const operation = options.installed === false ? 'install' : 'update';

  if (options.missingNpm) {
    server.descriptor.install.executable = 'npm';
  }

  const response = await start(server.app, 'claude', operation);

  assert.equal(response.statusCode, 202, response.body);
  server.gate.resolve();

  return (await completed(server.app)).recent.claude;
}

test('общая фаза и live output без выдуманного процента', async (t) => {
  const { wrapper, store, flushPromises, calls } = await dialogFixture(t, job());

  assert.equal(wrapper.get('[role="progressbar"]').attributes('aria-valuenow'), undefined);
  assert.match(wrapper.text(), /Скачиван/u);
  assert.match(wrapper.text(), /[Уу]станов/u);
  assert.match(wrapper.text(), /[Пп]роверк.*верси/u);
  assert.match(wrapper.text(), /[Оо]бновлен.*модел/u);
  assert.match(wrapper.text(), /строка из stdout/u);
  store.applySnapshot(snapshot(job({ outputTail: '<img src=x onerror="alert(1)">\nживой вывод' }), 4));
  await flushPromises();
  assert.match(wrapper.text(), /<img src=x/u);
  assert.equal(wrapper.find('img').exists(), false);
  assert.match(wrapper.text(), /живой вывод/u);
  await button(wrapper, /^Закрыть$/u).trigger('click');
  assert.equal(store.snapshot.active.id, 'fixture-job-1');
  assert.equal(calls.posts.length, 0, 'Закрытие отправляет abort или cancel');
});

test('номер сетевого повтора переводится и исчезает после фазы установки', async (t) => {
  const active = job({ retry: { attempt: 2, attempts: 3 } });
  const fixture = await dialogFixture(t, active);

  assert.match(fixture.wrapper.get('[role="status"]').text(), /Сбой сети.*2 из 3/u);
  fixture.module.setUiLocale('en');
  await fixture.flushPromises();
  assert.match(fixture.wrapper.get('[role="status"]').text(), /Network error.*2 of 3/u);
  assert.equal(fixture.calls.posts.length, 0, 'Перевод запустил новый installer');
  fixture.store.applySnapshot(snapshot({ ...active, stage: 'version' }, 4));
  await fixture.flushPromises();
  assert.equal(fixture.wrapper.find('[role="status"]').exists(), false);
});

test('четыре исхода и interrupted видны на RU и EN', async (t) => {
  const cases = [
    {
      status: 'succeeded',
      operation: 'install',
      outcome: 'installed',
      ru: /Установлен/u,
      en: /Installed/iu
    },
    {
      status: 'succeeded',
      outcome: 'updated',
      ru: /Обновлён/u,
      en: /Updated/iu
    },
    {
      status: 'succeeded',
      outcome: 'current',
      before: '2.0.0',
      ru: /последняя версия/u,
      en: /latest|up.to.date/iu
    },
    {
      status: 'failed',
      server: {
        commandResult: {
          code: 127,
          stdout: '',
          stderr: 'ENOENT npm'
        }
      },
      ru: /ENOENT/u,
      en: /ENOENT/u
    },
    {
      status: 'failed',
      server: {
        commandResult: {
          code: 1,
          stdout: '',
          stderr: 'EACCES'
        }
      },
      ru: /EACCES/u,
      en: /EACCES/u
    },
    {
      status: 'failed',
      server: { commandResult: { timedOut: true, code: null } },
      ownText: true,
      ru: /срок|время.*ожидан|тайм/iu,
      en: /timed? out|timeout|time limit/iu
    },
    {
      status: 'failed',
      server: { probeAfter: { ok: false, version: '' } },
      ownText: true,
      ru: /верси/iu,
      en: /version/iu
    },
    {
      status: 'failed',
      server: { installed: false, missingNpm: true },
      ownText: true,
      ru: /npm.*не найден/iu,
      en: /npm.*(?:not found|missing|unavailable)|(?:cannot|could not|unable to) find npm/iu
    },
    {
      status: 'interrupted',
      ru: /[Пп]рерван/u,
      en: /interrupted/iu
    },
    {
      status: 'succeeded',
      outcome: 'updated',
      server: { modelsError: true },
      ownText: true,
      ru: /модел.*не обнов/iu,
      en: /model.*(?:not|fail|unavailable)|(?:not|could|fail|unable).*model/iu
    },
  ];

  for (const [index, entry] of cases.entries()) {
    await t.test(`${entry.status}, ${index}`, async (scenario) => {
      const finalJob = entry.server ? await serverJob(scenario, entry.server) : job({
        ...entry,
        after: '2.0.0',
        finishedAt: 1_700_000_001_000,
      });
      const fixture = await dialogFixture(scenario, finalJob);

      assert.equal(finalJob.status, entry.status);

      for (const locale of ['ru', 'en']) {
        fixture.module.setUiLocale(locale);
        await fixture.flushPromises();

        const result = fixture.wrapper.get('[role="status"]').text();
        const unresolved = /settings\.providerInstallation|\{(?:before|after|version)\}/u;

        assert.match(result, entry[locale], `${entry.status}, ${locale}, ${index}`);
        assert.doesNotMatch(fixture.wrapper.text(), unresolved);

        if (entry.outcome === 'updated') {
          assert.match(result, /1\.0\.0.*2\.0\.0/su);
        }
        if (finalJob.warnings.length) {
          const rebuiltClaim = /Список моделей пересобран|model list (?:was )?rebuilt/iu;

          assert.doesNotMatch(result, rebuiltClaim);
        }
        if (entry.ownText && locale === 'en') {
          assert.doesNotMatch(result, /[А-Яа-яЁё]/u, 'Собственная причина сервера не переведена');
        }

        const output = fixture.wrapper.findAll('pre').map((item) => item.element.textContent).join('');

        assert.equal(output, finalJob.outputTail,
          'Сырой вывод команды должен оставаться данными при смене языка');
      }

      fixture.wrapper.unmount();
    });
  }
});

test('блокировка сервиса переводится при показе на RU и EN', async (t) => {
  const server = await installFixture(t);

  await fs.mkdir(path.dirname(server.config.providerInstallStatePath), { recursive: true });
  await fs.writeFile(server.config.providerInstallStatePath, '{}');

  const blocked = await current(server.app);

  assert.ok(blocked.blockedReason, 'Повреждённый private state должен запретить новую установку');

  const fixture = await dialogFixture(t, null, { get: async () => structuredClone(blocked) });

  for (const locale of ['ru', 'en']) {
    fixture.module.setUiLocale(locale);
    await fixture.flushPromises();

    const reason = fixture.wrapper.findAll('[role="alert"]').map((item) => item.text()).join('\n');

    assert.match(reason, locale === 'ru' ? /состояни/iu : /state/iu);

    if (locale === 'en') {
      assert.doesNotMatch(reason, /[А-Яа-яЁё]/u);
    }
  }

  assert.equal(fixture.store.busy, true);
  assert.equal(fixture.calls.posts.length, 0);
});

test('отказ старта переводится на RU и EN и сохраняет запасную команду', async (t) => {
  const server = await installFixture(t);

  server.descriptor.update = null;

  const fixture = await dialogFixture(t, null, {
    get: async () => current(server.app),
    post: async () => {
      const response = await start(server.app);
      const body = response.json();

      assert.equal(response.statusCode, 400, response.body);

      throw new ApiError(body.message, response.statusCode, body);
    },
  });

  await fixture.store.requestInstall('claude', 'update');

  for (const locale of ['ru', 'en']) {
    fixture.module.setUiLocale(locale);
    await fixture.flushPromises();

    const reason = fixture.wrapper.findAll('[role="alert"]').map((item) => item.text()).join('\n');

    assert.match(reason, locale === 'ru'
      ? /не поддерживает|недоступ/iu : /not support|unsupported|not available|unavailable/iu);

    if (locale === 'en') {
      assert.doesNotMatch(reason, /[А-Яа-яЁё]/u);
    }
  }

  await button(fixture.wrapper, /^Open in terminal$/iu).trigger('click');
  await fixture.flushPromises();
  assert.deepEqual(fixture.calls.terminals, [{ insert: card.installation.fallbackUpdateCommand }]);
  assert.equal(server.calls.commands.length, 0);
  assert.equal(fixture.calls.posts.length, 1);
});

test('Войти не исполняет installer', async (t) => {
  const fixture = await dialogFixture(t, job({
    operation: 'install',
    status: 'succeeded',
    outcome: 'installed',
    after: '2.0.0',
    finishedAt: 1_700_000_001_000,
  }));

  await button(fixture.wrapper, /^Войти$/u).trigger('click');
  await fixture.flushPromises();
  assert.deepEqual(fixture.calls.terminals, [{ insert: 'claude login' }]);
  assert.equal(fixture.calls.posts.length, 0);
});

test('fallback сохраняет старую команду', async (t) => {
  const fixture = await dialogFixture(t, job({
    status: 'failed',
    error: {
      code: 'EACCES',
      message: 'Нет прав'
    },
    fallbackCommand: 'старый installer && claude login',
    finishedAt: 1_700_000_001_000,
  }));

  assert.match(fixture.wrapper.text(), /Нет прав/u);
  await button(fixture.wrapper, /^Открыть в терминале$/u).trigger('click');
  await fixture.flushPromises();
  assert.deepEqual(fixture.calls.terminals, [{ insert: 'старый installer && claude login' }]);
  assert.equal(fixture.calls.posts.length, 0);
});

test('dirty-настройки могут отменить переход', async (t) => {
  let requested = 0;
  const settings = {
    isOpen: true,
    draft: { field: 'несохранённое значение' },
    async requestAction() {
      requested += 1;

      return false;
    },
  };
  const fixture = await dialogFixture(t, job({
    status: 'failed',
    error: {
      code: 'EACCES',
      message: 'Нет прав'
    },
    finishedAt: 1_700_000_001_000,
  }), { settings });

  await button(fixture.wrapper, /^Открыть в терминале$/u).trigger('click');
  await fixture.flushPromises();
  assert.equal(requested, 1);
  assert.equal(fixture.calls.terminals.length, 0);
  assert.equal(settings.draft.field, 'несохранённое значение');
  assert.match(fixture.wrapper.text(), /Нет прав/u);
  assert.ok(fixture.wrapper.find('[role="dialog"]').exists());
});

test('первая установка предупреждает о старом терминале и передаёт только login', async (t) => {
  const fixture = await dialogFixture(t, job({
    status: 'succeeded',
    operation: 'install',
    outcome: 'installed',
    after: '2.0.0',
    finishedAt: 1_700_000_001_000,
  }));

  assert.match(fixture.wrapper.text(), /команда не найдена/u);
  assert.match(fixture.wrapper.text(), /закры.*откр|переоткр/iu);
  fixture.module.setUiLocale('en');
  await fixture.flushPromises();
  assert.match(fixture.wrapper.text(), /command not found/iu);
  assert.match(fixture.wrapper.text(), /reopen|close.*open/isu);
  await button(fixture.wrapper, /^Log in$|^Sign in$/iu).trigger('click');
  await fixture.flushPromises();
  assert.deepEqual(fixture.calls.terminals, [{ insert: 'claude login' }]);
});
