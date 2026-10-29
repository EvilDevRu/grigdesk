import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { i18nBrowser } from './i18nBrowser.js';
import {
  atProject, atWorkspace, onboardingFixture, projectInput, repository, request, token,
} from '../../server/helpers/onboardingFixture.js';

export { atProject, atWorkspace, projectInput, repository, request, token };

export const names = {
  next: /^(Далее|Продолжить|Next|Continue)$/,
  skip: /^(Пропустить|Пропустить шаг|Skip|Skip step)$/,
  dismiss: /^(Настрою сам|I.ll set it up myself|Set up manually)$/,
  title: /название проекта|project (name|title)/i,
  path: /папка|путь|folder|path/i,
  branch: /ветка|branch/i,
  add: /добавить (папку|репозиторий)|add (folder|repository)/i,
  manual: /мастер|wizard/i,
};

/**
 * До появления страницы ошибка указывает на отсутствующую функцию продукта.
 * Проверки самой страницы после BUILD используют настоящий App, UI и router.
 */
export function requireWizard() {
  assert.ok(existsSync(new URL('../../../web/src/views/OnboardingView.vue', import.meta.url)),
    'Нет страницы мастера первого запуска');
}

/**
 * Каждый браузер получает настоящие onboarding и ProjectsService в своей папке данных.
 * Остальные API обслуживает прежняя изолированная фикстура интерфейса без данных владельца.
 */
export async function wizardBrowser(t, options = {}) {
  const cleanups = [];
  const lifetime = {
    after: (cleanup) => cleanups.unshift(cleanup),
  };

  // Ресурсы освобождаются в обратном порядке: сначала context и их запросы, затем сервер.
  // Ошибка одного disposer не оставляет остальные браузеры и временные папки живыми.
  t.after(async () => {
    const errors = [];

    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length) {
      throw new AggregateError(errors, 'Не удалось закрыть фикстуру мастера');
    }
  });

  const backend = await onboardingFixture(lifetime);
  const { browser, origin } = await i18nBrowser(lifetime, {
    ...(options.shell === undefined ? {} : { shell: options.shell }),
    responses: {
      '/api/providers/installations/current': {
        revision: 0,
        active: null,
        recent: {},
        blockedReason: null,
      },
      ...(options.providers === undefined ? {} : {
        '/api/providers': { providers: options.providers, models: [] },
      }),
    },
  });
  const pages = [];
  const calls = [];
  const controls = { intercept: null, onboardingGet: null };
  let emitted = 0;

  /**
   * События берутся у настоящего сервиса и проходят общий список EVENT_NAMES приложения.
   * Фикстура не вызывает обработчик стора и не подменяет результат onboarding JSON.
   */
  async function publish() {
    const events = backend.events.slice(emitted);

    emitted = backend.events.length;

    for (const page of pages) {
      if (page.isClosed()) {
        continue;
      }

      await page.evaluate((events) => {
        for (const { event, data } of events) {
          for (const source of window.__onboardingSources || []) {
            if (source.readyState === 1) {
              source.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) }));
            }
          }
        }
      }, events).catch(() => {});
    }
  }

  /**
   * Независимые context не разделяют storage или Pinia, только серверное состояние.
   * Перехватчик умеет задержать ACK и вернуть ошибку для проверки очереди autosave.
   */
  async function newPage(pageOptions = {}) {
    const locale = pageOptions.locale || 'ru';
    const context = await browser.newContext({
      viewport: pageOptions.viewport || { width: 1280, height: 800 },
      locale: locale === 'ru' ? 'ru-RU' : 'en-US',
      ...(pageOptions.touch ? { hasTouch: true, isMobile: true } : {}),
      ...(options.shell ? { userAgent: 'Fixture GrigDeskSettings/1 GrigDeskWindow/main' } : {}),
      ...(pageOptions.surface ? { userAgent: 'Fixture GrigDeskSettings/1 GrigDeskWindow/surface' } : {}),
    });
    const pending = new Set();
    let closing = false;

    lifetime.after(async () => {
      closing = true;
      await Promise.all([...pending]);
      await context.close();
    });
    await context.addInitScript(({ locale }) => {
      localStorage.setItem('grigdesk-ui-language', locale);
      window.__onboardingSources = [];
      window.EventSource = class extends EventTarget {
        static OPEN = 1;
        readyState = 1;

        constructor(url) {
          super();
          this.url = url;
          window.__onboardingSources.push(this);
          setTimeout(() => {
            this.onopen?.(new Event('open'));
            this.dispatchEvent(new MessageEvent('hello', { data: '{"boot":"onboarding-fixture"}' }));
          }, 0);
        }

        close() {
          this.readyState = 2;
        }
      };
    }, { locale });
    /**
     * Запрос целиком включает inject и доставку ответа, а не только чтение Fastify.
     * Cleanup ждёт все начатые обработчики и запрещает новые обращения к backend.
     */
    async function handleApiRoute(route) {
      const req = route.request();
      const url = new URL(req.url());
      const owned = url.pathname.startsWith('/api/onboarding')
        || url.pathname.startsWith('/api/projects') || url.pathname === '/api/profiles'
        || url.pathname.startsWith('/api/documents/');

      if (url.pathname === '/api/auth/state' && options.authenticated === false) {
        await route.fulfill({ json: { authenticated: false, configured: true } });

        return;
      }
      if (!owned) {
        await route.continue();

        return;
      }

      const call = {
        method: req.method(),
        url: url.pathname + url.search,
        body: req.postData() ? req.postDataJSON() : undefined,
      };

      calls.push(call);

      if (url.pathname === '/api/onboarding' && call.method === 'GET' && controls.onboardingGet) {
        await route.fulfill(controls.onboardingGet);

        return;
      }
      if (controls.intercept && await controls.intercept(route, call)) {
        return;
      }

      const response = await backend.app.inject({
        method: call.method,
        url: call.url,
        ...(call.body === undefined ? {} : { payload: call.body }),
      });

      await route.fulfill({
        status: response.statusCode,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        body: response.body,
      });
    }

    await context.route('**/api/**', (route) => {
      if (closing) {
        return route.abort();
      }

      const completion = handleApiRoute(route);

      pending.add(completion);

      return completion.finally(() => pending.delete(completion));
    });

    const page = await context.newPage();

    page.setDefaultTimeout(4000);
    page.setDefaultNavigationTimeout(30000);
    pages.push(page);
    await page.goto(origin + (pageOptions.route || '#/'), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const pinia = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia;
      const shell = pinia?._s.get('shell');

      if (!shell?.initialized) {
        return false;
      }

      // До online App не загружает auth; готовность offline определяется снимком shell.
      // Для браузера и подключённой машины по-прежнему ждём ответ авторизации.
      return (shell.present && shell.status !== 'online') || pinia._s.get('auth')?.ready;
    });
    await page.evaluate(async (surface) => {
      const globals = document.querySelector('#app').__vue_app__.config.globalProperties;
      const shell = globals.$pinia._s.get('shell');
      const auth = globals.$pinia._s.get('auth');
      const connected = !shell.present || (shell.profile && shell.status === 'online');

      // Первый lazy-маршрут должен завершиться до следующего goto с другим hash.
      // Экраны без рабочего подключения и surface не требуют готовности рабочей страницы.
      if (!surface && connected && auth?.authenticated) {
        await globals.$router.isReady();
      }
    }, Boolean(pageOptions.surface));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() =>
      requestAnimationFrame(resolve))));

    return page;
  }

  return {
    ...backend,
    browser,
    origin,
    newPage,
    calls,
    controls,
    publish,
  };
}

/**
 * Ожидание подтверждения читает диск через публичный API, не состояние страницы.
 * Последующая перезагрузка тем самым проверяет именно серверное сохранение.
 */
export async function waitState(fixture, accept) {
  const deadline = Date.now() + 5000;

  do {
    const state = await request(fixture.app);

    if (accept(state)) {
      return state;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);

  assert.fail('Сервер не подтвердил ожидаемое состояние мастера');
}

/**
 * Форма заполняется доступными пользователю полями настоящих UI-примитивов.
 * Папки принадлежат временному серверу, а ветки проверяет его настоящий Git.
 */
export async function fillProject(page, directories, title = 'Проект из мастера') {
  await page.getByRole('textbox', { name: names.title }).fill(title);

  for (let index = 0; index < directories.length; index += 1) {
    if (index > 0) {
      await page.getByRole('button', { name: names.add }).click();
    }

    const input = page.getByRole('textbox', { name: names.path }).nth(index);

    await input.fill(directories[index]);
    await input.blur();

    const branch = page.getByRole('combobox', { name: names.branch }).nth(index);

    await branch.waitFor();
    await page.waitForFunction((select) => select.value === 'main'
      && [...select.options].some((option) => option.value === 'main'), await branch.elementHandle());
  }
}

/**
 * Геометрия измеряется Chromium, где размеры существуют в отличие от happy-dom.
 * Проверка ограничена страницей мастера и её видимыми действиями.
 */
export async function assertGeometry(page, touch = false) {
  const result = await page.evaluate(() => {
    const current = document.querySelector('[aria-current="step"]');
    const root = current?.closest('main') || document.querySelector('main');
    const bounds = (root || document.documentElement).getBoundingClientRect();
    const visible = [...(root || document).querySelectorAll('button')]
      .filter((item) => item.getBoundingClientRect().width > 0);

    return {
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      clipped: visible.some((button) => {
        const rect = button.getBoundingClientRect();

        return rect.left < Math.max(0, bounds.left) - 1
          || rect.right > Math.min(innerWidth, bounds.right) + 1;
      }),
      short: visible.filter((button) => button.getBoundingClientRect().height < 43).length,
    };
  });

  assert.equal(result.overflow, false, 'Нет горизонтального переполнения');
  assert.equal(result.clipped, false, 'Действия не обрезаны');

  if (touch) {
    assert.equal(result.short, 0, 'Сенсорные действия имеют высоту не меньше 44px');
  }
}

/**
 * Увеличенный текст применяется один раз к каждому элементу, включая новые шаги.
 * Наблюдатель не меняет размеры площадок controls и не умножает шрифт при повторном рендере.
 */
export async function scaleWizardText(page, factor) {
  await page.evaluate((factor) => {
    const scaled = new WeakSet();
    const root = document.querySelector('.shell .content');
    /**
     * Новые текстовые узлы измеряются до общей записи размеров.
     * Уже увеличенные элементы остаются неизменными при смене шага.
     */
    const update = () => {
      const pending = [...root.querySelectorAll('*')].filter((element) => !scaled.has(element)
        && !(element instanceof SVGElement) && ([...element.childNodes].some((node) =>
          node.nodeType === Node.TEXT_NODE && node.textContent.trim())
          || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)));
      const sizes = pending.map((element) => {
        const style = getComputedStyle(element);

        return {
          element,
          font: parseFloat(style.fontSize),
          line: parseFloat(style.lineHeight),
        };
      });

      for (const { element, font, line } of sizes) {
        scaled.add(element);
        element.style.fontSize = `${font * factor}px`;

        if (Number.isFinite(line)) {
          element.style.lineHeight = `${line * factor}px`;
        }
      }
    };
    const observer = new MutationObserver(update);

    update();
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }, factor);
}
