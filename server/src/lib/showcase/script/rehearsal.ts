// Пробное исполнение сценария: настоящий интерфейс и те же действия recorder-а,
// без озвучки и публикации клипов. Неудача сохраняется вместе с тем, что было видно.
import { execFile } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { RenderStyle } from '../artifacts.ts';
import type { StorageState, ScreenMap } from '../render/recorder.ts';
import { runAction } from '../render/recorder.ts';
import { trackNetwork } from '../render/networkQuiet.ts';
import {
  actionTarget, currentScreen, observeScreen, pagePathOf, resolvableElements, screenFromPageId,
} from './observation.ts';
import type { ScreenObservation } from './observation.ts';
import type { DraftScene } from './writer.ts';

const run = promisify(execFile);

// Кадр для модели: не шире 1600 px и в WebP. Полный JPEG 1080p занимал ~115 КБ,
// а в base64 — ~150 КБ; двадцать таких кадров вместе с наблюдениями превышали
// предел одной строки stream-json Claude CLI (1 МиБ), и проверка падала на
// последнем проходе с «Input exceeds the maximum length». 1600 px в WebP — около
// 60 КБ, при этом «[!W]», значки и галочки в кадре читаются.
const FRAME_MAX_WIDTH = 1600;
const FRAME_WEBP_QUALITY = 70;

// Срок условия готовности экрана — тот же, что у записи.
const READY_TIMEOUT_MS = 30000;

export type RehearsalScreen = ScreenMap & { title: string };

export interface RehearsalResult {
  screens: RehearsalScreen[];
  observations: ScreenObservation[];
  completed: boolean;
  frames?: { sceneIndex: number; actionIndex: number; mediaType: string; data: string }[];
}

export interface RehearsalInput {
  browser: Browser;
  baseUrl: string;
  allowedOrigins: string[];
  allowedMethods: string[];
  screens: RehearsalScreen[];
  scenes: DraftScene[];
  style: RenderStyle;
  loginState: StorageState | null;
  workDir: string;
  readyTimeoutMs?: number;
}

/**
 * Снимок экрана после действия: полный JPEG сжимается в `<base>.webp`; без ffmpeg
 * остаётся `<base>.jpg` — исполнитель проверки читает то, что есть. Кадр служит
 * доказательством, поэтому неудача снимка сцену не срывает — её срывает только
 * само действие.
 */
async function captureFrame(page: Page, base: string): Promise<void> {
  const full = `${base}.full.jpg`;

  await page.screenshot({ path: full, type: 'jpeg', quality: 60, timeout: 5000 });

  try {
    await run('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', full,
      '-vf', `scale=min(${FRAME_MAX_WIDTH}\\,iw):-2`,
      '-c:v', 'libwebp', '-quality', String(FRAME_WEBP_QUALITY),
      `${base}.webp`,
    ]);
    await rm(full, { force: true });
  } catch {
    await rename(full, `${base}.jpg`).catch(() => null);
  }
}

/**
 * Каждый повтор открывает чистый контекст. После первого автоматически найденного
 * действия разрешены только GET/HEAD: найденная кнопка не получает право POST
 * из прежней карты и не может запустить платную операцию на стенде.
 */
export async function rehearseScript(input: RehearsalInput): Promise<RehearsalResult> {
  const screens = structuredClone(input.screens);
  const observations: ScreenObservation[] = [];
  const scenes = input.scenes.length > 0 ? input.scenes : screens.map((screen) => ({
    screenId: screen.id,
    readyCondition: null,
    continuesPrevious: false,
    actions: [],
  }));
  let context: BrowserContext | null = null;
  let readOnly = false;
  let blocked = 0;
  let page = null as Awaited<ReturnType<BrowserContext['newPage']>> | null;
  let network: ReturnType<typeof trackNetwork> | null = null;
  const quiet = { quietMs: 600, capMs: 8000 };
  const readyTimeoutMs = input.readyTimeoutMs ?? READY_TIMEOUT_MS;
  // Адрес, на котором объявленный экран собрался после перехода по адресу карты.
  const aliases = new Map<string, string>();

  try {
    for (const [sceneIndex, scene] of scenes.entries()) {
      // Экран сцены по объявлению; после действия, сменившего адрес, — тот, что
      // открылся на самом деле: его элементы и наблюдения ложатся туда, где видны.
      // Найденный прежним проходом экран без отчёта восстанавливается из адреса.
      let screen = screens.find((item) => item.id === scene.screenId)
        ?? screenFromPageId<RehearsalScreen>(scene.screenId);

      if (!screen) {
        throw new Error('Сценарий ссылается на неизвестный экран.');
      }

      if (!screens.includes(screen)) {
        screens.push(screen);
      }

      const continued = Boolean(scene.continuesPrevious && context && page);

      // `!page` здесь только сужает тип: продолжение без открытой страницы невозможно.
      if (!continued || !page) {
        network?.dispose();
        await context?.close();
        readOnly = false;
        blocked = 0;
        context = await input.browser.newContext({
          viewport: { width: input.style.width, height: input.style.height },
          locale: input.style.locale,
          colorScheme: input.style.theme === 'light' ? 'light' : 'dark',
          serviceWorkers: 'block',
          storageState: input.loginState ?? undefined,
        });
        await context.route('**/*', async (route, request) => {
          const methods = readOnly ? ['GET', 'HEAD'] : input.allowedMethods;
          const permitted = input.allowedOrigins.includes(new URL(request.url()).origin)
            && (methods.includes(request.method()) || request.method() === 'OPTIONS');

          if (!permitted) {
            // Фоновые картинки вне политики блокировались и при обычной записи.
            // Отказ приёмки здесь относится к новой попытке изменить данные.
            if (readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
              blocked += 1;
            }
            await route.abort('blockedbyclient');

            return;
          }

          await route.continue();
        });
        page = await context.newPage();
        network = trackNetwork(page);
        const response = await page.goto(new URL(screen.path, input.baseUrl).toString(), {
          waitUntil: 'commit',
          timeout: 45000,
        });

        if (!response?.ok()) {
          throw new Error(`Экран «${screen.id}» не открылся: HTTP ${response?.status() ?? '—'}.`);
        }
      }

      // Готовность объявленного экрана. Продолжение экран заново не открывает, и если
      // действия предыдущей сцены увели на страницу, которой в карте нет, каркас
      // объявленного экрана здесь не появится никогда. Это ошибка сценария, а не
      // стенда: она возвращается наблюдением с тем, что видно на самом деле, чтобы
      // модель назвала другой экран или начала сцену заново, а не роняла сборку
      // сырым таймаутом Playwright. У головной сцены та же неудача — стенд или карта,
      // сценарием её не исправить, и проход останавливается с понятной причиной.
      const readyFailure = await page.locator(scene.readyCondition || screen.readySelector).first()
        .waitFor({ state: 'visible', timeout: readyTimeoutMs })
        .then(() => null, (error: unknown) => (error instanceof Error ? error : new Error(String(error))));

      if (readyFailure) {
        const seconds = Math.round(readyTimeoutMs / 1000);
        const frame = path.join(input.workDir, `scene-${sceneIndex}-action--1`);

        if (!continued) {
          // Кадр остаётся человеку: по нему видно, что стенд показал вместо экрана.
          await captureFrame(page, frame).catch(() => null);

          throw readyFailure.name === 'TimeoutError'
            ? new Error(
              `Экран «${screen.id}» не открылся: условие готовности не выполнилось за ${seconds} с — `
              + 'стенд не прогрет или карта экранов отстала от него.',
            )
            : readyFailure;
        }

        const observation = await observeScreen(page, screen, sceneIndex, -1);

        observation.error = `Экран «${screen.id}» не готов через ${seconds} с после предыдущей сцены: `
          + 'её действия увели с этого экрана. Назови в screenId экран, который открылся, '
          + 'или начни сцену заново (continuesPrevious: false) с пути к нужному состоянию.';
        observations.push(observation);
        await captureFrame(page, frame).catch(() => null);

        return { screens, observations, completed: false };
      }

      await network?.quiet(quiet);

      if (!continued) {
        aliases.set(pagePathOf(page.url()), screen.id);
      }

      screen = await currentScreen(page, screens, input.baseUrl, screen, aliases);
      observations.push(await observeScreen(page, screen, sceneIndex, -1));
      await captureFrame(page, path.join(input.workDir, `scene-${sceneIndex}-action--1`));

      if (!scene.continuesPrevious) {
        blocked = 0;
      }

      for (const [actionIndex, action] of scene.actions.entries()) {
        try {
          // Цели — свои по карте и найденные браузером на любом экране: клик, уводящий
          // на другую страницу, и ожидание элемента уже на ней живут в одной сцене.
          const resolvable = { ...screen, elements: resolvableElements(screens, screen) };

          if ('targetId' in action) {
            const element = resolvable.elements.find((item) => item.id === action.targetId);

            if (element?.observed) {
              readOnly = true;
              await actionTarget(page, element);
            }
          }

          if (action.kind !== 'goto') {
            await runAction(page, resolvable, action, actionIndex, 6000, true);
          }

          await page.waitForTimeout(600);
          await network?.quiet(quiet);
          screen = await currentScreen(page, screens, input.baseUrl, screen, aliases);
          const observation = await observeScreen(page, screen, sceneIndex, actionIndex);

          if (blocked > 0) {
            observation.error = 'Действие требует запрещённого запроса; результат не подтверждён.';
          }

          observations.push(observation);
          await captureFrame(page, path.join(input.workDir, `scene-${sceneIndex}-action-${actionIndex}`));

          if (observation.error) {
            return { screens, observations, completed: false };
          }
        } catch (error) {
          const observation = await observeScreen(page, screen, sceneIndex, actionIndex);

          observation.error = error instanceof Error
            ? error.message.slice(0, 600)
            : 'Действие не выполнилось.';
          observations.push(observation);

          return { screens, observations, completed: false };
        }
      }
    }

    return { screens, observations, completed: true };
  } finally {
    network?.dispose();
    await context?.close();
  }
}
