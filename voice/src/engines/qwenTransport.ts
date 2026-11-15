import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { combineSignals, MAX_WAV_BYTES, withAudioOutput } from '../audioFile.ts';
import { VoiceError } from '../contract.ts';

export interface QwenConnection {
  apiKey: string | null;
  baseUrl: string;
  fetch: typeof fetch;
  signal?: AbortSignal;
}

interface AudioRequest extends QwenConnection {
  endpoint: string;
  body: unknown;
  outputFile: string;
  timeoutMs?: number;
  prepareFile?: (file: string) => Promise<void>;
}

/**
 * Один срок охватывает POST, JSON, скачивание и проверку WAV у обоих сервисов Qwen.
 * Платный POST не повторяется; ключ не передаётся по адресу аудио и не попадает в ошибки.
 */
export async function requestQwenAudio(options: AudioRequest) {
  if (!options.apiKey) {
    throw new VoiceError('Нет ключа Qwen.');
  }

  if (/[\r\n\u0000]/u.test(options.apiKey)) {
    throw new VoiceError('Ключ Qwen содержит недопустимые символы.');
  }

  const timeoutMs = options.timeoutMs ?? 120000;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new VoiceError('Срок запроса должен быть положительным.', 2);
  }

  const controller = new AbortController();
  const signal = combineSignals(options.signal, controller.signal)!;
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await options.fetch(`${options.baseUrl.replace(/\/+$/u, '')}${options.endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(options.body),
      redirect: 'error',
      signal,
    });

    if (!response.ok) {
      await response.body?.cancel();

      throw new VoiceError(`Сервис Qwen ответил HTTP ${response.status}.`);
    }

    const payload: unknown = await response.json();
    const output = payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>).output : undefined;
    const audio = output && typeof output === 'object'
      ? (output as Record<string, unknown>).audio : undefined;
    const urlValue = audio && typeof audio === 'object'
      ? (audio as Record<string, unknown>).url : undefined;

    if (typeof urlValue !== 'string' || !urlValue) {
      throw new VoiceError('Сервис Qwen не вернул адрес аудио.');
    }

    const audioUrl = new URL(urlValue);

    if (!['https:', 'http:'].includes(audioUrl.protocol) || audioUrl.username || audioUrl.password) {
      throw new VoiceError('Сервис Qwen вернул недопустимый адрес аудио.');
    }

    return await withAudioOutput(options.outputFile, async (temporaryFile) => {
      const download = await options.fetch(audioUrl, { signal, redirect: 'follow' });

      if (!download.ok) {
        await download.body?.cancel();

        throw new VoiceError(`Скачивание аудио Qwen: HTTP ${download.status}.`);
      }

      if (!download.body) {
        throw new VoiceError('Сервис Qwen вернул пустое аудио.');
      }

      let received = 0;

      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;

          if (received > MAX_WAV_BYTES) {
            callback(new VoiceError('Аудио Qwen превышает допустимый размер.'));
          } else {
            callback(null, chunk);
          }
        },
      });

      await pipeline(
        Readable.fromWeb(download.body as Parameters<typeof Readable.fromWeb>[0]),
        limiter,
        createWriteStream(temporaryFile, { flags: 'wx', mode: 0o600 }),
        { signal },
      );

      await options.prepareFile?.(temporaryFile);
    }, signal);
  } catch (error) {
    if (signal.aborted) {
      throw new VoiceError(timedOut ? 'Истёк срок запроса Qwen.' : 'Операция отменена.');
    }

    if (error instanceof VoiceError) {
      throw error;
    }

    throw new VoiceError('Не удалось получить речь от сервиса Qwen.');
  } finally {
    clearTimeout(timer);
  }
}
