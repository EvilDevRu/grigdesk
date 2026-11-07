import { i18nBrowser } from './i18nBrowser.js';
import { browserDiagnostics } from './browserDiagnostics.js';

/**
 * Прежние source-контракты читают русское представление настоящего каркаса.
 * Сеть целиком синтетическая; язык системы задан явно, данные владельца не используются.
 */
export async function shellContractBrowser(t) {
  const usage = {
    state: 'ok',
    bars: [{
      key: 'week',
      label: 'Неделя',
      pct: 42,
    }],
  };
  const provider = {
    id: 'claude',
    name: 'Тестовый CLI',
    vendor: 'Fixture',
    type: 'universal',
    kind: 'cli',
    available: false,
    installed: true,
    chatEnabled: true,
    models: [],
    settings: [],
    credentials: [],
  };
  const { browser, origin } = await i18nBrowser(t, {
    responses: {
      '/api/providers': { providers: [provider], models: [] },
      '/api/providers/usage': { usage: { claude: usage } },
    },
  });
  const context = await browser.newContext({ locale: 'ru-RU' });

  t.after(() => context.close());

  const page = await context.newPage();
  const diagnose = browserDiagnostics(page, 'app-shell-controls');

  await diagnose(async () => {
    await page.goto(origin + '#/chats');
    await page.getByRole('button', { name: 'Настройки', exact: true }).waitFor();
  });

  return {
    page,
    diagnose,
    async openProvider() {
      await page.locator('[data-context="provider-status"]').click();
      await page.locator('.ptip-name').waitFor();
    },
    async setUsage(value) {
      await page.evaluate((snapshot) => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;

        pinia._s.get('providers').applyUsage({ claude: snapshot });
      }, value);
    },
  };
}
