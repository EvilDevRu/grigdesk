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
// Запасная оценка KV-кэша, когда model_info не дал block_count: 160 КБ/токен
// (ровно столько выходит у реального qwen35moe 36B через GQA-эвристику ниже).
export const DEFAULT_KV_BYTES_PER_TOKEN = 160 * 1024;

/**
 * Адрес демона: настройка из UI (prefs) → env-override (config) → дефолт.
 * Без завершающего слэша, чтобы пути клеились однообразно.
 */
export function resolveBaseUrl(config) {
  let saved = '';
  try {
    saved = new PrefsStore({ prefsPath: config?.prefsPath }).read().providerSettings?.ollama?.host;
  } catch { /* prefs не читаются — работаем на env/дефолте */ }
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

// Данные модели из /api/show: родное окно (model_info.<семейство>.context_length) и
// сам model_info — из него estimateMaxNumCtx считает аппетит KV-кэша.
// Кэш по digest: пере-pull модели меняет digest, и данные переспросятся сами.
const showCache = new Map();

/**
 * { contextLength, modelInfo } модели; null — модель без show или демон моргнул
 * (caller подставляет дефолты). modelInfo null, если демон отдал пустой блок.
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
    };
  } catch { /* см. выше */ }
  if (digest && record) showCache.set(digest, record);
  return record;
}

/** Свободная VRAM всех карт по nvidia-smi (байты). Нет карты/драйвера/утилиты → 0. */
function queryFreeVramBytes() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
      { timeout: 2000 }, (err, stdout) => {
        if (err) { resolve(0); return; } // нет nvidia-smi → 0, остаётся ОЗУ-ветка (offload-мир)
        const mib = String(stdout).split('\n')
          .map((line) => Number(line.trim()))
          .filter((n) => Number.isFinite(n) && n >= 0);
        resolve(mib.reduce((sum, n) => sum + n, 0) * 1024 * 1024);
      });
  });
}

// VRAM дёргаем редко: nvidia-smi — подпроцесс, а ползунок переспросит при каждом
// открытии настроек. ОЗУ (os.freemem) читаем живьём — это дёшево.
const VRAM_CACHE_MS = 5 * 60 * 1000;
let vramCache = null; // { at, bytes }

/** Свободная память машины: { freeVramBytes, freeRamBytes }. */
export async function systemMemory() {
  if (!vramCache || Date.now() - vramCache.at > VRAM_CACHE_MS) {
    vramCache = { at: Date.now(), bytes: await queryFreeVramBytes() };
  }
  return { freeVramBytes: vramCache.bytes, freeRamBytes: os.freemem() };
}

/**
 * Байты KV-кэша на токен контекста (fp16): слои × KV-головы × (key+value) × 2 байта.
 * Ключи model_info ищем по суффиксу — у архитектур разные префиксы (qwen35moe.*, llama.*).
 * head_count_kv бывает null (реальный qwen35moe!) — тогда эвристика GQA ceil(heads/4);
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
 * Потолок num_ctx от железа: бюджет = свободная VRAM + 60% свободной ОЗУ − веса модели
 * (при CPU-offload веса и KV живут и в ОЗУ — потолок «только от VRAM» на 8-гигабайтной
 * карте с 24-гигабайтной моделью сказал бы «нельзя ничего», что неправда).
 * Итог клампится в [MIN_RANGE_NUM_CTX, context_length] и округляется вниз до 1024.
 * model_info нет вовсе → считать нечего, потолок = context_length || FALLBACK_MAX_NUM_CTX.
 */
export function estimateMaxNumCtx({ contextLength, modelInfo, modelSizeBytes, mem } = {}) {
  const ctx = Number(contextLength);
  const limit = Number.isFinite(ctx) && ctx > 0 ? Math.floor(ctx) : null;
  const info = modelInfo && typeof modelInfo === 'object' && Object.keys(modelInfo).length ? modelInfo : null;
  if (!info) return limit ?? FALLBACK_MAX_NUM_CTX;
  const kv = kvBytesPerToken(info) ?? DEFAULT_KV_BYTES_PER_TOKEN;
  const budget = (mem?.freeVramBytes || 0) + 0.6 * (mem?.freeRamBytes || 0) - (Number(modelSizeBytes) || 0);
  const raw = Math.floor(budget / kv);
  const clamped = Math.min(Math.max(raw, MIN_RANGE_NUM_CTX), limit ?? Number.POSITIVE_INFINITY);
  return Math.floor(clamped / 1024) * 1024;
}

/**
 * Потолок num_ctx конкретной модели: /api/show (окно + model_info) + память машины.
 * Демон молчит → FALLBACK_MAX_NUM_CTX (fetchModelInfo вернул null).
 */
export async function estimateModelMaxNumCtx(baseUrl, { name, digest, sizeBytes } = {}) {
  const [record, mem] = await Promise.all([
    fetchModelInfo(baseUrl, { name, digest }).catch(() => null),
    systemMemory(),
  ]);
  return estimateMaxNumCtx({
    contextLength: record?.contextLength,
    modelInfo: record?.modelInfo,
    modelSizeBytes: sizeBytes,
    mem,
  });
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
