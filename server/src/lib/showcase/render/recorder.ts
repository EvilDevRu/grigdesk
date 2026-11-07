// Запись сцен браузером.
//
// Единица записи — цепочка: голова открывает свой экран, а сцены-продолжения
// начинают там, где закончилась предыдущая, — открытый диалог и выбранные строки
// остаются на экране. Цепочка пишется одним контекстом и одним видео, а границы
// сцен запоминаются таймкодами: по ним исполнитель режет запись на клипы. Сцена без
// продолжений — цепочка из одной сцены, и для неё всё как раньше.
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
import path from 'node:path';

import type { Browser, Page } from 'playwright-core';

import type {
  ShowcaseAction,
  ShowcaseScene,
} from '../../../../../shared/plugins/showcase/showcaseContracts.ts';
import { ShowcaseError } from '../errors.ts';
import { browserLaunchArgs } from '../browserPolicy.ts';
import { DEFAULT_QUIET, trackNetwork } from './networkQuiet.ts';
import type { RenderStyle } from '../artifacts.ts';
import { actionTarget, assertObservedSurfaces } from '../script/observation.ts';
import type { ObservedElement, ScreenObservation } from '../script/observation.ts';

// Накладка курсора — доверенный код recorder-а. Она не приходит от модели, ничего
// не кликает и события не перехватывает: указатель нарисован поверх страницы.
//
// Скрипт запуска исполняется ДО того, как разбор документа создал <html>: первая
// версия вешала точку в этот момент, падала на null и до конца сцены не оставляла ни
// указателя, ни подсветки — «подсветка» в роликах не была видна вовсе. Поэтому точка
// создаётся при первом же перемещении, когда документ уже есть.
const CURSOR_OVERLAY = `
  (() => {
    const PAD = 6;
    let dot = null;
    let frame = null;
    const ensure = () => {
      if (dot && dot.isConnected && frame && frame.isConnected) return;
      const style = document.createElement('style');
      style.textContent = '@keyframes __showcasePulse{0%{box-shadow:0 0 0 0 rgba(37,99,235,.6)}'
        + '100%{box-shadow:0 0 0 22px rgba(37,99,235,0)}}';
      dot = document.createElement('div');
      dot.id = '__showcase_cursor';
      dot.style.cssText = [
        'position:fixed', 'z-index:2147483647', 'width:26px', 'height:26px',
        'margin:-13px 0 0 -13px', 'border-radius:50%', 'pointer-events:none',
        'box-sizing:border-box', 'background:rgba(59,130,246,.35)', 'border:3px solid #2563eb',
        'box-shadow:0 0 0 2px rgba(255,255,255,.9), 0 2px 8px rgba(0,0,0,.35)',
        'transition:left .22s ease, top .22s ease', 'left:-60px', 'top:-60px',
      ].join(';');
      frame = document.createElement('div');
      frame.id = '__showcase_frame';
      frame.style.cssText = [
        'position:fixed', 'z-index:2147483646', 'pointer-events:none', 'box-sizing:border-box',
        'border:3px solid #2563eb', 'border-radius:10px', 'opacity:0',
        'transition:opacity .2s ease', 'left:-10px', 'top:-10px', 'width:0', 'height:0',
      ].join(';');
      document.documentElement.appendChild(style);
      document.documentElement.appendChild(frame);
      document.documentElement.appendChild(dot);
    };
    window.__showcaseCursorTo = (x, y) => {
      ensure();
      dot.style.left = x + 'px';
      dot.style.top = y + 'px';
      frame.style.opacity = '0';
    };
    // Подсветка — рамка вокруг элемента с пульсом, а указатель отходит к его углу:
    // точка поверх текста закрывала бы то, о чём речь.
    window.__showcaseHighlight = (x, y, w, h) => {
      ensure();
      frame.style.left = (x - PAD) + 'px';
      frame.style.top = (y - PAD) + 'px';
      frame.style.width = (w + PAD * 2) + 'px';
      frame.style.height = (h + PAD * 2) + 'px';
      frame.style.opacity = '1';
      frame.style.animation = 'none';
      void frame.offsetWidth;
      frame.style.animation = '__showcasePulse .9s ease-out 2';
      dot.style.left = (x + w + PAD + 10) + 'px';
      dot.style.top = (y + h + PAD + 6) + 'px';
    };
    // Полноэкранная служебная отметка существует только до открытия сцены и после
    // её последнего полезного кадра. Цвет меняет recorder, а timestamp снимается
    // теми же монотонными часами страницы в том же animation frame.
    window.__showcaseCalibration = (color) => {
      let marker = document.getElementById('__showcase_calibration');
      if (!marker) {
        marker = document.createElement('div');
        marker.id = '__showcase_calibration';
        marker.style.cssText = [
          'position:fixed', 'inset:0', 'z-index:2147483647', 'pointer-events:none',
          'display:none', 'margin:0', 'padding:0', 'border:0',
        ].join(';');
        document.documentElement.appendChild(marker);
      }
      marker.style.background = color;
      marker.style.display = 'block';
    };
    window.__showcaseCalibrationHide = () => {
      const marker = document.getElementById('__showcase_calibration');
      if (marker) marker.style.display = 'none';
    };
  })();
`;

// Пауза между готовностью и первым действием. Зритель должен увидеть исходное
// состояние экрана, а речь — начаться раньше клика (пре-ролл сборки 400 мс);
// заодно пауза перекрывает разброс между часами исполнителя и началом видео,
// из-за которого срез клипа мог попасть на уже выполненное действие.
const ACTION_LEAD_MS = 600;

// Пауза между приездом накладки курсора к цели и самим кликом: зритель должен
// успеть увидеть, КУДА нажимают, иначе смена экрана читается как самопроизвольная.
const CLICK_LEAD_MS = 400;

// Пауза между действиями. Монтаж держит кадр ПЕРЕД действием, когда реплика о нём
// начинается позже самого действия, а опорой такого удержания служит только
// измеренный устойчивый интервал в промежутке между действиями. Без паузы hover
// и следующий за ним клик смыкались вплотную (конец hover = начало клика), и
// держать перед кликом было нечего — сцена уходила человеку на «проверку
// синхронизации». Запас над минимальной длиной устойчивого интервала (150 мс)
// оставляет место переходам интерфейса после действия (обычно до 300 мс: иконка
// по наведению, раскрытие списка) и дублям кадров компоновщика.
const ACTION_GAP_MS = 500;

// Сколько сцена держит подсветку: два пульса по 900 мс должны попасть в запись.
const HIGHLIGHT_HOLD_MS = 1_900;

// Одна отметка обязана прожить несколько кадров даже у 25 fps browser recorder.
// Последовательность намеренно не содержит белого и чёрного: ими часто бывают
// обычные подготовительные кадры Chromium.
const CALIBRATION_HOLD_MS = 180;
const CALIBRATION_COLORS = [
  { css: 'rgb(255, 0, 255)', rgb: [255, 0, 255] as const },
  { css: 'rgb(0, 255, 255)', rgb: [0, 255, 255] as const },
  { css: 'rgb(255, 255, 0)', rgb: [255, 255, 0] as const },
  { css: 'rgb(255, 0, 0)', rgb: [255, 0, 0] as const },
] as const;

// Полоса экрана, в которой цель считается удобно видимой: по 15 % сверху и снизу
// отданы под контекст. Цель за её пределами перед действием ставится в центр.
const REVEAL_BAND = 0.15;

// Предел ожидания плавной прокрутки к цели. Сама прокрутка Chromium укладывается в
// полсекунды, но на тяжёлой странице начинается с задержкой; сверх предела цель
// берётся там, где она есть, — срывать сцену из-за прокрутки нельзя.
const REVEAL_SCROLL_CAP_MS = 1_500;

// Сколько ждать появления цели, видимой только при наведении, после того как
// указатель подведён к её ближайшему видимому предку.
const HOVER_REVEAL_MS = 1_500;

export interface ScreenMap {
  id: string;
  path: string;
  readySelector: string;
  elements: ObservedElement[];
}

export interface ChainSceneInput {
  scene: ShowcaseScene;
  screen: ScreenMap;
  observations?: ScreenObservation[];
}

export interface RecordChainInput {
  browser: Browser;
  // Сцены цепочки в порядке показа: первая открывает экран, остальные продолжают.
  scenes: ChainSceneInput[];
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
  // Начало каждой сцены цепочки: исполнитель по нему отчитывается о ходе.
  onSceneStart?: (scene: ShowcaseScene, index: number) => Promise<void> | void;
  // Старый режим нужен прямым потребителям recorder-а и уже снятым клипам. Worker
  // новых записей включает измерения явно; при этом фиксированный hold подсветки
  // заменяется геометрией для будущего монтажа.
  timingMode?: 'legacy' | 'measured';
}

export interface RecordSceneInput extends Omit<RecordChainInput, 'scenes' | 'onSceneStart'> {
  scene: ShowcaseScene;
  screen: ScreenMap;
}

// Границы одной сцены внутри общей записи цепочки, от начала видео.
export interface ChainSceneMark {
  sceneId: string;
  // Смещение готовности: до него — загрузка экрана у головы или хвост предыдущей
  // сцены у продолжения, и исполнитель эту часть срезает.
  readyOffsetMs: number;
  // Конец сцены после затишья сети; у следующей сцены цепочки готовность идёт сразу
  // за ним.
  finishedOffsetMs: number;
  // Сколько ожиданий затишья упёрлось в предел: у спокойного стенда ноль.
  unsettled: number;
  // Сырые значения остаются в единой browser-monotonic шкале общей записи. В PTS
  // конкретного клипа их переводит worker только после закрытия видео.
  readyMonoMs?: number;
  finishedMonoMs?: number;
  actions?: RawRecordingAction[];
  highlights?: RawHighlightGeometry[];
}

export interface CalibrationMarkerSample {
  phase: 'head' | 'tail';
  sequence: number;
  browserMonoMs: number;
  rgb: readonly [number, number, number];
}

export interface TargetGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RawRecordingAction {
  actionIndex: number;
  kind: ShowcaseAction['kind'];
  startMonoMs: number;
  anchorMonoMs: number;
  endMonoMs: number;
  readyMonoMs: number | null;
  geometry: TargetGeometry | null;
}

export interface RawHighlightGeometry {
  actionIndex: number;
  geometry: TargetGeometry;
  validFromMonoMs: number;
  validToMonoMs: number;
}

export interface RecordingActionTimingCandidate {
  actionIndex: number;
  kind: ShowcaseAction['kind'];
  startMs: number;
  anchorMs: number;
  endMs: number;
  readyMs: number | null;
  geometry: TargetGeometry | null;
}

export interface RecordingStableIntervalCandidate {
  id: string;
  fromMs: number;
  toMs: number;
  frameMs: number;
  afterActionIndex: number | null;
  beforeActionIndex: number | null;
}

export interface RecordingRemovableWaitCandidate {
  id: string;
  fromMs: number;
  toMs: number;
  // `actionIndex` отмечает собственно action kind=wait. Lead до первого действия
  // имеет null; Stage6 сможет удалить оба случая, не выдавая любой gap за пустой.
  actionIndex: number | null;
  beforeActionIndex: number | null;
}

export interface RecordingHighlightCandidate extends TargetGeometry {
  actionIndex: number;
  validFromMs: number;
  validToMs: number;
  stableIntervalId: string;
}

export interface RecordingTimingCandidate {
  status: 'calibrated';
  durationMs: number;
  sceneReadyMs: number;
  calibration: {
    method: 'visual-marker-affine-v1';
    errorMs: number;
    startErrorMs: number;
    endErrorMs: number;
    rate: number;
  };
  actions: RecordingActionTimingCandidate[];
  stableIntervals: RecordingStableIntervalCandidate[];
  removableWaits: RecordingRemovableWaitCandidate[];
  highlights: RecordingHighlightCandidate[];
}

export interface RecordingTimingUnavailableCandidate {
  status: 'unavailable';
  durationMs: number;
  calibration: {
    method: 'visual-marker-affine-v1';
    reason: string;
  };
}

export type RecordingTimingWorkerCandidate =
  | RecordingTimingCandidate
  | RecordingTimingUnavailableCandidate;

export interface RecordChainResult {
  rawPath: string;
  scenes: ChainSceneMark[];
  recordedMs: number;
  blockedRequests: { url: string; method: string }[];
  calibration?: CalibrationMarkerSample[];
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

// Сколько ждать, пока цель перестанет двигаться: диалоги открываются с анимацией,
// и координаты, снятые в её середине, ставят указатель мимо элемента.
const STABLE_STEP_MS = 120;
const STABLE_LIMIT_MS = 1_500;

/**
 * Рамка цели после того, как она перестала двигаться. Два одинаковых замера подряд
 * означают конец анимации; не дождались за предел — берётся последний замер, и
 * сцена не срывается из-за бесконечно пульсирующей кнопки.
 */
type TargetBox = TargetGeometry;

interface TimedTargetBox extends TargetBox {
  sampledMonoMs: number;
}

/**
 * Общая для документов страницы монотонная шкала. Сам `performance.now()` после
 * navigation снова начинается с нуля; сумма с `timeOrigin` сохраняет координату
 * browser process и при этом не зависит от прыжков системных часов во время записи.
 */
async function browserMonoNow(page: Page): Promise<number> {
  const value = await page.evaluate(() => performance.timeOrigin + performance.now());

  if (!Number.isFinite(value)) {
    throw new ShowcaseError('record_failed', 'Браузер не отдал монотонное время страницы.', 500);
  }

  return value;
}

/** Несколько визуально различных переходов одной фазы калибровки. */
async function recordCalibrationMarkers(
  page: Page,
  phase: CalibrationMarkerSample['phase'],
): Promise<CalibrationMarkerSample[]> {
  const samples: CalibrationMarkerSample[] = [];

  for (const [sequence, color] of CALIBRATION_COLORS.entries()) {
    const browserMonoMs = await page.evaluate(async (css) => new Promise<number>((resolve) => {
      requestAnimationFrame(() => {
        const api = (window as unknown as {
          __showcaseCalibration?: (value: string) => void;
        }).__showcaseCalibration;

        api?.(css);
        resolve(performance.timeOrigin + performance.now());
      });
    }), color.css);

    samples.push({ phase, sequence, browserMonoMs, rgb: color.rgb });
    await page.waitForTimeout(CALIBRATION_HOLD_MS);
  }

  if (phase === 'head') {
    await page.evaluate(() => {
      (window as unknown as { __showcaseCalibrationHide?: () => void })
        .__showcaseCalibrationHide?.();
    });
    // Дать compositor-у вывести первый кадр без служебной отметки до navigation.
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
  }

  return samples;
}

async function stableBox(locator: ReturnType<Page['locator']>): Promise<TimedTargetBox | null> {
  let previous = await locator.boundingBox();

  for (let waited = 0; waited < STABLE_LIMIT_MS; waited += STABLE_STEP_MS) {
    await locator.page().waitForTimeout(STABLE_STEP_MS);

    const current = await locator.boundingBox();

    if (!current || !previous) {
      return current ? { ...current, sampledMonoMs: await browserMonoNow(locator.page()) } : null;
    }

    if (
      Math.abs(current.x - previous.x) < 0.5
      && Math.abs(current.y - previous.y) < 0.5
      && Math.abs(current.width - previous.width) < 0.5
      && Math.abs(current.height - previous.height) < 0.5
    ) {
      return { ...current, sampledMonoMs: await browserMonoNow(locator.page()) };
    }

    previous = current;
  }

  return previous
    ? { ...previous, sampledMonoMs: await browserMonoNow(locator.page()) }
    : null;
}

function visibleGeometry(page: Page, box: TargetBox): TargetGeometry | null {
  const viewport = page.viewportSize();

  if (!viewport) {
    return null;
  }

  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const right = Math.min(viewport.width, box.x + box.width);
  const bottom = Math.min(viewport.height, box.y + box.height);

  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null;
}

/**
 * Перемещение накладки курсора к центру цели. Вызов идёт по имени, объявленному
 * recorder-ом в скрипте запуска; страница, где скрипт не отработал, просто не
 * покажет указатель — сцену это не срывает.
 *
 * В страницу передаётся настоящая функция, а не строка с ней: строку Playwright
 * вычисляет как выражение и получившуюся функцию с аргументом НЕ вызывает — так
 * указатель молча стоял за экраном во всех прежних роликах.
 */
async function moveCursor(page: Page, box: TargetBox): Promise<void> {
  await page.evaluate(([x, y]) => {
    const overlay = (window as unknown as {
      __showcaseCursorTo?: (left: number, top: number) => void;
    }).__showcaseCursorTo;

    if (overlay) {
      overlay(x, y);
    }
  }, [box.x + box.width / 2, box.y + box.height / 2] as const);
}

/** Рамка подсветки вокруг цели; указатель отходит к её нижнему правому углу. */
async function highlightBox(page: Page, box: TargetBox): Promise<void> {
  await page.evaluate(([x, y, width, height]) => {
    const overlay = (window as unknown as {
      __showcaseHighlight?: (left: number, top: number, w: number, h: number) => void;
    }).__showcaseHighlight;

    if (overlay) {
      overlay(x, y, width, height);
    }
  }, [box.x, box.y, box.width, box.height] as const);
}

/**
 * Селектор берётся из карты профиля или проверенного наблюдения браузера.
 * Модель называет только идентификатор: собственного селектора у неё нет.
 */
async function checkedActionTarget(page: Page, screen: ScreenMap, targetId: string) {
  const element = screen.elements.find((item) => item.id === targetId);

  if (!element) {
    throw new ShowcaseError(
      'unknown_target',
      `Экран «${screen.id}» не объявлял элемент «${targetId}».`,
      400,
    );
  }

  return actionTarget(page, element);
}

/**
 * Прокрутка к цели так, чтобы вокруг неё было видно содержимое. Штатный
 * `scrollIntoViewIfNeeded` этого не даёт: элемент у самого нижнего края «виден»,
 * и прокрутки нет — так заголовок таблицы позиций подсвечивался на 894-й строке
 * экрана из 1080, а сама таблица весь ролик оставалась за кадром. Цель вне средней
 * полосы плавно ставится по центру; уже удобная не трогается, чтобы соседние
 * действия не дёргали страницу вверх-вниз.
 *
 * Конца прокрутки дожидается сама функция, а не замер рамки после неё. Плавная
 * прокрутка начинается не сразу: на странице с открытым диалогом (размытие фона,
 * ~11 кадров в секунду) первое движение приходило через 230–300 мс, и два одинаковых
 * замера ДО него выглядели остановкой — регион в шапке так и оставался за верхней
 * кромкой, а цепочка срывалась «за границей кадра» на первой же сцене после диалога.
 * Куда прокрутка приедет, известно заранее: мгновенный scrollIntoView с немедленным
 * возвратом на место (в одном task, до отрисовки) даёт конечные смещения всех
 * предков, и ожидание идёт до их достижения, а не до затишья. Цель, к которой
 * прокрутить нельзя (шапка при нулевой прокрутке), не стоит ни одного кадра ожидания.
 */
async function revealTarget(page: Page, target: ReturnType<Page['locator']>): Promise<void> {
  const height = page.viewportSize()?.height ?? 1080;

  await target.evaluate((element, [viewportHeight, band, capMs]) => new Promise<void>((resolve) => {
    const box = element.getBoundingClientRect();
    const comfortable = box.top >= viewportHeight * band
      && box.bottom <= viewportHeight * (1 - band);

    if (comfortable) {
      resolve();

      return;
    }

    const scrollers: Element[] = [];

    for (let node = element.parentElement; node; node = node.parentElement) {
      scrollers.push(node);
    }

    const root = document.scrollingElement;

    if (root && !scrollers.includes(root)) {
      scrollers.push(root);
    }

    const before = scrollers.map((node) => ({ node, left: node.scrollLeft, top: node.scrollTop }));

    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });

    const moving = before
      .map((from) => ({ node: from.node, from, left: from.node.scrollLeft, top: from.node.scrollTop }))
      .filter((item) => (
        Math.abs(item.left - item.from.left) >= 0.5 || Math.abs(item.top - item.from.top) >= 0.5
      ));

    for (const item of moving) {
      item.node.scrollTo({ left: item.from.left, top: item.from.top, behavior: 'instant' });
    }

    if (moving.length === 0) {
      resolve();

      return;
    }

    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });

    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const cap = setTimeout(finish, capMs);
    const tick = () => {
      if (settled) {
        return;
      }

      const arrived = moving.every((item) => (
        Math.abs(item.node.scrollLeft - item.left) <= 1 && Math.abs(item.node.scrollTop - item.top) <= 1
      ));

      if (arrived) {
        clearTimeout(cap);
        finish();

        return;
      }

      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  }), [height, REVEAL_BAND, REVEAL_SCROLL_CAP_MS] as const).catch(() => null);
}

/**
 * Рамка цели перед действием: цель дожидается появления в DOM, встаёт в удобную
 * полосу экрана и перестаёт двигаться.
 *
 * Цель, видимая только при наведении (иконка настройки в заголовке колонки, кнопка
 * в строке таблицы), без указателя рядом остаётся скрытой, и сцена срывалась
 * «не видна на экране» — хотя человек просто подвёл бы мышь. Поэтому скрытая цель
 * получает наведение на ближайший видимый предок и ждётся снова; накладка курсора
 * едет туда же, иначе появление элемента в записи выглядело бы самопроизвольным.
 * Цель, не появившаяся и после этого, отдаётся вызывающему как отсутствующая.
 */
async function settleTarget(
  page: Page,
  target: ReturnType<Page['locator']>,
  timeoutMs: number,
): Promise<TimedTargetBox | null> {
  await target.waitFor({ state: 'attached', timeout: timeoutMs });
  await revealTarget(page, target);

  const box = await stableBox(target);

  if (box) {
    return box;
  }

  // Предки идут в порядке документа, ближайший — последний из видимых.
  const anchor = target.locator('xpath=ancestor::*').filter({ visible: true }).last();

  await revealTarget(page, anchor);

  const anchorBox = await stableBox(anchor).catch(() => null);

  if (!anchorBox) {
    return null;
  }

  await moveCursor(page, anchorBox);
  await page.mouse.move(
    anchorBox.x + anchorBox.width / 2,
    anchorBox.y + anchorBox.height / 2,
    { steps: 8 },
  );

  const appeared = await target
    .waitFor({ state: 'visible', timeout: HOVER_REVEAL_MS })
    .then(() => true, () => false);

  if (!appeared) {
    return null;
  }

  await revealTarget(page, target);

  return stableBox(target);
}

/** Выполняет одно проверенное действие; общий путь для репетиции и записи. */
export async function runAction(
  page: Page,
  screen: ScreenMap,
  action: ShowcaseAction,
  actionIndex: number,
  timeoutMs: number,
  measured: boolean,
): Promise<{ action: RawRecordingAction; highlight: RawHighlightGeometry | null }> {
  const startMonoMs = await browserMonoNow(page);
  const done = (
    anchorMonoMs: number,
    endMonoMs: number,
    readyMonoMs: number | null,
    geometry: TargetGeometry | null,
    highlight: RawHighlightGeometry | null = null,
  ) => ({
    action: {
      actionIndex,
      kind: action.kind,
      startMonoMs,
      anchorMonoMs,
      endMonoMs,
      readyMonoMs,
      geometry,
    },
    highlight,
  });

  if (action.kind === 'wait') {
    await page.waitForTimeout(Math.min(action.ms, timeoutMs));
    const endMonoMs = await browserMonoNow(page);

    return done(startMonoMs, endMonoMs, null, null);
  }

  if (action.kind === 'scroll') {
    await page.mouse.wheel(0, action.delta);
    const anchorMonoMs = await browserMonoNow(page);
    // wheel завершается после отправки ввода, но compositor может ещё не выдать
    // кадр. Два rAF ограничивают действие реальным отображённым состоянием.
    const endMonoMs = await page.evaluate(() => new Promise<number>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve(performance.timeOrigin + performance.now());
      }));
    }));

    return done(anchorMonoMs, endMonoMs, null, null);
  }

  if (action.kind === 'waitVisible') {
    const target = await checkedActionTarget(page, screen, action.targetId);

    await target.waitFor({ state: 'visible', timeout: timeoutMs });

    const readyMonoMs = await browserMonoNow(page);
    const box = await stableBox(target);
    const endMonoMs = Math.max(readyMonoMs, box?.sampledMonoMs ?? readyMonoMs);

    return done(startMonoMs, endMonoMs, readyMonoMs, box ? visibleGeometry(page, box) : null);
  }

  if (action.kind === 'hover' || action.kind === 'highlight') {
    const target = await checkedActionTarget(page, screen, action.targetId);

    // Цель у края экрана подсвечивать бессмысленно: зритель увидит рамку без
    // содержимого, о котором речь. Сначала цель дожидается появления, затем встаёт
    // в удобную полосу экрана.
    const box = await settleTarget(page, target, timeoutMs);

    if (!box) {
      throw new ShowcaseError(
        'target_missing',
        `Цель действия «${action.targetId}» не видна на экране.`,
        409,
      );
    }

    if (action.kind === 'hover') {
      await moveCursor(page, box);

      // Наведение — не только накладка: настоящий указатель тоже едет к цели, иначе
      // страница не узнаёт о нём, и то, что появляется по наведению (иконка настройки
      // в заголовке колонки), в записи не появляется вовсе — следующее действие по
      // такому элементу срывалось «цель не видна». Шаги дают промежуточные события
      // мыши, как у живого движения.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
      const anchorMonoMs = await browserMonoNow(page);

      return done(
        anchorMonoMs,
        anchorMonoMs,
        null,
        visibleGeometry(page, box),
      );
    }

    const geometry = visibleGeometry(page, box);

    if (!geometry) {
      throw new ShowcaseError(
        'target_missing',
        `Цель действия «${action.targetId}» находится за границей кадра.`,
        409,
      );
    }

    const anchorMonoMs = box.sampledMonoMs;

    if (!measured) {
      // Legacy-запись уже содержит рамку и её фиксированную длительность. Новый
      // measured-путь оставляет исходный кадр чистым: рамку нарисует монтаж по box.
      await highlightBox(page, box);
      await page.waitForTimeout(HIGHLIGHT_HOLD_MS);
    }

    const endMonoMs = measured ? anchorMonoMs : await browserMonoNow(page);

    return done(anchorMonoMs, endMonoMs, null, geometry, {
      actionIndex,
      geometry,
      validFromMonoMs: anchorMonoMs,
      // Верхнюю границу уточнит runScene по началу следующего действия/концу сцены.
      validToMonoMs: endMonoMs,
    });
  }

  if (action.kind === 'click') {
    const target = await checkedActionTarget(page, screen, action.targetId);

    // Playwright прокрутил бы к цели сам, но лишь до края экрана: зритель должен
    // видеть, ГДЕ нажимают, а не угадывать по рамке у нижней кромки. Цель, которой
    // не нашлось, здесь не срывает сцену: сам клик ниже дождётся её или назовёт
    // причину отказа.
    const box = await settleTarget(page, target, timeoutMs).catch(() => null);

    // Накладка курсора едет к цели ДО клика: настоящий указатель в записи не виден,
    // и без этого зритель видел бы, как экран меняется сам по себе.
    if (box) {
      await moveCursor(page, box);
      await page.waitForTimeout(CLICK_LEAD_MS);
    }

    // Отдельный trial завершает auto-wait до timestamp: иначе locator.click мог
    // ещё сотни миллисекунд ждать actionability уже после нашей «опоры».
    await target.click({ timeout: timeoutMs, trial: true });
    const anchorMonoMs = await browserMonoNow(page);
    await target.click({ timeout: timeoutMs });
    const endMonoMs = await browserMonoNow(page);

    return done(
      anchorMonoMs,
      endMonoMs,
      null,
      box ? visibleGeometry(page, box) : null,
    );
  }

  // Неизвестная семантика действия прерывает сцену. Догадка «наверное, это клик»
  // здесь означала бы клик по чужому элементу на чужом экране.
  throw new ShowcaseError('unknown_action', `Действие «${action.kind}» не поддерживается.`, 400);
}

function sceneName(scene: ShowcaseScene): string {
  return `«${scene.title || scene.id}»`;
}

/**
 * Записывает цепочку сцен одним контекстом. Срок — на сцену, поэтому у цепочки он
 * складывается из сроков её сцен: длинная цепочка не должна срываться только
 * потому, что её сцены вместе длиннее одной.
 *
 * Контекст закрывается ДО чтения файла: браузер дописывает видео именно при
 * закрытии, и обращение к пути раньше даёт обрезанный файл.
 */
export async function recordChain(input: RecordChainInput): Promise<RecordChainResult> {
  if (input.scenes.length === 0) {
    throw new ShowcaseError('record_failed', 'В цепочке записи нет ни одной сцены.', 500);
  }

  const names = input.scenes.map((item) => sceneName(item.scene)).join(', ');

  return withDeadline(
    recordChainOnce(input),
    (input.deadlineMs ?? 90_000) * input.scenes.length,
    input.scenes.length === 1 ? `сцена ${names}` : `цепочка сцен ${names}`,
  );
}

/** Одиночная сцена — цепочка из одной сцены; результат в прежней плоской форме. */
export async function recordScene(input: RecordSceneInput): Promise<RecordSceneResult> {
  const { scene, screen, ...rest } = input;
  const recorded = await recordChain({ ...rest, scenes: [{ scene, screen }] });
  const mark = recorded.scenes[0] as ChainSceneMark;

  return {
    rawPath: recorded.rawPath,
    readyOffsetMs: mark.readyOffsetMs,
    recordedMs: recorded.recordedMs,
    blockedRequests: recorded.blockedRequests,
    unsettled: mark.unsettled,
  };
}

async function recordChainOnce(input: RecordChainInput): Promise<RecordChainResult> {
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
  let discoveredAction = false;
  let blockedActionRequests = 0;

  await context.route('**/*', async (route, request) => {
    const origin = new URL(request.url()).origin;
    const method = request.method();
    // OPTIONS — preflight, вопрос браузера перед cross-origin запросом, а не
    // действие страницы: сам запрос всё равно проверяется своим методом.
    const permitted = (discoveredAction ? ['GET', 'HEAD'] : allowedMethods).includes(method)
      || method === 'OPTIONS';

    if (!input.allowedOrigins.includes(origin) || !permitted) {
      blockedRequests.push({ url: request.url(), method });

      if (discoveredAction && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        blockedActionRequests += 1;
      }
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
  const measured = input.timingMode === 'measured';
  const calibration: CalibrationMarkerSample[] = [];

  if (measured) {
    calibration.push(...await recordCalibrationMarkers(page, 'head').catch(() => []));
  }

  const network = trackNetwork(page);
  const settle = {
    quietMs: input.settleQuietMs ?? DEFAULT_QUIET.quietMs,
    capMs: input.settleCapMs ?? DEFAULT_QUIET.capMs,
  };
  const marks: ChainSceneMark[] = [];

  try {
    for (const [index, item] of input.scenes.entries()) {
      await input.onSceneStart?.(item.scene, index);

      try {
        marks.push(await runScene(page, item, {
          startedAt,
          head: index === 0,
          previousScreenId: input.scenes[index - 1]?.screen.id ?? null,
          baseUrl: input.baseUrl,
          network,
          settle,
          actionTimeoutMs,
          readyTimeoutMs,
          measured,
          restrictToRead: () => {
            discoveredAction = true;
          },
          assertNetwork: () => {
            if (blockedActionRequests > 0) {
              throw new ShowcaseError(
                'observed_action_network',
                'Найденное действие требует запроса, не разрешённого для автоматического показа.',
                409,
              );
            }
          },
        }));
      } catch (error) {
        // Сорвалась цепочка, а человек чинит сцену: причина обязана назвать её —
        // и для отказа записи, и для таймаута Playwright на селекторе.
        if (input.scenes.length === 1) {
          throw error;
        }

        const message = `сцена ${sceneName(item.scene)}: ${
          error instanceof Error ? error.message : String(error)
        }`;

        throw error instanceof ShowcaseError
          ? new ShowcaseError(error.code, message, error.status)
          : new Error(message, { cause: error });
      }
    }

    const finishedAt = Date.now();

    if (measured) {
      // Целевая страница не должна иметь возможность подменить marker API или
      // закрыть отметку своим DOM/CSS. После последнего полезного timestamp уходим
      // в чистый документ того же page/video и рисуем хвост уже там.
      await page.goto('about:blank', { waitUntil: 'commit', timeout: actionTimeoutMs });
      // Первые кадры нового документа screencast отдаёт с задержкой: первая отметка
      // хвоста, показанная сразу после перехода, попадала в запись одним кадром на
      // 180 мс удержания. Калибровка такой guard переживает, но граница служебных
      // кадров от него точнее, когда он цел: два кадра чистого документа до первой
      // отметки дают compositor-у раскачаться на пустом кадре, а не на служебном.
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })).catch(() => null);
      calibration.push(...await recordCalibrationMarkers(page, 'tail').catch(() => []));
    }

    const video = page.video();

    if (!video) {
      throw new ShowcaseError('record_failed', 'Браузер не завёл запись сцены.', 500);
    }

    network.dispose();
    await context.close();

    return {
      rawPath: await video.path(),
      scenes: marks,
      recordedMs: finishedAt - startedAt,
      blockedRequests,
      ...(measured ? { calibration } : {}),
    };
  } catch (error) {
    network.dispose();
    await context.close().catch(() => null);

    throw error;
  }
}

interface SceneRunOptions {
  startedAt: number;
  // Голова цепочки открывает экран; продолжение застаёт его таким, каким его
  // оставила предыдущая сцена.
  head: boolean;
  // Экран предыдущей сцены цепочки: по нему видно, увёл ли её клик на другой экран.
  previousScreenId: string | null;
  baseUrl: string;
  network: ReturnType<typeof trackNetwork>;
  settle: { quietMs: number; capMs: number };
  actionTimeoutMs: number;
  readyTimeoutMs: number;
  measured: boolean;
  restrictToRead: () => void;
  assertNetwork: () => void;
}

/**
 * Одна сцена на уже открытой странице: готовность, пауза, действия, затишье.
 * Возвращает границы сцены от начала записи — по ним исполнитель режет клип.
 */
async function runScene(
  page: Page,
  item: ChainSceneInput,
  options: SceneRunOptions,
): Promise<ChainSceneMark> {
  const { network, settle, actionTimeoutMs, readyTimeoutMs } = options;
  let unsettled = 0;

  if (options.head) {
    const startUrl = new URL(item.screen.path, options.baseUrl).toString();
    const response = await page.goto(startUrl, { waitUntil: 'commit', timeout: readyTimeoutMs });

    if (!response || !response.ok()) {
      throw new ShowcaseError(
        'screen_unavailable',
        `Экран «${item.screen.id}» не открылся: код ${response?.status() ?? '—'}.`,
        502,
      );
    }
  }

  // Готовность — явное условие сцены с ограниченным ожиданием. Общего ожидания
  // тишины Playwright нет намеренно: стенд с SSE или polling до неё не доходит
  // никогда; вместо неё ниже ограниченное затишье по молодым запросам.
  //
  // Продолжение экран не открывает, но его каркас обязан быть на месте: если клик
  // предыдущей сцены увёл на другой экран, здесь ждётся именно он, а на том же
  // экране условие уже выполнено и ожидание мгновенно.
  const readySelector = item.scene.readyCondition || item.screen.readySelector;

  await page.locator(readySelector).first().waitFor({ state: 'visible', timeout: readyTimeoutMs });

  // Готовность — это собравшийся каркас; данные приходят второй волной запросов.
  // Её конец ждётся ограниченно: недождавшееся затишье сцену не срывает.
  //
  // Продолжение на том же экране этого ждать не должно: предыдущая сцена уже
  // закончилась затишьем, и повторная секунда ожидания была бы пустым временем
  // между сценами. Другой экран — другая волна данных, и её ждут как у головы.
  const freshScreen = options.head || item.screen.id !== options.previousScreenId;

  if (freshScreen && !(await network.quiet(settle))) {
    unsettled += 1;
  }

  // Снимок кадра заставляет браузер свести картинку: без него одна запись из
  // десяти выходила полностью однотонной при выполненном условии готовности.
  // Но это СРЕДСТВО, а не гарантия — сам снимок иногда отказывает протоколом,
  // и ронять из-за него сцену нельзя. Гарантией остаётся проверка готового
  // клипа: она ловит пустую запись независимо от того, удался ли снимок.
  // Продолжению он не нужен: картинка на странице уже сведена предыдущей сценой.
  if (options.head) {
    await page
      .screenshot({ type: 'jpeg', quality: 20, timeout: actionTimeoutMs })
      .catch(() => null);
  }

  const readyAt = Date.now();
  const readyMonoMs = await browserMonoNow(page);
  const actions: RawRecordingAction[] = [];
  const highlights: RawHighlightGeometry[] = [];

  await page.waitForTimeout(ACTION_LEAD_MS);

  for (const [actionIndex, action] of item.scene.actions.entries()) {
    // Пауза нужна перед действием, которое меняет экран: перед ожиданиями она была
    // бы пустым временем, а измеренная готовность результата уехала бы позже
    // настоящей; goto же вовсе не действие на экране.
    if (actionIndex > 0 && !['goto', 'wait', 'waitVisible'].includes(action.kind)) {
      await page.waitForTimeout(ACTION_GAP_MS);
    }

    if (action.kind === 'goto') {
      // Декларативный goto означает уже открытый и проверенный экран. Загрузочные
      // кадры намеренно вырезаются, поэтому его полезная опора — measured ready,
      // а не запрос navigation за границей будущего клипа.
      actions.push({
        actionIndex,
        kind: action.kind,
        startMonoMs: readyMonoMs,
        anchorMonoMs: readyMonoMs,
        endMonoMs: readyMonoMs,
        readyMonoMs,
        geometry: null,
      });

      continue;
    }

    if ('targetId' in action && item.screen.elements.some((element) => (
      element.id === action.targetId && element.observed
    ))) {
      options.restrictToRead();
    }

    const recorded = await runAction(
      page,
      item.screen,
      action,
      actionIndex,
      actionTimeoutMs,
      options.measured,
    );

    actions.push(recorded.action);

    const observation = item.observations?.find((step) => step.actionIndex === actionIndex);

    if (observation) {
      await page.waitForTimeout(600);
      await network.quiet(settle);
      await assertObservedSurfaces(page, observation.surfaces);
      options.assertNetwork();
    }

    if (recorded.highlight) {
      highlights.push(recorded.highlight);
    }
  }

  // Действия сами вызывают запросы — фильтр перестраивает таблицу, — и последний
  // кадр обязан показывать их результат, а не спиннер.
  if (!(await network.quiet(settle))) {
    unsettled += 1;
  }

  options.assertNetwork();

  const finishedMonoMs = await browserMonoNow(page);
  const timedHighlights = highlights.map((highlight) => {
    // Wait не меняет геометрию экрана: рамка остаётся валидной до следующего
    // визуального действия, а стабильные кадры внутри wait пригодны для монтажа.
    const following = actions.find((action) => (
      action.actionIndex > highlight.actionIndex && action.kind !== 'wait'
    ));

    return {
      ...highlight,
      validToMonoMs: Math.max(
        highlight.validFromMonoMs,
        following?.startMonoMs ?? finishedMonoMs,
      ),
    };
  });

  return {
    sceneId: item.scene.id,
    readyOffsetMs: readyAt - options.startedAt,
    finishedOffsetMs: Date.now() - options.startedAt,
    unsettled,
    ...(options.measured ? {
      readyMonoMs,
      finishedMonoMs,
      actions,
      highlights: timedHighlights,
    } : {}),
  };
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
  // Куда положить снимок экрана при неудачном входе. Без каталога снимка нет:
  // причину отказа тогда называет только текст.
  diagnosticsDir?: string;
}

/**
 * Вход на стенд тестовой учёткой. Идёт в своём контексте и заканчивается снимком
 * состояния (cookie и localStorage): сцены потом открываются уже вошедшими, а сам
 * пароль в их контексты не попадает.
 *
 * Это единственное место, где странице разрешён не-GET запрос — форма входа
 * отправляется POST. Назначение по-прежнему только объявленные origins.
 *
 * Отказ входа называет, ЧТО увидел браузер: адрес, на котором осталась страница,
 * и стоит ли на ней всё ещё форма. Голый таймаут селектора этого не говорил, и
 * первая сорвавшаяся запись ролика осталась без причины — со сжатым «locator.waitFor».
 */
export async function loginToStand(input: LoginInput): Promise<StorageState> {
  const timeoutMs = input.timeoutMs ?? 45_000;
  const context = await input.browser.newContext({
    viewport: { width: input.style.width, height: input.style.height },
    serviceWorkers: 'block',
    locale: input.style.locale,
    colorScheme: input.style.theme === 'light' ? 'light' : 'dark',
  });
  const blocked: string[] = [];

  await context.route('**/*', async (route, request) => {
    if (!input.allowedOrigins.includes(new URL(request.url()).origin)) {
      blocked.push(request.url());
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

      try {
        await page.locator(recipe.readySelector).first()
          .waitFor({ state: 'visible', timeout: timeoutMs });
      } catch {
        throw await describeLoginFailure({
          page,
          recipe,
          timeoutMs,
          blocked,
          diagnosticsDir: input.diagnosticsDir ?? null,
        });
      }
    })(), timeoutMs + 5_000, 'вход на стенд');

    return await context.storageState();
  } finally {
    await context.close().catch(() => null);
  }
}

/**
 * Причина несостоявшегося входа словами. Снимок экрана — в каталог попытки: по нему
 * человек видит форму с ошибкой или чужую страницу, а не гадает по селектору.
 */
async function describeLoginFailure(input: {
  page: Page;
  recipe: LoginRecipe;
  timeoutMs: number;
  blocked: string[];
  diagnosticsDir: string | null;
}): Promise<ShowcaseError> {
  const { page, recipe } = input;
  const url = page.url();
  const formStillThere = await page.locator(recipe.userSelector).first()
    .isVisible({ timeout: 1_000 })
    .catch(() => false);
  const seconds = Math.round(input.timeoutMs / 1000);
  const where = formStillThere
    ? `форма входа осталась на экране (${url}): стенд не принял учётку или не ответил на отправку`
    : `страница ушла на ${url}, но условие готовности не выполнилось`;
  // Отклонённые адреса называются: если среди них API самого стенда, причина —
  // не стенд, а политика цели, и чинить нужно target.json, а не ждать дольше.
  const origins = [...new Set(input.blocked.map((target) => new URL(target).origin))];
  const details = [
    `условие готовности «${recipe.readySelector}» не появилось за ${seconds} с`,
    origins.length
      ? `отклонены запросы к ${origins.slice(0, 4).join(', ')}${origins.length > 4 ? ' и др.' : ''}`
      : '',
  ].filter(Boolean).join('; ');
  let snapshot = '';

  if (input.diagnosticsDir) {
    const file = path.join(input.diagnosticsDir, 'login-failed.jpg');

    snapshot = await page.screenshot({ path: file, type: 'jpeg', quality: 40, timeout: 5_000 })
      .then(() => ' Снимок экрана — в каталоге попытки (login-failed.jpg).')
      .catch(() => '');
  }

  // Исходное исключение Playwright — сжатый «locator.waitFor: Timeout» без адреса и
  // без формы; оно уже пересказано словами выше, поэтому наружу не уходит.
  return new ShowcaseError(
    'login_failed',
    `Вход на стенд не удался: ${where}; ${details}.${snapshot}`,
    502,
  );
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
