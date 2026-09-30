// Загрузчик исполнителей (LLM-движков) — МОДУЛЬНОЕ подключение:
// один файл в этой папке = один ИИ. Файл экспортирует default-объект контракта:
//   id       — стабильный ключ (на него ссылаются схемы/чаты)
//   name     — человекочитаемое имя ('GPT (Codex)')
//   vendor   — производитель ('OpenAI')
//   color    — фирменный цвет иконки
//   order    — порядок в списках (меньше = выше)
//   install? — команда установки CLI для setup-карточки
//   login?   — отдельная команда авторизации уже установленного CLI; если её нет,
//              карточка использует install как совместимый запасной вариант
//   bin(config)              — какой бинарь пробовать
//   probe(config)            — { ok, version } — установлен ли
//   auth(config, deps)       — { mode, label } — авторизован ли
//   efforts?(config)         — динамическое обнаружение уровней эффорта (или null)
//   modes?(config)           — режимы прав: [{ id, label, hint }] (или null)
//   seedModels()             — стартовый список моделей для models.json
//   catalog?(config)         — полный список моделей, поддерживаемых установленным CLI
//                              (обновляется при смене версии; см. models-registry)
//   catalogLive?             — каталог зависит от rollout/аккаунта, опрашивать каждый кэш-цикл
//   catalogCacheKey?(config) — persisted fingerprint env/policy помимо версии CLI;
//                              сменился → локальный каталог пересобирается после рестарта
//   modelFamily?(model)      — стабильное семейство записи каталога для model policy
//   familyClass?(family)     — класс семейства (reasoning|balanced|cheap) для сверки
//                              рекомендаций шаблонов агентов с политикой профиля.
//                              Не объявлен → сверка для этого ИИ не проводится
//   statusPage?              — URL официальной страницы состояния вендора. Когда лимиты
//                              не пришли по причине на его стороне, кокпит читает её сам
//                              (`lib/provider-status.js`, формат Atlassian Statuspage) и
//                              кладёт разобранное состояние в `usage.vendorStatus`;
//                              незнакомый движок страницы даёт `unknown`, и остаётся
//                              одна ссылка. Локальный исполнитель поля не объявляет: его
//                              сбой на внешней странице не виден
//   usage?()                 — состояние лимитов + provider-neutral account resources.
//                              У ручки ресурса (`controls[]`) есть `scope`: по умолчанию
//                              её меняют ТОЛЬКО в плашке настроек, а всплывашка топбара
//                              показывает значение текстом. `scope: 'live'` — операция
//                              над рантаймом (выгрузить модель, использовать сброс
//                              лимита): такую ручку видно и во всплывашке
//   usageActions?            — явная Map-подобная таблица разрешённых действий ресурсов
//   mcpStatus?(config)       — состояние MCP-серверов этого CLI для его плашки:
//                              { state: 'ok'|'error', error?, note?, groups?, servers:
//                              [{ name, target, scope: 'user'|'project'|'account',
//                              state: 'ok'|'failed'|'needs-auth'|'configured'|'disabled'|
//                              'remote'|'unknown', detail, hint? }] }. groups переименовывает
//                              scope для конкретного CLI. Метод ЛЕНИВЫЙ: его зовёт только
//                              `GET /api/providers/:id/mcp`, потому что живой health-check
//                              может стоить секунд. Не объявлен — UI всё равно резервирует
//                              место, но показывает нейтральный placeholder без запроса
//   updateCmd?               — команда обновления CLI (кнопка «Обновить» в настройках)
//   settings?                — СВОИ настройки исполнителя для его плашки в
//                              «Настройках → Исполнители»: [{ id, kind, label, hint?,
//                              value, disabled?, note?, min?, max?, step?, confirm? }]
//                              ЛИБО
//                              async-функция (config) → такой же массив — для деклараций,
//                              зависящих от окружения исполнителя. kind: 'toggle' |
//                              'text' | 'number' | 'range' (ползунок, обязаны min/max/step;
//                              значение приводится к числу, как у 'number'). Ручки у разных
//                              ИИ разные, поэтому список объявляет сам executor, а UI только
//                              рисует его по kind. `disabled: true` + `note` — ручка
//                              объявлена, но ещё не подключена к ходу (тумблер показан и
//                              не работает). `confirm.on/off` — направленное подтверждение
//                              `{ text, label?, danger? }`; сервер принимает такую смену
//                              только с точным `confirmed: true`.
//   directSshPolicy?         — как адаптер обеспечивает запрет прямого SSH: объект
//                              либо `(config) => object`, где enforcement — один из
//                              command-hook|network-sandbox|fail-closed|
//                              unsupported, note? — честная режимная граница для UI.
//                              Не объявлен или сломан → unsupported.
//   workdir?                 — { switch: 'resume'|'reseed', roots: 'multi'|'single' }
//                              либо `(config) => capability`, если возможности зависят
//                              от режима запуска. Нет/сломана → перенос не обещается.
//   validateWorkdir?         — чистая проверка cwd/extraDirs до переноса и запуска:
//                              { error?, extraDirs, rejected?: [{ path, reason }] }.
//                              Признак уезжает в `/api/providers`, чтобы UI называл
//                              поддерживающих исполнителей без списка вендоров в Vue.
//   autoCompactEnv?          — имя переменной окружения, которой CLI задаётся ПОРОГ
//                              автокомпакта в токенах. Есть → кокпит подставляет туда
//                              значение из «Настроек → Запуски». Нет → у этого CLI
//                              может быть свой transport через opts.compactWindow.
//   chatAutoCompact?         — адаптер применяет opts.compactWindow своим transport.
//                              Вместе с autoCompactEnv объявляет поддержку порога UI.
//   session?                 — умеет ли исполнитель ЖИТЬ между ходами:
//                              { mode: 'persistent'|'per-turn', unsolicited: boolean,
//                                restartOn?: string[], open(spec) -> handle }.
//                              Не объявлен → процесс поднимается на каждый ход, как раньше.
//                              `mode: 'persistent'` означает, что handle обслуживает много
//                              ходов подряд: handle.send({message, onStep, onProgress})
//                              возвращает то же, что run(), handle.interrupt() прерывает
//                              ХОД (не сессию), handle.close() гасит процесс.
//                              `unsolicited: true` — исполнитель может выдать ход БЕЗ
//                              запроса (у claude так отчитываются фоновые задачи и
//                              субагенты); такой ход уезжает в hooks.onBackground и дальше
//                              в историю чата, а не в ответ HTTP.
//                              `restartOn` — поля spec, которые задаются при запуске
//                              процесса и потому требуют переоткрытия сессии (модель,
//                              усилие, режим прав, cwd, дополнительные рабочие корни).
//                              Владелец времени жизни — lib/chat/live-sessions.js.
//   compaction?              — как сжимать контекст по кнопке на кольце:
//                              { kind: 'native', message } — CLI понимает слэш-команду
//                              и в неинтерактивном режиме, сессия сохраняется;
//                              { kind: 'summary' } — родного компакта нет, кокпит
//                              заказывает выжимку текстом и начинает новую сессию с неё.
//                              Поле не объявлено = 'summary' (безопасный дефолт).
//   commands?(config)        — команды CLI/навыки для меню чата:
//                              [{ cmd, desc, run, hint?, args? }]. cmd — '/name'
//                              либо нативное '$name' Codex, без аргументов;
//                              desc — однострочное описание
//                              (сервер режет до 120); run: 'prompt' — исполняется отправкой
//                              текста ходом (доказано гейтом исполняемости), 'none' — только
//                              информационный показ (в кокпите не исполняется, живёт в TUI),
//                              тогда hint — короткая пометка («только в TUI»); args: true —
//                              обязательный аргумент: команда вставляется в композер, а не
//                              отправляется. Не объявлен → у исполнителя нет секции в меню.
//   run(opts)                — выполнить сообщение → { reply, sessionId, contextTokens,
//                              contextWindow?, contextMetric?, contextIsEstimate?, cost,
//                              contextCache? }. contextCache — метрики КОНКРЕТНОГО
//                              последнего обращения к модели:
//                              { scope:'request', status:'reported'|'unavailable'|
//                              'not-applicable', readTokens?, writeTokens?, uncachedTokens? }.
//                              Числа — только известные неотрицательные целые; отсутствие
//                              поля не приравнивается к нулю.
//                              opts.extraDirs — дополнительные корни проекта/задачи и вложений
//                              opts.workspaceAccess — строгие readable/writable roots для
//                              adapter-ов с capability scopedWorkspace; сеть и temp roots
//                              задаются там же и не выводятся из cwd
//                              opts.workTools — server-owned структурные инструменты; adapter
//                              передаёт только их descriptors/invoke, без внешних MCP
//                              opts.providerSettings — выбор из настроек этого исполнителя
//                              opts.compactWindow — порог автокомпакта из общих настроек
//                              opts.onStep — колбэк нейтральных шагов хода:
//                              start/think/text/tool/res/note. Каждый executor сам
//                              разбирает свой CLI-поток и показывает только
//                              опубликованное provider-ом резюме рассуждений.
//   untrustedInput?          — capability отдельного model-only transport для текста,
//                              пришедшего извне: { text, images, maxImages, mediaTypes }.
//   runUntrusted?(opts)      — одноразовый ход без coding tools, cwd, project rules,
//                              MCP, сессии и файловых путей. Изображения приходят как
//                              [{ mediaType, data: base64 }]. Обычный run() НЕ является
//                              fallback: permission mode не изолирует prompt injection.
//                              opts.timeoutMs — срок хода; без него исполнитель берёт
//                              свой (пять минут), и длинный сценарий в него не влезает.
//   scopedWorkspace?         — boolean либо async (config) => boolean: adapter и текущая
//                              версия CLI действительно разводят readable/writable roots;
//                              одного permission mode для этой capability недостаточно.
// Карточка установки может не иметь run(): такой адаптер виден в настройках, но не
// попадает в runtime-реестр и потому физически не может получить ход чата. Это нужно
// для поэтапного подключения нового CLI: сначала обычная установка/авторизация, затем
// отдельным изменением transport и модели.
// Папка сканируется при старте: новый исполнитель = новый файл, код ядра не трогаем.
import type { WorkdirCapability } from '../../../../shared/chatWorkdir.ts';
import type { WorkdirValidator } from '../chat/workdir.ts';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { CockpitConfig } from '../../config.ts';
import type {
  InTurnAssistantEvent,
  InTurnCapability,
  InTurnPort,
  InTurnReceiptEvent,
  InTurnUnavailableReason,
} from '../../../../shared/chatInTurnContracts.ts';
import type { ChatStep } from '../chat/streamSteps.ts';
import type { ChatRunMetadata } from '../../../../shared/chatRun.ts';

import { createWorkToolRegistry } from './work-tools/index.ts';

// Ответ проверки установки: найден ли бинарь и какую версию он назвал сам.
export interface ExecutorProbe {
  ok: boolean;
  version: string | null;
}

// Ответ проверки авторизации: способ входа, подпись для карточки и готовность к ходу.
export interface ExecutorAuth {
  mode: string;
  label: string;
  available: boolean;
}

// Общая часть запуска: её используют и чат, и арбитр. Дополнительные каналы
// взаимодействия описывает вызывающая подсистема, а не имя конкретного провайдера.
export interface ExecutorRunInput {
  config: Partial<CockpitConfig>;
  message?: string;
  model?: string;
  cwd?: string;
  extraDirs?: readonly string[];
  effort?: string;
  sessionId?: string | null;
  permissionMode?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onProgress?: (tokens: number, info?: Record<string, unknown>) => void;
  onStep?: (step: ChatStep) => void;
  onSessionCreated?: (sessionId: string) => void | Promise<void>;
  // Только модель, названная основным исполнителем; fallback сюда не передаётся.
  onRunMetadata?: (metadata: ChatRunMetadata) => void;
  // Канал ввода в активный ход: адаптер отдаёт порт, когда транспорт действительно готов,
  // сообщает о смене готовности и о позднем подтверждении потребления.
  onInTurnReady?: (port: InTurnPort) => void;
  onInTurnAvailability?: (status: { available: boolean; reason?: InTurnUnavailableReason }) => void;
  onInTurnReceipt?: (event: InTurnReceiptEvent) => void | Promise<void>;
  // Видимый ответ агента: адаптер даёт id и текст, сервер назначает sequence и revision.
  onAssistantMessage?: (event: InTurnAssistantEvent) => void | Promise<void>;
  [field: string]: unknown;
}

// Лента уже приведена адаптером к общему виду. Текст модели и данные кэша остаются
// недоверенными до разбора потребителем; дополнительные метрики не теряются.
export interface ExecutorRunResult {
  reply?: unknown;
  sessionId?: string | null;
  steps?: ChatStep[];
  contextCache?: unknown;
  emptyRun?: boolean;
  subtype?: unknown;
  note?: boolean;
  [field: string]: unknown;
}

export interface ExecutorSessionBinding {
  authProfileId: (
    config: unknown,
    providerSettings?: Record<string, unknown>,
  ) => string | Promise<string>;
  securityProfile: (
    config: unknown,
    providerSettings?: Record<string, unknown>,
  ) => string | Promise<string>;
}

// Контракт адаптера исполнителя — ровно то, что перечислено в шапке файла. Обязательны
// только идентичность, бинарь и две проверки установки; всё остальное объявляет сам
// адаптер, и ядро спрашивает наличие метода, а не вендора.
export interface ExecutorAdapter {
  id: string;
  name?: string;
  vendor?: string;
  color?: string;
  order?: number;
  install?: string;
  login?: string;
  statusPage?: string;
  updateCmd?: readonly string[];
  catalogLive?: boolean;
  autoCompactEnv?: string;
  chatAutoCompact?: boolean;
  retryContract?: string;
  scopedWorkspace?: boolean | ((config: unknown) => unknown);
  workdir?: WorkdirCapability | ((config: unknown) => unknown);
  validateWorkdir?: WorkdirValidator;
  directSshPolicy?: unknown;
  settings?: unknown;
  sessionBinding?: ExecutorSessionBinding;
  session?: Record<string, unknown>;
  compaction?: Record<string, unknown>;
  usageActions?: Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
  untrustedInput?: { text?: boolean };
  // Подробный контракт канала ввода в активный ход; отсутствие поля — честное «не умею».
  inTurnInput?: InTurnCapability;
  bin: (config: unknown) => unknown;
  probe: (config: unknown) => Promise<ExecutorProbe> | ExecutorProbe;
  auth: (config: unknown, deps?: unknown) => Promise<ExecutorAuth> | ExecutorAuth;
  latestVersion?: (config: unknown) => unknown;
  efforts?: (config: unknown) => unknown;
  modes?: (config: unknown) => unknown;
  seedModels?: () => unknown[];
  catalog?: (config: unknown) => unknown;
  catalogCacheKey?: (config: unknown) => unknown;
  discoverModels?: (config: unknown) => unknown;
  modelFamily?: (model: unknown) => unknown;
  modelEfforts?: (model: unknown, efforts: string[]) => unknown;
  familyClass?: (family: unknown) => unknown;
  usage?: (...args: never[]) => unknown;
  mcpStatus?: (config: unknown, deps?: unknown) => unknown;
  commands?: (config: unknown) => unknown;
  run?: (input: ExecutorRunInput) => Promise<ExecutorRunResult>;
  runUntrusted?: (...args: never[]) => unknown;
  [field: string]: unknown;
}

const DIR = path.dirname(fileURLToPath(import.meta.url));

// Один файл = один ИИ, и язык файла на это не влияет: сервер исполняет TypeScript
// снятием типов. Пока список знал только .js, перевод исполнителя молча убирал бы
// его из реестра — с зелёными типами и пустым выбором модели в чате.
const ADAPTER_EXTENSIONS = ['.js', '.ts'];

/**
 * Provider-neutral рабочие инструменты замкнуты на server-owned scope. Никакое
 * поле аргументов модели не способно назначить проект, чат или живую сессию.
 */
export function createWorkTools({
  projectId = null,
  chatKey = '',
  permissionMode = '',
  invoke,
  pluginEnabled,
  dbInvoke,
}: Record<string, unknown> = {}) {
  return createWorkToolRegistry({
    projectId,
    chatKey,
    permissionMode,
    invoke,
    pluginEnabled,
    dbInvoke,
  });
}

export const workTools = createWorkTools;

let loadedAdapters: Map<string, ExecutorAdapter> | null = null; // Map id → provider adapter
let loadedExecutors: Map<string, ExecutorAdapter> | null = null; // Map id → adapter с run()

/**
 * Все карточки CLI для «Настройки → Исполнители». Адаптер без run() остаётся
 * setup-only: probe/auth/update работают, а выбрать его модель и запустить чат нельзя.
 */
export async function getProviderAdapters(): Promise<Map<string, ExecutorAdapter>> {
  if (loadedAdapters) return loadedAdapters;
  const map = new Map<string, ExecutorAdapter>();
  const seenNames = new Set<string>();
  for (const f of readdirSync(DIR).sort()) {
    // Файлы на `_` — вспомогательные модули исполнителей (каталоги моделей и т.п.), не ИИ.
    const extension = ADAPTER_EXTENSIONS.find((suffix) => f.endsWith(suffix));
    if (!extension || f.startsWith('_')) continue;
    // Один ИИ — один файл. Переименование в TypeScript оставляет прежний .js на
    // диске незамеченным, и тогда карточка подключилась бы дважды, из разных версий.
    const name = f.slice(0, -extension.length);
    // Сам загрузчик исполнителем не является — независимо от расширения файла.
    if (name === 'index') continue;
    if (seenNames.has(name)) {
      throw new Error(`Исполнитель ${name} объявлен дважды: убери лишний файл в ${DIR}`);
    }
    seenNames.add(name);
    const mod = await import(pathToFileURL(path.join(DIR, f)).href);
    const adapter = mod.default;
    if (adapter?.id && typeof adapter.probe === 'function' && typeof adapter.auth === 'function') {
      map.set(adapter.id, adapter);
    }
  }
  loadedAdapters = new Map(
    [...map.entries()].sort((a, b) => (a[1].order || 99) - (b[1].order || 99)),
  );
  return loadedAdapters;
}

/**
 * Только реально подключённые исполнители. Setup-only карточки намеренно отфильтрованы:
 * наличие CLI на машине не означает, что Cockpit уже умеет безопасно передать ему ход.
 */
export async function getExecutors(): Promise<Map<string, ExecutorAdapter>> {
  if (loadedExecutors) return loadedExecutors;
  loadedExecutors = new Map(
    [...(await getProviderAdapters()).entries()].filter(([, adapter]) => typeof adapter.run === 'function'),
  );
  return loadedExecutors;
}

/**
 * Один исполнитель по id (null — нет такого).
 */
export async function getExecutor(id: string): Promise<ExecutorAdapter | null> {
  return (await getExecutors()).get(id) || null;
}

/** Capability может зависеть от версии установленного CLI и всегда проверяется fail-closed. */
export async function supportsScopedWorkspace(
  executor: ExecutorAdapter | null | undefined,
  config: unknown,
): Promise<boolean> {
  if (!executor || typeof executor.run !== 'function') return false;
  try {
    const declared = typeof executor.scopedWorkspace === 'function'
      ? await executor.scopedWorkspace(config)
      : executor.scopedWorkspace;
    return declared === true;
  } catch {
    return false;
  }
}
