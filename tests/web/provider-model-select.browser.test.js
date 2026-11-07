import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import data from './fixtures/settings-modal/data.json' with { type: 'json' };
import { clientBrowser } from './helpers/client-browser.mjs';

/**
 * Недоступный Claude сохраняет кэш, старая Codex-модель остаётся в полном реестре.
 * Настройки получают настоящие непрозрачные GLM id и capability плагина.
 */
function catalog() {
  return [
    {
      id: 'claude',
      name: 'Claude',
      available: false,
      models: [{ id: 'opus', name: 'Opus' }],
    },
    {
      id: 'codex',
      name: 'Codex',
      color: '#10a37f',
      available: true,
      capabilities: { scopedWorkspace: true },
      models: [
        {
          id: 'gpt-current',
          name: 'GPT-6 Astra',
          efforts: ['low', 'high'],
        },
        {
          id: 'gpt-old',
          name: 'Старая модель',
          extra: true,
        },
      ],
    },
    {
      id: 'glm',
      name: 'GLM (Z.ai)',
      color: '#ffffff',
      available: true,
      capabilities: { scopedWorkspace: true },
      models: ['glm-5.3', 'glm-5.2'].map((id) => ({
        id: JSON.stringify(['zai', id]),
        name: id.toUpperCase(),
        efforts: ['low', 'high'],
      })),
    },
  ];
}

test('MODEL-SETTINGS: арбитр и плагин используют общий выбор на desktop и touch', async (t) => {
  const prefs = structuredClone(data.prefs);
  const plugins = structuredClone(data.plugins);
  const reference = { provider: 'codex', model: 'gpt-current' };

  prefs.arbiter.modelRef = reference;
  plugins.plugins[0].enabled = true;
  plugins.plugins[0].values.model = reference;

  const client = await clientBrowser(t, {
    artifacts: path.join(process.env.GRIGDESK_ARTIFACTS_DIR || '/tmp/grigdesk-model-select', 'settings'),
    responses: {
      '/api/settings/prefs': prefs,
      '/api/providers': { providers: catalog() },
      '/api/plugins': plugins,
      '/api/plugin-catalog': { state: 'unconfigured', catalog: null },
      '/api/plugin-installs/jobs/current': { job: null, recoveryError: null },
    },
  });
  const errors = [];

  for (const pageId of ['automation.arbiter', 'plugins.installed']) {
    for (const [width, height, touch] of [[1280, 900, false], [390, 844, true], [320, 568, true]]) {
      const context = await client.browser.newContext({
        viewport: { width, height },
        hasTouch: touch,
        isMobile: touch,
        locale: 'ru-RU',
      });

      try {
        const page = await context.newPage();
        const writes = [];

        page.on('pageerror', (error) => errors.push(error.message));
        page.on('request', (request) => {
          if (request.method() !== 'GET' && /\/api\/(settings\/prefs|plugins\/sample\/settings)$/u
            .test(new URL(request.url()).pathname)) {
            writes.push(request.url());
          }
        });
        await page.addInitScript(() => localStorage.setItem('grigdesk-ui-language', 'ru'));
        await page.goto(client.origin + '#/settings?page=' + pageId);

        if (pageId === 'plugins.installed') {
          await page.locator('[data-plugins-tab="installed"]').click();
        }

        const trigger = page.locator('button[data-provider-model-select]');

        await trigger.waitFor();
        assert.equal(await trigger.innerText(), 'GPT-6 Astra');
        await trigger.click();

        const popup = page.locator('.ui-select-popup');

        await popup.waitFor({ state: 'visible' });
        assert.equal(await popup.getByRole('option').count(), 1);
        assert.equal(await popup.getByRole('button', { name: 'Claude', exact: true }).count(), 0);
        assert.equal(await popup.locator('.ui-select-group-nav svg').count(), 3);
        assert.equal(await popup.getByRole('button', { name: 'Codex', exact: true }).locator('svg')
          .evaluate((node) => getComputedStyle(node).color), 'rgb(16, 163, 127)');

        const bounds = await popup.evaluate((node) => {
          const box = node.getBoundingClientRect();

          return {
            left: box.left,
            right: box.right,
            top: box.top,
            bottom: box.bottom,
            overflow: node.scrollWidth > node.clientWidth + 1,
          };
        });

        assert.equal(bounds.left >= 0 && bounds.right <= width, true);
        assert.equal(bounds.top >= 0 && bounds.bottom <= height, true);
        assert.equal(bounds.overflow, false);
        await popup.screenshot({ path: path.join(client.artifacts, `${pageId}-${width}.png`) });
        await popup.getByRole('button', { name: 'GLM (Z.ai)', exact: true }).click();
        assert.equal(await popup.getByRole('option').count(), 2);
        assert.equal((await popup.innerText()).includes('["zai"'), false);
        await popup.locator('input[type="search"]').fill('GLM-5.2');
        assert.equal(await popup.getByRole('option').count(), 1);
        await popup.getByRole('option', { name: 'GLM-5.2', exact: true }).click();
        await popup.waitFor({ state: 'hidden' });
        assert.equal(await trigger.innerText(), 'GLM-5.2');

        const selected = await trigger.evaluate((button) => {
          return button.closest('.ui-select-wrap').querySelector('select').value;
        });

        assert.deepEqual(JSON.parse(selected), { provider: 'glm', model: '["zai","glm-5.2"]' });
        await trigger.click();
        await popup.locator('[data-select-group="all"]').click();
        assert.equal(await popup.getByRole('option').count(), 4);
        assert.equal((await popup.innerText()).includes('Старая модель'), false);
        await popup.locator('input[type="search"]').fill('Opus');
        assert.equal(await popup.getByRole('option').count(), 0);
        await popup.locator('[data-select-group="all"]').click();
        await popup.locator('[data-option-index="0"]').click();
        await popup.waitFor({ state: 'hidden' });
        assert.equal(await trigger.evaluate((button) => {
          return button.closest('.ui-select-wrap').querySelector('select').value;
        }), '');
        assert.deepEqual(writes, []);
      } finally {
        await context.close();
      }
    }
  }

  assert.deepEqual(errors, []);
});
