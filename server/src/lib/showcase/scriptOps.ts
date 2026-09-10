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

    const target = await resolver({
      modelRef: deps.scriptModelRef?.() ?? null,
      config: {},
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
    const reply: unknown = await runUntrusted.call(executor, {
      config: {},
      message: prompt,
      model: ref.model,
      effort: typeof target.effort === 'string' ? target.effort : undefined,
      images: [],
      providerSettings: {},
      log: {},
    });

    return typeof reply === 'string' ? reply : String((reply as { text?: string })?.text ?? '');
  }

  /**
   * Контекст генерации. Пути и Git-ссылки сервер берёт у зарегистрированных
   * репозиториев стенда: модель не выбирает, что ей показать.
   */
  async function scriptContextOf(project: ShowcaseProject, taskText: string): Promise<ScriptContext> {
    if (project.target.status !== 'ready') {
      throw new ShowcaseError('target_unavailable', project.target.reason, 409);
    }

    const scope = await targets.internalScope(project.ref, project.target.scope.profile);
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

  return { generateBrief, generateScript };
}
