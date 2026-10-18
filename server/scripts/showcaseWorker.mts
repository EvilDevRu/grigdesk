// Отсоединённый исполнитель заданий раздела «Презентации».
//
// Живёт отдельным процессом по трём причинам, выясненным в заходе 0: запись
// переживает перезапуск GrigDesk; смерть браузера не должна ронять сервер; сеть
// ограничивается на ЗАПУСКЕ процесса браузера, а не правилами внутри сервера.
//
// Пишет только свои файлы: журнал попытки и её результат. Актуальные ссылки ролика
// публикует сервер, сверив хеши входов, — иначе поздний отчёт старой попытки
// заменил бы собой свежий результат.
//
// Вход — путь к файлу задания. Аргументов с адресами, ключами и селекторами нет:
// всё, что нужно, сервер положил в снимок, и worker его не расширяет.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createAttemptLog } from '../src/lib/showcase/attemptLog.ts';

import { startEgressGuard } from '../src/lib/showcase/browserPolicy.ts';
import { checkSceneClip } from '../src/lib/showcase/render/clipCheck.ts';
import {
  browserMonoToVideoPts,
  calibrateVideoTiming,
  probeVideoFrameSignatures,
  READY_MARGIN_MS,
  stableFrameRunsOf,
  trimSceneClipExact,
  videoContainsCalibrationMarker,
} from '../src/lib/showcase/render/clipTrim.ts';
import type {
  CalibratedVideoTiming,
  ExactTrimResult,
} from '../src/lib/showcase/render/clipTrim.ts';
import { launchBrowser, loginToStand, recordChain } from '../src/lib/showcase/render/recorder.ts';
import type {
  ChainSceneInput,
  LoginRecipe,
  RawHighlightGeometry,
  RecordingActionTimingCandidate,
  RecordingStableIntervalCandidate,
  RecordingTimingCandidate,
  RecordingTimingWorkerCandidate,
  StorageState,
} from '../src/lib/showcase/render/recorder.ts';
import type { RenderStyle } from '../src/lib/showcase/artifacts.ts';
import type { Browser } from 'playwright-core';

interface WorkerTask {
  jobId: string;
  attemptId: string;
  projectId: string;
  baseUrl: string;
  allowedOrigins: string[];
  // Методы, объявленные целью: чтение и, если профиль сказал, POST для сводок.
  allowedMethods?: string[];
  browserPath: string;
  style: RenderStyle;
  workDir: string;
  deadlineMs: number;
  // Вход на стенд: селекторы и учётка. Секрет приходит в файле задания с правами
  // 0600 и стирается из него сразу после чтения — на диске он не задерживается.
  login: LoginRecipe | null;
  // Единица записи — цепочка: голова открывает экран, продолжения застают его
  // таким, каким его оставила предыдущая сцена. Сервер уже собрал цепочки целиком:
  // продолжение без своей головы здесь не бывает.
  chains: ChainSceneInput[][];
}

interface SceneOutcome {
  sceneId: string;
  attempts: number;
  rawPath: string;
  readyOffsetMs: number;
  recordedMs: number;
  durationMs: number;
  blockedRequests: number;
  unsettled: number;
  recordingTiming: RecordingTimingWorkerCandidate;
}

// Попытки считаются на цепочку: продолжение без головы не переснять, поэтому
// негодный клип любой её сцены повторяет запись всей цепочки.
const MAX_CHAIN_ATTEMPTS = 3;

// Вход повторяется один раз и с паузой: первая попытка приходится на холодный стенд
// (dev-сервер собирает страницу, API поднимает соединения), и именно она срывалась,
// а повтор через минуту проходил с первого раза. Повтор без паузы — не повтор.
const MAX_LOGIN_ATTEMPTS = 2;
const LOGIN_RETRY_PAUSE_MS = 3_000;

const EPSILON_MS = 0.01;
// Для hold публикуется только наблюдаемое состояние длиной хотя бы 150 мс: короче
// может оказаться дублем кадра после 25→30 CFR, а не неподвижным экраном.
const MIN_STABLE_MS = 150;

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

interface StableRun {
  fromMs: number;
  toMs: number;
  frameMs: number;
}

/** Серии кадров одного состояния экрана — доказательство, что frame можно держать. */
async function stableRunsOf(file: string, fps: number): Promise<StableRun[]> {
  const frameMs = 1000 / fps;
  const minFrames = Math.ceil((MIN_STABLE_MS - EPSILON_MS) / frameMs);

  return stableFrameRunsOf(await probeVideoFrameSignatures(file), { minFrames }).map((run) => ({
    fromMs: run.fromIndex * frameMs,
    toMs: (run.toIndex + 1) * frameMs,
    frameMs: run.fromIndex * frameMs,
  }));
}

function stableIntervalsOf(
  runs: readonly StableRun[],
  actions: readonly RecordingActionTimingCandidate[],
  durationMs: number,
  fps: number,
): RecordingStableIntervalCandidate[] {
  const frameMs = 1000 / fps;
  // Явный wait не меняет экран и не обрывает доказанный stable run. Это позволяет
  // сохранить геометрию highlight через следующий wait и одновременно опубликовать
  // сам wait как removable. Остальные действия остаются жёсткими границами.
  const visualActions = actions.filter((action) => action.kind !== 'wait');
  const gaps = visualActions.length === 0
    ? [{ fromMs: 0, toMs: durationMs, afterActionIndex: null, beforeActionIndex: null }]
    : [
      {
        fromMs: 0,
        toMs: visualActions[0]?.startMs ?? 0,
        afterActionIndex: null,
        beforeActionIndex: visualActions[0]?.actionIndex ?? null,
      },
      ...visualActions.slice(0, -1).map((action, index) => ({
        fromMs: action.endMs,
        toMs: visualActions[index + 1]?.startMs ?? action.endMs,
        afterActionIndex: action.actionIndex,
        beforeActionIndex: visualActions[index + 1]?.actionIndex ?? null,
      })),
      {
        fromMs: visualActions.at(-1)?.endMs ?? durationMs,
        toMs: durationMs,
        afterActionIndex: visualActions.at(-1)?.actionIndex ?? null,
        beforeActionIndex: null,
      },
    ];
  const intervals: RecordingStableIntervalCandidate[] = [];

  for (const gap of gaps) {
    for (const run of runs) {
      const fromMs = Math.max(gap.fromMs, run.fromMs);
      const toMs = Math.min(gap.toMs, run.toMs);
      const firstFrame = Math.ceil((fromMs - EPSILON_MS) / frameMs);
      const selectedFrameMs = firstFrame * frameMs;

      if (toMs - fromMs < frameMs - EPSILON_MS || selectedFrameMs >= toMs - EPSILON_MS) {
        continue;
      }

      intervals.push({
        id: `stable-${intervals.length}`,
        fromMs,
        toMs,
        frameMs: selectedFrameMs,
        afterActionIndex: gap.afterActionIndex,
        beforeActionIndex: gap.beforeActionIndex,
      });
    }
  }

  return intervals;
}

function intersectingStableRun(
  runs: readonly StableRun[],
  fromMs: number,
  toMs: number,
  fps: number,
): { fromMs: number; toMs: number } | null {
  const frameMs = 1000 / fps;
  const candidates = runs.map((run) => ({
    fromMs: Math.max(fromMs, run.fromMs),
    toMs: Math.min(toMs, run.toMs),
  })).filter((run) => run.toMs - run.fromMs >= frameMs - EPSILON_MS)
    .sort((left, right) => (right.toMs - right.fromMs) - (left.toMs - left.fromMs));

  return candidates[0] ?? null;
}

async function timingCandidateOf(input: {
  mark: Awaited<ReturnType<typeof recordChain>>['scenes'][number];
  calibration: CalibratedVideoTiming;
  trim: ExactTrimResult;
  fps: number;
}): Promise<RecordingTimingCandidate | null> {
  const { mark, calibration, trim, fps } = input;

  if (
    !finiteNonNegative(mark.readyMonoMs ?? Number.NaN)
    || !finiteNonNegative(mark.finishedMonoMs ?? Number.NaN)
    || !Array.isArray(mark.actions)
    || !Array.isArray(mark.highlights)
  ) {
    return null;
  }

  const local = (browserMonoMs: number) => browserMonoToVideoPts(calibration, browserMonoMs)
    - trim.firstRetainedSourcePtsMs + trim.outputFirstPtsMs;
  const inside = (value: number) => finiteNonNegative(value)
    && value <= trim.durationMs + EPSILON_MS;
  const sceneReadyMs = local(mark.readyMonoMs as number);
  const actions: RecordingActionTimingCandidate[] = mark.actions.map((action) => ({
    actionIndex: action.actionIndex,
    kind: action.kind,
    startMs: local(action.startMonoMs),
    anchorMs: local(action.anchorMonoMs),
    endMs: local(action.endMonoMs),
    readyMs: action.readyMonoMs === null ? null : local(action.readyMonoMs),
    geometry: action.geometry,
  }));

  if (
    !inside(sceneReadyMs)
    || actions.some((action, index) => (
      action.actionIndex !== index
      || !inside(action.startMs)
      || !inside(action.anchorMs)
      || !inside(action.endMs)
      || action.startMs > action.anchorMs + EPSILON_MS
      || action.anchorMs > action.endMs + EPSILON_MS
      || (action.readyMs !== null && !inside(action.readyMs))
    ))
  ) {
    // Никакого clamp к нулю: эта сцена честно остаётся без точного журнала.
    return null;
  }

  const runs = await stableRunsOf(trim.path, fps);
  const stableIntervals = stableIntervalsOf(runs, actions, trim.durationMs, fps);
  const highlights = (mark.highlights as RawHighlightGeometry[]).flatMap((highlight) => {
    const validFromMs = local(highlight.validFromMonoMs);
    const validToMs = local(highlight.validToMonoMs);
    const interval = stableIntervals.find((candidate) => (
      candidate.frameMs + EPSILON_MS >= validFromMs
      && candidate.frameMs <= validToMs + EPSILON_MS
      && candidate.afterActionIndex === highlight.actionIndex
    ));

    if (
      !interval
      || !inside(validFromMs)
      || !inside(validToMs)
      || validFromMs >= validToMs
    ) {
      return [];
    }

    return [{
      actionIndex: highlight.actionIndex,
      ...highlight.geometry,
      validFromMs,
      validToMs,
      stableIntervalId: interval.id,
    }];
  });
  const removableWaits: RecordingTimingCandidate['removableWaits'] = [];
  const firstAction = actions[0];

  if (firstAction && sceneReadyMs < firstAction.startMs) {
    const stable = intersectingStableRun(runs, sceneReadyMs, firstAction.startMs, fps);

    if (stable) {
      removableWaits.push({
        id: 'wait-lead',
        fromMs: stable.fromMs,
        toMs: stable.toMs,
        actionIndex: null,
        beforeActionIndex: firstAction.actionIndex,
      });
    }
  }

  for (const action of actions) {
    if (action.kind !== 'wait') {
      continue;
    }

    const stable = intersectingStableRun(runs, action.startMs, action.endMs, fps);

    if (stable) {
      removableWaits.push({
        id: `wait-action-${action.actionIndex}`,
        fromMs: stable.fromMs,
        toMs: stable.toMs,
        actionIndex: action.actionIndex,
        beforeActionIndex: actions[action.actionIndex + 1]?.actionIndex ?? null,
      });
    }
  }

  // Пауза между действиями — тоже измеренное пустое ожидание: когда речь опережает
  // экран, монтаж её вырезает, а когда отстаёт — держит кадр из неё же. Без этого
  // пауза, добавленная ради устойчивого кадра, удлиняла видео там, где речь
  // короткая, и следующему действию не хватало безопасной паузы в реплике.
  for (const [index, action] of actions.entries()) {
    const previous = actions[index - 1];

    if (!previous || previous.endMs >= action.startMs) {
      continue;
    }

    const stable = intersectingStableRun(runs, previous.endMs, action.startMs, fps);

    if (stable) {
      removableWaits.push({
        id: `wait-gap-${action.actionIndex}`,
        fromMs: stable.fromMs,
        toMs: stable.toMs,
        actionIndex: null,
        beforeActionIndex: action.actionIndex,
      });
    }
  }

  removableWaits.sort((left, right) => left.fromMs - right.fromMs);

  return {
    status: 'calibrated',
    durationMs: trim.durationMs,
    sceneReadyMs,
    calibration: {
      method: calibration.method,
      errorMs: calibration.errorMs,
      startErrorMs: calibration.startErrorMs,
      endErrorMs: calibration.endErrorMs,
      rate: calibration.rate,
    },
    actions,
    stableIntervals,
    removableWaits,
    highlights,
  };
}

const taskFile = process.argv[2];

if (!taskFile) {
  console.error('showcaseWorker: не передан файл задания');
  process.exit(2);
}

const task = JSON.parse(await readFile(taskFile, 'utf8')) as WorkerTask;
const { finish, report } = createAttemptLog(task);

if (task.login) {
  await writeFile(
    taskFile,
    `${JSON.stringify({ ...task, login: { ...task.login, password: '' } }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

async function main(): Promise<void> {
  await mkdir(task.workDir, { recursive: true });
  await report('running', 'готовим запись');

  // Ограничитель сети поднимается ДО браузера и живёт ровно столько же: разрешены
  // только объявленные адреса цели, всё остальное отклоняется на соединении.
  // Методы — те, что объявила цель (по умолчанию только чтение), плюс POST формы
  // входа, если вход есть. Сцены ограничены теми же методами цели своим
  // перехватом: записываемая страница читает стенд, а не меняет его.
  const allowedMethods = task.allowedMethods ?? ['GET', 'HEAD'];
  const guard = await startEgressGuard({
    allowedOrigins: task.allowedOrigins,
    allowedMethods: [...new Set([...allowedMethods, ...(task.login ? ['POST'] : [])])],
  });

  let browser: Browser | null = null;
  let loginState: StorageState | null = null;
  const scenes: SceneOutcome[] = [];

  // Сорвавшийся вход повторяется в том же браузере, но в новом контексте: снимок
  // состояния берётся только с удавшейся попытки. Наружу уходит причина последней.
  const loginWithRetry = async (launched: Browser, login: LoginRecipe): Promise<StorageState> => {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt += 1) {
      await report('running', attempt === 1 ? 'входим на стенд' : 'повторяем вход на стенд');

      try {
        return await loginToStand({
          browser: launched,
          baseUrl: task.baseUrl,
          allowedOrigins: task.allowedOrigins,
          style: task.style,
          login,
          diagnosticsDir: task.workDir,
        });
      } catch (error) {
        lastError = error;

        if (attempt < MAX_LOGIN_ATTEMPTS) {
          const reason = error instanceof Error ? error.message : String(error);

          await report('running', `повтор входа: ${reason}`, { attempt });
          await new Promise((resolve) => {
            setTimeout(resolve, LOGIN_RETRY_PAUSE_MS);
          });
        }
      }
    }

    throw lastError;
  };

  // Вход повторяется после каждого запуска браузера: снимок состояния живёт в
  // памяти исполнителя, а новый процесс браузера о прежнем ничего не знает.
  const launch = async () => {
    const launched = await launchBrowser({
      executablePath: task.browserPath,
      proxyPort: guard.port,
    });

    try {
      if (task.login) {
        loginState = await loginWithRetry(launched, task.login);
      }

      return launched;
    } catch (error) {
      // До присваивания outer `browser` экземпляр принадлежит launch(). Ошибка
      // входа раньше оставляла Chromium без владельца и он переживал worker.
      await launched.close().catch(() => null);
      throw error;
    }
  };

  const total = task.chains.reduce((sum, chain) => sum + chain.length, 0);
  let resourcesClosed = false;

  const closeResources = async (): Promise<void> => {
    if (resourcesClosed) {
      return;
    }

    resourcesClosed = true;
    const launched = browser;

    browser = null;
    await launched?.close().catch(() => null);
    await guard.close().catch(() => null);
  };

  /**
   * Клипы сцен из общей записи цепочки. В клип входит только то, что после
   * готовности: у головы это загрузка страницы, которая в ролике выглядела как
   * перезагрузка, у продолжения — хвост предыдущей сцены. Негодный клип любой
   * сцены отвергает всю запись: повторять её можно только с головы.
   */
  const cutChain = async (
    chain: ChainSceneInput[],
    recorded: Awaited<ReturnType<typeof recordChain>>,
    attempts: number,
  ): Promise<{ outcomes: SceneOutcome[]; reason: string }> => {
    const outcomes: SceneOutcome[] = [];
    const calibration = await calibrateVideoTiming(
      recorded.rawPath,
      recorded.calibration ?? [],
    );

    for (const [index, item] of chain.entries()) {
      const mark = recorded.scenes[index];

      if (!mark || mark.sceneId !== item.scene.id) {
        return { outcomes, reason: `в записи нет границ сцены «${item.scene.id}»` };
      }

      const output = path.join(task.workDir, `${item.scene.id}-ready.webm`);
      const precise = calibration.status === 'calibrated'
        && mark.readyMonoMs !== undefined
        && mark.finishedMonoMs !== undefined;
      // При unavailable mapping сохраняется прежняя приблизительная граница, но
      // сам клип всё равно проходит exact frame selection и CFR-нормализацию. Эта
      // ветка не выдаёт rough offsets за измеренные события.
      const exact = await trimSceneClipExact({
        rawPath: recorded.rawPath,
        startPtsMs: precise
          ? Math.max(
            index === 0 ? calibration.headExcludedBeforePtsMs : 0,
            browserMonoToVideoPts(calibration, mark.readyMonoMs as number) - READY_MARGIN_MS,
          )
          : Math.max(0, mark.readyOffsetMs - READY_MARGIN_MS),
        endPtsMs: precise
          ? Math.min(
            index === chain.length - 1
              ? calibration.tailExcludedFromPtsMs
              : Number.POSITIVE_INFINITY,
            browserMonoToVideoPts(calibration, mark.finishedMonoMs as number),
          )
          // При провале marker mapping Date.now остаётся только legacy-оценкой.
          // Отступ от конца нужен в обеих ветках: tail marker начинается сразу
          // после finishedOffset, а служебные кадры не должны пережить fallback.
          : Math.max(
            Math.max(0, mark.readyOffsetMs - READY_MARGIN_MS) + 40,
            mark.finishedOffsetMs - READY_MARGIN_MS,
          ),
        fps: task.style.fps,
        outFile: output,
      });
      const trimmed = exact.path;
      const check = await checkSceneClip(trimmed);

      if (!check.ok) {
        return { outcomes, reason: `сцена «${item.scene.title || item.scene.id}»: ${check.reason}` };
      }

      if (await videoContainsCalibrationMarker(trimmed, recorded.calibration ?? [])) {
        return {
          outcomes,
          reason: `сцена «${item.scene.title || item.scene.id}»: служебная отметка попала в клип`,
        };
      }

      const measuredTiming = calibration.status === 'calibrated'
        ? await timingCandidateOf({ mark, calibration, trim: exact, fps: task.style.fps })
        : null;
      const recordingTiming: RecordingTimingWorkerCandidate = measuredTiming ?? {
        status: 'unavailable',
        durationMs: exact.durationMs,
        calibration: {
          method: 'visual-marker-affine-v1',
          reason: calibration.status === 'unavailable'
            ? calibration.reason
            : 'События записи вышли за фактические границы клипа.',
        },
      };

      outcomes.push({
        sceneId: item.scene.id,
        attempts,
        rawPath: trimmed,
        readyOffsetMs: mark.readyOffsetMs,
        recordedMs: index === chain.length - 1 ? recorded.recordedMs : mark.finishedOffsetMs,
        // Медиа-ref остаётся старым публичным контрактом с целыми миллисекундами;
        // точная дробная длительность лежит в recordingTiming.
        durationMs: Math.round(exact.durationMs),
        blockedRequests: recorded.blockedRequests.length,
        unsettled: mark.unsettled,
        recordingTiming,
      });
    }

    return { outcomes, reason: '' };
  };

  try {
    browser = await launch();

    let done = 0;

    for (const chain of task.chains) {
      const startIndex = done;
      let attempts = 0;
      let outcomes: SceneOutcome[] | null = null;
      let lastReason = '';

      while (attempts < MAX_CHAIN_ATTEMPTS && !outcomes) {
        attempts += 1;

        try {
          const recorded = await recordChain({
            browser,
            scenes: chain,
            baseUrl: task.baseUrl,
            allowedOrigins: task.allowedOrigins,
            allowedMethods,
            outDir: task.workDir,
            style: task.style,
            loginState,
            deadlineMs: task.deadlineMs,
            timingMode: 'measured',
            onSceneStart: (scene, index) => report(
              'running',
              `пишем сцену «${scene.title || scene.id}»`,
              { index: startIndex + index + 1, total },
            ),
          });
          const cut = await cutChain(chain, recorded, attempts);

          if (!cut.reason) {
            outcomes = cut.outcomes;

            break;
          }

          lastReason = cut.reason;
        } catch (error) {
          lastReason = error instanceof Error ? error.message : String(error);

          // Сорванная сцена — повод поднять браузер заново: после смерти его
          // процесса прежний экземпляр отвечать не начнёт, и следующая попытка
          // на нём просто повторит ожидание до срока.
          await browser?.close().catch(() => null);
          browser = await launch();
        }

        if (!outcomes) {
          const what = chain.length === 1 ? 'повтор сцены' : 'повтор цепочки сцен';

          await report('running', `${what}: ${lastReason}`, { attempt: attempts });
        }
      }

      if (!outcomes) {
        const names = chain.map((item) => `«${item.scene.id}»`).join(', ');
        const what = chain.length === 1 ? 'сцена' : 'цепочка сцен';

        throw new Error(`${what} ${names} не записалась: ${lastReason}`);
      }

      scenes.push(...outcomes);
      done += chain.length;
    }

    // result.json — сигнал серверу публиковать клипы и забыть handle. Поэтому он
    // появляется только после закрытия Chromium и прокси, а не перед finally.
    await closeResources();
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

    await closeResources();
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
    await closeResources();
  }
}

await main();
