// Ollama — локальные модели (Qwen и др.) через HTTP API демона. Это ПРОСТОЙ ЧАТ без
// инструментов: ни файловых действий, ни режимов прав, ни слэш-команд — модель только
// отвечает текстом. Демон stateless, поэтому историю разговора восстанавливаем из
// server-owned истории чата (opts.chatHistory) на каждый ход. Адрес демона и размер
// контекста (num_ctx) — свои настройки исполнителя, редактируются из UI
// («Настройки → Исполнители», prefs.providerSettings.ollama). num_ctx — ползунок
// с потолком от памяти машины (см. _ollama-client.js), а run() дополнительно клампит
// его по per-model оценке выбранной модели.
import { createStepSink, cut } from '../chat/stream-steps.js';
import {
  DEFAULT_NUM_CTX,
  FALLBACK_MAX_NUM_CTX,
  MIN_RANGE_NUM_CTX,
  asUnavailableError,
  estimateMaxNumCtx,
  estimateModelMaxNumCtx,
  fetchJson,
  fetchModelInfo,
  postChatStream,
  resolveBaseUrl,
  resolveNumCtx,
  systemMemory,
} from './_ollama-client.js';

// Троттлинг text/think шагов ленты: стрим течёт токенами, спамить SSE на каждый нельзя.
const STEP_THROTTLE_MS = 200;
const STEP_THROTTLE_CHARS = 500;

/** «14.8B» → 14.8, «7B» → 7 — ранг силы для сортировки каталога. Не число → 0. */
function tierFromParameterSize(value) {
  const m = String(value || '').match(/([\d.]+)\s*B/i);
  const parsed = m ? Number(m[1]) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Сообщения для POST /api/chat. История реплеится только в живом разговоре
 * (sessionId truthy): сброс памяти и сжатие-выжимкой обнуляют sessionId на клиенте,
 * и тогда начинаем с чистого листа (выжимка приезжает в самом тексте сообщения).
 * Клиент сохраняет чат ДО отправки, поэтому текущее сообщение уже сидит последним
 * user-блоком истории — срезаем дубликат: последний user с непустым текстом,
 * который является суффиксом message (у message есть служебные префиксы).
 */
function buildMessages({ message, sessionId, chatHistory }) {
  const messages = [];
  if (sessionId && Array.isArray(chatHistory)) {
    const history = chatHistory
      .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && String(m?.text || '').trim())
      .map((m) => ({ role: m.role, text: String(m.text).trim() }));
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i].role === 'user' && message.endsWith(history[i].text)) {
        history.splice(i, 1);
        break;
      }
    }
    for (const m of history) messages.push({ role: m.role, content: m.text });
  }
  messages.push({ role: 'user', content: message });
  return messages;
}

/** Жив ли демон: GET /api/version с коротким таймаутом. */
async function probeDaemon(config) {
  try {
    const data = await fetchJson(resolveBaseUrl(config), '/api/version', { timeoutMs: 1500 });
    return { ok: true, version: String(data?.version || '').slice(0, 60) || null };
  } catch {
    return { ok: false, version: null };
  }
}

export default {
  id: 'ollama',
  name: 'Ollama',
  vendor: 'Ollama',
  color: '#b8c0cc',
  order: 4,
  install: 'curl -fsSL https://ollama.com/install.sh | sh',

  // Свои настройки: адрес демона у всех разный (localhost, LAN, Tailscale), а дефолтный
  // num_ctx у Ollama — 2048–4096, для разговора это ничто. Обе ручки редактируются из UI.
  // settings — async-ФУНКЦИЯ (расширение контракта, см. executors/index.js): потолок
  // ползунка numCtx вычисляется от памяти машины и весов моделей, поэтому декларацию
  // собираем по живому опросу демона; молчит → дефолтный потолок FALLBACK_MAX_NUM_CTX.
  async settings(config) {
    const baseUrl = resolveBaseUrl(config);
    let max = FALLBACK_MAX_NUM_CTX;
    try {
      const tags = await fetchJson(baseUrl, '/api/tags', { timeoutMs: 2000 });
      const models = (Array.isArray(tags?.models) ? tags.models : []).filter((m) => m?.name);
      const estimates = await Promise.all(models.map((m) => estimateModelMaxNumCtx(baseUrl, {
        name: m.name, digest: m.digest, sizeBytes: m.size,
      })));
      if (estimates.length) max = Math.max(...estimates);
    } catch { /* демон молчит — рисуем ползунок с дефолтным потолком */ }
    return [
      {
        id: 'host', kind: 'text', label: 'Адрес демона Ollama', value: 'http://127.0.0.1:11434',
        hint: 'Где слушает ollama serve (у всех по-разному: localhost, LAN, Tailscale).',
      },
      {
        id: 'numCtx', kind: 'range', label: 'Размер контекста (num_ctx)',
        min: MIN_RANGE_NUM_CTX, step: 1024, max, value: 32768,
        hint: 'Потолок — оценка по памяти машины (VRAM + ОЗУ при offload) и весам моделей; родное окно qwen3.6 — 256k, но в память влезает меньше.',
      },
    ];
  },

  bin() { return 'ollama'; },

  async probe(config) {
    return probeDaemon(config);
  },

  // Авторизации у локального HTTP нет; available — просто «демон отвечает».
  async auth(config) {
    const { ok } = await probeDaemon(config);
    return { mode: 'none', label: 'локальный HTTP — авторизация не нужна', available: ok };
  },

  // Каталог полностью наполняет catalog() из живого демона; пустой массив truthy —
  // досев в models.json не нужен.
  seedModels() { return []; },

  catalogLive: true,

  /**
   * Подтянутые в демон модели (GET /api/tags) + родное окно из /api/show (кэш по digest).
   * maxNumCtx — потолок num_ctx модели от памяти машины (тот же расчёт, что у ползунка
   * в настройках и клампа в run). Демон недоступен → null: реестр оставит прошлый
   * список, а не пустоту.
   */
  async catalog(config) {
    const baseUrl = resolveBaseUrl(config);
    let tags;
    try {
      tags = await fetchJson(baseUrl, '/api/tags', { timeoutMs: 2000 });
    } catch {
      return null;
    }
    const mem = await systemMemory();
    const out = [];
    for (const m of Array.isArray(tags?.models) ? tags.models : []) {
      const tag = String(m?.name || '').trim();
      if (!tag) continue;
      const details = m?.details || {};
      const record = await fetchModelInfo(baseUrl, { name: tag, digest: m?.digest });
      const context = record?.contextLength ?? DEFAULT_NUM_CTX;
      const spec = [details.parameter_size, details.quantization_level].filter(Boolean).join(', ');
      out.push({
        id: tag,
        name: spec ? `${tag} (${spec})` : tag,
        context,
        maxNumCtx: estimateMaxNumCtx({
          contextLength: record?.contextLength,
          modelInfo: record?.modelInfo,
          modelSizeBytes: m?.size,
          mem,
        }),
        tier: tierFromParameterSize(details.parameter_size),
        efforts: [],
        family: String(details.family || tag.split(':')[0]),
      });
    }
    return out;
  },

  /**
   * Ход чата: POST /api/chat со стримом NDJSON. thinking-чанки → think-шаги ленты,
   * content → накопление reply и троттленные text-шаги; финальная строка done:true
   * несёт prompt_eval_count/eval_count — из них честный расход контекста.
   */
  async run({ config, chatKey, signal, message, model, sessionId, chatHistory, providerSettings, onStep }) {
    const baseUrl = resolveBaseUrl(config);
    const nextSessionId = sessionId || (chatKey ? `ollama:${chatKey}` : null);
    const sink = createStepSink(onStep);
    if (!model) throw new Error('Не выбрана модель Ollama — выбери её в селекте чата.');

    const messages = buildMessages({ message: String(message || ''), sessionId, chatHistory });
    sink.emit({ k: 'start', model, mode: '', cwd: '' });

    // Кламп num_ctx по per-model оценке памяти: больше потолка KV-кэш не влезет
    // в VRAM+ОЗУ этой модели. Оценку не удалось получить — работаем с настройкой как есть.
    let numCtx = resolveNumCtx(providerSettings);
    try {
      const tags = await fetchJson(baseUrl, '/api/tags', { timeoutMs: 2000 });
      const entry = (Array.isArray(tags?.models) ? tags.models : []).find((m) => m?.name === model);
      const maxNumCtx = entry
        ? await estimateModelMaxNumCtx(baseUrl, { name: model, digest: entry.digest, sizeBytes: entry.size })
        : null;
      if (maxNumCtx && numCtx > maxNumCtx) {
        numCtx = maxNumCtx;
        sink.emit({ k: 'note', text: `num_ctx ограничен до ${maxNumCtx}: больше не влезет в память по оценке` });
      }
    } catch { /* демон моргнул на оценке — дальше ход сам решит, жив ли он */ }

    let reply = '';
    let thinking = '';
    let promptTokens = 0;
    let evalTokens = 0;
    let lastStepAt = 0;
    let lastStepLen = 0;
    const emitProgress = (force = false) => {
      const total = thinking.length + reply.length;
      const now = Date.now();
      if (!force && now - lastStepAt < STEP_THROTTLE_MS && total - lastStepLen < STEP_THROTTLE_CHARS) return;
      lastStepAt = now;
      lastStepLen = total;
      if (thinking) sink.emit({ k: 'think', text: cut(thinking) });
      if (reply) sink.emit({ k: 'text', text: cut(reply, 4000) });
    };

    try {
      await postChatStream(baseUrl, {
        model,
        messages,
        stream: true,
        options: { num_ctx: numCtx },
      }, {
        signal,
        onLine(chunk) {
          const piece = chunk?.message || {};
          if (piece.thinking) thinking += String(piece.thinking);
          if (piece.content) reply += String(piece.content);
          if (piece.thinking || piece.content) emitProgress();
          if (chunk?.done) {
            promptTokens = Number(chunk.prompt_eval_count) || 0;
            evalTokens = Number(chunk.eval_count) || 0;
          }
        },
      });
    } catch (err) {
      // Кнопка «стоп»: ход оборван человеком, а не сломан — отдаём накопленное.
      if (signal?.aborted) {
        const stopped = new Error('Ход остановлен.');
        stopped.stopped = true;
        stopped.sessionId = nextSessionId;
        stopped.contextTokens = promptTokens + evalTokens;
        stopped.steps = sink.steps;
        throw stopped;
      }
      throw asUnavailableError(err, baseUrl) || err;
    }
    emitProgress(true); // финальный срез ленты, если стрим давал текст

    // Некоторые модели шлют размышления прямо в content — убираем их из ответа.
    const cleaned = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return {
      reply: cleaned || '(модель вернула пустой ответ)',
      sessionId: nextSessionId,
      contextTokens: promptTokens + evalTokens,
      contextWindow: numCtx,
      cost: null,
      steps: sink.steps,
    };
  },
};
