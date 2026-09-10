import { api } from './apiClient.ts';
import {
  parseShowcaseDoctor,
  parseShowcaseJob,
  parseShowcaseOverview,
  parseShowcaseProject,
  parseShowcaseTarget,
  parseShowcaseVoiceCatalog,
} from '../../../shared/showcaseContracts';
import type { ShowcaseAction, ShowcaseTargetRef } from '../../../shared/showcaseContracts';

export interface ShowcaseSceneDraft {
  title: string;
  screenId: string;
  narration: string;
  caption: string;
  subtitleText: string;
  actions: ShowcaseAction[];
}

export interface ShowcaseCreateOptions {
  ref: ShowcaseTargetRef;
  profile: string;
  title?: string;
}

/**
 * HTTP-клиент общий для приложения, но его JSON ещё не является данными раздела.
 * Каждый ответ проходит проверку контракта до попадания в реактивное состояние:
 * запись браузера и синтез речи — необратимые и небесплатные действия, и решать
 * по непроверенной форме, что цель готова, нельзя.
 */
export const showcaseApi = {
  async overview() {
    const value: unknown = await api.get('/api/showcase');

    return parseShowcaseOverview(value);
  },

  async project(id: string) {
    const value: unknown = await api.get(`/api/showcase/${encodeURIComponent(id)}`);

    return parseShowcaseProject(value);
  },

  async target(ref: ShowcaseTargetRef, profile: string) {
    const query = new URLSearchParams({
      kind: ref.kind,
      id: ref.id,
      profile,
    });
    const value: unknown = await api.get(`/api/showcase/target?${query.toString()}`);

    return parseShowcaseTarget(value);
  },

  async doctor(ref: ShowcaseTargetRef | null, profile: string) {
    const query = new URLSearchParams(ref ? {
      kind: ref.kind,
      id: ref.id,
      profile,
    } : {});
    const value: unknown = await api.get(`/api/showcase/doctor?${query.toString()}`);

    return parseShowcaseDoctor(value);
  },

  async create(options: ShowcaseCreateOptions) {
    const value: unknown = await api.post('/api/showcase', {
      kind: options.ref.kind,
      id: options.ref.id,
      profile: options.profile,
      title: options.title ?? '',
    });

    return parseShowcaseProject(value);
  },

  // Правка уходит со своей ожидаемой редакцией: сервер отвечает 409, если ролик
  // изменился в другом месте, и чужая работа не затирается.
  async rename(id: string, expectedRevision: number, title: string) {
    const value: unknown = await api.put(`/api/showcase/${encodeURIComponent(id)}`, {
      expectedRevision,
      title,
    });

    return parseShowcaseProject(value);
  },

  async remove(id: string) {
    await api.del(`/api/showcase/${encodeURIComponent(id)}`);
  },

  async addScene(id: string, expectedRevision: number, draft: ShowcaseSceneDraft) {
    const value: unknown = await api.post(`/api/showcase/${encodeURIComponent(id)}/scenes`, {
      expectedRevision,
      ...draft,
    });

    return parseShowcaseProject(value);
  },

  async updateScene(
    id: string,
    expectedRevision: number,
    sceneId: string,
    patch: Partial<ShowcaseSceneDraft>,
  ) {
    const path = `/api/showcase/${encodeURIComponent(id)}/scenes/${encodeURIComponent(sceneId)}`;
    const value: unknown = await api.put(path, {
      expectedRevision,
      ...patch,
    });

    return parseShowcaseProject(value);
  },

  async removeScene(id: string, expectedRevision: number, sceneId: string) {
    const path = `/api/showcase/${encodeURIComponent(id)}/scenes/${encodeURIComponent(sceneId)}`;
    const value: unknown = await api.del(path, { expectedRevision });

    return parseShowcaseProject(value);
  },

  // Порядок уходит полным списком: сервер отказывается достраивать частичный,
  // потому что достроенный порядок — это ролик, собранный не так, как виделось.
  async reorderScenes(id: string, expectedRevision: number, order: string[]) {
    const value: unknown = await api.put(`/api/showcase/${encodeURIComponent(id)}/order`, {
      expectedRevision,
      order,
    });

    return parseShowcaseProject(value);
  },

  /**
   * Загрузка звука сцены идёт формой: файл не помещается в JSON, а общий клиент
   * умеет multipart и сохраняет при этом разбор ошибок и выход по 401.
   */
  async importSceneAudio(id: string, expectedRevision: number, sceneId: string, file: File) {
    const form = new FormData();

    form.append('expectedRevision', String(expectedRevision));
    form.append('file', file, file.name);

    const path = `/api/showcase/${encodeURIComponent(id)}/scenes/${encodeURIComponent(sceneId)}/audio`;
    const value: unknown = await api.upload(path, form);

    return parseShowcaseProject(value);
  },

  async proposeBrief(id: string, taskText: string) {
    const value: unknown = await api.post(`/api/showcase/${encodeURIComponent(id)}/brief`, {
      taskText,
    });

    return parseShowcaseProject(value);
  },

  async proposeScript(id: string, taskText: string) {
    const value: unknown = await api.post(`/api/showcase/${encodeURIComponent(id)}/script`, {
      taskText,
    });

    return parseShowcaseProject(value);
  },

  /**
   * Доступность подготовки данных. Ответ разбирается вручную, а не общим декодером:
   * это служебная справка о живом состоянии стенда, а не данные ролика, и своего
   * места в контракте раздела у неё нет.
   */
  async seedStatus(id: string) {
    const value: unknown = await api.get(`/api/showcase/${encodeURIComponent(id)}/seed`);
    const source = asRecord(value);

    return {
      available: source.available === true,
      reason: typeof source.reason === 'string' ? source.reason : '',
      recipeFingerprint: typeof source.recipeFingerprint === 'string' ? source.recipeFingerprint : '',
      profile: typeof source.profile === 'string' ? source.profile : '',
      targetLabel: typeof source.targetLabel === 'string' ? source.targetLabel : '',
    };
  },

  /**
   * Запуск подготовки. Отпечаток рецепта обязателен: сервер сверит его ещё раз и
   * отклонит подтверждение, выданное на другой скрипт или другой стенд.
   */
  async prepareData(id: string, recipeFingerprint: string) {
    const value: unknown = await api.post(`/api/showcase/${encodeURIComponent(id)}/seed`, {
      recipeFingerprint,
    });
    const source = asRecord(value);

    return {
      state: typeof source.state === 'string' ? source.state : 'failed',
      reason: typeof source.reason === 'string' ? source.reason : '',
    };
  },

  async markDataUpdated(id: string) {
    await api.post(`/api/showcase/${encodeURIComponent(id)}/data-updated`, {});
  },

  async voices() {
    const value: unknown = await api.get('/api/showcase/voices');

    return parseShowcaseVoiceCatalog(value);
  },

  // Установка локального голоса. Ответ — тот же каталог: состояние движка,
  // список голосов и идущая установка приходят одним снимком, чтобы вид не
  // склеивал их из нескольких ответов.
  async installVoice(voiceId: string) {
    const value: unknown = await api.post('/api/showcase/voices/install', { voiceId });

    return parseShowcaseVoiceCatalog(value);
  },

  async cancelVoiceInstall() {
    const value: unknown = await api.post('/api/showcase/voices/install/cancel', {});

    return parseShowcaseVoiceCatalog(value);
  },

  async synthesize(id: string) {
    const value: unknown = await api.post(`/api/showcase/${encodeURIComponent(id)}/voice`, {});

    return parseShowcaseJob(value);
  },

  async startRecording(id: string) {
    const value: unknown = await api.post(`/api/showcase/${encodeURIComponent(id)}/record`, {});

    return parseShowcaseJob(value);
  },

  async assemble(id: string) {
    const value: unknown = await api.post(`/api/showcase/${encodeURIComponent(id)}/assemble`, {});

    return parseShowcaseJob(value);
  },

  /**
   * Адрес артефакта для плеера и скачивания. Ссылка идёт через тот же гейт, что и
   * остальные ручки раздела: плееру нужен обычный URL, а не выданный наружу файл.
   */
  artifactUrl(id: string, artifactId: string) {
    return api.url(
      `/api/showcase/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}`,
    );
  },

  async cancelJob(id: string) {
    const value: unknown = await api.post(`/api/showcase/jobs/${encodeURIComponent(id)}/cancel`, {});

    return parseShowcaseJob(value);
  },
};

// Тексты нужны только там, где сервер отвечает ОДНИМ кодом без пояснения: остальные
// отказы он формулирует сам, и вторая формулировка на клиенте разошлась бы с первой.
const MESSAGES: Record<string, string> = {
  plugin_disabled: 'Раздел «Презентации» выключен в настройках плагинов.',
  session_required: 'Разделом управляет человек: нужен вход в кокпит.',
  bad_target: 'Цель показа выбрана неверно.',
  bad_profile: 'Профиль выбран неверно.',
  bad_id: 'Ролик указан неверно.',
  bad_revision: 'Правка пришла без редакции ролика.',
  bad_scene: 'Сцена описана неверно: проверьте экран и действия.',
  bad_order: 'Новый порядок сцен не подошёл.',
  browser_missing: 'Браузер записи не установлен.',
  nothing_to_record: 'Все клипы сцен уже свежие — записывать нечего.',
  scene_not_ready: 'Сцена ещё не готова к сборке.',
  no_scenes: 'В ролике нет ни одной сцены.',
  voice_unavailable: 'Голосовой движок недоступен: загрузите готовый звук.',
  nothing_to_synthesize: 'Озвучивать нечего — звук сцен свежий.',
  empty_narration: 'У сцены нет текста для озвучки.',
  model_unavailable: 'Модель для брифа и сценария не выбрана в настройках плагина.',
  unsafe_model_provider: 'У выбранного исполнителя нет безопасного режима для недоверенного текста.',
  model_reply_invalid: 'Модель ответила не по форме — можно повторить или написать руками.',
  no_brief: 'Сначала нужен бриф: без него сценарий не о чем.',
  seed_unavailable: 'Подготовка данных для этой цели недоступна.',
  seed_decision_stale: 'Стенд или рецепт изменились: нужно подтвердить заново.',
  target_busy: 'По ролику уже идёт работа — подождите её завершения.',
  bad_decision: 'Подтверждение пришло без рецепта.',
  not_recovered: 'Кокпит ещё сверяет журнал заданий после перезапуска.',
  showcase_error: 'Сервер не смог выполнить действие — подробности в журнале кокпита.',
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/**
 * Текст отказа для человека. Общий клиент кладёт тело ответа в `data`: текст
 * сервера точнее всего, а карта кодов закрывает отказы, приходящие без пояснения.
 */
export function showcaseErrorMessage(error: unknown, fallback = 'Действие не удалось.'): string {
  const data = asRecord(asRecord(error).data);
  const detail = typeof data.message === 'string' ? data.message : '';
  const code = typeof data.error === 'string' ? data.error : '';

  return detail || MESSAGES[code] || fallback;
}
