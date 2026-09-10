// Локальный нейросетевой голос: Piper.
//
// Второй адаптер появился по измеренной причине, а не ради выбора: системный
// RHVoice требует пакет, который ставится администратором машины, а Piper —
// колёса python и один файл модели. Поэтому именно он ставится КНОПКОЙ раздела,
// а RHVoice остаётся для установок, где системный пакет уже есть.
//
// Речь не покидает машину: ни ключей, ни запросов наружу синтез не делает.
// Скачивание происходит один раз, отдельным заданием установки.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const SYNTH_SCRIPT = fileURLToPath(new URL('./piperSynth.py', import.meta.url));

// Проверка окружения запускает python, поэтому её результат живёт короткое время:
// раздел спрашивает готовность на каждом открытии, а установка меняет ответ
// самое частое раз в несколько минут.
const DOCTOR_CACHE_MS = 20_000;
const DOCTOR_TIMEOUT_MS = 15_000;

// Ниже этого пика файл считается тишиной. Порог грубый и ловит именно грубое:
// молчащий синтез, который в остальном выглядит как удачный.
const SILENCE_PEAK = 0.005;

export interface PiperEngineOptions {
  // Python отдельного окружения синтеза. Пустая строка означает «ещё не
  // установлено» — это обычное состояние свежей установки, а не поломка.
  python: string;
  voicesDir: string;
}

export interface InstalledPiperVoice {
  id: string;
  name: string;
  language: string;
  timbre: string;
  model: string;
  config: string;
  sampleRate: number;
}

/**
 * Установленные голоса. Источник правды — манифесты на диске, а не каталог
 * доступных для скачивания: список должен показывать то, что реально можно
 * произнести сейчас.
 */
export async function readInstalledVoices(voicesDir: string): Promise<InstalledPiperVoice[]> {
  const entries = await fs.readdir(voicesDir, { withFileTypes: true }).catch(() => []);
  const voices: InstalledPiperVoice[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifestFile = path.join(voicesDir, entry.name, 'voice.json');
    const manifest = await fs.readFile(manifestFile, 'utf8').then(
      (text) => JSON.parse(text) as InstalledPiperVoice,
      () => null,
    );

    if (!manifest || manifest.id !== entry.name) {
      continue;
    }

    voices.push(manifest);
  }

  return voices.sort((left, right) => left.name.localeCompare(right.name, 'ru'));
}

export function createPiperEngine(options: PiperEngineOptions): VoiceEngine {
  let cached: { at: number; doctor: VoiceDoctor } | null = null;

  function capabilities(): VoiceCapabilities {
    return {
      languages: ['ru'],
      tone: false,
      pace: true,
      emphasis: false,
      pause: false,
      stress: false,
      maxChars: 2000,
      supportedFormats: ['wav'],
      engineVersion: 'piper-1.8.0',
      // Ревизия принадлежит голосу, а не движку: у каждого своя модель, и общее
      // число здесь означало бы не то, что читающий подумает.
      modelRevision: null,
    };
  }

  async function probe(): Promise<VoiceDoctor> {
    if (!options.python) {
      return {
        status: 'blocked',
        reason: 'Локальный синтез не установлен.',
        install: 'Установите голос кнопкой в разделе: движок и модель скачаются один раз.',
      };
    }

    const executable = await fs.stat(options.python).then((info) => info.isFile(), () => false);

    if (!executable) {
      return {
        status: 'blocked',
        reason: 'Окружение синтеза указано, но его python не найден.',
        install: 'Переустановите голос кнопкой в разделе.',
      };
    }

    try {
      await runWithStdin(options.python, ['-c', 'import piper'], {
        input: '',
        timeoutMs: DOCTOR_TIMEOUT_MS,
      });
    } catch {
      return {
        status: 'blocked',
        reason: 'В окружении синтеза нет модуля piper.',
        install: 'Переустановите голос кнопкой в разделе.',
      };
    }

    const voices = await readInstalledVoices(options.voicesDir);

    if (voices.length === 0) {
      return {
        status: 'blocked',
        // Разница важна человеку: движок готов, произносить нечем.
        reason: 'Движок установлен, но ни один голос не скачан.',
        install: 'Выберите голос в разделе и нажмите «Установить».',
      };
    }

    return {
      status: 'ready',
      reason: 'Локальный синтез работает без сети и ключей.',
      install: '',
    };
  }

  async function doctor(): Promise<VoiceDoctor> {
    if (cached && Date.now() - cached.at < DOCTOR_CACHE_MS) {
      return cached.doctor;
    }

    const result = await probe();

    cached = { at: Date.now(), doctor: result };

    return result;
  }

  async function voices(): Promise<VoiceInfo[]> {
    const installed = await readInstalledVoices(options.voicesDir);
    const state = await doctor();
    const ready = state.status === 'ready';

    return installed.map((voice) => ({
      id: voice.id,
      name: `${voice.name} (${voice.timbre})`,
      language: voice.language,
      available: ready,
      reason: ready ? '' : state.reason,
    }));
  }

  /**
   * Темп в единицах движка: Piper растягивает длину, поэтому «медленнее» — это
   * множитель БОЛЬШЕ единицы. Общего числа для всех движков нет и быть не может.
   */
  function lengthScale(pace: SynthesisInput['direction']['pace']): string {
    if (pace === 'slow') {
      return '1.15';
    }

    return pace === 'fast' ? '0.9' : '1';
  }

  async function synthesize(
    input: SynthesisInput,
    synthesisOptions: SynthesisOptions,
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

    const installed = await readInstalledVoices(options.voicesDir);
    const voice = installed.find((item) => item.id === input.voiceRef) ?? installed[0];

    if (!voice) {
      throw new ShowcaseError('voice_unavailable', 'Ни один голос не установлен.', 503);
    }

    const file = path.join(synthesisOptions.outputDir, `voice-${Date.now()}.wav`);

    await fs.mkdir(synthesisOptions.outputDir, { recursive: true, mode: 0o700 });

    const voiceDir = path.join(options.voicesDir, voice.id);
    const args = [
      SYNTH_SCRIPT,
      '--model', path.join(voiceDir, voice.model),
      '--config', path.join(voiceDir, voice.config),
      '--out', file,
      '--length-scale', lengthScale(input.direction.pace),
    ];
    const produced = await runWithStdin(options.python, args, {
      input: input.canonicalText,
      timeoutMs: synthesisOptions.deadlineMs,
      signal: synthesisOptions.signal,
    });
    const facts = JSON.parse(produced.stdout.trim().split('\n').at(-1) ?? '{}') as {
      durationMs?: number;
      sampleRate?: number;
      channels?: number;
      peak?: number | null;
    };
    const info = await fs.stat(file).catch(() => null);

    if (!info || info.size === 0) {
      throw new ShowcaseError('voice_failed', 'Движок не оставил файла с речью.', 500);
    }

    if (typeof facts.peak === 'number' && facts.peak < SILENCE_PEAK) {
      throw new ShowcaseError('voice_failed', 'Движок вернул тишину вместо речи.', 500);
    }

    return {
      temporaryFile: file,
      format: 'wav',
      sampleRate: facts.sampleRate ?? voice.sampleRate,
      channels: facts.channels ?? 1,
      engineRequestId: null,
      ignoredDirections: unsupportedDirections(input.direction, own),
    };
  }

  return {
    id: 'piper',
    name: 'Piper (локально)',
    kind: 'local',
    capabilities,
    doctor,
    voices,
    synthesize,
  };
}
