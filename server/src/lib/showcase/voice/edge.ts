// Облачный голос: Microsoft Edge TTS.
//
// Подключён по причине, которую слышно: многоязычные нейросетевые голоса
// поставщика прослушаны, и один из них утверждён для роликов вместе с темпом и
// высотой (см. edgeCatalog.ts). Сервис — тот, что читает страницы вслух в браузере
// Edge: ключа и оплаты у него нет, но и договора тоже. Это граница: текст сцен
// уходит поставщику, а сам сервис не публичный API — он вправе поменять протокол
// без предупреждения, и тогда отказ приходит словами в готовности движка.
//
// Протокол — WebSocket сервиса чтения вслух: подпись запроса считается от времени
// и общего токена браузера (Sec-MS-GEC), речь приходит порциями MP3, которые
// склеиваются и перегоняются ffmpeg в сырые отсчёты. SSML сервис принимает только
// формы «голос → просодия → текст»: `<break>` он отвергает (проверено 11.09.2026,
// код 1007 «SSML is invalid»), поэтому пауза — это отдельный запрос на каждую
// часть текста и тишина между частями в отсчётах. Акценты, тон и ударения по той
// же причине объявлены неподдержанными: знак ударения в тексте меняет форму волны,
// но слухом эффект не проверен, и обещать его нельзя.
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';

import { ShowcaseError } from '../errors.ts';
import { unsupportedDirections } from './contract.ts';
import { peakOfPcm, silencePcm, wavOfPcm } from './pcm.ts';
import {
  EDGE_CHROMIUM_VERSION,
  EDGE_SOCKET_URL,
  EDGE_TRUSTED_CLIENT_TOKEN,
  EDGE_VOICE_LIST_URL,
  EDGE_VOICE_TUNING,
  EDGE_VOICES_SNAPSHOT,
  edgeVoiceLabel,
  edgeVoiceReads,
  parseEdgeVoiceList,
  sortEdgeVoices,
} from './edgeCatalog.ts';
import type { EdgeVoice, EdgeVoiceTuning } from './edgeCatalog.ts';
import type {
  SynthesisInput,
  SynthesisOptions,
  VoiceCandidate,
  VoiceCapabilities,
  VoiceDoctor,
  VoiceEngine,
  VoiceInfo,
  VoicePace,
  VoiceSpeechSpanTiming,
  VoiceSpeechTiming,
} from './contract.ts';

// Поставщик отдаёт MP3 24 кГц моно; сырые отсчёты — той же частоты.
const SAMPLE_RATE = 24_000;
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

// Ниже этого пика файл считается тишиной: молчащий ответ, который в остальном
// выглядит как удачный, не должен стать звуком сцены.
const SILENCE_PEAK = 0.005;

// Дольше семи секунд пауза ролику не нужна.
const MAX_PAUSE_MS = 7000;

// Одним запросом сервис принимает около четырёх килобайт текста — так режет
// текст и эталонная реализация протокола. Кириллица — два байта на знак.
const MAX_PIECE_BYTES = 4096;

// Edge сообщает Offset/Duration в шагах по 100 нс. После декодирования MP3
// граница иногда выступает за последний PCM-отсчёт из-за округления поставщика;
// до 20 мс можно честно прижать к WAV, больший выход делает все метки непригодными.
const EDGE_TICKS_PER_MS = 10_000;
const TIMING_END_TOLERANCE_MS = 20;

// Живой список голосов живёт час: голоса у поставщика появляются редко, а
// проверка готовности спрашивается на каждом открытии раздела. Отказ сети
// помнится минуту — сеть возвращается, и движок должен включиться сам.
const CATALOG_CACHE_MS = 60 * 60 * 1000;
const CATALOG_RETRY_MS = 60 * 1000;
const CATALOG_ATTEMPTS = 3;
const CATALOG_TIMEOUT_MS = 8000;
const CATALOG_BUDGET_MS = 12_000;

// Сроки одного запроса речи: рукопожатие и тишина в эфире после него.
const CONNECT_TIMEOUT_MS = 15_000;
const RECEIVE_TIMEOUT_MS = 30_000;

// Сетевые отказы повторяются: TLS к поставщику на некоторых маршрутах рвётся
// сериями, и один обрыв — не причина ронять озвучку сцены.
const SYNTH_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [300, 800, 1500];

const WINDOWS_EPOCH_SECONDS = 11_644_473_600;

const SWITCH_HINT = 'Уберите COCKPIT_SHOWCASE_EDGE_TTS=0 из корневого .env сервера и перезапустите его.';

// Ступени темпа — множитель к темпу голоса (у утверждённого голоса он уже +12 %).
const EDGE_PACE_RATE: Record<VoicePace, number> = {
  slowest: 0.7,
  slow: 0.85,
  normal: 1,
  fast: 1.2,
  fastest: 1.4,
};

export interface EdgeEngineOptions {
  // Выключенный настройкой движок остаётся в списке с подсказкой, как включить.
  enabled: boolean;
  // Язык озвучки: по нему из живого списка отбираются голоса, которые его читают.
  language?: string;
  // Адреса и fetch переопределяют только тесты: в них поставщика подменяют местные
  // HTTP- и WebSocket-серверы, и ни один запрос из проверок наружу не уходит.
  voiceListUrl?: string;
  socketUrl?: string;
  fetch?: typeof fetch;
}

export interface EdgePiece {
  text: string;
  silenceAfterMs: number;
}

type EdgeBoundaryKind = 'word' | 'segment';

interface EdgeBoundary {
  kind: EdgeBoundaryKind;
  text: string;
  startMs: number;
  endMs: number;
}

interface EdgePieceResponse {
  audio: Buffer;
  requestId: string;
  boundaries: EdgeBoundary[] | null;
}

// Сетевой отказ одного запроса: его можно повторить. Всё остальное — окончательно.
class EdgeNetworkError extends Error {}

// Глобальный WebSocket Node (undici) принимает заголовки вторым аргументом;
// типы DOM об этом расширении не знают, поэтому конструктор приводится явно.
type SocketFactory = new (url: string, init: { headers: Record<string, string> }) => WebSocket;

const NodeWebSocket = WebSocket as unknown as SocketFactory;

/**
 * Подпись запроса Sec-MS-GEC: SHA-256 от времени Windows (сотни наносекунд от
 * 1601 года), округлённого вниз до пяти минут, и общего токена браузера.
 * Формула повторяет эталонную реализацию протокола; часы сервера должны идти
 * верно с точностью до этих пяти минут, иначе поставщик отвечает отказом.
 */
export function edgeSecMsGec(epochMs: number): string {
  let ticks = epochMs / 1000 + WINDOWS_EPOCH_SECONDS;

  ticks -= ticks % 300;
  ticks *= 1e7;

  return createHash('sha256')
    .update(`${ticks.toFixed(0)}${EDGE_TRUSTED_CLIENT_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase();
}

// Темп в единицах поставщика: проценты со знаком от его обычной скорости.
export function edgeRatePercent(factor: number): string {
  const percent = Math.round((factor - 1) * 100);

  return `${percent < 0 ? '-' : '+'}${Math.abs(percent)}%`;
}

export function edgePitchHz(hz: number): string {
  const rounded = Math.round(hz);

  return `${rounded < 0 ? '-' : '+'}${Math.abs(rounded)}Hz`;
}

// Текст — узел XML: экранируются пять служебных знаков, управляющие символы
// (кроме перевода строки и табуляции) сервис не принимает и заменяются пробелом.
function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * SSML ровно той формы, которую сервис принимает: голос, просодия, текст. Ничего
 * другого внутрь класть нельзя — любой лишний элемент даёт отказ «SSML is invalid».
 */
export function edgeSsml(voiceId: string, text: string, tuning: EdgeVoiceTuning): string {
  return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>"
    + `<voice name='${voiceId}'>`
    + `<prosody pitch='${edgePitchHz(tuning.pitchHz)}' rate='${edgeRatePercent(tuning.rate)}' volume='+0%'>`
    + escapeXml(text)
    + '</prosody></voice></speak>';
}

// Самый длинный префикс, укладывающийся в предел байтов UTF-8.
function charsWithin(text: string, maxBytes: number): number {
  let bytes = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index) ?? 0;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;

    if (bytes + size > maxBytes) {
      return index;
    }

    bytes += size;

    if (code > 0xffff) {
      index += 1;
    }
  }

  return text.length;
}

/**
 * Нарезка длинного текста под предел запроса: по концу предложения, иначе по
 * пробелу, иначе по последнему знаку, который влезает. Куски без текста не
 * возвращаются.
 */
function splitByBytes(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let rest = text.trim();

  while (rest && Buffer.byteLength(rest, 'utf8') > maxBytes) {
    const limit = charsWithin(rest, maxBytes);
    const head = rest.slice(0, limit);
    const sentenceEnd = Math.max(
      ...[...head.matchAll(/[.!?…]\s/g)].map((match) => match.index + 1),
      -1,
    );
    const cut = sentenceEnd > 0 ? sentenceEnd : Math.max(head.lastIndexOf(' '), head.lastIndexOf('\n'));
    const at = cut > 0 ? cut : Math.max(limit, 1);
    const chunk = rest.slice(0, at).trim();

    if (chunk) {
      chunks.push(chunk);
    }

    rest = rest.slice(at).trim();
  }

  if (rest) {
    chunks.push(rest);
  }

  return chunks;
}

/**
 * Части реплики для отдельных запросов: текст режется в позициях пауз и по
 * пределу запроса, у каждой части — тишина после неё. Пауза без текста рядом
 * (в начале, в конце, две подряд) не теряется: тишина складывается с соседней.
 */
export function edgePieces(
  text: string,
  pauses: readonly { at: number; ms: number }[],
  maxBytes = MAX_PIECE_BYTES,
): EdgePiece[] {
  const cuts = pauses
    .map((pause) => ({
      at: Math.min(Math.max(Math.round(pause.at), 0), text.length),
      ms: Math.min(Math.max(Math.round(pause.ms), 0), MAX_PAUSE_MS),
    }))
    .filter((pause) => pause.ms > 0)
    .sort((left, right) => left.at - right.at);
  const segments: EdgePiece[] = [];
  let cursor = 0;

  for (const cut of cuts) {
    segments.push({ text: text.slice(cursor, cut.at), silenceAfterMs: cut.ms });
    cursor = cut.at;
  }

  segments.push({ text: text.slice(cursor), silenceAfterMs: 0 });

  const pieces: EdgePiece[] = [];

  for (const segment of segments) {
    const chunks = splitByBytes(segment.text, maxBytes);
    const last = pieces.at(-1);

    if (chunks.length === 0) {
      if (segment.silenceAfterMs > 0 && last) {
        last.silenceAfterMs += segment.silenceAfterMs;
      } else if (segment.silenceAfterMs > 0) {
        pieces.push({ text: '', silenceAfterMs: segment.silenceAfterMs });
      }

      continue;
    }

    for (const [index, chunk] of chunks.entries()) {
      pieces.push({
        text: chunk,
        silenceAfterMs: index === chunks.length - 1 ? segment.silenceAfterMs : 0,
      });
    }
  }

  return pieces;
}

// Метка времени в форме, которую ждёт сервис: как её печатает JavaScript браузера.
function edgeTimestamp(now = new Date()): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (value: number): string => String(value).padStart(2, '0');

  return `${days[now.getUTCDay()]} ${months[now.getUTCMonth()]} ${pad(now.getUTCDate())} `
    + `${now.getUTCFullYear()} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:`
    + `${pad(now.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

/**
 * Заголовки, с которыми сервис узнаёт браузер Edge: агент, источник расширения
 * чтения вслух и случайный идентификатор MUID в cookie. Без них рукопожатие
 * отвергается кодом 403.
 */
function edgeHeaders(): Record<string, string> {
  const major = EDGE_CHROMIUM_VERSION.split('.')[0];

  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
      + `Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    Cookie: `muid=${randomBytes(16).toString('hex').toUpperCase()};`,
  };
}

function signedUrl(base: string, connectionId: string | null): string {
  const url = new URL(base);

  url.searchParams.set('Sec-MS-GEC', edgeSecMsGec(Date.now()));
  url.searchParams.set('Sec-MS-GEC-Version', `1-${EDGE_CHROMIUM_VERSION}`);

  if (connectionId) {
    url.searchParams.set('ConnectionId', connectionId);
  }

  return url.toString();
}

// Заголовки сообщения протокола: строки `Ключ:значение` до пустой строки.
function headersOf(block: string): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const line of block.split('\r\n')) {
    const colon = line.indexOf(':');

    if (colon > 0) {
      headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }

  return headers;
}

function textPathOf(message: string): string {
  const end = message.indexOf('\r\n\r\n');

  return headersOf(end >= 0 ? message.slice(0, end) : message).Path ?? '';
}

function textBodyOf(message: string): string {
  const end = message.indexOf('\r\n\r\n');

  return end >= 0 ? message.slice(end + 4) : '';
}

function edgeBoundaryText(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    quot: '"',
  };

  return text.replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|apos|gt|lt|quot));/gi, (whole, decimal, hex, name) => {
    if (name) {
      return named[String(name).toLowerCase()] ?? whole;
    }

    const codePoint = Number.parseInt(decimal ?? hex, decimal ? 10 : 16);

    try {
      return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : whole;
    } catch {
      return whole;
    }
  });
}

/**
 * Одно сообщение может содержать несколько границ. Неизвестные виды игнорируются:
 * сервис добавляет служебные записи независимо от включённых WordBoundary.
 */
function boundariesOfMetadata(message: string): EdgeBoundary[] | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(textBodyOf(message)) as unknown;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { Metadata?: unknown }).Metadata)) {
    return null;
  }

  const boundaries: EdgeBoundary[] = [];

  for (const raw of (parsed as { Metadata: unknown[] }).Metadata) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const record = raw as { Type?: unknown; Data?: unknown };
    const kind: EdgeBoundaryKind | null = record.Type === 'WordBoundary'
      ? 'word'
      : record.Type === 'SentenceBoundary'
        ? 'segment'
        : null;

    if (!kind) {
      continue;
    }

    if (!record.Data || typeof record.Data !== 'object') {
      return null;
    }

    const data = record.Data as {
      Offset?: unknown;
      Duration?: unknown;
      text?: { Text?: unknown };
    };
    const offsetTicks = data.Offset;
    const durationTicks = data.Duration;
    const text = data.text?.Text;

    if (
      typeof offsetTicks !== 'number'
      || typeof durationTicks !== 'number'
      || !Number.isSafeInteger(offsetTicks)
      || !Number.isSafeInteger(durationTicks)
      || offsetTicks < 0
      || durationTicks <= 0
      || typeof text !== 'string'
      || text.length === 0
    ) {
      return null;
    }

    const startMs = offsetTicks / EDGE_TICKS_PER_MS;
    const endMs = startMs + durationTicks / EDGE_TICKS_PER_MS;

    if (!Number.isFinite(endMs)) {
      return null;
    }

    boundaries.push({ kind, text: edgeBoundaryText(text), startMs, endMs });
  }

  return boundaries;
}

function timingOfPiece(
  boundaries: EdgeBoundary[] | null,
  pcmSamples: number,
): Pick<VoiceSpeechTiming, 'words' | 'segments'> | null {
  if (!boundaries || !Number.isSafeInteger(pcmSamples) || pcmSamples <= 0) {
    return null;
  }

  const durationMs = pcmSamples * 1000 / SAMPLE_RATE;
  const sourceBoundaries = boundaries;

  function spans(kind: EdgeBoundaryKind): VoiceSpeechSpanTiming[] | null {
    const source = sourceBoundaries.filter((boundary) => boundary.kind === kind);
    const result: VoiceSpeechSpanTiming[] = [];
    let previousEndMs = 0;

    for (const boundary of source) {
      if (
        boundary.startMs < previousEndMs
        || boundary.startMs >= durationMs
        || boundary.endMs > durationMs + TIMING_END_TOLERANCE_MS
      ) {
        return null;
      }

      const endMs = Math.min(boundary.endMs, durationMs);

      if (endMs <= boundary.startMs) {
        return null;
      }

      result.push({ text: boundary.text, startMs: boundary.startMs, endMs });
      previousEndMs = endMs;
    }

    return result;
  }

  const words = spans('word');
  const segments = spans('segment');

  // Точный нативный результат обязан иметь слова для каждой озвученной части.
  if (!words || words.length === 0 || !segments) {
    return null;
  }

  return { words, segments };
}

/**
 * Двоичный кадр: два байта длины заголовков, заголовки, звук. Кадр без звука —
 * штатный конец потока, а не отказ.
 */
export function audioOfFrame(frame: Buffer): Buffer | null {
  if (frame.length < 2) {
    return null;
  }

  const headerLength = frame.readUInt16BE(0);

  if (frame.length < headerLength + 2) {
    return null;
  }

  const headers = headersOf(frame.subarray(2, 2 + headerLength).toString('utf8'));

  if (headers.Path !== 'audio') {
    return null;
  }

  return frame.subarray(2 + headerLength);
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);

    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * MP3 → сырые отсчёты через ffmpeg с потоками, без временных файлов: звук
 * поставщика идёт на stdin, отсчёты читаются со stdout.
 */
async function decodeMp3(mp3: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'mp3', '-i', 'pipe:0',
      '-f', 's16le', '-ac', '1', '-ar', String(SAMPLE_RATE),
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: Error) => {
      reject(new ShowcaseError('voice_failed', `ffmpeg не запустился: ${error.message}`, 500));
    });
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve(Buffer.concat(out));

        return;
      }

      reject(new ShowcaseError(
        'voice_failed',
        `ffmpeg не раскодировал ответ Microsoft (код ${code}): ${stderr.trim().slice(-300)}`,
        502,
      ));
    });
    child.stdin.on('error', () => {
      // ffmpeg закрыл stdin раньше конца — отказ придёт кодом возврата.
    });
    child.stdin.end(mp3);
  });
}

export function createEdgeEngine(options: EdgeEngineOptions): VoiceEngine {
  const language = options.language ?? 'ru';
  const voiceListUrl = options.voiceListUrl ?? EDGE_VOICE_LIST_URL;
  const socketUrl = options.socketUrl ?? EDGE_SOCKET_URL;
  const call = options.fetch ?? fetch;

  // Живой список и его отказ помнятся по-разному долго: см. константы выше.
  // Идущий запрос делится между вызовами: готовность и список голосов спрашивают
  // его одновременно, и два одинаковых запроса к поставщику ни к чему.
  let catalog: { at: number; voices: EdgeVoice[] | null; error: string } | null = null;
  let inflight: Promise<{ voices: EdgeVoice[] | null; error: string }> | null = null;

  /**
   * Один заход за живым списком с ограниченным числом попыток и общим бюджетом
   * времени: раздел ждёт этот ответ на открытии, и минута ожидания хуже честного
   * «сеть не ответила».
   */
  async function fetchCatalog(): Promise<EdgeVoice[]> {
    const started = Date.now();
    let lastError = 'сеть не ответила';

    for (let attempt = 0; attempt < CATALOG_ATTEMPTS; attempt += 1) {
      if (attempt > 0 && Date.now() - started > CATALOG_BUDGET_MS) {
        break;
      }

      try {
        const response = await call(signedUrl(voiceListUrl, null), {
          headers: edgeHeaders(),
          signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
        });

        if (!response.ok) {
          throw new Error(`список голосов ответил кодом ${response.status}`);
        }

        return parseEdgeVoiceList(await response.json());
      } catch (error) {
        const cause = (error as { cause?: { message?: unknown } }).cause?.message;

        lastError = typeof cause === 'string'
          ? cause
          : (error instanceof Error ? error.message : String(error));
      }
    }

    throw new Error(lastError);
  }

  async function liveCatalog(): Promise<{ voices: EdgeVoice[] | null; error: string }> {
    const ttl = catalog?.voices ? CATALOG_CACHE_MS : CATALOG_RETRY_MS;

    if (catalog && Date.now() - catalog.at < ttl) {
      return catalog;
    }

    if (!inflight) {
      inflight = fetchCatalog()
        .then((voices) => ({ at: Date.now(), voices, error: '' }))
        .catch((error: unknown) => ({
          at: Date.now(),
          voices: null,
          error: error instanceof Error ? error.message : String(error),
        }))
        .then((result) => {
          catalog = result;
          inflight = null;

          return result;
        });
    }

    return inflight;
  }

  function tuningOf(voiceId: string): EdgeVoiceTuning {
    return EDGE_VOICE_TUNING[voiceId] ?? { rate: 1, pitchHz: 0 };
  }

  function capabilities(voiceRef: string | null): VoiceCapabilities {
    const tuning = tuningOf(voiceRef ?? '');
    const tuned = tuning.rate !== 1 || tuning.pitchHz !== 0;

    return {
      languages: [language],
      tone: false,
      pace: true,
      emphasis: false,
      pause: true,
      stress: false,
      maxChars: 4000,
      supportedFormats: ['wav'],
      // Настройка голоса входит в версию: образец, синтезированный с другим
      // темпом или высотой, обманывал бы слух.
      engineVersion: tuned
        ? `edge-tts-1-rate${Math.round(tuning.rate * 100)}-pitch${tuning.pitchHz}`
        : 'edge-tts-1',
      modelRevision: null,
    };
  }

  /**
   * Готовность — по живому списку голосов: запрос бесплатный, и «готов» здесь
   * означает «поставщик отвечает с этой машины», а не «ключ задан». Сеть вернулась
   * — движок включается сам через минуту.
   */
  async function doctor(): Promise<VoiceDoctor> {
    if (!options.enabled) {
      return {
        status: 'blocked',
        reason: 'Облачный голос Microsoft выключен настройкой сервера.',
        install: SWITCH_HINT,
      };
    }

    const live = await liveCatalog();

    if (!live.voices) {
      return {
        status: 'blocked',
        reason: `Облако Microsoft недоступно: ${live.error}.`,
        install: 'Проверьте доступ сервера к speech.platform.bing.com; когда сеть вернётся, '
          + 'движок включится сам.',
      };
    }

    const readable = live.voices.filter((voice) => edgeVoiceReads(voice, language)).length;

    return {
      status: 'ready',
      reason: 'Речь синтезирует облако Microsoft (Edge TTS): текст сцен уходит поставщику, '
        + `ключ и оплата не нужны. Голосов, читающих русский: ${readable}.`,
      install: '',
    };
  }

  function forgetDoctor(): void {
    catalog = null;
  }

  async function knownVoices(): Promise<EdgeVoice[]> {
    const live = options.enabled ? await liveCatalog() : null;
    const source = live?.voices ?? EDGE_VOICES_SNAPSHOT;

    return sortEdgeVoices(source.filter((voice) => edgeVoiceReads(voice, language)), language);
  }

  async function voices(): Promise<VoiceInfo[]> {
    const state = await doctor();
    const ready = state.status === 'ready';

    return (await knownVoices()).map((voice) => ({
      id: voice.id,
      name: edgeVoiceLabel(voice),
      language,
      available: ready,
      reason: ready ? '' : state.reason,
    }));
  }

  /**
   * Один запрос речи: соединение, настройка вывода, SSML, порции звука до конца
   * хода. Сетевые отказы поднимаются своим классом — их повторит вызывающий;
   * отвергнутая разметка окончательна.
   */
  function requestPiece(
    ssml: string,
    signal: AbortSignal,
  ): Promise<EdgePieceResponse> {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID().replace(/-/g, '');
      const chunks: Buffer[] = [];
      const boundaries: EdgeBoundary[] = [];
      let socket: WebSocket;
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let metadataValid = true;

      const finish = (outcome: { audio: Buffer; boundaries: EdgeBoundary[] | null } | Error): void => {
        if (settled) {
          return;
        }

        settled = true;

        if (timer) {
          clearTimeout(timer);
        }

        signal.removeEventListener('abort', onAbort);

        try {
          socket.close();
        } catch {
          // Соединение уже закрыто или не открылось — закрывать нечего.
        }

        if (outcome instanceof Error) {
          reject(outcome);
        } else {
          resolve({ audio: outcome.audio, requestId, boundaries: outcome.boundaries });
        }
      };

      const arm = (ms: number, reason: string): void => {
        if (timer) {
          clearTimeout(timer);
        }

        timer = setTimeout(() => finish(new EdgeNetworkError(reason)), ms);
      };

      function onAbort(): void {
        finish(new EdgeNetworkError('запрос снят'));
      }

      try {
        socket = new NodeWebSocket(signedUrl(socketUrl, requestId), { headers: edgeHeaders() });
      } catch (error) {
        reject(new EdgeNetworkError(error instanceof Error ? error.message : String(error)));

        return;
      }

      socket.binaryType = 'arraybuffer';
      signal.addEventListener('abort', onAbort, { once: true });
      arm(CONNECT_TIMEOUT_MS, `рукопожатие не завершилось за ${CONNECT_TIMEOUT_MS / 1000} с`);

      socket.addEventListener('open', () => {
        arm(RECEIVE_TIMEOUT_MS, `нет ответа ${RECEIVE_TIMEOUT_MS / 1000} с`);
        socket.send(
          `X-Timestamp:${edgeTimestamp()}\r\n`
          + 'Content-Type:application/json; charset=utf-8\r\n'
          + 'Path:speech.config\r\n\r\n'
          + '{"context":{"synthesis":{"audio":{"metadataoptions":{'
          + '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},'
          + `"outputFormat":"${OUTPUT_FORMAT}"}}}}\r\n`,
        );
        // Буква Z после метки — не ошибка: так делает сам Edge, и сервис ждёт её.
        socket.send(
          `X-RequestId:${requestId}\r\n`
          + 'Content-Type:application/ssml+xml\r\n'
          + `X-Timestamp:${edgeTimestamp()}Z\r\n`
          + 'Path:ssml\r\n\r\n'
          + ssml,
        );
      });
      socket.addEventListener('message', (event) => {
        arm(RECEIVE_TIMEOUT_MS, `нет ответа ${RECEIVE_TIMEOUT_MS / 1000} с`);

        if (typeof event.data === 'string') {
          const messagePath = textPathOf(event.data);

          if (messagePath === 'audio.metadata') {
            const parsed = boundariesOfMetadata(event.data);

            if (!parsed) {
              metadataValid = false;
            } else {
              boundaries.push(...parsed);
            }
          } else if (messagePath === 'turn.end') {
            finish({
              audio: Buffer.concat(chunks),
              boundaries: metadataValid ? boundaries : null,
            });
          }

          return;
        }

        const audio = audioOfFrame(Buffer.from(event.data as ArrayBuffer));

        if (audio && audio.length > 0) {
          chunks.push(audio);
        }
      });
      socket.addEventListener('error', () => {
        finish(new EdgeNetworkError('соединение с поставщиком не удалось'));
      });
      socket.addEventListener('close', (event) => {
        if (event.code === 1007) {
          finish(new ShowcaseError(
            'voice_failed',
            `Microsoft отверг разметку речи: ${event.reason || 'без пояснения'}.`,
            502,
          ));

          return;
        }

        const reason = event.reason ? `: ${event.reason}` : '';

        finish(new EdgeNetworkError(`соединение закрыто до конца речи (код ${event.code}${reason})`));
      });
    });
  }

  async function requestWithRetries(
    ssml: string,
    signal: AbortSignal,
  ): Promise<EdgePieceResponse> {
    let last: unknown = null;

    for (let attempt = 0; attempt < SYNTH_ATTEMPTS && !signal.aborted; attempt += 1) {
      if (attempt > 0) {
        await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 1500, signal);
      }

      try {
        return await requestPiece(ssml, signal);
      } catch (error) {
        if (!(error instanceof EdgeNetworkError)) {
          throw error;
        }

        last = error;
      }
    }

    throw last ?? new EdgeNetworkError('запрос снят');
  }

  async function synthesize(
    input: SynthesisInput,
    synthesisOptions: SynthesisOptions,
  ): Promise<VoiceCandidate> {
    const state = await doctor();

    if (state.status !== 'ready') {
      throw new ShowcaseError('voice_unavailable', state.reason, 503);
    }

    const known = await knownVoices();
    const voice = known.find((item) => item.id === input.voiceRef) ?? known[0];

    if (!voice) {
      throw new ShowcaseError('voice_unavailable', 'В каталоге Microsoft нет голоса для этого языка.', 503);
    }

    const own = capabilities(voice.id);

    if (input.canonicalText.length > own.maxChars) {
      throw new ShowcaseError(
        'text_too_long',
        `Реплика длиннее предела движка: ${input.canonicalText.length} из ${own.maxChars}.`,
        400,
      );
    }

    const base = tuningOf(voice.id);
    const tuning: EdgeVoiceTuning = {
      rate: base.rate * EDGE_PACE_RATE[input.direction.pace ?? 'normal'],
      pitchHz: base.pitchHz,
    };
    const timeout = AbortSignal.timeout(synthesisOptions.deadlineMs);
    const signal = synthesisOptions.signal
      ? AbortSignal.any([synthesisOptions.signal, timeout])
      : timeout;
    const parts: Buffer[] = [];
    const words: VoiceSpeechSpanTiming[] = [];
    const segments: VoiceSpeechSpanTiming[] = [];
    let requestId: string | null = null;
    let speechPeak = 0;
    let outputSamples = 0;
    let timingValid = true;

    for (const piece of edgePieces(input.canonicalText, input.direction.pauses)) {
      if (piece.text) {
        let produced: EdgePieceResponse;

        try {
          produced = await requestWithRetries(edgeSsml(voice.id, piece.text, tuning), signal);
        } catch (error) {
          if (synthesisOptions.signal?.aborted) {
            throw new ShowcaseError('voice_failed', 'Синтез отменён.', 504);
          }

          if (timeout.aborted) {
            const seconds = Math.round(synthesisOptions.deadlineMs / 1000);

            throw new ShowcaseError('voice_failed', `Microsoft Edge TTS не ответил за ${seconds} с.`, 504);
          }

          if (error instanceof EdgeNetworkError) {
            throw new ShowcaseError(
              'voice_failed',
              `Microsoft Edge TTS недоступен: ${error.message}. Если сеть в порядке, поставщик мог `
                + 'сменить протокол или отвергнуть подпись запроса — проверьте часы сервера.',
              502,
            );
          }

          throw error;
        }

        if (produced.audio.length === 0) {
          throw new ShowcaseError('voice_failed', 'Microsoft Edge TTS не вернул звука.', 502);
        }

        const pcm = await decodeMp3(produced.audio);
        const localTiming = timingOfPiece(produced.boundaries, pcm.length / 2);
        const offsetMs = outputSamples * 1000 / SAMPLE_RATE;

        requestId ??= produced.requestId;
        speechPeak = Math.max(speechPeak, peakOfPcm(pcm));

        if (!localTiming) {
          timingValid = false;
        } else {
          words.push(...localTiming.words.map((span) => ({
            ...span,
            startMs: span.startMs + offsetMs,
            endMs: span.endMs + offsetMs,
          })));
          segments.push(...localTiming.segments.map((span) => ({
            ...span,
            startMs: span.startMs + offsetMs,
            endMs: span.endMs + offsetMs,
          })));
        }

        parts.push(pcm);
        outputSamples += pcm.length / 2;
      }

      if (piece.silenceAfterMs > 0) {
        const silence = silencePcm(piece.silenceAfterMs, SAMPLE_RATE);

        parts.push(silence);
        outputSamples += silence.length / 2;
      }
    }

    if (speechPeak < SILENCE_PEAK) {
      throw new ShowcaseError('voice_failed', 'Microsoft Edge TTS вернул тишину вместо речи.', 502);
    }

    const file = path.join(synthesisOptions.outputDir, `voice-${Date.now()}.wav`);

    await fs.mkdir(synthesisOptions.outputDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(file, wavOfPcm(Buffer.concat(parts), SAMPLE_RATE));

    return {
      temporaryFile: file,
      format: 'wav',
      sampleRate: SAMPLE_RATE,
      channels: 1,
      engineRequestId: requestId,
      ignoredDirections: unsupportedDirections(input.direction, own),
      ...(timingValid && words.length > 0
        ? { speechTiming: { source: 'edge' as const, words, segments } }
        : {}),
    };
  }

  return {
    id: 'edge',
    name: 'Microsoft Edge TTS (облако)',
    kind: 'cloud',
    capabilities,
    doctor,
    forgetDoctor,
    voices,
    synthesize,
  };
}
