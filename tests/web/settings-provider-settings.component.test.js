import assert from 'node:assert/strict';
import test from 'node:test';
import { settingsHarness } from './helpers/settings-harness.js';

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
