// Ollama — локальные модели (Qwen и др.) через HTTP API демона.
//
// В отличие от агентских CLI (claude/codex/kimi) демон приносит только модель: он не
// умеет ни ходить по файлам, ни спрашивать разрешения, ни держать сессию. Всё это даёт
// кокпит — каталог инструментов и песочница путей лежат в `_ollama-tools.js`, цикл
// «ответ → инструменты → ответ» крутится здесь, в `run()`. Демон stateless, поэтому
// историю разговора восстанавливаем из server-owned истории чата (`opts.chatHistory`)
// на каждый ход, а правила проекта (AGENTS.md/CLAUDE.md рабочего каталога) кладём
// системным блоком — так модель ведёт себя как остальные исполнители, а не как чистый чат.
//
// Что модель умеет, решает она сама: `/api/tags` отдаёт `capabilities`, и от них зависят
// эффорт (`thinking`), инструменты (`tools`) и вложения-картинки (`vision`). Хардкода
// возможностей здесь нет — новая модель включает их фактом своей поддержки.
//
// Адрес демона, num_ctx и время жизни модели в памяти — свои настройки исполнителя
// («Настройки → Исполнители», prefs.providerSettings.ollama).
import fs from 'node:fs/promises';
import path from 'node:path';

import { contextCacheStatus } from '../chat/contextCache.ts';
import { createStepSink, cut } from '../chat/streamSteps.ts';
import type { ChatStep } from '../chat/streamSteps.ts';
import { directSshSetting } from './_directSshPolicy.ts';
import {
  DEFAULT_KEEP_ALIVE_MIN,
  DEFAULT_NUM_CTX,
  FALLBACK_MAX_NUM_CTX,
  MAX_KEEP_ALIVE_MIN,
  MIN_RANGE_NUM_CTX,
  asUnavailableError,
  estimateMaxNumCtx,
  estimateModelMaxNumCtx,
  fetchJson,
  fetchLoadedModels,
  fetchModelInfo,
  formatBytes,
  kvBytesPerToken,
  normalizeCapabilities,
  postChatStream,
  resolveBaseUrl,
  resolveKeepAlive,
  resolveNumCtx,
  savedSettings,
  systemMemory,
  unloadModel,
} from './_ollamaClient.ts';
import {
  MAX_TOOL_CALLS,
  RESULT_LIMIT,
  createToolbox,
  toolDeclarations,
  toolModes,
} from './_ollamaTools.ts';
import type { PermissionBridge, WorkToolsPort } from './_ollamaTools.ts';
import type { LoadedOllamaModel, OllamaSettings } from './_ollamaClient.ts';

// Серверный config в объёме, который читает исполнитель: путь к prefs и env-override
// адреса демона. Полная его форма объявлена в config.ts.
type OllamaConfig = {
  prefsPath?: string;
  ollamaBaseUrl?: unknown;
};

// Сообщение тела /api/chat. Поля сверх role/content есть не у всех ролей: images —
// у пользователя с картинками, tool_calls — у ответа модели, tool_name — у результата.
interface OllamaMessage {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: unknown[];
  tool_name?: string;
}

// Тело запроса /api/chat. tools и think шлём только тем моделям, которые их объявили.
interface OllamaChatBody {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  keep_alive: string;
  options: Record<string, number>;
  tools?: unknown[];
  think?: boolean;
}

// Строка NDJSON-ответа демона: кусок сообщения либо финальная запись со счётчиками.
interface OllamaChunk {
  message?: {
    content?: unknown;
    thinking?: unknown;
    tool_calls?: unknown[];
  };
  done?: boolean;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
}

// Запись /api/tags. Форма приходит от демона, поэтому значения приводим на месте.
interface OllamaTag {
  name?: string;
  digest?: string;
  size?: number;
  capabilities?: unknown;
  details?: {
    parameter_size?: unknown;
    quantization_level?: unknown;
    family?: unknown;
  };
}

// Правила проекта, попавшие в системный блок хода.
interface ProjectDoc {
  name: string;
  text: string;
}

// Картинка недоверенного обращения: серверная граница triage уже прочитала и проверила её.
interface UntrustedImage {
  mediaType?: unknown;
  data?: unknown;
}

// Троттлинг счётчика «думает… · N ток.»: стрим течёт токенами, слать SSE на каждый нельзя.
const PROGRESS_THROTTLE_MS = 400;
// Грубая оценка токенов по символам, пока раунд не закончился и точного eval_count нет.
const CHARS_PER_TOKEN = 3;
// Правила проекта в системный блок — только эти файлы рабочего каталога. Их @-включения
// НЕ раскрываем: большой docs/ заметно удорожает префилл КАЖДОГО хода. Нужный документ
// модель дочитает инструментом сама.
const PROJECT_DOCS = ['AGENTS.md', 'CLAUDE.md'];
const DOC_CHARS_LIMIT = 24000;
// Потолок обменов с моделью за ход: MAX_TOOL_CALLS ограничивает вызовы инструментов,
// этот — сами раунды, чтобы пустые ответы тоже не крутились бесконечно.
const MAX_ROUNDS = MAX_TOOL_CALLS + 5;
const MAX_IMAGES = 4;
const OLLAMA_UNTRUSTED_MAX_IMAGES = 20;
const OLLAMA_UNTRUSTED_MAX_TOKENS = 1024;
const OLLAMA_UNTRUSTED_TIMEOUT_MS = 5 * 60 * 1000;
const OLLAMA_UNTRUSTED_MEDIA_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
]);
// Нижняя граница окна, до которой оценка памяти имеет право ужимать ход: меньше — и в
// контекст не влезает даже системный блок с правилами проекта и объявлением инструментов.
const MIN_AGENT_NUM_CTX = 8192;

/** «14.8B» → 14.8, «7B» → 7 — ранг силы для сортировки каталога. Не число → 0. */
function tierFromParameterSize(value: unknown) {
  const m = String(value || '').match(/([\d.]+)\s*B/i);
  const parsed = m ? Number(m[1]) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Где лежит загруженная модель — VRAM против ОЗУ: это и объясняет её скорость. */
function placementOf(m: LoadedOllamaModel) {
  if (!m.totalBytes) return 'размер неизвестен';
  if (!m.ramBytes) return `${formatBytes(m.totalBytes)} целиком в видеопамяти`;
  if (!m.vramBytes) return `${formatBytes(m.totalBytes)} целиком в ОЗУ`;
  return `${formatBytes(m.vramBytes)} в видеопамяти + ${formatBytes(m.ramBytes)} в ОЗУ`;
}

/** Правила проекта из рабочего каталога: то, ради чего ход выглядит «как у остальных». */
async function readProjectDocs(cwd: string | undefined): Promise<ProjectDoc[]> {
  if (!cwd) return [];
  const out: ProjectDoc[] = [];
  for (const name of PROJECT_DOCS) {
    try {
      const raw = await fs.readFile(path.join(cwd, name), 'utf8');
      if (!raw.trim()) continue;
      out.push({
        name,
        text: raw.length > DOC_CHARS_LIMIT
          ? `${raw.slice(0, DOC_CHARS_LIMIT)}\n… файл обрезан, дочитай его инструментом read_file`
          : raw,
      });
    } catch { /* файла нет — обычное дело, не все каталоги проектные */ }
  }
  return out;
}

/** Системный блок хода: где мы, что доступно и по каким правилам работаем. */
function buildSystemPrompt({ cwd, roots, docs, toolsOn, permissionMode }: {
  cwd?: string;
  roots: readonly string[];
  docs: readonly ProjectDoc[];
  toolsOn: boolean;
  permissionMode: string;
}) {
  const lines: Array<string | null> = [
    'Ты — ИИ-исполнитель в кокпите. Отвечай по-русски.',
    cwd ? `Рабочий каталог: ${cwd}` : null,
    roots.length ? `Доступные каталоги: ${roots.join(', ')}` : null,
  ];
  if (toolsOn) {
    lines.push(
      'Инструменты: read_file, list_dir, grep, write_file, edit_file, bash.',
      'Не угадывай содержимое файлов — читай их инструментами. Путь вне доступных каталогов будет отклонён.',
      permissionMode === 'plan'
        ? 'Режим «план»: доступно только чтение. Ничего не меняй — опиши, что нужно сделать.'
        : 'Правка или команда может потребовать подтверждения человека; отказ придёт результатом инструмента.',
    );
  } else {
    lines.push('Инструментов у этой модели нет: файлы читать нечем, отвечай по тексту разговора.');
  }
  if (docs.length) {
    lines.push('', `Ниже — правила проекта (${docs.map((d) => d.name).join(', ')}). Соблюдай их.`);
    if (toolsOn) {
      lines.push('Ссылки вида @путь/файл.md — отдельные документы, они сюда не вложены: понадобятся — прочитай их read_file.');
    }
    for (const d of docs) lines.push('', `--- ${d.name} ---`, d.text);
  }
  return lines.filter((l) => l !== null).join('\n');
}

/**
 * Сообщения для POST /api/chat. История реплеится только в живом разговоре
 * (sessionId truthy): сброс памяти и сжатие-выжимкой обнуляют sessionId на клиенте,
 * и тогда начинаем с чистого листа (выжимка приезжает в самом тексте сообщения).
 * Клиент сохраняет чат ДО отправки, поэтому текущее сообщение уже сидит последним
 * user-блоком истории — срезаем дубликат: последний user с непустым текстом,
 * который является суффиксом message (у message есть служебные префиксы).
 */
function buildMessages({ system, message, sessionId, chatHistory, images }: {
  system: string;
  message: string;
  sessionId?: unknown;
  chatHistory?: unknown;
  images?: readonly string[];
}): OllamaMessage[] {
  const messages: OllamaMessage[] = [];
  if (system) messages.push({ role: 'system', content: system });
  if (sessionId && Array.isArray(chatHistory)) {
    const history = (chatHistory as Array<{ role?: unknown; text?: unknown }>)
      .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && String(m?.text || '').trim())
      .map((m) => ({ role: String(m.role), text: String(m.text).trim() }));
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const entry = history[i];
      if (entry?.role === 'user' && message.endsWith(entry.text)) {
        history.splice(i, 1);
        break;
      }
    }
    for (const m of history) messages.push({ role: m.role, content: m.text });
  }
  const user: OllamaMessage = { role: 'user', content: message };
  if (images?.length) user.images = [...images];
  messages.push(user);
  return messages;
}

/** Вложения → base64 для поля images (только у моделей с capability vision). */
async function readImages(paths: unknown): Promise<string[]> {
  const out: string[] = [];
  for (const p of (Array.isArray(paths) ? paths : []).slice(0, MAX_IMAGES)) {
    try { out.push((await fs.readFile(p)).toString('base64')); } catch { /* файл пропал — пропускаем */ }
  }
  return out;
}

/** Аргументы вызова: Ollama отдаёт объектом, но принимаем и JSON-строку — на случай смены формата. */
function parseToolArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch { return {}; }
  }
  return {};
}

/** Жив ли демон: GET /api/version с коротким таймаутом. */
async function probeDaemon(config: OllamaConfig) {
  try {
    const data = await fetchJson(resolveBaseUrl(config), '/api/version', {
      timeoutMs: 1500,
    }) as { version?: unknown } | null;
    return { ok: true, version: String(data?.version || '').slice(0, 60) || null };
  } catch {
    return { ok: false, version: null };
  }
}

/**
 * Возможности и потолок контекста ВЫБРАННОЙ модели одним заходом в /api/tags:
 * этот запрос всё равно нужен для клампа num_ctx, а capabilities решают, слать ли
 * tools/think/images. Демон старой версии список возможностей в /api/tags не кладёт —
 * тогда добираем их из /api/show (тот же кэш по digest, лишнего запроса нет).
 */
async function resolveModelFacts(baseUrl: string, model: string): Promise<{
  capabilities: string[];
  maxNumCtx: number | null;
}> {
  try {
    const tags = await fetchJson(baseUrl, '/api/tags', { timeoutMs: 2000 }) as { models?: unknown } | null;
    const models = (Array.isArray(tags?.models) ? tags.models : []) as OllamaTag[];
    const entry = models.find((m) => m?.name === model);
    if (!entry) return { capabilities: [], maxNumCtx: null };
    let capabilities = normalizeCapabilities(entry.capabilities);
    if (!capabilities.length) {
      const record = await fetchModelInfo(baseUrl, { name: model, digest: entry.digest });
      capabilities = record?.capabilities || [];
    }
    const maxNumCtx = await estimateModelMaxNumCtx(baseUrl, {
      name: model, digest: entry.digest, sizeBytes: entry.size,
    });
    return { capabilities, maxNumCtx };
  } catch {
    // Демон моргнул на подготовке — дальше ход сам решит, жив ли он.
    return { capabilities: [], maxNumCtx: null };
  }
}

function ollamaUntrustedError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

/**
 * Одноразовый model-only ход для недоверенного Inbox. В body нет tools, history,
 * project docs, cwd или путей: даже prompt injection не получает исполняемой
 * capability. Картинки уже прочитаны и проверены серверной границей triage.
 */
export async function runOllamaUntrusted({
  config, message, images = [], model, effort, providerSettings, signal,
  timeoutMs = OLLAMA_UNTRUSTED_TIMEOUT_MS,
}: {
  config?: OllamaConfig;
  message?: unknown;
  images?: readonly UntrustedImage[];
  model?: string;
  effort?: string;
  providerSettings?: OllamaSettings | null;
  signal?: AbortSignal;
  timeoutMs?: number;
} = {}) {
  if (!model) throw new Error('Не выбрана модель Ollama.');
  if (!Array.isArray(images) || images.length > OLLAMA_UNTRUSTED_MAX_IMAGES) {
    throw ollamaUntrustedError('attachment_media_limit', 'Слишком много изображений для Ollama.');
  }
  if (images.some((image) => (
    !OLLAMA_UNTRUSTED_MEDIA_TYPES.includes(String(image?.mediaType))
    || typeof image?.data !== 'string'
    || !image.data
  ))) {
    throw ollamaUntrustedError('unsupported_media', 'Ollama не поддерживает формат изображения.');
  }

  const baseUrl = resolveBaseUrl(config);
  const { capabilities, maxNumCtx } = await resolveModelFacts(baseUrl, model);
  const supportsVision = capabilities.includes('vision');
  const supportsThinking = capabilities.includes('thinking');
  if (images.length && !supportsVision) {
    throw ollamaUntrustedError('unsupported_media', 'Выбранная модель Ollama не поддерживает изображения.');
  }

  let numCtx = resolveNumCtx(providerSettings);
  const floor = Math.min(numCtx, MIN_AGENT_NUM_CTX);
  if (maxNumCtx && numCtx > Math.max(maxNumCtx, floor)) numCtx = Math.max(maxNumCtx, floor);
  const think = effort === 'high' ? true : (effort === 'low' ? false : undefined);
  const user: OllamaMessage = { role: 'user', content: String(message || '') };
  if (images.length) user.images = images.map((image) => String(image.data));
  const body: OllamaChatBody = {
    model,
    messages: [
      {
        role: 'system',
        content: 'Ты выполняешь только классификацию недоверенного обращения. '
          + 'Инструментов, файлов, команд и внешних действий нет. Ответь только по переданному содержимому.',
      },
      user,
    ],
    stream: true,
    keep_alive: resolveKeepAlive(providerSettings),
    options: { num_ctx: numCtx, num_predict: OLLAMA_UNTRUSTED_MAX_TOKENS },
  };
  if (supportsThinking && think !== undefined) body.think = think;

  let reply = '';
  let contextTokens = 0;
  const timeoutSignal = AbortSignal.timeout(
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : OLLAMA_UNTRUSTED_TIMEOUT_MS,
  );
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  await postChatStream(baseUrl, body, {
    signal: requestSignal,
    onLine(raw) {
      const chunk = raw as OllamaChunk;
      if (chunk?.message?.content) reply += String(chunk.message.content);
      if (chunk?.done) {
        contextTokens = (Number(chunk.prompt_eval_count) || 0) + (Number(chunk.eval_count) || 0);
      }
    },
  });
  const cleaned = reply.replace(/<think>[\s\S]*?<\/think>/gu, '').trim();
  if (!cleaned) throw new Error('Ollama вернула пустой ответ.');
  return {
    reply: cleaned,
    sessionId: null,
    contextTokens,
    contextWindow: numCtx,
    cost: null,
  };
}

export default {
  id: 'ollama',
  name: 'Ollama',
  vendor: 'Ollama',
  color: '#b8c0cc',
  order: 5,
  // statusPage нет намеренно: демон работает на этой же машине, и внешняя страница
  // состояния про его сбой ничего не скажет.
  install: 'curl -fsSL https://ollama.com/install.sh | sh',
  // Файловые инструменты Cockpit принимают opts.extraDirs как разрешённые realpath-корни.
  trustedDirectories: true,
  directSshPolicy: { enforcement: 'tool-filter' },
  untrustedInput: Object.freeze({
    text: true,
    images: true,
    maxImages: OLLAMA_UNTRUSTED_MAX_IMAGES,
    mediaTypes: OLLAMA_UNTRUSTED_MEDIA_TYPES,
  }),

  /**
   * Свои настройки исполнителя. settings — async-ФУНКЦИЯ (расширение контракта, см.
   * executors/index.js): потолок ползунка num_ctx и справочные строки считаются по
   * живому опросу демона и памяти машины. Демон молчит → дефолтный потолок и прочерки.
   * Строки `kind: 'info'` фронт рисует подписью с пояснением — своего контрола у них нет.
   */
  async settings(config: OllamaConfig) {
    const baseUrl = resolveBaseUrl(config);
    const chosenNumCtx = resolveNumCtx(savedSettings(config));
    let max = FALLBACK_MAX_NUM_CTX;
    let ctxCost = 'не удалось оценить — демон не ответил';

    try {
      const tags = await fetchJson(baseUrl, '/api/tags', { timeoutMs: 2000 }) as { models?: unknown } | null;
      const models = ((Array.isArray(tags?.models) ? tags.models : []) as OllamaTag[])
        .filter((m) => m?.name);
      const estimates: number[] = [];
      const costs: number[] = [];
      for (const m of models) {
        // estimateModelMaxNumCtx и fetchModelInfo делят один кэш по digest — второй
        // вызов бесплатный, поэтому цену KV-кэша считаем тут же, а не отдельным обходом.
        estimates.push(await estimateModelMaxNumCtx(baseUrl, {
          name: m.name, digest: m.digest, sizeBytes: m.size,
        }));
        const record = await fetchModelInfo(baseUrl, { name: m.name, digest: m.digest });
        costs.push((kvBytesPerToken(record?.modelInfo) ?? 0) * chosenNumCtx);
      }
      if (estimates.length) max = Math.max(...estimates);
      if (costs.length) {
        const lo = formatBytes(Math.min(...costs));
        const hi = formatBytes(Math.max(...costs));
        ctxCost = lo === hi
          ? `${chosenNumCtx.toLocaleString('ru')} токенов ≈ ${lo} памяти под KV-кэш`
          : `${chosenNumCtx.toLocaleString('ru')} токенов ≈ ${lo}–${hi} под KV-кэш (зависит от модели)`;
      }
    } catch { /* демон молчит — ползунок с дефолтным потолком, оценка прочерком */ }

    const mem = await systemMemory();
    const memNote = [
      mem.totalVramBytes
        ? `видеопамять: свободно ${formatBytes(mem.freeVramBytes)} из ${formatBytes(mem.totalVramBytes)}`
        : 'видеопамять: не обнаружена (модель пойдёт целиком в ОЗУ)',
      `ОЗУ: свободно ${formatBytes(mem.freeRamBytes)} из ${formatBytes(mem.totalRamBytes)}`,
    ].join(' · ');

    const loaded = await fetchLoadedModels(baseUrl);
    const loadedNote = loaded.length
      ? loaded.map((m) => [
        `${m.name} — ${placementOf(m)}`,
        m.contextLength ? `окно ${m.contextLength.toLocaleString('ru')}` : null,
        m.expiresInSec != null ? `выгрузится через ${Math.max(1, Math.round(m.expiresInSec / 60))} мин` : null,
      ].filter(Boolean).join(', ')).join(' · ')
      : 'ничего не загружено — ближайший ход оплатит чтение весов модели с диска';

    return [
      directSshSetting(),
      {
        id: 'host', kind: 'text', label: 'Адрес демона Ollama', value: 'http://127.0.0.1:11434',
        hint: 'Где слушает ollama serve (у всех по-разному: localhost, локальная сеть, машина за VPN).',
      },
      {
        id: 'numCtx', kind: 'range', label: 'Размер контекста (num_ctx)',
        min: MIN_RANGE_NUM_CTX, step: 1024, max, value: DEFAULT_NUM_CTX,
        hint: 'Сколько разговора модель держит перед глазами. Больше — дороже по памяти: '
          + 'не влезло в видеопамять, значит поехало в ОЗУ и ход замедлился. Меньше — Ollama '
          + 'молча срежет начало разговора. Потолок — оценка по памяти этой машины.',
      },
      {
        id: 'keepAliveMin', kind: 'range', label: 'Держать модель в памяти, минут',
        min: 0, step: 1, max: MAX_KEEP_ALIVE_MIN, value: DEFAULT_KEEP_ALIVE_MIN,
        hint: 'После этой паузы демон выгружает модель, и следующий ход снова читает веса '
          + 'с диска (для крупной модели — десятки секунд). 0 — выгружать сразу после хода: '
          + 'память освобождается мгновенно, но каждый ход платит загрузкой.',
      },
      {
        id: 'memInfo', kind: 'info', label: 'Память машины', note: memNote,
        hint: 'Отсюда берётся потолок ползунка контекста. Ollama кладёт в видеопамять что влезло, остальное считает на процессоре.',
      },
      {
        id: 'loadedInfo', kind: 'info', label: 'Сейчас в памяти демона', note: loadedNote,
        hint: 'Это же объясняет, почему первый ход после перерыва идёт дольше остальных. Выгрузить вручную можно из всплывашки исполнителя в шапке.',
      },
      {
        id: 'ctxCostInfo', kind: 'info', label: 'Цена выбранного контекста', note: ctxCost,
        hint: 'Столько памяти займёт KV-кэш ПОВЕРХ весов модели при выбранном num_ctx.',
      },
    ];
  },

  bin() { return 'ollama'; },

  async probe(config: OllamaConfig) {
    return probeDaemon(config);
  },

  // Авторизации у локального HTTP нет; available — просто «демон отвечает».
  async auth(config: OllamaConfig) {
    const { ok } = await probeDaemon(config);
    return { mode: 'none', label: 'локальный HTTP — авторизация не нужна', available: ok };
  },

  // Каталог полностью наполняет catalog() из живого демона; пустой массив truthy —
  // досев в models.json не нужен.
  seedModels() { return []; },

  catalogLive: true,

  // Инструменты исполняет сам кокпит, поэтому и режимы прав объявляем свои —
  // спрашивать о них нечего и некого (у claude их перечисляет CLI).
  async modes() { return toolModes(); },

  /**
   * Подтянутые в демон модели (GET /api/tags) + родное окно из /api/show (кэш по digest).
   * maxNumCtx — потолок num_ctx модели от памяти машины (тот же расчёт, что у ползунка
   * в настройках и клампа в run). Демон недоступен → null: реестр оставит прошлый
   * список, а не пустоту.
   */
  async catalog(config: OllamaConfig) {
    const baseUrl = resolveBaseUrl(config);
    let tags: { models?: unknown } | null;
    try {
      tags = await fetchJson(baseUrl, '/api/tags', { timeoutMs: 2000 }) as { models?: unknown } | null;
    } catch {
      return null;
    }
    const mem = await systemMemory();
    const out: Array<Record<string, unknown>> = [];
    for (const m of (Array.isArray(tags?.models) ? tags.models : []) as OllamaTag[]) {
      const tag = String(m?.name || '').trim();
      if (!tag) continue;
      const details = m?.details || {} as NonNullable<OllamaTag['details']>;
      const record = await fetchModelInfo(baseUrl, { name: tag, digest: m?.digest });
      const context = record?.contextLength ?? DEFAULT_NUM_CTX;
      const spec = [details.parameter_size, details.quantization_level].filter(Boolean).join(', ');
      const capabilities = normalizeCapabilities(m?.capabilities).length
        ? normalizeCapabilities(m?.capabilities)
        : (record?.capabilities || []);
      out.push({
        id: tag,
        name: spec ? `${tag} (${spec})` : tag,
        context,
        inputModalities: capabilities.includes('vision') ? ['text', 'image'] : ['text'],
        maxNumCtx: estimateMaxNumCtx({
          contextLength: record?.contextLength,
          modelInfo: record?.modelInfo,
          modelSizeBytes: m?.size,
          mem,
        }),
        tier: tierFromParameterSize(details.parameter_size),
        // Эффорт объявляем БИНАРНЫМ и только у думающих моделей: демон принимает
        // think: "low"|"medium"|"high", но длина рассуждения от промежуточного уровня
        // стабильно не зависит. Три уровня были бы враньём слайдера.
        efforts: capabilities.includes('thinking') ? ['low', 'high'] : [],
        family: String(details.family || tag.split(':')[0]),
      });
    }
    return out;
  },

  runUntrusted(options: Parameters<typeof runOllamaUntrusted>[0]) {
    return runOllamaUntrusted(options);
  },

  /**
   * Ход чата: цикл «POST /api/chat → tool_calls → выполнить → снова POST», пока модель
   * не ответит без вызовов. thinking-чанки и текст уходят в ленту шагов, действия — как
   * tool/res, живость — счётчиком токенов через onProgress. Финальная строка done:true
   * каждого раунда несёт prompt_eval_count/eval_count — из них честный расход контекста.
   */
  async run({
    config, chatKey, signal, message, model, effort, sessionId, chatHistory, providerSettings,
    cwd, extraDirs = [], attachmentPaths = [], permissionMode, onPermission, onProgress, onStep,
    workTools,
  }: {
    config?: OllamaConfig;
    chatKey?: string;
    signal?: AbortSignal;
    message?: unknown;
    model?: string;
    effort?: string;
    sessionId?: string | null;
    chatHistory?: unknown;
    providerSettings?: OllamaSettings | null;
    cwd?: string;
    extraDirs?: readonly string[];
    attachmentPaths?: readonly string[];
    permissionMode?: string;
    onPermission?: PermissionBridge | null;
    onProgress?: (tokens: number, info?: Record<string, unknown>) => void;
    onStep?: (step: ChatStep) => void;
    workTools?: WorkToolsPort | null;
  }) {
    const baseUrl = resolveBaseUrl(config);
    const nextSessionId = sessionId || (chatKey ? `ollama:${chatKey}` : null);
    const sink = createStepSink(onStep);
    if (!model) throw new Error('Не выбрана модель Ollama — выбери её в селекте чата.');

    // Пустой режим означает «дефолт исполнителя»; у нас он самый осторожный из рабочих.
    const mode = permissionMode || 'manual';
    sink.emit({ k: 'start', model, mode, cwd: cwd || '' });

    const { capabilities, maxNumCtx } = await resolveModelFacts(baseUrl, model);
    const supportsTools = capabilities.includes('tools');
    const supportsVision = capabilities.includes('vision');
    const supportsThinking = capabilities.includes('thinking');

    // Кламп num_ctx по per-model оценке памяти: больше потолка KV-кэш не влезет
    // в VRAM+ОЗУ этой модели. Оценки нет — работаем с настройкой как есть.
    // Ниже MIN_AGENT_NUM_CTX не опускаемся никогда: в такое окно не помещается даже
    // системный блок с правилами проекта и объявлением инструментов, и ход выродился бы
    // в пустой ответ (проверено живьём — модель отдавала только размышление). Оценка
    // памяти — эвристика, а Ollama при нехватке доложит часть на CPU, а не упадёт;
    // цена ошибки в меньшую сторону куда выше, чем в большую.
    let numCtx = resolveNumCtx(providerSettings);
    const floor = Math.min(numCtx, MIN_AGENT_NUM_CTX);
    if (maxNumCtx && numCtx > Math.max(maxNumCtx, floor)) {
      numCtx = Math.max(maxNumCtx, floor);
      sink.emit({ k: 'note', text: `num_ctx ограничен до ${numCtx}: больше не влезет в память по оценке` });
    }
    if (!supportsTools) {
      sink.emit({ k: 'note', text: 'модель без поддержки инструментов — файлы и команды ей недоступны' });
    }
    if (attachmentPaths.length && !supportsVision) {
      sink.emit({ k: 'note', text: 'модель не понимает картинки — вложения не отправлены' });
    }

    const toolbox = await createToolbox({
      cwd,
      roots: extraDirs,
      permissionMode: mode,
      blockDirectSsh: providerSettings?.blockDirectSsh !== false,
      blockDirectDb: providerSettings?.blockDirectDb === true,
      strictUnknownDbClient: providerSettings?.strictUnknownDbClient === true,
      onPermission,
      sink,
      signal,
      workTools,
    });
    const docs = await readProjectDocs(cwd);
    const messages = buildMessages({
      system: buildSystemPrompt({
        cwd, roots: toolbox.roots, docs, toolsOn: supportsTools, permissionMode: mode,
      }),
      message: String(message || ''),
      sessionId,
      chatHistory,
      images: supportsVision ? await readImages(attachmentPaths) : [],
    });

    // Эффорт → think булевым: три уровня модель не отрабатывает (см. catalog).
    // Эффорт не выбран — поле не шлём вовсе: у думающей модели дефолт демона — думать,
    // и подставленный false молча отнял бы у неё рассуждения.
    const think = effort === 'high' ? true : (effort === 'low' ? false : undefined);
    const keepAlive = resolveKeepAlive(providerSettings);

    let toolsAllowed = supportsTools;
    let reply = '';
    let contextTokens: number | null = null;
    let doneTokens = 0;
    let roundChars = 0;
    let lastProgressAt = 0;
    const pushProgress = () => {
      const now = Date.now();
      if (now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
      lastProgressAt = now;
      try {
        onProgress?.(doneTokens + Math.round(roundChars / CHARS_PER_TOKEN));
      } catch { /* счётчик не роняет ход */ }
    };

    try {
      for (let round = 1; round <= MAX_ROUNDS; round += 1) {
        let content = '';
        let thinking = '';
        let thinkShown = false;
        const rawCalls: unknown[] = [];

        const body: OllamaChatBody = {
          model, messages, stream: true, keep_alive: keepAlive, options: { num_ctx: numCtx },
        };
        if (toolsAllowed) body.tools = toolDeclarations(workTools);
        if (supportsThinking && think !== undefined) body.think = think;

        await postChatStream(baseUrl, body, {
          signal,
          onLine(raw) {
            const chunk = raw as OllamaChunk;
            const piece = chunk?.message || {};
            if (piece.thinking) thinking += String(piece.thinking);
            if (piece.content) {
              // Рассуждение к этому моменту закончилось — показываем его одной строкой,
              // не дожидаясь конца раунда: так человек видит ход мысли раньше ответа.
              if (thinking && !thinkShown) {
                thinkShown = true;
                sink.emit({ k: 'think', text: cut(thinking) });
              }
              content += String(piece.content);
            }
            if (Array.isArray(piece.tool_calls)) rawCalls.push(...piece.tool_calls);
            if (piece.thinking || piece.content) {
              roundChars = thinking.length + content.length;
              pushProgress();
            }
            if (chunk?.done) {
              // Оба числа относятся к последнему запросу. Вывод прежних раундов
              // уже входит в его prompt; повторное сложение завышало заполненность.
              const prompt = chunk.prompt_eval_count;
              const output = chunk.eval_count;
              contextTokens = typeof prompt === 'number' && Number.isSafeInteger(prompt) && prompt >= 0
                && typeof output === 'number' && Number.isSafeInteger(output) && output >= 0
                ? prompt + output : null;
              doneTokens += Number(chunk.eval_count) || 0;
              roundChars = 0;
              try {
                onProgress?.(doneTokens, {
                  contextTokens: contextTokens ?? 0,
                  contextWindow: numCtx,
                  contextMetric: contextTokens === null ? 'unavailable' : 'request-total-v1',
                  contextIsEstimate: false,
                  contextCache: contextCacheStatus('not-applicable'),
                });
              } catch { /* счётчик не роняет ход */ }
            }
          },
        });
        // Раунд закончился — показываем его целиком одной строкой. Именно целиком:
        // стрим идёт токенами, а emit добавляет НОВУЮ строку ленты, поэтому кусками
        // вышла бы стена растущих дублей. Живость даёт счётчик токенов (onProgress),
        // как у остальных исполнителей. Текст последнего раунда — это и есть ответ,
        // он остаётся в ленте так же, как у claude (там reply тоже дублируется шагом).
        if (thinking && !thinkShown) sink.emit({ k: 'think', text: cut(thinking) });
        if (content.trim()) sink.emit({ k: 'text', text: cut(content, 4000) });

        if (!rawCalls.length || !toolsAllowed) {
          reply = content;
          break;
        }

        // Рассуждение обратно в контекст не возвращаем: моделям семейства qwen это
        // прямо не рекомендовано, а места в локальном окне оно занимает много.
        messages.push({ role: 'assistant', content, tool_calls: rawCalls });
        for (const raw of rawCalls as Array<{ function?: { name?: unknown; arguments?: unknown } }>) {
          const name = String(raw?.function?.name || '');
          const out = await toolbox.call({ name, args: parseToolArgs(raw?.function?.arguments) });
          messages.push({
            role: 'tool',
            tool_name: name,
            content: String(out?.text ?? '').slice(0, RESULT_LIMIT) || '(пусто)',
          });
        }

        if (toolbox.calls >= MAX_TOOL_CALLS) {
          // Не обрываем ход на полуслове: снимаем инструменты и просим подвести итог —
          // следующий раунд придёт без вызовов и станет ответом.
          toolsAllowed = false;
          sink.emit({ k: 'note', text: `предел вызовов инструментов за ход (${MAX_TOOL_CALLS}) — прошу подвести итог` });
          messages.push({
            role: 'user',
            content: `Предел вызовов инструментов за ход исчерпан (${MAX_TOOL_CALLS}). `
              + 'Инструменты больше недоступны: подведи итог сделанного и скажи, что осталось.',
          });
        }
      }
    } catch (err) {
      // Кнопка «стоп»: ход оборван человеком, а не сломан — отдаём накопленное.
      if (signal?.aborted) {
        throw Object.assign(new Error('Ход остановлен.'), {
          stopped: true,
          sessionId: nextSessionId,
          contextTokens: contextTokens ?? 0,
          contextWindow: numCtx,
          contextMetric: contextTokens === null ? 'unavailable' : 'request-total-v1',
          contextIsEstimate: false,
          contextCache: contextCacheStatus('not-applicable'),
          steps: sink.steps,
        });
      }
      throw asUnavailableError(err, baseUrl) || err;
    }

    // Некоторые модели шлют размышления прямо в content — убираем их из ответа.
    const cleaned = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return {
      reply: cleaned || '(модель вернула пустой ответ)',
      sessionId: nextSessionId,
      contextTokens: contextTokens ?? 0,
      contextWindow: numCtx,
      contextMetric: contextTokens === null ? 'unavailable' : 'request-total-v1',
      contextIsEstimate: false,
      contextCache: contextCacheStatus('not-applicable'),
      cost: null,
      steps: sink.steps,
    };
  },

  /**
   * Всплывашка исполнителя в шапке. Подписочных лимитов у локального демона нет и не
   * будет, поэтому показываем то, что здесь действительно решает: занятость памяти
   * машины, что демон держит загруженным (и когда выгрузит) и кнопку немедленной
   * выгрузки — это единственный способ вернуть видеопамять другим задачам сразу.
   */
  async usage(config: OllamaConfig) {
    const baseUrl = resolveBaseUrl(config);
    const { ok, version } = await probeDaemon(config);
    if (!ok) {
      return {
        state: 'unavailable',
        message: `Демон Ollama не отвечает на ${baseUrl}.`,
        bars: [],
        resources: [],
      };
    }

    const mem = await systemMemory();
    const bars: Array<Record<string, unknown>> = [];
    if (mem.totalVramBytes) {
      const used = Math.max(0, mem.totalVramBytes - mem.freeVramBytes);
      bars.push({
        key: 'vram',
        label: 'Видеопамять',
        pct: Math.round((used / mem.totalVramBytes) * 100),
        note: `занято ${formatBytes(used)} из ${formatBytes(mem.totalVramBytes)}`,
      });
    }
    if (mem.totalRamBytes) {
      const used = Math.max(0, mem.totalRamBytes - mem.freeRamBytes);
      bars.push({
        key: 'ram',
        label: 'Оперативная память',
        pct: Math.round((used / mem.totalRamBytes) * 100),
        note: `занято ${formatBytes(used)} из ${formatBytes(mem.totalRamBytes)}`,
      });
    }

    const loaded = await fetchLoadedModels(baseUrl);
    const resources: Array<Record<string, unknown>> = [{
      key: 'daemon',
      label: 'Демон',
      summary: version ? `версия ${version}` : 'отвечает',
      note: baseUrl,
      tone: 'ok',
    }];
    loaded.forEach((m, i) => {
      resources.push({
        // Имя модели («qwen3.6:latest») в ключ не годится: контракт ресурсов требует
        // [a-z0-9_-], а двоеточие и точка его не проходят. Имя живёт в подписи.
        key: `loaded-${i + 1}`,
        label: m.name,
        summary: placementOf(m),
        // Доля весов в видеопамяти: чем она меньше, тем больше считает процессор.
        ...(m.totalBytes && { percent: (m.vramBytes / m.totalBytes) * 100 }),
        note: [
          m.contextLength ? `окно ${m.contextLength.toLocaleString('ru')} токенов` : null,
          m.expiresInSec != null
            ? `выгрузится через ${Math.max(1, Math.round(m.expiresInSec / 60))} мин`
            : null,
        ].filter(Boolean).join(' · '),
        tone: 'ok',
        controls: [{
          id: 'unload',
          kind: 'button',
          // Операция над рантаймом, а не настройка аккаунта: нужна там, где человек
          // смотрит на занятую память, — во всплывашке топбара.
          scope: 'live',
          label: 'Выгрузить из памяти',
          action: 'unload-model',
          payload: { model: m.name },
          confirm: {
            text: `Выгрузить ${m.name} из памяти? Освободится ${formatBytes(m.totalBytes)}, `
              + 'следующий ход снова прочитает веса с диска.',
            label: 'Выгрузить',
          },
        }],
      });
    });
    if (!loaded.length) {
      resources.push({
        key: 'idle',
        label: 'Модели в памяти',
        summary: 'ничего не загружено',
        note: 'ближайший ход оплатит чтение весов с диска; сколько держать модель загруженной — в настройках исполнителя',
        tone: 'muted',
      });
    }

    return { state: 'ok', bars, resources };
  },

  usageActions: {
    'unload-model': async ({ payload, config }: {
      payload?: unknown;
      config?: unknown;
    }) => {
      const model = String((payload as { model?: unknown } | null)?.model || '').trim();
      if (!model) return { ok: false, error: 'не указана модель для выгрузки' };
      try {
        await unloadModel(resolveBaseUrl(config as OllamaConfig), model);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error)?.message || 'выгрузить модель не удалось' };
      }
    },
  },
};
