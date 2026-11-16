import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { clientFixture, closeClientBrowser, card, job, snapshot } from './helpers/providerInstallFixture.js';
import {
  deferred, installFixture, current, start, completed,
} from '../server/helpers/providerInstallFixture.js';
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

test('окно сразу показывает preparing со спиннером, затем точный отказ prepare', async (t) => {
  for (const operation of ['install', 'uninstall']) {
    await t.test(operation, async (scenario) => {
      const prepare = deferred();
      const message = 'Каталог программы доступен чужой записи: /fixture/.kimi-code/bin';
      const fixture = await dialogFixture(scenario, job({
        status: 'succeeded',
        outcome: 'updated',
        finishedAt: 1_700_000_001_000,
      }), { prepare: () => prepare.promise });

      fixture.providers.providers[0].installation.lifecycleProtocol = 2;
      fixture.store.visible = false;
      await fixture.flushPromises();
      assert.equal(fixture.wrapper.find('[data-role="provider-install-dialog"]').exists(), false);

      const request = fixture.store.requestInstall(card.id, operation);

      await fixture.flushPromises();
      assert.equal(fixture.wrapper.get('.provider-install').attributes('data-phase'), 'preparing');
      assert.equal(fixture.wrapper.get('[role="progressbar"]').attributes('aria-valuenow'), undefined);
      assert.equal(fixture.wrapper.get('[aria-current="step"]').text(), 'Проверка подготовки');
      assert.equal(fixture.wrapper.find('[aria-current="step"] .ui-spinner').exists(), true);
      assert.equal(fixture.wrapper.find('pre').exists(), false);
      assert.doesNotMatch(fixture.wrapper.text(), /Обновлён|Войти/u);
      await fixture.store.requestInstall(card.id, operation);
      assert.equal(fixture.calls.posts.length, 1);

      prepare.reject(new ApiError(message, 409, { error: 'installation_conflict', message }));
      await request;
      await fixture.flushPromises();
      assert.equal(fixture.wrapper.find('[role="progressbar"]').exists(), false);
      assert.equal(fixture.wrapper.find('[aria-current="step"]').exists(), false);
      assert.ok(fixture.wrapper.get('[role="alert"]').text().includes(message));
      fixture.module.setUiLocale('en');
      await fixture.flushPromises();
      assert.ok(fixture.wrapper.get('[role="alert"]').text().includes(message));
      assert.equal(fixture.calls.confirmations.length, 0);
    });
  }
});

test('общая фаза и свёрнутый live output без выдуманного процента', async (t) => {
  const { wrapper, store, flushPromises, calls } = await dialogFixture(t, job());

  assert.equal(wrapper.get('[role="progressbar"]').attributes('aria-valuenow'), undefined);
  assert.match(wrapper.text(), /Скачиван/u);
  assert.match(wrapper.text(), /[Уу]станов/u);
  assert.match(wrapper.text(), /[Пп]роверк.*верси/u);
  assert.match(wrapper.text(), /[Оо]бновлен.*модел/u);
  assert.match(wrapper.text(), /строка из stdout/u);
  assert.equal(wrapper.get('pre').isVisible(), false);
  assert.equal(button(wrapper, /^Детали/u).attributes('aria-expanded'), 'false');
  await button(wrapper, /^Детали/u).trigger('click');
  assert.equal(wrapper.get('pre').isVisible(), true);
  assert.equal(button(wrapper, /^Детали/u).attributes('aria-expanded'), 'true');

  store.applySnapshot(snapshot(job({ outputTail: '<img src=x onerror="alert(1)">\nживой вывод' }), 4));
  await flushPromises();
  assert.match(wrapper.text(), /<img src=x/u);
  assert.equal(wrapper.find('img').exists(), false);
  assert.match(wrapper.text(), /живой вывод/u);
  assert.equal(wrapper.get('pre').isVisible(), true);
  await button(wrapper, /^Закрыть$/u).trigger('click');
  await flushPromises();
  assert.equal(store.snapshot.active.id, 'fixture-job-1');
  assert.equal(calls.posts.length, 0, 'Закрытие отправляет abort или cancel');

  store.show('claude');
  await flushPromises();
  assert.equal(wrapper.get('pre').isVisible(), false);
  await button(wrapper, /^Детали/u).trigger('click');
  store.applySnapshot(snapshot(job({ id: 'fixture-job-2' }), 5));
  await flushPromises();
  assert.equal(wrapper.get('pre').isVisible(), false);
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

        if (entry.ownText) {
          const notice = finalJob.error || finalJob.warnings[0];

          assert.ok(result.includes(notice.message));
        } else {
          assert.match(result, entry[locale], `${entry.status}, ${locale}, ${index}`);
        }

        assert.doesNotMatch(fixture.wrapper.text(), unresolved);

        if (entry.outcome === 'updated') {
          assert.match(result, /1\.0\.0.*2\.0\.0/su);
        }
        if (finalJob.warnings.length) {
          const rebuiltClaim = /Список моделей пересобран|model list (?:was )?rebuilt/iu;

          assert.doesNotMatch(result, rebuiltClaim);
        }

        const output = fixture.wrapper.findAll('pre').map((item) => item.element.textContent).join('');

        assert.equal(output, finalJob.outputTail,
          'Сырой вывод команды должен оставаться данными при смене языка');

        if (finalJob.outputTail) {
          const details = button(fixture.wrapper, locale === 'ru' ? /^Детали/u : /^Details/u);

          assert.equal(fixture.wrapper.get('pre').isVisible(), false);
          await details.trigger('click');
          assert.equal(fixture.wrapper.get('pre').isVisible(), true);
          await details.trigger('click');
          assert.equal(fixture.wrapper.get('pre').isVisible(), false);
        }
      }

      fixture.wrapper.unmount();
    });
  }
});

test('блокировка сервиса сохраняет message на RU и EN', async (t) => {
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

    assert.ok(reason.includes(blocked.blockedReason.message));
  }

  assert.equal(fixture.store.busy, true);
  assert.equal(fixture.calls.posts.length, 0);
});

test('отказ старта сохраняет message на RU и EN и запасную команду', async (t) => {
  const server = await installFixture(t);

  server.descriptor.update = null;

  let message = '';

  const fixture = await dialogFixture(t, null, {
    get: async () => current(server.app),
    post: async () => {
      const response = await start(server.app);
      const body = response.json();

      assert.equal(response.statusCode, 400, response.body);
      message = body.message;

      throw new ApiError(body.message, response.statusCode, body);
    },
  });

  await fixture.store.requestInstall('claude', 'update');

  for (const locale of ['ru', 'en']) {
    fixture.module.setUiLocale(locale);
    await fixture.flushPromises();

    const reason = fixture.wrapper.findAll('[role="alert"]').map((item) => item.text()).join('\n');

    assert.ok(reason.includes(message));
  }

  await button(fixture.wrapper, /^Open in terminal$/iu).trigger('click');
  await fixture.flushPromises();
  assert.deepEqual(fixture.calls.terminals, [{ insert: card.installation.fallbackUpdateCommand }]);
  assert.equal(server.calls.commands.length, 0);
  assert.equal(fixture.calls.posts.filter((post) => post.url.endsWith('/start')).length, 1);
});

/**
 * Подготовка не запускает installer: её отказ должен объяснять новый клик.
 * Сохранённые версия, лог и вход прошлого обновления не относятся к этой попытке.
 */
test('отказ подготовки показывает незапущенную установку вместо прошлого обновления', async (t) => {
  const previous = job({
    id: 'previous-update',
    status: 'succeeded',
    stage: 'models',
    outcome: 'updated',
    after: '2.1.310',
    outputTail: 'вывод прошлого обновления',
    finishedAt: 1_700_000_001_000,
  });
  const remote = snapshot(null, 3, { claude: previous });
  const fixture = await dialogFixture(t, previous, {
    get: async () => structuredClone(remote),
    prepare: async () => {
      throw new ApiError('Маршрут подготовки не найден', 404, { error: 'not_found' });
    },
  });

  await fixture.store.requestInstall('claude', 'install');
  await fixture.store.load();

  for (const locale of ['ru', 'en']) {
    fixture.module.setUiLocale(locale);
    await fixture.flushPromises();

    const text = fixture.wrapper.text();

    assert.match(text, locale === 'ru' ? /Установка Claude/u : /Claude.*installation/u);
    assert.match(text, locale === 'ru' ? /Установка не началась/u : /Installation did not start/u);
    assert.match(text, locale === 'ru' ? /Перезапустите GrigDesk/u : /Restart GrigDesk/u);
    assert.doesNotMatch(text, /2\.1\.310|вывод прошлого обновления/u);
    assert.equal(fixture.wrapper.find('.provider-install-steps').exists(), false);
    assert.equal(fixture.wrapper.find('pre').exists(), false);
    assert.equal(fixture.wrapper.find('[role="progressbar"]').exists(), false);

    const loginButtons = fixture.wrapper.findAll('button')
      .filter((item) => /^(Войти|Log in|Sign in)$/u.test(item.text()));

    assert.equal(loginButtons.length, 0);
    assert.equal(fixture.wrapper.find('.provider-install').attributes('data-tone'), 'danger');
  }

  assert.equal(fixture.calls.confirmations.length, 0);
  assert.equal(fixture.calls.posts.filter((post) => post.url.endsWith('/start')).length, 0);
  assert.equal(fixture.store.snapshot.recent.claude.id, previous.id);
});

test('отказ подготовки называет выбранную lifecycle-операцию на RU и EN', async (t) => {
  const fixture = await dialogFixture(t, null, {
    prepare: async () => {
      throw new ApiError('shell conflict', 409, { error: 'shell_conflict' });
    },
  });
  const cases = [
    ['reinstall', /Переустановка не началась/u, /Reinstallation did not start/u],
    ['uninstall', /Удаление не началось/u, /Uninstallation did not start/u],
  ];

  fixture.providers.providers[0].installation.lifecycleProtocol = 2;

  for (const [operation, ru, en] of cases) {
    await fixture.store.requestInstall('claude', operation);

    for (const [locale, expected] of [['ru', ru], ['en', en]]) {
      fixture.module.setUiLocale(locale);
      await fixture.flushPromises();
      assert.match(fixture.wrapper.text(), expected);
    }
  }

  assert.equal(fixture.calls.confirmations.length, 0);
  assert.equal(fixture.calls.posts.filter((post) => post.url.endsWith('/start')).length, 0);
});

test('отказ проверки npm показывает перевод причины prepare на RU и EN', async (t) => {
  const cases = [
    {
      code: 'installer_strategy_unverified',
      ru: /Способ установки этой версии не проверен/u,
      en: /This installation method is not verified for the version/u,
    },
    {
      code: 'npm_graph_invalid',
      ru: /Не удалось проверить граф npm-пакета/u,
      en: /The npm package graph could not be verified/u,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.code, async (scenario) => {
      const fixture = await dialogFixture(scenario, null, {
        prepare: async () => {
          throw new ApiError(entry.code, 409, { error: entry.code, message: '' });
        },
      });

      fixture.providers.providers[0].installation.lifecycleProtocol = 2;
      await fixture.store.requestInstall('claude', 'update');

      for (const locale of ['ru', 'en']) {
        fixture.module.setUiLocale(locale);
        await fixture.flushPromises();

        const text = fixture.wrapper.text();

        assert.match(text, entry[locale]);
        assert.doesNotMatch(text,
          /Подготовка операции не удалась|installer_strategy_unverified|npm_graph_invalid/u);
      }

      assert.equal(fixture.calls.confirmations.length, 0);
      assert.equal(fixture.calls.posts.length, 1);
      assert.equal(fixture.calls.posts[0].url.endsWith('/prepare'), true);
    });
  }
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

test('Повторить сохраняет вид операции и открывает новый запуск после подтверждения', async (t) => {
  for (const status of ['failed', 'interrupted']) {
    for (const operation of ['install', 'update']) {
      await t.test(`${status}/${operation}`, async (scenario) => {
        const fixture = await dialogFixture(scenario, job({
          status,
          operation,
          finishedAt: 1_700_000_001_000,
        }), {
          post: async () => snapshot(job({ id: 'retry-job', operation }), 4),
        });

        fixture.module.setUiLocale('en');
        await fixture.flushPromises();
        assert.equal(button(fixture.wrapper, /^Retry$/u).attributes('disabled'), undefined);
        fixture.module.setUiLocale('ru');
        await fixture.flushPromises();
        await button(fixture.wrapper, /^Повторить$/u).trigger('click');
        await fixture.flushPromises();

        assert.equal(fixture.calls.confirmations.length, 1);
        assert.ok(fixture.calls.confirmations[0].details.details.text
          .startsWith(card.installation[`${operation}Command`]));
        assert.deepEqual(fixture.calls.posts.map((post) => post.url), [
          `/api/providers/claude/${operation}/prepare`,
          `/api/providers/claude/${operation}/start`,
        ]);
        assert.deepEqual(fixture.calls.posts[1].body,
          { preparationToken: 'fixture-preparation-token' });
        assert.equal(fixture.store.snapshot.active.id, 'retry-job');
        assert.equal(fixture.wrapper.findAll('button').some((item) => item.text() === 'Повторить'), false);
        assert.equal(fixture.calls.terminals.length, 0);
        fixture.wrapper.unmount();
      });
    }
  }
});

test('отмена повтора сохраняет ошибку без новой команды', async (t) => {
  const fixture = await dialogFixture(t, job({
    status: 'failed',
    error: { code: 'network', message: 'Обрыв соединения' },
    finishedAt: 1_700_000_001_000,
  }), { confirm: false });

  await button(fixture.wrapper, /^Повторить$/u).trigger('click');
  await fixture.flushPromises();
  assert.equal(fixture.calls.confirmations.length, 1);
  assert.equal(fixture.calls.posts.filter((post) => post.url.endsWith('/start')).length, 0);
  assert.match(fixture.wrapper.text(), /Обрыв соединения/u);
  assert.equal(button(fixture.wrapper, /^Повторить$/u).attributes('disabled'), undefined);
});

test('повтор недоступен при занятой установке, блокировке, неизвестном исходе и отправке POST', async (t) => {
  const final = job({ status: 'failed', finishedAt: 1_700_000_001_000 });
  const fixture = await dialogFixture(t, final);

  fixture.store.applySnapshot(snapshot(job({ providerId: 'codex' }), 4, { claude: final }));
  await fixture.flushPromises();
  assert.equal(button(fixture.wrapper, /^Повторить$/u).attributes('disabled'), '');
  await button(fixture.wrapper, /^Повторить$/u).trigger('click');
  fixture.store.applySnapshot(snapshot(null, 5, { claude: final }, 'Состояние недоступно'));
  await fixture.flushPromises();
  assert.equal(button(fixture.wrapper, /^Повторить$/u).attributes('disabled'), '');
  await button(fixture.wrapper, /^Повторить$/u).trigger('click');
  fixture.store.applySnapshot(snapshot(null, 6, { claude: final }));
  fixture.store.uncertain = true;
  await fixture.flushPromises();
  assert.equal(button(fixture.wrapper, /^Повторить$/u).attributes('disabled'), '');
  await button(fixture.wrapper, /^Повторить$/u).trigger('click');
  fixture.store.uncertain = false;
  fixture.store.pending = 'claude';
  await fixture.flushPromises();
  assert.equal(button(fixture.wrapper, /^Повторить$/u).attributes('disabled'), '');
  await button(fixture.wrapper, /^Повторить$/u).trigger('click');
  assert.equal(fixture.calls.confirmations.length, 0);
  assert.equal(fixture.calls.posts.length, 0);
});

test('успешный итог не предлагает повтор установки', async (t) => {
  const fixture = await dialogFixture(t, job({
    status: 'succeeded',
    outcome: 'updated',
    after: '2.0.0',
    finishedAt: 1_700_000_001_000,
  }));

  assert.equal(fixture.wrapper.findAll('button').some((item) => item.text() === 'Повторить'), false);
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

/**
 * Стадия терминала — собственная подпись в ходе и отдельная честная строка итога.
 * Старый job без поля terminal не объявляется проверенным.
 */
test('стадия terminal показывается своей подписью на RU и EN', async (t) => {
  const fixture = await dialogFixture(t, job({ stage: 'terminal' }));

  assert.match(fixture.wrapper.text(), /Настройка терминала/u);
  fixture.module.setUiLocale('en');
  await fixture.flushPromises();
  assert.match(fixture.wrapper.text(), /Terminal setup/u);
});

test('итог терминала отделён от успеха CLI на RU и EN', async (t) => {
  const cases = [
    {
      terminal: {
        status: 'ready',
        reason: null,
        binDirectory: '/home/fixture/.local/bin',
        shell: 'bash',
      },
      ru: /доступна в новом терминале/u,
      en: /available in a new terminal/iu,
    },
    {
      terminal: {
        status: 'needs_setup',
        reason: 'terminal_setup_required',
        binDirectory: '/home/fixture/.local/bin',
        shell: 'bash',
      },
      ru: /не находится.*\/home\/fixture\/\.local\/bin/su,
      en: /not find the command.*\/home\/fixture\/\.local\/bin/isu,
    },
    {
      terminal: {
        status: 'conflict',
        reason: 'terminal_command_conflict',
        binDirectory: '/home/fixture/.local/bin',
        shell: 'other',
      },
      ru: /имя уже занято/u,
      en: /name is already taken/iu,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.terminal.status, async (scenario) => {
      const finalJob = job({
        status: 'succeeded',
        outcome: 'updated',
        after: '2.0.0',
        terminal: entry.terminal,
        finishedAt: 1_700_000_001_000,
      });
      const fixture = await dialogFixture(scenario, finalJob);

      for (const locale of ['ru', 'en']) {
        fixture.module.setUiLocale(locale);
        await fixture.flushPromises();

        const result = fixture.wrapper.get('[role="status"]').text();

        assert.match(result, entry[locale], `${entry.terminal.status} ${locale}`);
        assert.match(result, /Обновлён|Updated/u, 'итог CLI потерян');
        assert.doesNotMatch(result, /settings\.providerInstallation/u);
      }
    });
  }
});

test('справочное предупреждение nvm-scoped не показывается и не меняет тон успеха', async (t) => {
  const fixture = await dialogFixture(t, job({
    status: 'succeeded',
    outcome: 'updated',
    after: '2.0.0',
    warnings: [{ code: 'npm_prefix_nvm_scoped', message: 'Сырой текст сервера' }],
    finishedAt: 1_700_000_001_000,
  }));

  assert.doesNotMatch(fixture.wrapper.text(), /nvm/iu);
  assert.doesNotMatch(fixture.wrapper.text(), /Сырой текст сервера/u);
  assert.equal(fixture.wrapper.find('.provider-install').attributes('data-tone'), 'success');
});

test('перенос копии при равной версии виден отдельно', async (t) => {
  const finalJob = job({
    status: 'succeeded',
    operation: 'update',
    outcome: 'current',
    before: '2.0.0',
    after: '2.0.0',
    migration: { from: '/data/state/npm-global/bin/claude', to: '/home/fixture/.local/bin/claude' },
    finishedAt: 1_700_000_001_000,
  });
  const fixture = await dialogFixture(t, finalJob);

  assert.match(fixture.wrapper.text(), /Копия перенесена/u);
  assert.match(fixture.wrapper.text(), /\.local\/bin\/claude/u);
  fixture.module.setUiLocale('en');
  await fixture.flushPromises();
  assert.match(fixture.wrapper.text(), /Copy moved/iu);
});

test('старый job без terminal не выдаётся за готовый терминал', async (t) => {
  const fixture = await dialogFixture(t, job({
    status: 'succeeded',
    outcome: 'updated',
    after: '2.0.0',
    finishedAt: 1_700_000_001_000,
  }));

  assert.doesNotMatch(fixture.wrapper.text(), /доступна в новом терминале|manual|ручн/iu);
  assert.equal(fixture.wrapper.find('[data-terminal]').exists(), false);
});

test('Войти передаёт абсолютный bin без Enter', async (t) => {
  const fixture = await dialogFixture(t, job({
    operation: 'install',
    status: 'succeeded',
    outcome: 'installed',
    after: '2.0.0',
    loginCommand: '/home/fixture/.local/bin/claude login',
    finishedAt: 1_700_000_001_000,
  }));

  await button(fixture.wrapper, /^Войти$/u).trigger('click');
  await fixture.flushPromises();

  assert.deepEqual(fixture.calls.terminals, [{ insert: '/home/fixture/.local/bin/claude login' }]);
});
