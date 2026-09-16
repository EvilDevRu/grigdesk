// Бриф и сцены, предложенные моделью.
//
// Текст задачи и diff — НЕДОВЕРЕННЫЕ данные. Поэтому модель зовётся одноразовым
// безопасным режимом: без инструментов, рабочей области и продолжения сессии.
// Обычный `run` не используется даже как запасной путь.
//
// Форма ответа и идентификаторы проходят строгий разбор. Пробное исполнение
// дополняет карту наблюдениями браузера и проверяет рассказ по кадрам; исправление
// обязательно исполняется заново до публикации сцен и начала озвучки.
import path from 'node:path';

import { ShowcaseError } from './errors.ts';
import { launchRehearsal } from './script/rehearsalRunner.ts';
import {
  briefHashOf,
  readScriptProof,
  scriptHashOf,
  SCRIPT_VERIFICATION_VERSION,
  verifyAndRepairScript,
  writeScriptProof,
} from './script/verification.ts';
import { collectDiffContext } from './script/context.ts';
import {
  buildBindingsPrompt,
  buildBriefPrompt,
  buildRepairPrompt,
  buildScriptPrompt,
  SCRIPT_PROMPT_VERSION,
} from './script/prompt.ts';
import type { ScriptContext } from './script/prompt.ts';
import {
  parseBindingsReply,
  parseBrief,
  parseScriptReplyResult,
} from './script/writer.ts';
import type { BindingReplyScene, DraftSyncCue, ScriptReplyProblem } from './script/writer.ts';
import { applyGeneratedSyncCues } from './sceneOps.ts';
import {
  createScene,
  createSyncBindings,
  sceneSyncBindingsState,
} from './scenes.ts';
import { mapRevisionOf } from './targets.ts';
import type { ShowcaseProject, ShowcaseScene } from '../../../../shared/showcaseContracts.ts';
import type { ShowcaseStore } from './store.ts';
import type { ShowcaseTargets } from './targets.ts';
import type { SandboxActivityLease } from '../sandboxes/activityGuard.ts';

// Пометка о неполном diff. Модель видела не все изменения — план и сцены построены
// по видимой части, и человек должен знать об этом, не слушая оговорку в ролике.
const DIFF_TRUNCATED_NOTE = 'Изменения репозиториев прочитаны не полностью (длинные файлы '
  + 'обрезаны, тесты не читались): план и сцены построены по видимой части.';

// Длина текста задачи, которая доезжает до промпта. Постановки бывают на десятки
// килобайт, а разбору нужна суть: остальное всё равно вытеснит diff и карту экранов.
const TASK_TEXT_MAX = 4000;

// Срок одного вызова модели. Срок исполнителя по умолчанию — пять минут под триаж
// Входящих, а сценарий на opus с полным effort думает четыре-шесть минут: разбор
// срывался на пороге «Claude завершился без результата», хотя модель просто
// не успела. Запрос синхронный, человек ждёт на экране — поэтому срок конечен.
const SCRIPT_MODEL_TIMEOUT_MS = 15 * 60 * 1000;

// Попыток вызова модели на один запрос вместе с первой, когда исполнитель сообщил,
// что до API не дошёл сам запрос (обрывы соединения, повторы CLI до истечения
// срока). Сеть до API рвётся сериями по нескольку минут, а не по секунде: сборка
// идёт без человека, и падать из-за серии — значит показать ему красную ошибку
// через час. Третья попытка — это уже полчаса недоступной сети: дальше честнее
// остановиться с названной причиной, чем держать задание до его крайнего срока.
const MODEL_TRANSPORT_ATTEMPTS = 3;
// Пауза перед повтором. Повтор без паузы попадает в ту же серию обрывов.
const MODEL_TRANSPORT_PAUSE_MS = 60 * 1000;

/**
 * Описание задачи приходит размеченным. Модели нужен текст, а не теги, поэтому
 * разметка снимается здесь же: своего HTML-разбора у раздела нет и заводить его
 * ради одного поля незачем.
 */
function plainText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\[\/?[a-z][^\]]*\]/gi, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface ScriptOpsDeps {
  resolveBrowserPath?: () => Promise<string | null>;
  assertEnabled: () => void;
  broadcast: (event: string, data: unknown) => void;
  limits: () => { maxScenes: number };
  readProject: (id: string) => Promise<ShowcaseProject>;
  // Модель приходит резолвером: раздел не знает, как устроен выбор исполнителя,
  // но обязан получить именно model-only режим.
  resolveScriptModel: ((options: {
    modelRef: unknown;
    config: Record<string, unknown>;
    requireImages: boolean;
    log: { warn?: (data: unknown, message: string) => unknown };
  }) => Promise<unknown>) | null;
  scriptModelRef: (() => unknown) | null;
  // Связь стенда с задачей портала принадлежит серверу. Раздел не знает ни адреса
  // портала, ни его протокола — только просит текст по номеру стенда.
  taskDetails: ((taskId: string) => Promise<{
    title?: unknown;
    description?: unknown;
  } | null>) | null;
  // Серверный config исполнителей и настройки провайдеров: путь к CLI и каталог
  // моделей объявлены в config.ts, и без них вызов падает на запуске процесса.
  executorConfig: (() => Record<string, unknown>) | null;
  providerSettings: (() => Record<string, unknown>) | null;
  acquireTargetLease: (ref: ShowcaseProject['ref']) => Promise<SandboxActivityLease | null>;
  // Ожидание перед повтором запроса к модели: тесты подменяют его, чтобы не ждать.
  pause?: (ms: number) => Promise<void>;
  store: ShowcaseStore;
  targets: ShowcaseTargets;
  // Ответ мутации — с живой целью и свежестью сцен, как у чтения; сам снимок цели
  // в project.json для интерфейса не годится (см. publish в service).
  publish: (project: ShowcaseProject) => Promise<ShowcaseProject> | ShowcaseProject;
}

export function createScriptOps(deps: ScriptOpsDeps) {
  const {
    assertEnabled, broadcast, limits, readProject, store, targets, publish,
  } = deps;

  /**
   * Одноразовый вызов модели на недоверенном тексте. Обычный `run` не используется
   * даже как запасной путь: текст задачи и diff не должны получить инструменты,
   * рабочую область и продолжение сессии.
   */
  async function runUntrustedModel(
    prompt: string,
    images: { mediaType: string; data: string }[] = [],
    onProgress?: (label: string) => Promise<void>,
  ): Promise<string> {
    const resolver = deps.resolveScriptModel;

    if (!resolver) {
      throw new ShowcaseError('model_unavailable', 'Модель для сценария не подключена.', 503);
    }

    const config = deps.executorConfig?.() ?? {};
    const target = await resolver({
      modelRef: deps.scriptModelRef?.() ?? null,
      config,
      requireImages: images.length > 0,
      log: {},
    }) as Record<string, unknown> | null;

    if (!target || target.ok !== true) {
      throw new ShowcaseError(
        'model_unavailable',
        target?.error === 'unsupported_media'
          ? 'Выбранная модель не умеет проверять кадры ролика. Нужна модель с поддержкой изображений.'
          : 'Модель для брифа и сценария не выбрана или недоступна.',
        503,
      );
    }

    const executor = target.executor as Record<string, unknown> | undefined;
    const runUntrusted = executor?.runUntrusted;

    if (typeof runUntrusted !== 'function') {
      throw new ShowcaseError(
        'unsafe_model_provider',
        'Выбранный исполнитель не умеет безопасный режим недоверенного ввода.',
        503,
      );
    }

    const ref = target.ref as { provider: string; model: string };
    const settings = deps.providerSettings?.() ?? {};
    const pause = deps.pause ?? ((ms: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }));
    let reply: unknown;

    for (let attempt = 1; ; attempt += 1) {
      try {
        reply = await runUntrusted.call(executor, {
          config,
          message: prompt,
          model: ref.model,
          effort: typeof target.effort === 'string' ? target.effort : undefined,
          images,
          providerSettings: (settings[ref.provider] ?? {}) as Record<string, unknown>,
          timeoutMs: SCRIPT_MODEL_TIMEOUT_MS,
          log: {},
        });

        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: string })?.code;

        if (code === 'model_rate_limited' || /hit your (?:session|usage) limit/iu.test(message)) {
          const reset = /resets\s+([^\n]+)/iu.exec(message)?.[1]?.slice(0, 120);

          throw new ShowcaseError(
            'model_rate_limited',
            'Выбранная модель сценария исчерпала лимит. '
              + (reset ? `Сброс по ответу провайдера: ${reset}. ` : '')
              + 'Повторите сборку после сброса лимита или выберите другую модель в настройках плагина.',
            429,
          );
        }

        if (code !== 'model_unreachable') {
          throw error;
        }

        if (attempt >= MODEL_TRANSPORT_ATTEMPTS) {
          throw new ShowcaseError(
            'model_unreachable',
            `Модель сценария недоступна по сети: ${attempt} попытки подряд не дошли до API `
              + `(${message}). Повторите сборку, когда сеть восстановится.`,
            502,
          );
        }

        // Отчёт о ходе заодно проверяет, что задание не отменили, пока шёл срок:
        // отменённая подготовка не должна занимать модель ещё четверть часа.
        await onProgress?.(`Модель недоступна по сети (${message}). `
          + `Повтор ${attempt + 1} из ${MODEL_TRANSPORT_ATTEMPTS} через минуту.`);
        await pause(MODEL_TRANSPORT_PAUSE_MS);
        await onProgress?.(
          `Повторяю запрос к модели: попытка ${attempt + 1} из ${MODEL_TRANSPORT_ATTEMPTS}.`,
        );
      }
    }

    // Исполнители отдают ответ полем `reply` — тем же, что читают триаж Входящих и
    // название коммита. Читать другое поле значит получать пустую строку и винить
    // модель за «ответ не по форме».
    return typeof reply === 'string' ? reply : String((reply as { reply?: unknown })?.reply ?? '');
  }

  /**
   * Контекст генерации. Пути и Git-ссылки сервер берёт у зарегистрированных
   * репозиториев стенда: модель не выбирает, что ей показать.
   */
  async function scriptContextOf(project: ShowcaseProject, taskText: string): Promise<{
    context: ScriptContext;
    // Ревизия словаря карты, по которому собран контекст: сценарий запоминает её,
    // чтобы после правки карты экранов интерфейс мог сказать «сцены старше карты».
    mapRevision: string;
  }> {
    if (project.target.status !== 'ready') {
      throw new ShowcaseError('target_unavailable', project.target.reason, 409);
    }

    const lease = await deps.acquireTargetLease(project.ref);

    try {
      const scope = await targets.selectedInternalScope(
        project.ref,
        project.target.scope.profile,
        project.target.scope.targetFingerprint,
      );

      await lease?.assertPathIdentity();

      const diff = await collectDiffContext(scope.sandbox?.repos ?? []);

      return {
        context: {
          taskTitle: project.title,
          taskText,
          diff: diff.diff,
          diffBase: diff.base,
          diffHead: diff.head,
          diffTruncated: diff.truncated,
          screens: scope.screens.map((screen) => ({
            id: screen.id,
            title: screen.title,
            path: screen.path,
            elements: screen.elements.map((element) => ({ id: element.id, title: element.title })),
          })),
          maxScenes: limits().maxScenes,
        },
        mapRevision: mapRevisionOf(scope.screens),
      };
    } finally {
      await lease?.release();
    }
  }

  /**
   * Бриф. Одна попытка исправить форму ответа и не больше: крутить модель по кругу
   * дорого, а человеку полезнее честный отказ с возможностью повторить самому.
   */
  async function generateBrief(
    id: string,
    taskText: string,
    onProgress?: (label: string) => Promise<void>,
  ): Promise<ShowcaseProject> {
    assertEnabled();

    const project = await readProject(id);
    const { context } = await scriptContextOf(project, taskText);
    const prompt = buildBriefPrompt(context);

    await onProgress?.('Готовлю план по задаче и изменениям на стенде.');
    const first = await runUntrustedModel(prompt, [], onProgress);
    let points = parseBrief(first);

    if (!points) {
      points = parseBrief(await runUntrustedModel(buildRepairPrompt(prompt, first), [], onProgress));
    }

    if (!points) {
      throw new ShowcaseError(
        'model_reply_invalid',
        'Модель не вернула бриф нужной формы. Можно повторить или написать пункты руками.',
        502,
      );
    }

    const saved = await store.updateProject(id, project.revision, (current) => ({
      ...current,
      brief: points,
      decisions: [
        ...current.decisions.filter((item) => item.kind !== 'script'),
        {
          id: `brief-${Date.now().toString(36)}`,
          kind: 'script' as const,
          // Решение привязано к версии промпта: бриф, собранный прошлой версией,
          // нельзя выдавать за собранный текущей.
          inputHash: SCRIPT_PROMPT_VERSION,
          decidedAt: new Date().toISOString(),
          note: 'Бриф предложен моделью и ждёт правки человека.',
        },
      ],
    }));

    broadcast('showcase-changed', { projectId: id, revision: saved.revision });

    return publish(saved);
  }

  /**
   * Сценарий по ПРИНЯТОМУ брифу. Негодный ответ не меняет сохранённую редакцию:
   * человеку остаётся то, что он уже видел, а не половина новой версии.
   *
   * Годный ответ ЗАМЕНЯЕТ сцены ролика: «разобрать заново» — это новый сценарий, а
   * не дописанный к прежнему. Голос и темп ролика при этом переживают замену: их
   * выбирал человек для ролика целиком, а не для конкретных сцен.
   */
  async function generateScript(
    id: string,
    taskText: string,
    keepScenes = false,
    onProgress?: (label: string) => Promise<void>,
  ): Promise<ShowcaseProject> {
    assertEnabled();

    const project = await readProject(id);

    if (project.brief.length === 0) {
      throw new ShowcaseError('no_brief', 'Сначала нужен бриф: без него сценарий не о чем.', 409);
    }

    const { context, mapRevision } = await scriptContextOf(project, taskText);
    const prompt = buildScriptPrompt(context, project.brief);

    await onProgress?.(keepScenes ? 'Проверяю сохранённый сценарий.' : 'Готовлю действия и текст сцен.');
    const first = keepScenes ? '' : await runUntrustedModel(prompt, [], onProgress);
    let parsed = keepScenes ? {
      problem: null,
      draft: {
        gaps: project.scriptGaps ?? [],
        scenes: [...project.scenes].sort((a, b) => a.order - b.order).map((scene) => ({
          title: scene.title,
          screenId: scene.screenId,
          startState: scene.startState,
          readyCondition: scene.readyCondition,
          continuesPrevious: scene.continuesPrevious ?? false,
          narration: scene.narration,
          caption: scene.caption,
          subtitleText: scene.subtitleText,
          actions: scene.actions,
          syncCues: null,
        })),
      },
    } : parseScriptReplyResult(first, context.screens, context.maxScenes);
    let problem = parsed.problem;

    if (!parsed.draft) {
      parsed = parseScriptReplyResult(
        await runUntrustedModel(buildRepairPrompt(prompt, first), [], onProgress),
        context.screens,
        context.maxScenes,
      );
      problem = parsed.problem ?? problem;
    }

    if (!parsed.draft) {
      const detail = problem?.message;

      throw new ShowcaseError(
        detail ? 'model_bindings_invalid' : 'model_reply_invalid',
        detail
          ? `${detail} Не удалось однозначно связать речь с действиями.`
          : 'Модель не вернула сценарий нужной формы после автоматического повтора.',
        502,
      );
    }

    let draft = parsed.draft;
    let scriptProofHash: string | null = null;
    const browserPath = await deps.resolveBrowserPath?.();

    if (browserPath) {
      const lease = await deps.acquireTargetLease(project.ref);

      try {
        if (project.target.status !== 'ready') {
          throw new ShowcaseError('target_unavailable', project.target.reason, 409);
        }

        const scope = await targets.selectedInternalScope(
          project.ref, project.target.scope.profile, project.target.scope.targetFingerprint,
        );

        await lease?.assertPathIdentity();

        const previousProof = await readScriptProof(store.namesOf(id).dir, project, false);

        const verified = await verifyAndRepairScript({
          context,
          brief: project.brief,
          draft,
          runModel: (candidate, images) => runUntrustedModel(candidate, images, onProgress),
          onProgress,
          allowRepair: !keepScenes || (!project.scriptProofHash && Boolean(project.scriptMapRevision)),
          rehearse: (candidate, previous) => launchRehearsal({
            scope,
            targets,
            browserPath,
            workDir: path.join(store.namesOf(id).dir, 'rehearsals'),
            inheritedFds: lease ? [lease.inheritedFd()] : undefined,
            draft: candidate,
            previous: previous ?? previousProof?.rehearsal ?? null,
          }),
        });

        draft = verified.draft;
        scriptProofHash = await writeScriptProof(store.namesOf(id).dir, {
          version: SCRIPT_VERIFICATION_VERSION,
          targetFingerprint: scope.targetFingerprint,
          policyRevision: scope.policyRevision,
          dataRevision: scope.dataRevision,
          briefHash: briefHashOf(project.brief),
          scriptHash: scriptHashOf(draft.scenes),
          rehearsal: verified.rehearsal,
        });
      } finally {
        await lease?.release();
      }
    }

    const { scenes: drafts } = draft;
    // Обрезка изменений — знание для человека, а не тема ролика: она идёт в тот же
    // список, что и пробелы карты, а не в озвучку заключительной сцены.
    const gaps = [
      ...draft.gaps.filter((gap) => gap !== DIFF_TRUNCATED_NOTE),
      ...(context.diffTruncated ? [DIFF_TRUNCATED_NOTE] : []),
    ];

    const savedScenes = [...project.scenes].sort((a, b) => a.order - b.order);

    if (keepScenes && scriptHashOf(drafts) === scriptHashOf(savedScenes)) {
      const saved = await store.updateProject(id, project.revision, (current) => ({
        ...current,
        scriptGaps: gaps,
        scriptMapRevision: current.scriptMapRevision ? mapRevision : null,
        scriptProofHash,
      }));

      broadcast('showcase-changed', { projectId: id, revision: saved.revision });

      return publish(saved);
    }
    const saved = await store.updateProject(id, project.revision, (current) => {
      const previous = [...current.scenes].sort((left, right) => left.order - right.order).at(-1);
      let next: ShowcaseProject = {
        ...current,
        scenes: [],
        scriptGaps: gaps,
        scriptMapRevision: mapRevision,
        scriptProofHash,
      };

      for (const item of drafts) {
        // Первая новая сцена наследует голос и темп у последней прежней, дальше
        // наследование идёт по цепочке само — как при добавлении сцены руками.
        const seed = next.scenes.length === 0 && previous ? { ...next, scenes: [previous] } : next;
        const scene = createScene(seed, {
          title: item.title,
          screenId: item.screenId,
          narration: item.narration,
          caption: item.caption,
          subtitleText: item.subtitleText,
          startState: null,
          readyCondition: null,
          continuesPrevious: item.continuesPrevious,
          actions: item.actions,
          syncBindings: item.syncCues && item.syncCues.length > 0
            ? createSyncBindings(item.narration, item.actions, item.syncCues)
            : null,
        });

        next = {
          ...next,
          scenes: [...next.scenes, { ...scene, order: next.scenes.length + 1 }],
        };
      }

      return next;
    });

    broadcast('showcase-changed', { projectId: id, revision: saved.revision });

    return publish(saved);
  }

  /**
   * Готовит снимок уже принятого сценария для модели. Ручные связи входят только
   * занятыми индексами: цитаты человека модели не нужны и заменять их она не может.
   */
  function bindingScenesOf(project: ShowcaseProject): BindingReplyScene[] {
    return [...project.scenes]
      .sort((left, right) => left.order - right.order)
      .map((scene) => {
        const manual = (scene.syncBindings?.cues ?? []).filter((cue) => cue.origin === 'manual');
        const state = sceneSyncBindingsState(scene);

        if (manual.length > 0 && state.status !== 'valid') {
          throw new ShowcaseError(
            'stale_manual_bindings',
            `Ручные привязки сцены «${scene.title}» потеряли актуальность. Исправьте эту сцену.`,
            409,
          );
        }

        return {
          id: scene.id,
          title: scene.title,
          narration: scene.narration,
          actions: scene.actions,
          manualActionIndices: manual.map((cue) => cue.actionIndex),
        };
      });
  }

  /** Проверяет совместимость модельных связей с сохранёнными ручными cue. */
  function mergeGeneratedBindings(
    scenes: readonly BindingReplyScene[],
    project: ShowcaseProject,
    bindings: ReadonlyMap<string, DraftSyncCue[]>,
  ): { changed: Map<string, ShowcaseScene>; problem: ScriptReplyProblem | null } {
    const changed = new Map<string, ShowcaseScene>();

    for (const [sceneIndex, context] of scenes.entries()) {
      const scene = project.scenes.find((item) => item.id === context.id) as ShowcaseScene;

      try {
        changed.set(scene.id, applyGeneratedSyncCues(scene, bindings.get(scene.id) ?? []));
      } catch (error) {
        if (!(error instanceof ShowcaseError)) {
          throw error;
        }

        return {
          changed,
          problem: {
            sceneId: scene.id,
            sceneIndex,
            message: `Сцена «${scene.title}»: ${error.message}`,
          },
        };
      }
    }

    return { changed, problem: null };
  }

  /**
   * Для существующего проекта модель строит только смысловые связи. Два ответа —
   * исходный и один repair — предел операции. До атомарной записи narration,
   * actions, порядок и ручные cue остаются неизменными.
   */
  async function generateBindings(id: string): Promise<ShowcaseProject> {
    assertEnabled();

    const project = await readProject(id);

    if (project.scenes.length === 0) {
      throw new ShowcaseError('no_scenes', 'В ролике нет сцен для привязки.', 409);
    }

    const scenes = bindingScenesOf(project);
    const prompt = buildBindingsPrompt(scenes.map((scene) => ({
      id: scene.id,
      title: scene.title,
      narration: scene.narration,
      actions: scene.actions.map((action) => ({ ...action })),
      manualActionIndices: scene.manualActionIndices,
    })));
    let previousReply = '';
    let prepared: Map<string, ShowcaseScene> | null = null;
    let problem: ScriptReplyProblem | null = null;

    for (let attempt = 0; attempt < 2 && !prepared; attempt += 1) {
      const reply = await runUntrustedModel(
        attempt === 0 ? prompt : buildRepairPrompt(prompt, previousReply),
      );
      const parsed = parseBindingsReply(reply, scenes);

      previousReply = reply;
      problem = parsed.problem ?? problem;

      if (!parsed.bindings) {
        continue;
      }

      const merged = mergeGeneratedBindings(scenes, project, parsed.bindings);

      prepared = merged.problem ? null : merged.changed;
      problem = merged.problem ?? problem;
    }

    if (!prepared) {
      throw new ShowcaseError(
        problem ? 'model_bindings_invalid' : 'model_reply_invalid',
        problem?.message
          ?? 'Модель не вернула смысловые привязки нужной формы. Исправьте сцены вручную.',
        502,
      );
    }

    const saved = await store.updateProject(id, project.revision, (current) => ({
      ...current,
      scenes: current.scenes.map((scene) => {
        const updated = prepared?.get(scene.id);

        return updated ? { ...scene, syncBindings: updated.syncBindings } : scene;
      }),
    }));

    broadcast('showcase-changed', { projectId: id, revision: saved.revision });

    return publish(saved);
  }

  /**
   * Разбор целиком: текст связанной задачи, бриф и сцены одним шагом. Человек в
   * мастере не собирает ролик по кнопкам — он говорит, ЧТО показать, и получает
   * готовый план. Отсутствие задачи в портале разбор не останавливает: diff стенда
   * и карта экранов остаются на месте, а текст был лишь подсказкой модели.
   */
  async function analyze(id: string, onProgress?: (label: string) => Promise<void>): Promise<ShowcaseProject> {
    assertEnabled();

    const project = await readProject(id);
    const taskText = await taskTextOf(project);

    await generateBrief(id, taskText, onProgress);

    return generateScript(id, taskText, false, onProgress);
  }

  /**
   * Текст задачи из портала. Стенд задачи назван её номером, поэтому связь ищется
   * по нему и только на сервере: браузер номер задачи не присылает и подменить его
   * не может. Любая беда портала здесь — не отказ разбора, а пустой текст.
   */
  async function taskTextOf(project: ShowcaseProject): Promise<string> {
    if (project.ref.kind === 'project' || !deps.taskDetails) {
      return '';
    }

    try {
      const details = await deps.taskDetails(project.ref.id);

      if (!details) {
        return '';
      }

      const title = String(details.title ?? '').trim();
      const description = plainText(String(details.description ?? ''));

      return [title, description].filter(Boolean).join('\n\n').slice(0, TASK_TEXT_MAX);
    } catch {
      return '';
    }
  }

  /** Полный запуск старого автоматического сценария сам обновляет его проверку. */
  async function ensurePrepared(
    id: string,
    onProgress?: (label: string) => Promise<void>,
  ): Promise<ShowcaseProject> {
    const project = await readProject(id);

    if (await readScriptProof(store.namesOf(id).dir, project)) {
      return project;
    }

    if (!(await deps.resolveBrowserPath?.())) {
      throw new ShowcaseError('browser_missing', 'Для проверки сценария нужен браузер записи.', 503);
    }

    return project.brief.length > 0
      ? generateScript(id, await taskTextOf(project), project.scenes.length > 0, onProgress)
      : analyze(id, onProgress);
  }

  return { analyze, ensurePrepared, generateBindings, generateBrief, generateScript };
}
