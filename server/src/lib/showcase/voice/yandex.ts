// Облачный голос: Yandex SpeechKit (API v3).
//
// Подключён по причине, которую слышно: нейросетевые голоса поставщика держат
// интонацию живой речи, а локальные движки до этой планки не дотягивают. Цена —
// граница: текст сцен уходит поставщику, синтез платный (тарифицируется порциями
// по 250 знаков). Ключ — серверная машинная настройка из корневого .env; интерфейс
// получает только статус, сам ключ никуда не отдаётся.
//
// Речь запрашивается сырым PCM и заворачивается в WAV здесь: поставщик отдаёт
// ответ порциями, и у каждой порции WAV был бы свой заголовок — склейка таких
// файлов даёт щелчки, а сырые отсчёты склеиваются без потерь.
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ShowcaseError } from '../errors.ts';
import { unsupportedDirections } from './contract.ts';
import {
  YANDEX_DEFAULT_VOICE,
  YANDEX_ROLE_BY_TONE,
  YANDEX_TTS_ENDPOINT,
  YANDEX_VOICES,
} from './yandexCatalog.ts';
import type { YandexVoice } from './yandexCatalog.ts';
import type {
  SynthesisInput,
  SynthesisOptions,
  VoiceCandidate,
  VoiceCapabilities,
  VoiceDirection,
  VoiceDoctor,
  VoiceEngine,
  VoiceInfo,
} from './contract.ts';

const SAMPLE_RATE = 48_000;

// Ниже этого пика файл считается тишиной: молчащий ответ, который в остальном
// выглядит как удачный, не должен стать звуком сцены.
const SILENCE_PEAK = 0.005;

// Поставщик не держит паузу дольше семи секунд; ролику более длинная и не нужна.
const MAX_PAUSE_MS = 7000;

const KEY_HINT = 'Задайте COCKPIT_SHOWCASE_YANDEX_API_KEY в корневом .env сервера '
  + '(ключ сервисного аккаунта с ролью ai.speechkit-tts.user) и перезапустите сервер.';

export interface YandexEngineOptions {
  apiKey: string;
  folderId: string;
  // Адрес и fetch переопределяют только тесты: в них поставщика подменяет местный
  // сервер, и ни один запрос из проверок наружу не уходит.
  endpoint?: string;
  fetch?: typeof fetch;
}

/**
 * Разметка поставщика поверх канонического текста: `+` перед ударной гласной,
 * `sil<[мс]>` для паузы, `**слово**` для акцента. Вставки идут с конца, чтобы
 * смещения указаний оставались верными — каждая вставка сдвигает всё правее себя.
 * Смещения читаются так: у ударения `at` — начало слова, `vowel` — сдвиг ударной
 * гласной от него; у паузы и акцента — позиции в самом тексте.
 */
export function yandexMarkup(text: string, direction: VoiceDirection): string {
  const edits: { at: number; insert: string }[] = [];

  for (const stress of direction.stresses) {
    edits.push({ at: stress.at + stress.vowel, insert: '+' });
  }

  for (const pause of direction.pauses) {
    const ms = Math.min(Math.max(Math.round(pause.ms), 0), MAX_PAUSE_MS);

    if (ms > 0) {
      edits.push({ at: pause.at, insert: ` sil<[${ms}]>` });
    }
  }

  for (const range of direction.emphasis) {
    if (range.to > range.from) {
      edits.push({ at: range.from, insert: '**' });
      edits.push({ at: range.to, insert: '**' });
    }
  }

  let result = text;

  for (const edit of edits.sort((left, right) => right.at - left.at)) {
    const at = Math.min(Math.max(edit.at, 0), text.length);

    result = `${result.slice(0, at)}${edit.insert}${result.slice(at)}`;
  }

  return result;
}

/**
 * WAV из сырых отсчётов: заголовок в 44 байта перед PCM 16 бит. Своя обёртка
 * вместо ffmpeg — потому что формат тривиален, а лишний процесс на каждую реплику
 * только добавил бы способ упасть.
 */
export function wavOf(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  const blockAlign = channels * 2;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

function peakOf(pcm: Buffer): number {
  let peak = 0;

  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    peak = Math.max(peak, Math.abs(pcm.readInt16LE(offset)));
  }

  return peak / 32_768;
}

/**
 * Темп в единицах поставщика. Три ступени интерфейса переводятся здесь, а не
 * хранятся числами в ядре: у другого движка шкала своя, и общее число значило бы
 * разное. Обычный темп не передаётся вовсе — голос звучит так, как задумал автор.
 */
function speedOf(pace: VoiceDirection['pace']): number | null {
  if (pace === 'slow') {
    return 0.85;
  }

  if (pace === 'fast') {
    return 1.2;
  }

  return null;
}

function roleOf(tone: string | null, voice: YandexVoice): string | null {
  const role = tone ? YANDEX_ROLE_BY_TONE[tone.trim().toLowerCase()] : undefined;

  return role && voice.roles.includes(role) ? role : null;
}

/**
 * Ответ поставщика: один объект или поток объектов по строке — так REST отдаёт
 * потоковый метод. Оба вида читаются одинаково, а ответ не по форме называется
 * своей причиной: молча получить пустой звук нельзя.
 */
function parseResponse(text: string): unknown[] {
  const trimmed = text.trim();

  if (!trimmed) {
    return [];
  }

  try {
    return [JSON.parse(trimmed) as unknown];
  } catch {
    // Не один объект — значит, поток объектов по строке.
  }

  return trimmed.split('\n').filter((line) => line.trim()).map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new ShowcaseError('voice_failed', 'Yandex SpeechKit вернул ответ не по форме.', 502);
    }
  });
}

/**
 * Склейка звука из порций ответа. Порции приходят обёрнутыми в `result` или без
 * обёртки — читаются обе формы; отказ внутри потока становится отказом синтеза.
 */
function audioOf(objects: unknown[]): Buffer {
  const parts: Buffer[] = [];

  for (const object of objects) {
    const outer = (object ?? {}) as { result?: unknown; error?: { message?: unknown } };

    if (outer.error) {
      throw new ShowcaseError(
        'voice_failed',
        `Yandex SpeechKit: ${String(outer.error.message ?? 'отказ без пояснения')}`,
        502,
      );
    }

    const item = (outer.result ?? outer) as { audioChunk?: { data?: unknown } };
    const data = item.audioChunk?.data;

    if (typeof data === 'string' && data) {
      parts.push(Buffer.from(data, 'base64'));
    }
  }

  return Buffer.concat(parts);
}

function messageOf(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      message?: unknown;
      error_message?: unknown;
      error?: { message?: unknown };
    };
    const message = parsed.message ?? parsed.error_message ?? parsed.error?.message;

    return typeof message === 'string' ? message : '';
  } catch {
    return text.trim().slice(0, 200);
  }
}

/**
 * Отказ поставщика — словами о том, что делать. Код HTTP поставщика наружу не
 * пробрасывается: 401 от Яндекса клиент кокпита прочитал бы как выход из своей
 * сессии.
 */
function failureOf(status: number, text: string): ShowcaseError {
  const message = messageOf(text);

  if (status === 401) {
    return new ShowcaseError(
      'voice_failed',
      'Yandex SpeechKit отверг ключ: проверьте COCKPIT_SHOWCASE_YANDEX_API_KEY в корневом .env.',
      502,
    );
  }

  if (status === 403) {
    return new ShowcaseError(
      'voice_failed',
      'Ключу Yandex SpeechKit не хватает прав: сервисному аккаунту нужна роль ai.speechkit-tts.user.',
      502,
    );
  }

  if (status === 429) {
    return new ShowcaseError('voice_failed', 'Квота Yandex SpeechKit исчерпана: повторите позже.', 503);
  }

  return new ShowcaseError(
    'voice_failed',
    `Yandex SpeechKit ответил кодом ${status}: ${message || 'без пояснения'}.`,
    502,
  );
}

export function createYandexEngine(options: YandexEngineOptions): VoiceEngine {
  const endpoint = options.endpoint ?? YANDEX_TTS_ENDPOINT;
  const call = options.fetch ?? fetch;

  function voiceOf(voiceRef: string | null): YandexVoice {
    return YANDEX_VOICES.find((item) => item.id === voiceRef) ?? YANDEX_DEFAULT_VOICE;
  }

  function capabilities(voiceRef: string | null): VoiceCapabilities {
    return {
      languages: ['ru'],
      // Тон есть только у голосов с амплуа: остальным поставщик его не даёт.
      tone: voiceOf(voiceRef).roles.length > 0,
      pace: true,
      emphasis: true,
      pause: true,
      stress: true,
      maxChars: 5000,
      supportedFormats: ['wav'],
      engineVersion: 'yandex-tts-v3',
      modelRevision: null,
    };
  }

  /**
   * Готовность — по наличию ключа. Пробный запрос в проверке готовности стоил бы
   * денег при каждом открытии раздела, поэтому работу ключа подтверждает первый
   * образец голоса, а отказ поставщика называется словами тогда.
   */
  async function doctor(): Promise<VoiceDoctor> {
    if (!options.apiKey) {
      return {
        status: 'blocked',
        reason: 'Ключ Yandex SpeechKit не задан.',
        install: KEY_HINT,
      };
    }

    return {
      status: 'ready',
      reason: 'Речь синтезирует облако Яндекса: текст сцен уходит поставщику, синтез платный. '
        + 'Работу ключа подтверждает первый образец голоса.',
      install: '',
    };
  }

  async function voices(): Promise<VoiceInfo[]> {
    const state = await doctor();
    const ready = state.status === 'ready';

    return YANDEX_VOICES.map((voice) => ({
      id: voice.id,
      name: `${voice.name} (${voice.timbre})`,
      language: 'ru',
      available: ready,
      reason: ready ? '' : state.reason,
    }));
  }

  /**
   * Один запрос к поставщику со сроком и отменой. Срок и отмена снимают запрос
   * одинаково, но человеку называется его причина: «отменено» и «не ответил» —
   * разные события.
   */
  async function request(
    body: unknown,
    synthesisOptions: SynthesisOptions,
  ): Promise<{ pcm: Buffer; requestId: string | null }> {
    const timeout = AbortSignal.timeout(synthesisOptions.deadlineMs);
    const signal = synthesisOptions.signal
      ? AbortSignal.any([synthesisOptions.signal, timeout])
      : timeout;
    const headers: Record<string, string> = {
      authorization: `Api-Key ${options.apiKey}`,
      'content-type': 'application/json',
      // Поставщик не хранит переданный текст, пока его об этом не попросят явно.
      'x-data-logging-enabled': 'false',
    };

    if (options.folderId) {
      headers['x-folder-id'] = options.folderId;
    }

    let response: Response;
    let text: string;

    try {
      response = await call(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
      text = await response.text();
    } catch (error) {
      if (synthesisOptions.signal?.aborted) {
        throw new ShowcaseError('voice_failed', 'Синтез отменён.', 504);
      }

      if (timeout.aborted) {
        const seconds = Math.round(synthesisOptions.deadlineMs / 1000);

        throw new ShowcaseError('voice_failed', `Yandex SpeechKit не ответил за ${seconds} с.`, 504);
      }

      const cause = (error as { cause?: { message?: unknown } }).cause?.message;
      const message = typeof cause === 'string'
        ? cause
        : (error instanceof Error ? error.message : 'сеть недоступна');

      throw new ShowcaseError('voice_failed', `Yandex SpeechKit недоступен: ${message}.`, 502);
    }

    if (!response.ok) {
      throw failureOf(response.status, text);
    }

    return {
      pcm: audioOf(parseResponse(text)),
      requestId: response.headers.get('x-request-id'),
    };
  }

  async function synthesize(
    input: SynthesisInput,
    synthesisOptions: SynthesisOptions,
  ): Promise<VoiceCandidate> {
    const state = await doctor();

    if (state.status !== 'ready') {
      throw new ShowcaseError('voice_unavailable', state.reason, 503);
    }

    const voice = voiceOf(input.voiceRef);
    const own = capabilities(voice.id);

    if (input.canonicalText.length > own.maxChars) {
      throw new ShowcaseError(
        'text_too_long',
        `Реплика длиннее предела движка: ${input.canonicalText.length} из ${own.maxChars}.`,
        400,
      );
    }

    const role = roleOf(input.direction.tone, voice);
    const speed = speedOf(input.direction.pace);
    const hints: Record<string, unknown>[] = [{ voice: voice.id }];

    if (role) {
      hints.push({ role });
    }

    if (speed) {
      hints.push({ speed });
    }

    const { pcm, requestId } = await request({
      text: yandexMarkup(input.canonicalText, input.direction),
      hints,
      outputAudioSpec: {
        rawAudio: { audioEncoding: 'LINEAR16_PCM', sampleRateHertz: SAMPLE_RATE },
      },
      loudnessNormalizationType: 'LUFS',
      // Без этого режима реплика длиннее 250 знаков отвергается; с ним поставщик
      // сам режет текст на фразы.
      unsafeMode: true,
    }, synthesisOptions);

    if (pcm.length < 2) {
      throw new ShowcaseError('voice_failed', 'Yandex SpeechKit не вернул звука.', 502);
    }

    if (peakOf(pcm) < SILENCE_PEAK) {
      throw new ShowcaseError('voice_failed', 'Yandex SpeechKit вернул тишину вместо речи.', 502);
    }

    const file = path.join(synthesisOptions.outputDir, `voice-${Date.now()}.wav`);

    await fs.mkdir(synthesisOptions.outputDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(file, wavOf(pcm, SAMPLE_RATE));

    const ignored = unsupportedDirections(input.direction, own);

    // Тон, для которого у голоса нет такого амплуа, тоже не применён — и об этом
    // надо сказать, а не дать голосу молча прозвучать иначе.
    if (input.direction.tone && !role && !ignored.includes('тон')) {
      ignored.push('тон');
    }

    return {
      temporaryFile: file,
      format: 'wav',
      sampleRate: SAMPLE_RATE,
      channels: 1,
      engineRequestId: requestId,
      ignoredDirections: ignored,
    };
  }

  return {
    id: 'yandex',
    name: 'Yandex SpeechKit (облако)',
    kind: 'cloud',
    capabilities,
    doctor,
    voices,
    synthesize,
  };
}
