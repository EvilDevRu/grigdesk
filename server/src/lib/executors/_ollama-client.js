// HTTP-клиент демона Ollama (вспомогательный модуль исполнителя ollama.js).
// Ollama — stateless HTTP API без авторизации: версия/список моделей/окно контекста
// и NDJSON-стрим чата. Адрес демона настраивается из UI (prefs.providerSettings.ollama.host),
// машинный override — env COCKPIT_OLLAMA_HOST (config.ollamaBaseUrl).
// Вторая половина модуля — оценка потолка num_ctx от памяти машины: ползунок в настройках
// и кламп в run() считают, сколько KV-кэша реально влезет (VRAM + ОЗУ при CPU-offload).
import { execFile } from 'node:child_process';
import os from 'node:os';

import { PrefsStore } from '../prefs-store.js';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
export const DEFAULT_NUM_CTX = 32768;
export const MIN_NUM_CTX = 512;
// Потолок ползунка num_ctx, когда оценить память не удалось (демон молчит).
export const FALLBACK_MAX_NUM_CTX = 131072;
// Нижняя граница ползунка и клампа: меньше для разговора бессмысленно.
export const MIN_RANGE_NUM_CTX = 2048;
// Консервативная запасная оценка KV-кэша, когда model_info не дал block_count.
export const DEFAULT_KV_BYTES_PER_TOKEN = 160 * 1024;
// Сколько модель ждёт в памяти после хода. Дефолт самой Ollama — 5 минут, и это
// заметно для большой локальной модели: первый ход после выгрузки платит за холодную
// загрузку с диска. Ползунок в минутах, 0 — выгружать сразу после хода.
export const DEFAULT_KEEP_ALIVE_MIN = 5;
export const MAX_KEEP_ALIVE_MIN = 60;

/**
 * Сохранённые настройки исполнителя из prefs. Нужны там, где значений в аргументах
 * нет: контракт отдаёт `settings(config)` только config, а декларация должна знать
 * выбранный num_ctx, чтобы посчитать его цену в памяти. Ход получает те же значения
 * готовым объектом (`providerSettings` в run) и сюда не ходит.
 */
export function savedSettings(config) {
  try {
    return new PrefsStore({ prefsPath: config?.prefsPath }).read().providerSettings?.ollama || {};
  } catch {
    return {}; // prefs не читаются — работаем на env/дефолтах
  }
}

/**
 * Адрес демона: настройка из UI (prefs) → env-override (config) → дефолт.
 * Без завершающего слэша, чтобы пути клеились однообразно.
 */
export function resolveBaseUrl(config) {
  const saved = savedSettings(config).host;
  const raw = (typeof saved === 'string' && saved.trim()) || String(config?.ollamaBaseUrl || '').trim()
    || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, '');
}

/**
 * Эффективный num_ctx: выбор человека из настроек, иначе дефолт. Ollama сама ставит
 * 2048–4096 — для чата это «чудовищно мало», поэтому передаём явно каждым ходом.
 */
export function resolveNumCtx(providerSettings) {
  const raw = Number(providerSettings?.numCtx);
  if (Number.isFinite(raw) && raw > 0) return Math.max(MIN_NUM_CTX, Math.floor(raw));
  return DEFAULT_NUM_CTX;
}

/**
 * Значение keep_alive для тела запроса: минуты из настроек → строка «Nm» (формат
 * длительности Ollama). Ровно 0 — валидный выбор «выгрузить сразу», поэтому проверяем
 * конечность числа, а не truthy.
 */
export function resolveKeepAlive(providerSettings) {
  const raw = Number(providerSettings?.keepAliveMin);
  const minutes = Number.isFinite(raw) && raw >= 0
    ? Math.min(MAX_KEEP_ALIVE_MIN, Math.floor(raw))
    : DEFAULT_KEEP_ALIVE_MIN;
  return `${minutes}m`;
}

/** «5.5 ГБ» — для строк-справок в настройках и всплывашке. Не число → прочерк. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const gb = n / 1024 ** 3;
  if (gb >= 10) return `${Math.round(gb)} ГБ`;
  if (gb >= 1) return `${gb.toFixed(1)} ГБ`;
  return `${Math.max(1, Math.round(n / 1024 ** 2))} МБ`;
}

/** Ошибка «демон недоступен» (отказ в соединении/таймаут), а не ошибка протокола. */
function isUnavailable(err) {
  const code = err?.cause?.code || err?.code;
  return ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'ETIMEDOUT'].includes(code)
    || err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError';
}

/** Человекочитаемая ошибка транспорта; null — это не транспортный сбой. */
export function asUnavailableError(err, baseUrl) {
  return isUnavailable(err) ? new Error(`демон Ollama не отвечает на ${baseUrl}`) : null;
}

async function readErrorText(res) {
  const text = await res.text().catch(() => '');
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** GET JSON с таймаутом (probe/catalog — демон локальный, ждать долго нечего). */
export async function fetchJson(baseUrl, path, { timeoutMs = 1500 } = {}) {
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw asUnavailableError(err, baseUrl) || err;
  }
  if (!res.ok) {
    const detail = await readErrorText(res);
    throw new Error(`Ollama ответила HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

async function postJson(baseUrl, path, body, { timeoutMs = 1500 } = {}) {
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw asUnavailableError(err, baseUrl) || err;
  }
  if (!res.ok) {
    const detail = await readErrorText(res);
    throw new Error(`Ollama ответила HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

// Данные модели из /api/show: родное окно (model_info.<семейство>.context_length),
// сам model_info — из него estimateMaxNumCtx считает аппетит KV-кэша, — и capabilities.
// Кэш по digest: пере-pull модели меняет digest, и данные переспросятся сами.
const showCache = new Map();

/** Возможности модели из ответа демона: только известные строки, без дублей. */
export function normalizeCapabilities(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((c) => String(c || '').trim().toLowerCase()).filter(Boolean))]
    : [];
}

/**
 * { contextLength, modelInfo, capabilities } модели; null — модель без show или демон
 * моргнул (caller подставляет дефолты). modelInfo null, если демон отдал пустой блок.
 * capabilities дублирует поле из /api/tags и служит запасным источником для демонов,
 * которые в списке моделей его ещё не отдают.
 */
export async function fetchModelInfo(baseUrl, { name, digest } = {}) {
  if (digest && showCache.has(digest)) return showCache.get(digest);
  let record = null;
  try {
    const data = await postJson(baseUrl, '/api/show', { name });
    const info = data?.model_info && typeof data.model_info === 'object' ? data.model_info : {};
    const key = Object.keys(info).find((k) => k.endsWith('.context_length'));
    const parsed = Number(info[key]);
    record = {
      contextLength: Number.isFinite(parsed) && parsed > 0 ? parsed : null,
      modelInfo: Object.keys(info).length ? info : null,
      capabilities: normalizeCapabilities(data?.capabilities),
    };
  } catch { /* см. выше */ }
  if (digest && record) showCache.set(digest, record);
  return record;
}

/**
 * VRAM всех карт по nvidia-smi: { freeBytes, totalBytes }. Свободная нужна расчёту
 * потолка num_ctx, полная — полосе занятости во всплывашке топбара.
 * Нет карты/драйвера/утилиты → нули.
 */
function queryVramBytes() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=memory.free,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 2000 }, (err, stdout) => {
        if (err) { resolve({ freeBytes: 0, totalBytes: 0 }); return; } // нет nvidia-smi → ОЗУ-ветка
        let free = 0;
        let total = 0;
        for (const line of String(stdout).split('\n')) {
          const [freeMib, totalMib] = line.split(',').map((n) => Number(String(n).trim()));
          if (!Number.isFinite(freeMib) || freeMib < 0) continue;
          free += freeMib;
          if (Number.isFinite(totalMib) && totalMib > 0) total += totalMib;
        }
        resolve({ freeBytes: free * 1024 * 1024, totalBytes: total * 1024 * 1024 });
      });
  });
}

// VRAM дёргаем редко: nvidia-smi — подпроцесс, а ползунок переспросит при каждом
// открытии настроек. ОЗУ (os.freemem) читаем живьём — это дёшево.
const VRAM_CACHE_MS = 5 * 60 * 1000;
let vramCache = null; // { at, freeBytes, totalBytes }

/** Память машины: { freeVramBytes, totalVramBytes, freeRamBytes, totalRamBytes }. */
export async function systemMemory() {
  if (!vramCache || Date.now() - vramCache.at > VRAM_CACHE_MS) {
    vramCache = { at: Date.now(), ...(await queryVramBytes()) };
  }
  return {
    freeVramBytes: vramCache.freeBytes,
    totalVramBytes: vramCache.totalBytes,
    freeRamBytes: os.freemem(),
    totalRamBytes: os.totalmem(),
  };
}

/**
 * Байты KV-кэша на токен контекста (fp16): слои × KV-головы × (key+value) × 2 байта.
 * Ключи model_info ищем по суффиксу — у архитектур разные префиксы (qwen35moe.*, llama.*).
 * head_count_kv может быть null — тогда эвристика GQA ceil(heads/4);
 * нет и head_count → 1. Не нашли block_count → null: caller берёт DEFAULT_KV_BYTES_PER_TOKEN.
 */
export function kvBytesPerToken(modelInfo) {
  const info = modelInfo && typeof modelInfo === 'object' ? modelInfo : {};
  const pick = (suffix) => {
    const key = Object.keys(info).find((k) => k.endsWith(suffix));
    const n = Number(key ? info[key] : NaN);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const blocks = pick('.block_count');
  if (!blocks) return null;
  const heads = pick('.attention.head_count');
  const headsKv = pick('.attention.head_count_kv');
  const keyLen = pick('.attention.key_length') ?? 128; // типичная размерность головы
  const valueLen = pick('.attention.value_length') ?? 128;
  const kvHeads = headsKv ?? (heads ? Math.ceil(heads / 4) : 1);
  return blocks * kvHeads * (keyLen + valueLen) * 2;
}

/**
 * Потолок num_ctx от железа: бюджет = свободная VRAM + 60% свободной ОЗУ − веса модели.
 * При CPU-offload веса и KV живут и в ОЗУ, поэтому потолок только от VRAM был бы неверным.
 * Итог клампится в [MIN_RANGE_NUM_CTX, context_length] и округляется вниз до 1024.
 * model_info нет вовсе → считать нечего, потолок = context_length || FALLBACK_MAX_NUM_CTX.
 *
 * `loaded` — сколько памяти эта же модель занимает ПРЯМО СЕЙЧАС (из /api/ps). Её
 * обязательно вернуть в бюджет: при смене num_ctx демон перезагружает модель, то есть
 * сначала освобождает занятое. Без этого веса вычитались бы дважды (их уже нет в
 * свободной памяти — и мы вычитаем их ещё раз), бюджет уходил в минус, и после первого
 * хода потолок ошибочно падал до минимального значения.
 */
export function estimateMaxNumCtx({ contextLength, modelInfo, modelSizeBytes, mem, loaded } = {}) {
  const ctx = Number(contextLength);
  const limit = Number.isFinite(ctx) && ctx > 0 ? Math.floor(ctx) : null;
  const info = modelInfo && typeof modelInfo === 'object' && Object.keys(modelInfo).length ? modelInfo : null;
  if (!info) return limit ?? FALLBACK_MAX_NUM_CTX;
  const kv = kvBytesPerToken(info) ?? DEFAULT_KV_BYTES_PER_TOKEN;
  const vram = (mem?.freeVramBytes || 0) + (loaded?.vramBytes || 0);
  const ram = (mem?.freeRamBytes || 0) + (loaded?.ramBytes || 0);
  const budget = vram + 0.6 * ram - (Number(modelSizeBytes) || 0);
  const raw = Math.floor(budget / kv);
  const clamped = Math.min(Math.max(raw, MIN_RANGE_NUM_CTX), limit ?? Number.POSITIVE_INFINITY);
  return Math.floor(clamped / 1024) * 1024;
}

/**
 * Потолок num_ctx конкретной модели: /api/show (окно + model_info), память машины и
 * то, что эта модель уже занимает в демоне.
 * Демон молчит → FALLBACK_MAX_NUM_CTX (fetchModelInfo вернул null).
 */
export async function estimateModelMaxNumCtx(baseUrl, { name, digest, sizeBytes } = {}) {
  const [record, mem, loadedList] = await Promise.all([
    fetchModelInfo(baseUrl, { name, digest }).catch(() => null),
    systemMemory(),
    fetchLoadedModels(baseUrl).catch(() => []),
  ]);
  return estimateMaxNumCtx({
    contextLength: record?.contextLength,
    modelInfo: record?.modelInfo,
    modelSizeBytes: sizeBytes,
    mem,
    loaded: loadedList.find((m) => m.name === name),
  });
}

/**
 * Что сейчас загружено в память демона (GET /api/ps): для каждой модели — сколько
 * весов лежит в VRAM против ОЗУ, фактическое окно контекста загруженного экземпляра
 * и когда он выгрузится. Именно это отвечает на вопрос «почему первый ход после
 * перерыва такой долгий»; демон молчит → пустой список.
 */
export async function fetchLoadedModels(baseUrl, { timeoutMs = 1500 } = {}) {
  let data;
  try {
    data = await fetchJson(baseUrl, '/api/ps', { timeoutMs });
  } catch {
    return [];
  }
  return (Array.isArray(data?.models) ? data.models : [])
    .filter((m) => m?.name)
    .map((m) => {
      const total = Number(m.size) || 0;
      const vram = Number(m.size_vram) || 0;
      const expiresAt = Date.parse(m.expires_at || '');
      return {
        name: String(m.name),
        totalBytes: total,
        vramBytes: vram,
        // Остаток весов лежит в ОЗУ (CPU-offload); для модели крупнее VRAM это
        // основная часть, и именно она объясняет скорость.
        ramBytes: Math.max(0, total - vram),
        contextLength: Number(m.context_length) || null,
        expiresInSec: Number.isFinite(expiresAt)
          ? Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
          : null,
      };
    });
}

/**
 * Выгрузить модель из памяти: пустой ход с keep_alive 0 — документированный способ
 * Ollama освободить VRAM, отдельной ручки «unload» у демона нет.
 */
export async function unloadModel(baseUrl, model) {
  // stream: false обязателен — иначе демон отвечает NDJSON-потоком, а нам нужен
  // один разбираемый документ (генерации тут нет: сообщений ноль, ответ — одна запись).
  await postJson(baseUrl, '/api/chat', {
    model, messages: [], keep_alive: 0, stream: false,
  }, { timeoutMs: 10000 });
}

/**
 * Стрим хода чата: POST /api/chat, ответ — NDJSON-строки
 * { message: { role, content, thinking? }, done, prompt_eval_count?, eval_count? }.
 * Каждая распарсенная строка уходит в onLine. Abort внешним signal обрывает чтение;
 * зватель по signal.aborted отличает «стоп человека» от сбоя сети.
 */
export async function postChatStream(baseUrl, body, { signal, onLine } = {}) {
  let res;
  try {
    res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw asUnavailableError(err, baseUrl) || err;
  }
  if (!res.ok) {
    const detail = await readErrorText(res);
    throw new Error(`Ollama ответила HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const feed = (chunk, { flush = false } = {}) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { onLine(JSON.parse(line)); } catch { /* битая строка стрима — пропускаем */ }
    }
    if (flush) {
      const tail = buf.trim();
      buf = '';
      if (tail) {
        try { onLine(JSON.parse(tail)); } catch { /* см. выше */ }
      }
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
    feed(decoder.decode(), { flush: true });
  } finally {
    reader.releaseLock();
  }
}
