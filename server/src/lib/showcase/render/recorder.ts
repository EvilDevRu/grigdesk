// Запись сцены браузером.
//
// Одна сцена — один контекст со своим видео и своим начальным состоянием: сцена,
// требующая результата предыдущей, контракта первого выпуска не проходит.
//
// Что доказал заход 0 и что из этого следует здесь:
//  • изоляцию сети даёт внешний прокси, а перехват запросов — только второй слой
//    правил: запросы мимо страницы он не видит;
//  • выполненное условие готовности НЕ означает отрисованный кадр, поэтому после
//    него снимается кадр — он заставляет браузер свести картинку;
//  • браузер умеет умереть молча, оставив ожидание без конца, поэтому у сцены есть
//    свой срок, а у снимка кадра — свой;
//  • выполненное условие готовности означает собравшийся каркас, а не пришедшие
//    данные: вторая волна запросов стартует после него, и без ожидания её конца
//    в клип попадает пустая таблица со спиннером — при здоровом стенде.
import type { Browser, Page } from 'playwright-core';

import type { ShowcaseAction, ShowcaseScene } from '../../../../../shared/showcaseContracts.ts';
import { ShowcaseError } from '../errors.ts';
import { browserLaunchArgs } from '../browserPolicy.ts';
import { DEFAULT_QUIET, trackNetwork } from './networkQuiet.ts';
import type { RenderStyle } from '../artifacts.ts';

// Накладка курсора — доверенный код recorder-а. Она не приходит от модели, ничего
// не кликает и события не перехватывает: указатель нарисован поверх страницы.
const CURSOR_OVERLAY = `
  (() => {
    const dot = document.createElement('div');
    dot.id = '__showcase_cursor';
    dot.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'width:22px', 'height:22px',
      'margin:-11px 0 0 -11px', 'border-radius:50%', 'pointer-events:none',
      'background:rgba(59,130,246,.35)', 'border:2px solid #3b82f6',
      'transition:left .18s ease, top .18s ease', 'left:-50px', 'top:-50px',
    ].join(';');
    document.documentElement.appendChild(dot);
    window.__showcaseCursorTo = (x, y) => { dot.style.left = x + 'px'; dot.style.top = y + 'px'; };
  })();
`;

// Пауза между готовностью и первым действием. Зритель должен увидеть исходное
// состояние экрана, а речь — начаться раньше клика (пре-ролл сборки 400 мс);
// заодно пауза перекрывает разброс между часами исполнителя и началом видео,
// из-за которого срез клипа мог попасть на уже выполненное действие.
const ACTION_LEAD_MS = 600;

export interface ScreenMap {
  id: string;
  path: string;
  readySelector: string;
  elements: { id: string; selector: string }[];
}

export interface RecordSceneInput {
  browser: Browser;
  scene: ShowcaseScene;
  screen: ScreenMap;
  baseUrl: string;
  allowedOrigins: string[];
  // Методы к разрешённым адресам. Без объявления — только чтение: страница,
  // которая читает данные POST-ом, объявляет это в цели, а не получает молча.
  allowedMethods?: string[];
  outDir: string;
  style: RenderStyle;
  loginState: NonNullable<Parameters<Browser['newContext']>[0]>['storageState'] | null;
  deadlineMs?: number;
  actionTimeoutMs?: number;
  readyTimeoutMs?: number;
  // Затишье сети после готовности и после действий: сколько подряд сеть должна
  // молчать и сколько ждать самое большее. По умолчанию секунда и десять секунд.
  settleQuietMs?: number;
  settleCapMs?: number;
}

export interface RecordSceneResult {
  rawPath: string;
  // Смещение готовности от начала записи: до него в клипе загрузка страницы, и
  // исполнитель эту часть срезает.
  readyOffsetMs: number;
  recordedMs: number;
  blockedRequests: { url: string; method: string }[];
  // Сколько ожиданий затишья упёрлось в предел: у спокойного стенда ноль.
  unsettled: number;
}

/**
 * Ограничение по времени на всю сцену. Без него зависание не имеет конца: в опытном
 * прогоне браузер умер молча, и ожидание ответа продолжалось, пока его не сняли
 * руками. Ждущий исполнитель снаружи выглядит как идущая работа.
 */
async function withDeadline<Value>(promise: Promise<Value>, ms: number, what: string): Promise<Value> {
  let timer: NodeJS.Timeout | null = null;
  const guard = new Promise<never>((resolve, reject) => {
    timer = setTimeout(
      () => reject(new ShowcaseError('scene_timeout', `${what}: не уложились в ${ms} мс.`, 504)),
      ms,
    );
  });

  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Селектор действия берётся из КАРТЫ ЭКРАНОВ профиля по идентификатору элемента.
 * Модель называет идентификатор, но не передаёт селектор: иначе она могла бы
 * указать на любой элемент страницы, включая тот, которого нет в объявлении.
 */
function selectorOf(screen: ScreenMap, targetId: string): string {
  const element = screen.elements.find((item) => item.id === targetId);

  if (!element) {
    throw new ShowcaseError(
      'unknown_target',
      `Экран «${screen.id}» не объявлял элемент «${targetId}».`,
      400,
    );
  }

  return element.selector;
}

async function runAction(
  page: Page,
  screen: ScreenMap,
  action: ShowcaseAction,
  timeoutMs: number,
): Promise<void> {
  if (action.kind === 'wait') {
    await page.waitForTimeout(Math.min(action.ms, timeoutMs));

    return;
  }

  if (action.kind === 'scroll') {
    await page.mouse.wheel(0, action.delta);

    return;
  }

  if (action.kind === 'waitVisible') {
    await page.locator(selectorOf(screen, action.targetId)).first()
      .waitFor({ state: 'visible', timeout: timeoutMs });

    return;
  }

  if (action.kind === 'hover' || action.kind === 'highlight') {
    const box = await page.locator(selectorOf(screen, action.targetId)).first().boundingBox();

    if (!box) {
      throw new ShowcaseError(
        'target_missing',
        `Цель действия «${action.targetId}» не видна на экране.`,
        409,
      );
    }

    await page.evaluate(
      // Накладка живёт в странице: вызов идёт по имени, объявленному recorder-ом.
      '([x, y]) => window.__showcaseCursorTo && window.__showcaseCursorTo(x, y)',
      [box.x + box.width / 2, box.y + box.height / 2],
    );

    return;
  }

  if (action.kind === 'click') {
    await page.locator(selectorOf(screen, action.targetId)).first().click({ timeout: timeoutMs });

    return;
  }

  // Неизвестная семантика действия прерывает сцену. Догадка «наверное, это клик»
  // здесь означала бы клик по чужому элементу на чужом экране.
  throw new ShowcaseError('unknown_action', `Действие «${action.kind}» не поддерживается.`, 400);
}

/**
 * Записывает одну сцену. Контекст закрывается ДО чтения файла: браузер дописывает
 * видео именно при закрытии, и обращение к пути раньше даёт обрезанный файл.
 */
export async function recordScene(input: RecordSceneInput): Promise<RecordSceneResult> {
  return withDeadline(
    recordSceneOnce(input),
    input.deadlineMs ?? 90_000,
    `сцена «${input.scene.title || input.scene.id}»`,
  );
}

async function recordSceneOnce(input: RecordSceneInput): Promise<RecordSceneResult> {
  const actionTimeoutMs = input.actionTimeoutMs ?? 15_000;
  const readyTimeoutMs = input.readyTimeoutMs ?? 30_000;
  const blockedRequests: { url: string; method: string }[] = [];
  const context = await input.browser.newContext({
    viewport: { width: input.style.width, height: input.style.height },
    recordVideo: {
      dir: input.outDir,
      size: { width: input.style.width, height: input.style.height },
    },
    serviceWorkers: 'block',
    locale: input.style.locale,
    colorScheme: input.style.theme === 'light' ? 'light' : 'dark',
    storageState: input.loginState ?? undefined,
  });

  const allowedMethods = input.allowedMethods ?? ['GET', 'HEAD'];

  await context.route('**/*', async (route, request) => {
    const origin = new URL(request.url()).origin;
    const method = request.method();
    // OPTIONS — preflight, вопрос браузера перед cross-origin запросом, а не
    // действие страницы: сам запрос всё равно проверяется своим методом.
    const permitted = allowedMethods.includes(method) || method === 'OPTIONS';

    if (!input.allowedOrigins.includes(origin) || !permitted) {
      blockedRequests.push({ url: request.url(), method });
      await route.abort('blockedbyclient');

      return;
    }

    await route.continue();
  });

  await context.addInitScript(CURSOR_OVERLAY);

  // Отсчёт идёт ДО создания страницы: видео контекста начинается вместе с ней, и
  // смещение готовности, посчитанное от более поздней точки, срезало бы клип
  // раньше самой готовности.
  const startedAt = Date.now();
  const page = await context.newPage();
  const network = trackNetwork(page);
  const settle = {
    quietMs: input.settleQuietMs ?? DEFAULT_QUIET.quietMs,
    capMs: input.settleCapMs ?? DEFAULT_QUIET.capMs,
  };
  let unsettled = 0;

  try {
    const startUrl = new URL(input.screen.path, input.baseUrl).toString();
    const response = await page.goto(startUrl, { waitUntil: 'commit', timeout: readyTimeoutMs });

    if (!response || !response.ok()) {
      throw new ShowcaseError(
        'screen_unavailable',
        `Экран «${input.screen.id}» не открылся: код ${response?.status() ?? '—'}.`,
        502,
      );
    }

    // Готовность — явное условие сцены с ограниченным ожиданием. Общего ожидания
    // тишины Playwright нет намеренно: стенд с SSE или polling до неё не доходит
    // никогда; вместо неё ниже ограниченное затишье по молодым запросам.
    const readySelector = input.scene.readyCondition || input.screen.readySelector;

    await page.locator(readySelector).first().waitFor({ state: 'visible', timeout: readyTimeoutMs });

    // Готовность — это собравшийся каркас; данные приходят второй волной запросов.
    // Её конец ждётся ограниченно: недождавшееся затишье сцену не срывает.
    if (!(await network.quiet(settle))) {
      unsettled += 1;
    }

    // Снимок кадра заставляет браузер свести картинку: без него одна запись из
    // десяти выходила полностью однотонной при выполненном условии готовности.
    // Но это СРЕДСТВО, а не гарантия — сам снимок иногда отказывает протоколом,
    // и ронять из-за него сцену нельзя. Гарантией остаётся проверка готового
    // клипа: она ловит пустую запись независимо от того, удался ли снимок.
    await page
      .screenshot({ type: 'jpeg', quality: 20, timeout: actionTimeoutMs })
      .catch(() => null);

    const readyAt = Date.now();

    await page.waitForTimeout(ACTION_LEAD_MS);

    for (const action of [...input.scene.actions].filter((item) => item.kind !== 'goto')) {
      await runAction(page, input.screen, action, actionTimeoutMs);
    }

    // Действия сами вызывают запросы — фильтр перестраивает таблицу, — и последний
    // кадр обязан показывать их результат, а не спиннер.
    if (!(await network.quiet(settle))) {
      unsettled += 1;
    }

    const finishedAt = Date.now();
    const video = page.video();

    if (!video) {
      throw new ShowcaseError('record_failed', 'Браузер не завёл запись сцены.', 500);
    }

    network.dispose();
    await context.close();

    return {
      rawPath: await video.path(),
      readyOffsetMs: readyAt - startedAt,
      recordedMs: finishedAt - startedAt,
      blockedRequests,
      unsettled,
    };
  } catch (error) {
    network.dispose();
    await context.close().catch(() => null);

    throw error;
  }
}

export type StorageState = NonNullable<Parameters<Browser['newContext']>[0]>['storageState'];

export interface LoginRecipe {
  url: string;
  userSelector: string;
  passwordSelector: string;
  submitSelector: string;
  readySelector: string;
  user: string;
  password: string;
}

export interface LoginInput {
  browser: Browser;
  baseUrl: string;
  allowedOrigins: string[];
  style: RenderStyle;
  login: LoginRecipe;
  timeoutMs?: number;
}

/**
 * Вход на стенд тестовой учёткой. Идёт в своём контексте и заканчивается снимком
 * состояния (cookie и localStorage): сцены потом открываются уже вошедшими, а сам
 * пароль в их контексты не попадает.
 *
 * Это единственное место, где странице разрешён не-GET запрос — форма входа
 * отправляется POST. Назначение по-прежнему только объявленные origins.
 */
export async function loginToStand(input: LoginInput): Promise<StorageState> {
  const timeoutMs = input.timeoutMs ?? 45_000;
  const context = await input.browser.newContext({
    viewport: { width: input.style.width, height: input.style.height },
    serviceWorkers: 'block',
    locale: input.style.locale,
    colorScheme: input.style.theme === 'light' ? 'light' : 'dark',
  });

  await context.route('**/*', async (route, request) => {
    if (!input.allowedOrigins.includes(new URL(request.url()).origin)) {
      await route.abort('blockedbyclient');

      return;
    }

    await route.continue();
  });

  const page = await context.newPage();
  const recipe = input.login;

  try {
    await withDeadline((async () => {
      const url = new URL(recipe.url, input.baseUrl).toString();

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await page.locator(recipe.userSelector).first().fill(recipe.user, { timeout: timeoutMs });
      await page.locator(recipe.passwordSelector).first().fill(recipe.password, { timeout: timeoutMs });
      await page.locator(recipe.submitSelector).first().click({ timeout: timeoutMs });
      await page.locator(recipe.readySelector).first()
        .waitFor({ state: 'visible', timeout: timeoutMs });
    })(), timeoutMs + 5_000, 'вход на стенд');

    return await context.storageState();
  } finally {
    await context.close().catch(() => null);
  }
}

export interface LaunchInput {
  executablePath: string;
  proxyPort: number;
}

/**
 * Запуск браузера с ограничением сети. Модуль Playwright подгружается динамически:
 * раздел обязан собираться и отвечать доктором там, где браузер не установлен, а
 * статический импорт уронил бы весь сервер на старте.
 */
export async function launchBrowser(input: LaunchInput): Promise<Browser> {
  let playwright: typeof import('playwright-core');

  try {
    playwright = await import('playwright-core');
  } catch {
    throw new ShowcaseError(
      'browser_missing',
      'Библиотека браузера записи не установлена.',
      503,
    );
  }

  return playwright.chromium.launch({
    executablePath: input.executablePath,
    args: browserLaunchArgs(input.proxyPort),
  });
}
