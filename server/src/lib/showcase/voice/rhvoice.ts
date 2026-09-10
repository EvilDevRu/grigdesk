// Локальный голос: RHVoice.
//
// Выбран как первый адаптер по причинам, а не по рейтингу: русские голоса, работа
// на процессоре, отсутствие ключей и внешних запросов, свободная лицензия. Речь
// не покидает машину вовсе, поэтому решения о передаче данных наружу для него не
// требуется.
//
// Синтез в файл делает `RHVoice-client`. Библиотека и голоса могут стоять в системе
// без него — тогда адаптер объявляет себя недоступным и НАЗЫВАЕТ недостающее.
//
// Кнопкой этот движок не ставится, и это не упущение: нужен системный пакет, а его
// вправе поставить только администратор машины. Обёртка из PyPI не выручает —
// она собирает движок из исходников, и на проверенной машине сборка не проходит.
// Поэтому кнопкой ставится Piper, а RHVoice остаётся для установок, где пакет уже
// есть.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { ShowcaseError } from '../errors.ts';
import { runWithStdin } from './process.ts';
import { unsupportedDirections } from './contract.ts';
import type {
  SynthesisInput,
  SynthesisOptions,
  VoiceCandidate,
  VoiceCapabilities,
  VoiceDoctor,
  VoiceEngine,
  VoiceInfo,
} from './contract.ts';

const run = promisify(execFile);

const CLIENT = 'RHVoice-client';
const VOICES_DIR = '/usr/share/RHVoice/voices';

// Русские голоса пакета. Список читается с диска, а этот — только запасной порядок
// показа: человеку удобнее видеть знакомые имена в стабильной последовательности.
const KNOWN_ORDER = ['anna', 'elena', 'irina', 'aleksandr', 'artemiy'];

async function hasClient(): Promise<boolean> {
  try {
    await run('which', [CLIENT]);

    return true;
  } catch {
    return false;
  }
}

/**
 * Темп речи в единицах движка. RHVoice принимает множитель, поэтому три ступени
 * интерфейса переводятся здесь, а не хранятся числами в ядре: у другого движка
 * шкала своя, и общее число значило бы разное.
 */
function rateOf(pace: SynthesisInput['direction']['pace']): string {
  if (pace === 'slow') {
    return '0.85';
  }

  return pace === 'fast' ? '1.15' : '1';
}

export function createRhvoiceEngine(): VoiceEngine {
  function capabilities(): VoiceCapabilities {
    return {
      languages: ['ru'],
      tone: false,
      pace: true,
      emphasis: false,
      pause: false,
      stress: false,
      maxChars: 4000,
      supportedFormats: ['wav'],
      engineVersion: 'rhvoice-1',
      modelRevision: null,
    };
  }

  async function doctor(): Promise<VoiceDoctor> {
    const voicesPresent = await fs.readdir(VOICES_DIR).then(
      (names) => names.length > 0,
      () => false,
    );

    if (!voicesPresent) {
      return {
        status: 'blocked',
        reason: 'Голоса RHVoice не установлены.',
        install: 'Нужен системный пакет с русскими голосами RHVoice: его ставит '
          + 'администратор машины. Голос, который раздел ставит сам, — Piper.',
      };
    }

    if (!(await hasClient())) {
      return {
        status: 'blocked',
        // Голоса есть, а синтезировать в файл нечем: разница важна человеку,
        // иначе он будет искать причину не там.
        reason: `Голоса RHVoice найдены, но нет ${CLIENT} — синтезировать в файл нечем.`,
        install: `Нужен системный пакет с ${CLIENT}: его ставит администратор машины. `
          + 'Голос, который раздел ставит сам, — Piper.',
      };
    }

    return {
      status: 'ready',
      reason: 'Локальный синтез работает без сети и ключей.',
      install: '',
    };
  }

  /**
   * Список голосов читается с диска: он и есть источник правды о том, что movie
   * может произнести. Недоступность клиента не прячет голоса — она объясняется
   * причиной у каждого, чтобы выбор оставался видимым.
   */
  async function voices(): Promise<VoiceInfo[]> {
    const installed = await fs.readdir(VOICES_DIR).catch(() => [] as string[]);
    const clientReady = await hasClient();
    const reason = clientReady ? '' : `Нет ${CLIENT}: синтез недоступен.`;
    const ordered = [
      ...KNOWN_ORDER.filter((name) => installed.includes(name)),
      ...installed.filter((name) => !KNOWN_ORDER.includes(name)).sort(),
    ];

    return ordered.map((id) => ({
      id,
      name: id,
      language: 'ru',
      available: clientReady,
      reason,
    }));
  }

  /**
   * Синтез одной реплики. Отмена и срок обязательны: без них зависший процесс
   * держит очередь раздела, а человек видит бесконечное «идёт».
   */
  async function synthesize(
    input: SynthesisInput,
    options: SynthesisOptions,
  ): Promise<VoiceCandidate> {
    const state = await doctor();

    if (state.status !== 'ready') {
      throw new ShowcaseError('voice_unavailable', state.reason, 503);
    }

    const own = capabilities();

    if (input.canonicalText.length > own.maxChars) {
      throw new ShowcaseError(
        'text_too_long',
        `Реплика длиннее предела движка: ${input.canonicalText.length} из ${own.maxChars}.`,
        400,
      );
    }

    const file = path.join(options.outputDir, `voice-${Date.now()}.wav`);

    await fs.mkdir(options.outputDir, { recursive: true, mode: 0o700 });

    const args = ['-o', file, '-r', rateOf(input.direction.pace)];

    if (input.voiceRef) {
      args.push('-p', input.voiceRef);
    }

    // Текст уходит на stdin, а не аргументом: реплика приходит от человека и от
    // модели, и превращать её в часть командной строки незачем.
    await runWithStdin(CLIENT, args, {
      input: input.canonicalText,
      timeoutMs: options.deadlineMs,
      signal: options.signal,
    });

    const info = await fs.stat(file).catch(() => null);

    if (!info || info.size === 0) {
      throw new ShowcaseError('voice_failed', 'Движок не оставил файла с речью.', 500);
    }

    return {
      temporaryFile: file,
      format: 'wav',
      sampleRate: 24_000,
      channels: 1,
      engineRequestId: null,
      ignoredDirections: unsupportedDirections(input.direction, own),
    };
  }

  return {
    id: 'rhvoice',
    name: 'RHVoice (локально)',
    kind: 'local',
    capabilities,
    doctor,
    voices,
    synthesize,
  };
}
