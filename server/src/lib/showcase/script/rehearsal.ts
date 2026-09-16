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
import { actionTarget, observeScreen } from './observation.ts';
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

  try {
    for (const [sceneIndex, scene] of scenes.entries()) {
      const screen = screens.find((item) => item.id === scene.screenId);

      if (!screen) {
        throw new Error('Сценарий ссылается на неизвестный экран.');
      }

      if (!scene.continuesPrevious || !context || !page) {
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

      await page.locator(scene.readyCondition || screen.readySelector).first()
        .waitFor({ state: 'visible', timeout: 30000 });
      await network?.quiet(quiet);
      observations.push(await observeScreen(page, screen, sceneIndex, -1));
      await captureFrame(page, path.join(input.workDir, `scene-${sceneIndex}-action--1`));

      if (!scene.continuesPrevious) {
        blocked = 0;
      }

      for (const [actionIndex, action] of scene.actions.entries()) {
        try {
          if ('targetId' in action) {
            const element = screen.elements.find((item) => item.id === action.targetId);

            if (element?.observed) {
              readOnly = true;
              await actionTarget(page, element);
            }
          }

          if (action.kind !== 'goto') {
            await runAction(page, screen, action, actionIndex, 6000, true);
          }

          await page.waitForTimeout(600);
          await network?.quiet(quiet);
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
