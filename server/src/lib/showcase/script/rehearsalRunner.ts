// Сервер ждёт отчёт отсоединённого браузера. Селекторы, учётка и аренда стенда
// приходят из серверного каталога; ответ модели не участвует в их разрешении.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { setTimeout as pause } from 'node:timers/promises';

import { ShowcaseError } from '../errors.ts';
import { RENDER_STYLE } from '../formats.ts';
import { launchWorker, stopWorker } from '../render/runner.ts';
import { processAlive } from '../processIdentity.ts';
import type { ShowcaseTargets, ShowcaseResolvedScope } from '../targets.ts';
import type { DraftScript } from './writer.ts';
import type { RehearsalResult } from './rehearsal.ts';

/** Один полный проход с конечным сроком; неудачный проход сохраняет свои наблюдения. */
export async function launchRehearsal(input: {
  scope: ShowcaseResolvedScope;
  targets: ShowcaseTargets;
  browserPath: string;
  workDir: string;
  inheritedFds?: number[];
  draft: DraftScript;
  previous: RehearsalResult | null;
}): Promise<RehearsalResult> {
  const { scope } = input;
  const credentials = scope.login ? await input.targets.loginCredentialsOf(scope) : null;

  if (scope.login && !credentials) {
    throw new ShowcaseError(
      'login_credentials_missing',
      'Учётка входа для проверки сценария не найдена.',
      409,
    );
  }

  const handle = await launchWorker({
    workDir: input.workDir,
    inheritedFds: input.inheritedFds,
    helper: 'showcase-rehearsal',
    task: {
      baseUrl: scope.recordUrl,
      allowedOrigins: scope.allowedOrigins,
      allowedMethods: scope.allowedMethods,
      browserPath: input.browserPath,
      style: RENDER_STYLE,
      login: scope.login && credentials ? { ...scope.login, ...credentials } : null,
      screens: input.previous?.screens ?? scope.screens,
      scenes: input.draft.scenes,
    },
  });
  const deadline = Date.now() + 11 * 60 * 1000;

  try {
    while (Date.now() < deadline) {
      const result = await readFile(path.join(handle.workDir, 'result.json'), 'utf8')
        .then((text) => JSON.parse(text) as RehearsalResult & {
          state: string;
          error?: string;
        })
        .catch(() => null);

      if (result?.state === 'succeeded') {
        const finals = [...new Set(result.observations.map((step) => step.sceneIndex))]
          .map((index) => result.observations.filter((step) => step.sceneIndex === index).at(-1))
          .filter((step) => step !== undefined);
        const selected = [...finals, ...result.observations.filter((step) => {
          const action = input.draft.scenes[step.sceneIndex]?.actions[step.actionIndex];

          return ['click', 'hover'].includes(action?.kind ?? '') && !finals.includes(step);
        })].slice(0, 20);
        const frames: NonNullable<RehearsalResult['frames']> = [];

        for (const step of selected) {
          const base = path.join(handle.workDir, `scene-${step.sceneIndex}-action-${step.actionIndex}`);

          // Сжатый WebP — основной кадр; JPEG остаётся, когда сжать было нечем.
          for (const [extension, mediaType] of [['webp', 'image/webp'], ['jpg', 'image/jpeg']] as const) {
            const bytes = await readFile(`${base}.${extension}`).catch(() => null);

            if (bytes) {
              frames.push({
                sceneIndex: step.sceneIndex,
                actionIndex: step.actionIndex,
                mediaType,
                data: bytes.toString('base64'),
              });

              break;
            }
          }
        }

        return {
          screens: result.screens,
          observations: result.observations,
          completed: result.completed,
          frames,
        };
      }

      if (result?.state === 'failed' || !processAlive(handle.identity)) {
        throw new ShowcaseError('rehearsal_failed', result?.error ?? 'Проверка сценария прервалась.', 502);
      }

      await pause(300);
    }

    throw new ShowcaseError('rehearsal_timeout', 'Проверка сценария превысила отведённое время.', 504);
  } finally {
    if (processAlive(handle.identity)) {
      stopWorker(handle.identity);
    }
  }
}
