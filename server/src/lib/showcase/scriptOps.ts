// Бриф и сцены, предложенные моделью.
//
// Текст задачи и diff — НЕДОВЕРЕННЫЕ данные. Поэтому модель зовётся одноразовым
// безопасным режимом: без инструментов, рабочей области и продолжения сессии.
// Обычный `run` не используется даже как запасной путь.
//
// Ответ модели проверяется как данные из сети: каждый идентификатор экрана и
// элемента сверяется с картой профиля, а форма — разбором. Одна попытка исправить
// форму и не больше: крутить модель по кругу дорого, а человеку полезнее честный
// отказ с возможностью написать сцены самому.
import { ShowcaseError } from './errors.ts';
import { collectDiffContext } from './script/context.ts';
import {
  buildBriefPrompt,
  buildRepairPrompt,
  buildScriptPrompt,
  SCRIPT_PROMPT_VERSION,
} from './script/prompt.ts';
import type { ScriptContext } from './script/prompt.ts';
import { parseBrief, parseScript } from './script/writer.ts';
import { createScene } from './scenes.ts';
import type { ShowcaseProject } from '../../../../shared/showcaseContracts.ts';
import type { ShowcaseStore } from './store.ts';
import type { ShowcaseTargets } from './targets.ts';
import type { SandboxActivityLease } from '../sandboxes/activityGuard.ts';

// Длина текста задачи, которая доезжает до промпта. Постановки бывают на десятки
// килобайт, а разбору нужна суть: остальное всё равно вытеснит diff и карту экранов.
const TASK_TEXT_MAX = 4000;

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
  assertEnabled: () => void;
  broadcast: (event: string, data: unknown) => void;
  limits: () => { maxScenes: number };
  readProject: (id: string) => Promise<ShowcaseProject>;
  // Модель приходит резолвером: раздел не знает, как устроен выбор исполнителя,
  // но обязан получить именно model-only режим.
  resolveScriptModel: ((options: {
    modelRef: unknown;
    config: Record<string, unknown>;
    requireImages: false;
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
  store: ShowcaseStore;
  targets: ShowcaseTargets;
  withFreshness: (project: ShowcaseProject) => ShowcaseProject;
}

export function createScriptOps(deps: ScriptOpsDeps) {
  const {
    assertEnabled, broadcast, limits, readProject, store, targets, withFreshness,
  } = deps;

  /**
   * Одноразовый вызов модели на недоверенном тексте. Обычный `run` не используется
   * даже как запасной путь: текст задачи и diff не должны получить инструменты,
   * рабочую область и продолжение сессии.
   */
  async function runUntrustedModel(prompt: string): Promise<string> {
    const resolver = deps.resolveScriptModel;

    if (!resolver) {
      throw new ShowcaseError('model_unavailable', 'Модель для сценария не подключена.', 503);
    }

    const config = deps.executorConfig?.() ?? {};
    const target = await resolver({
      modelRef: deps.scriptModelRef?.() ?? null,
      config,
      requireImages: false,
      log: {},
    }) as Record<string, unknown> | null;

    if (!target || target.ok !== true) {
      throw new ShowcaseError(
        'model_unavailable',
        'Модель для брифа и сценария не выбрана или недоступна.',
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
    const reply: unknown = await runUntrusted.call(executor, {
      config,
      message: prompt,
      model: ref.model,
      effort: typeof target.effort === 'string' ? target.effort : undefined,
      images: [],
      providerSettings: (settings[ref.provider] ?? {}) as Record<string, unknown>,
      log: {},
    });

    // Исполнители отдают ответ полем `reply` — тем же, что читают триаж Входящих и
    // название коммита. Читать другое поле значит получать пустую строку и винить
    // модель за «ответ не по форме».
    return typeof reply === 'string' ? reply : String((reply as { reply?: unknown })?.reply ?? '');
  }

  /**
   * Контекст генерации. Пути и Git-ссылки сервер берёт у зарегистрированных
   * репозиториев стенда: модель не выбирает, что ей показать.
   */
  async function scriptContextOf(project: ShowcaseProject, taskText: string): Promise<ScriptContext> {
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
          elements: screen.elements.map((element) => ({ id: element.id })),
        })),
        maxScenes: limits().maxScenes,
      };
    } finally {
      await lease?.release();
    }
  }

  /**
   * Бриф. Одна попытка исправить форму ответа и не больше: крутить модель по кругу
   * дорого, а человеку полезнее честный отказ с возможностью повторить самому.
   */
  async function generateBrief(id: string, taskText: string): Promise<ShowcaseProject> {
    assertEnabled();

    const project = await readProject(id);
    const context = await scriptContextOf(project, taskText);
    const prompt = buildBriefPrompt(context);
    const first = await runUntrustedModel(prompt);
    let points = parseBrief(first);

    if (!points) {
      points = parseBrief(await runUntrustedModel(buildRepairPrompt(prompt, first)));
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

    return withFreshness(saved);
  }

  /**
   * Сценарий по ПРИНЯТОМУ брифу. Негодный ответ не меняет сохранённую редакцию:
   * человеку остаётся то, что он уже видел, а не половина новой версии.
   */
  async function generateScript(id: string, taskText: string): Promise<ShowcaseProject> {
    assertEnabled();

    const project = await readProject(id);

    if (project.brief.length === 0) {
      throw new ShowcaseError('no_brief', 'Сначала нужен бриф: без него сценарий не о чем.', 409);
    }

    const context = await scriptContextOf(project, taskText);
    const prompt = buildScriptPrompt(context, project.brief);
    const first = await runUntrustedModel(prompt);
    let drafts = parseScript(first, context.screens, context.maxScenes);

    if (!drafts) {
      drafts = parseScript(
        await runUntrustedModel(buildRepairPrompt(prompt, first)),
        context.screens,
        context.maxScenes,
      );
    }

    if (!drafts) {
      throw new ShowcaseError(
        'model_reply_invalid',
        'Модель не вернула сценарий нужной формы. Сцены можно собрать руками.',
        502,
      );
    }

    const saved = await store.updateProject(id, project.revision, (current) => {
      let next = current;

      for (const draft of drafts) {
        next = {
          ...next,
          scenes: [...next.scenes, createScene(next, {
            title: draft.title,
            screenId: draft.screenId,
            narration: draft.narration,
            caption: draft.caption,
            subtitleText: draft.subtitleText,
            startState: null,
            readyCondition: null,
            actions: draft.actions,
          })],
        };
      }

      return next;
    });

    broadcast('showcase-changed', { projectId: id, revision: saved.revision });

    return withFreshness(saved);
  }

  /**
   * Разбор целиком: текст связанной задачи, бриф и сцены одним шагом. Человек в
   * мастере не собирает ролик по кнопкам — он говорит, ЧТО показать, и получает
   * готовый план. Отсутствие задачи в портале разбор не останавливает: diff стенда
   * и карта экранов остаются на месте, а текст был лишь подсказкой модели.
   */
  async function analyze(id: string): Promise<ShowcaseProject> {
    assertEnabled();

    const project = await readProject(id);
    const taskText = await taskTextOf(project);

    await generateBrief(id, taskText);

    return generateScript(id, taskText);
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

  return { analyze, generateBrief, generateScript };
}
