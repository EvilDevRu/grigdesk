// Отсоединённый исполнитель заданий раздела «Презентации».
//
// Живёт отдельным процессом по трём причинам, выясненным в заходе 0: запись
// переживает перезапуск кокпита; смерть браузера не должна ронять сервер; сеть
// ограничивается на ЗАПУСКЕ процесса браузера, а не правилами внутри сервера.
//
// Пишет только свои файлы: журнал попытки и её результат. Актуальные ссылки ролика
// публикует сервер, сверив хеши входов, — иначе поздний отчёт старой попытки
// заменил бы собой свежий результат.
//
// Вход — путь к файлу задания. Аргументов с адресами, ключами и селекторами нет:
// всё, что нужно, сервер положил в снимок, и worker его не расширяет.
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { createAttemptLog } from '../src/lib/showcase/attemptLog.ts';

import { startEgressGuard } from '../src/lib/showcase/browserPolicy.ts';
import { checkSceneClip } from '../src/lib/showcase/render/clipCheck.ts';
import { launchBrowser, recordScene } from '../src/lib/showcase/render/recorder.ts';
import type { ScreenMap } from '../src/lib/showcase/render/recorder.ts';
import type { RenderStyle } from '../src/lib/showcase/artifacts.ts';
import type { Browser } from 'playwright-core';
import type { ShowcaseScene } from '../../shared/showcaseContracts.ts';

interface WorkerTask {
  jobId: string;
  attemptId: string;
  projectId: string;
  baseUrl: string;
  allowedOrigins: string[];
  browserPath: string;
  style: RenderStyle;
  workDir: string;
  deadlineMs: number;
  scenes: {
    scene: ShowcaseScene;
    screen: ScreenMap;
  }[];
}

interface SceneOutcome {
  sceneId: string;
  attempts: number;
  rawPath: string;
  readyOffsetMs: number;
  recordedMs: number;
  durationMs: number;
  blockedRequests: number;
}

const MAX_SCENE_ATTEMPTS = 3;

const taskFile = process.argv[2];

if (!taskFile) {
  console.error('showcaseWorker: не передан файл задания');
  process.exit(2);
}

const task = JSON.parse(await readFile(taskFile, 'utf8')) as WorkerTask;
const { finish, report } = createAttemptLog(task);

async function main(): Promise<void> {
  await mkdir(task.workDir, { recursive: true });
  await report('running', 'готовим запись');

  // Ограничитель сети поднимается ДО браузера и живёт ровно столько же: разрешены
  // только объявленные адреса цели, всё остальное отклоняется на соединении.
  const guard = await startEgressGuard({
    allowedOrigins: task.allowedOrigins,
    allowedMethods: ['GET', 'HEAD'],
  });

  let browser: Browser | null = null;
  const scenes: SceneOutcome[] = [];

  const launch = async () => launchBrowser({
    executablePath: task.browserPath,
    proxyPort: guard.port,
  });

  try {
    browser = await launch();

    for (const [index, item] of task.scenes.entries()) {
      await report('running', `пишем сцену «${item.scene.title || item.scene.id}»`, {
        index: index + 1,
        total: task.scenes.length,
      });

      let attempts = 0;
      let outcome: SceneOutcome | null = null;
      let lastReason = '';

      while (attempts < MAX_SCENE_ATTEMPTS && !outcome) {
        attempts += 1;

        try {
          const recorded = await recordScene({
            browser,
            scene: item.scene,
            screen: item.screen,
            baseUrl: task.baseUrl,
            allowedOrigins: task.allowedOrigins,
            outDir: task.workDir,
            style: task.style,
            loginState: null,
            deadlineMs: task.deadlineMs,
          });
          const check = await checkSceneClip(recorded.rawPath);

          if (check.ok) {
            outcome = {
              sceneId: item.scene.id,
              attempts,
              rawPath: recorded.rawPath,
              readyOffsetMs: recorded.readyOffsetMs,
              recordedMs: recorded.recordedMs,
              durationMs: check.durationMs,
              blockedRequests: recorded.blockedRequests.length,
            };

            break;
          }

          lastReason = check.reason;
        } catch (error) {
          lastReason = error instanceof Error ? error.message : String(error);

          // Сорванная сцена — повод поднять браузер заново: после смерти его
          // процесса прежний экземпляр отвечать не начнёт, и следующая попытка
          // на нём просто повторит ожидание до срока.
          await browser?.close().catch(() => null);
          browser = await launch();
        }

        if (!outcome) {
          await report('running', `повтор сцены: ${lastReason}`, { attempt: attempts });
        }
      }

      if (!outcome) {
        throw new Error(`сцена «${item.scene.id}» не записалась: ${lastReason}`);
      }

      scenes.push(outcome);
    }

    await report('succeeded', 'запись завершена');
    await finish({
      attemptId: task.attemptId,
      state: 'succeeded',
      scenes,
      blockedByGuard: guard.blocked.length,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await report('failed', message);
    await finish({
      attemptId: task.attemptId,
      state: 'failed',
      error: message,
      scenes,
      blockedByGuard: guard.blocked.length,
      finishedAt: new Date().toISOString(),
    });
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => null);
    await guard.close();
  }
}

await main();
