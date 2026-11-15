import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';
import codex from '../../server/src/lib/executors/codex.ts';
import { resolveProviderSettings } from '../../server/src/lib/providerSettings.ts';
import { translator, resolveLocaleText } from '../../shared/i18n/catalogs.ts';

const risk = 'Агент сможет запускать прямые SSH-клиенты с правами процесса GrigDesk. '
  + 'Режим прав Bash не заменяет этот запрет. Подтверждений и журнала SSH-инструмента не будет.';

test('после удаления npm оставшаяся копия сохраняет обычные действия и объясняет версию', async (t) => {
  const nativeId = 'a'.repeat(64);
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    entityId: 'fixture',
    prepare({ providers }) {
      Object.assign(providers.providers[0], {
        installed: true,
        available: true,
        version: '2.3.2',
        install: 'official-fixture-installer',
        canUpdate: true,
        installation: {
          lifecycleProtocol: 2,
          canInstall: false,
          canUpdate: true,
          canReinstall: true,
          canUninstall: true,
          inventory: {
            selectedId: nativeId,
            terminalId: nativeId,
            conflict: false,
            installations: [{
              installationId: nativeId,
              resourceKey: nativeId,
              source: 'native',
              state: 'unverified',
              path: '/fixture/native/bin/fixture',
              realpath: '/fixture/native/bin/fixture',
              root: '/fixture/native/bin',
              prefix: null,
              version: null,
              aliases: ['/fixture/native/bin/fixture'],
            }],
          },
        },
      });
    },
  });
  const installation = h.wrapper.vm.$pinia._s.get('provider-install');

  installation.snapshot.recent.fixture = {
    status: 'succeeded',
    outcome: 'uninstalled',
    before: '2.3.3',
  };
  h.settings.selectPage('agents.providers', 'fixture', 'overview');
  await h.flushPromises();

  const buttons = h.wrapper.findAll('button').map((button) => button.text());

  assert.ok(buttons.includes('Обновить CLI'));
  assert.ok(buttons.includes('Переустановить'));
  assert.ok(buttons.includes('Удалить программу'));
  assert.doesNotMatch(h.wrapper.text(), /нативная|Установить \/ обновить в терминале/iu);
  assert.match(h.wrapper.get('[data-provider-removal-result]').text(),
    /Версия 2\.3\.3 удалена.*другая установленная копия: 2\.3\.2/u);

  const provider = h.providers.providers[0];

  provider.installed = false;
  provider.available = false;
  provider.installation.canInstall = true;
  provider.installation.canReinstall = false;
  provider.installation.canUninstall = false;
  provider.installation.inventory.installations = [];
  provider.installation.inventory.selectedId = null;
  provider.installation.inventory.terminalId = null;
  await h.flushPromises();

  assert.ok(h.wrapper.findAll('button').some((button) => button.text() === 'Установить'));
  assert.equal(h.wrapper.find('[data-provider-manual-install]').exists(), false);
  assert.equal(h.wrapper.find('[data-provider-removal-result]').exists(), false);
});

test('страница исполнителя не предлагает отдельную миграцию из старого снимка сервера', async (t) => {
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    entityId: 'fixture',
    prepare({ providers }) {
      providers.providers[0].installation = {
        lifecycleProtocol: 2,
        canMigrate: true,
        canInstall: true,
        canReinstall: true,
        canUninstall: true,
      };
    },
  });

  h.settings.selectPage('agents.providers', 'fixture', 'overview');
  await h.flushPromises();
  assert.match(h.wrapper.text(), /Переустановить/u);
  assert.doesNotMatch(h.wrapper.text(), /Привести установки в порядок|Tidy up installations/u);
});

test('Запрет SSH: подтверждение при правке, отказ, общий Apply и один диалог', async (t) => {
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    entityId: 'fixture',
    prepare({ providers, control }) {
      providers.providers[0].settings = [{
        id: 'blockDirectSsh',
        kind: 'toggle',
        label: 'Запретить прямой SSH',
        value: true,
        confirm: { off: {
          text: risk,
          label: 'Разрешить прямой SSH',
          danger: true,
        } },
      }];
      control.handlers['/api/providers/fixture/settings'] = ({ body }) =>
        new Response(JSON.stringify({ ok: true, value: body.value }));
    },
  });

  h.settings.selectPage('agents.providers', 'fixture', 'parameters');
  await h.flushPromises();

  const toggle = h.wrapper.get('[aria-label="Запретить прямой SSH"]');

  h.control.answer = false;
  await toggle.setValue(false);
  assert.equal(h.settings.snapshot.dirtyCount, 0);
  assert.equal(h.writes().length, 0);
  assert.equal(h.control.confirms[0][0], risk);
  h.control.answer = true;
  await toggle.setValue(false);
  assert.equal(h.writes().length, 0);
  assert.equal(h.settings.snapshot.dirtyCount, 1);
  await h.settings.apply();
  assert.equal(h.writes().length, 1);
  assert.equal(h.writes()[0].body.value, false);
  assert.equal(h.writes()[0].body.confirmed, true);
  await toggle.setValue(true);
  assert.equal(h.control.confirms.length, 2);
});

/**
 * UI получает декларацию настоящего адаптера, а не придуманную тестом ручку.
 * Сеть сохраняет подтверждённое значение и умеет отказать один раз для проверки retry.
 */
async function codexHostSettings(t, locale, failOnce = false) {
  const fields = await resolveProviderSettings(codex, {}, {});
  let saved = false;
  let refusing = failOnce;
  const h = await settingsHarness(t, 'agents.providers', 'ProviderPage', {
    entityId: 'codex',
    prepare({ providers, control }) {
      Object.assign(providers.providers[0], {
        id: 'codex',
        name: 'Codex',
        settings: fields,
      });
      control.handlers['/api/providers/codex/settings'] = ({ body }) => {
        if (refusing) {
          refusing = false;

          return Response.json({
            error: 'settings_failed',
            message: 'Синтетический отказ сохранения',
          },
            { status: 503 });
        }

        saved = body.value;

        return Response.json({
          ok: true,
          settings: fields.map((field) => ({
            ...field,
            value: field.id === 'allowHostAccess' ? saved : field.value,
          })),
        });
      };
    },
  });

  h.module.setUiLocale(locale);
  t.after(() => h.module.setUiLocale('ru'));
  h.settings.selectPage('agents.providers', 'codex', 'parameters');
  await h.flushPromises();

  return {
    ...h,
    fields,
    saved: () => saved,
  };
}

for (const locale of ['ru', 'en']) {
  test(`Codex Host confirm/cancel/Apply/reopen: ${locale}`, async (t) => {
    const h = await codexHostSettings(t, locale);
    const label = translator.t(locale, 'settings.builtinProviders.codex.settings.allowHostAccess.label');
    const toggles = h.wrapper.findAll('input[role="switch"]')
      .filter((item) => item.attributes('aria-label') === label);

    assert.equal(toggles.length, 1, 'AC1: один Codex Host toggle из декларации адаптера');

    const toggle = toggles[0];
    const field = h.fields.find((item) => item.id === 'allowHostAccess');

    assert.equal(toggle.element.checked, false);
    h.control.answer = false;
    await toggle.setValue(true);
    await h.flushPromises();
    assert.equal(h.settings.snapshot.dirtyCount, 0);
    assert.equal(h.writes().length, 0);
    assert.equal(toggle.element.checked, false);
    assert.equal(h.control.confirms.length, 1);

    const riskText = resolveLocaleText(h.control.confirms[0][0], locale);

    assert.ok(riskText.length > 50);
    assert.match(riskText, locale === 'ru' ? /песочниц|файлов|сетев/iu : /sandbox|filesystem|network/iu);
    assert.match(riskText, /sudo/iu);
    assert.ok(field.confirm?.on?.text);
    h.control.answer = true;
    await toggle.setValue(true);
    assert.equal(h.settings.snapshot.dirtyCount, 1);
    assert.equal(h.writes().length, 0);
    await h.settings.apply();
    await h.flushPromises();
    assert.equal(h.writes().length, 1);
    assert.deepEqual(h.writes()[0].body, {
      settingId: 'allowHostAccess',
      value: true,
      confirmed: true,
    });
    assert.equal(h.saved(), true);
    assert.equal(h.settings.snapshot.dirtyCount, 0);
    h.settings.selectPage('agents.providers', 'codex', 'overview');
    await h.flushPromises();
    h.settings.selectPage('agents.providers', 'codex', 'parameters');
    await h.flushPromises();
    assert.equal(h.wrapper.get(`input[aria-label='${label}']`).element.checked, true);
    assert.equal(h.control.confirms.length, 2, 'Apply и reopen не спрашивают согласие повторно');
  });
}

test('Codex Host: POST error сохраняет draft и причину, retry использует прежнее согласие', async (t) => {
  const h = await codexHostSettings(t, 'ru', true);
  const label = translator.t('ru', 'settings.builtinProviders.codex.settings.allowHostAccess.label');
  const toggle = h.wrapper.find(`input[aria-label='${label}']`);

  assert.equal(toggle.exists(), true, 'AC1: Codex объявляет Host toggle');
  await toggle.setValue(true);
  await h.settings.apply();
  await h.flushPromises();
  assert.equal(h.saved(), false);
  assert.equal(h.settings.snapshot.dirtyCount, 1);
  assert.match(h.wrapper.text(), /Синтетический отказ сохранения/u);
  assert.equal(toggle.element.checked, true);
  await h.settings.apply();
  await h.flushPromises();
  assert.equal(h.saved(), true);
  assert.equal(h.settings.snapshot.dirtyCount, 0);
  assert.equal(h.writes().length, 2);
  assert.equal(h.control.confirms.length, 1);
});
