// Локальный нейросетевой голос: Silero (v4, русский).
//
// Третий адаптер появился по причине, которую слышно: Piper разборчив, но читает
// ровно, а Silero держит интонацию фразы и сам расставляет ударения. Работает на
// процессоре быстрее реального времени, видеокарта не нужна. Одна модель несёт
// несколько дикторов, поэтому голосом здесь называется диктор, а не файл.
//
// Речь не покидает машину: ни ключей, ни запросов наружу синтез не делает.
// Скачивание модели и движка — отдельное задание установки; здесь модель только
// читается с диска.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ShowcaseError } from '../errors.ts';
import { runWithStdin } from './process.ts';
import { unsupportedDirections } from './contract.ts';
import type { SileroSpeaker } from './sileroCatalog.ts';
import type {
  SynthesisInput,
  SynthesisOptions,
  VoiceCandidate,
  VoiceCapabilities,
  VoiceDoctor,
  VoiceEngine,
  VoiceInfo,
} from './contract.ts';

export const SILERO_SYNTH_SCRIPT = fileURLToPath(new URL('./sileroSynth.py', import.meta.url));

// Проверка окружения импортирует torch, а это секунды: результат живёт короткое
// время, чтобы раздел не платил за него на каждом открытии.
const DOCTOR_CACHE_MS = 20_000;
const DOCTOR_TIMEOUT_MS = 90_000;

// Ниже этого пика файл считается тишиной. Порог грубый и ловит именно грубое:
// молчащий синтез, который в остальном выглядит как удачный.
const SILENCE_PEAK = 0.005;

export interface SileroEngineOptions {
  // Python отдельного окружения синтеза. Пустая строка означает «ещё не
  // установлено» — это обычное состояние свежей установки, а не поломка.
  python: string;
  modelsDir: string;
}

export interface InstalledSileroModel {
  id: string;
  name: string;
  language: string;
  file: string;
  sampleRate: number;
  speakers: SileroSpeaker[];
}

/**
 * Установленные модели, новые версии первыми. Источник правды — манифесты на
 * диске, а не каталог доступных для скачивания: список должен показывать то, что
 * реально можно произнести сейчас. Порядок важен: одни и те же дикторы живут в
 * каждой версии модели, и голосом «Ксения» должен говорить самый свежий файл, а
 * не тот, что первым прочитался с диска.
 */
export async function readInstalledSileroModels(modelsDir: string): Promise<InstalledSileroModel[]> {
  const entries = await fs.readdir(modelsDir, { withFileTypes: true }).catch(() => []);
  const models: InstalledSileroModel[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifestFile = path.join(modelsDir, entry.name, 'voice.json');
    const manifest = await fs.readFile(manifestFile, 'utf8').then(
      (text) => JSON.parse(text) as InstalledSileroModel,
      () => null,
    );

    if (!manifest || manifest.id !== entry.name || !Array.isArray(manifest.speakers)) {
      continue;
    }

    models.push(manifest);
  }

  return models.sort((left, right) => right.id.localeCompare(left.id, 'en', { numeric: true }));
}

/**
 * Темп в терминах движка: у Silero три ступени prosody rate, ровно столько же
 * различает интерфейс, и переводить их числом было бы выдумкой.
 */
function rateOf(pace: SynthesisInput['direction']['pace']): string {
  if (pace === 'slow' || pace === 'fast') {
    return pace;
  }

  return 'normal';
}

export function createSileroEngine(options: SileroEngineOptions): VoiceEngine {
  let cached: { at: number; doctor: VoiceDoctor } | null = null;

  // Последний прочитанный список моделей. Возможности движка отдаются синхронно,
  // а версия в них — это версия самой свежей установленной модели: по ней старятся
  // образцы и звук сцен после обновления, и врать здесь нельзя.
  let installed: InstalledSileroModel[] = [];

  async function readInstalled(): Promise<InstalledSileroModel[]> {
    installed = await readInstalledSileroModels(options.modelsDir);

    return installed;
  }

  function capabilities(): VoiceCapabilities {
    return {
      languages: ['ru'],
      tone: false,
      pace: true,
      emphasis: false,
      pause: false,
      stress: false,
      maxChars: 3000,
      supportedFormats: ['wav'],
      engineVersion: installed[0] ? `silero-${installed[0].id}` : 'silero',
      modelRevision: null,
    };
  }

  async function probe(): Promise<VoiceDoctor> {
    if (!options.python) {
      return {
        status: 'blocked',
        reason: 'Голос Silero не установлен.',
        install: 'Установите его кнопкой в разделе: движок и модель скачаются один раз.',
      };
    }

    const executable = await fs.stat(options.python).then((info) => info.isFile(), () => false);

    if (!executable) {
      return {
        status: 'blocked',
        reason: 'Окружение Silero указано, но его python не найден.',
        install: 'Переустановите голос кнопкой в разделе.',
      };
    }

    try {
      await runWithStdin(options.python, ['-c', 'import torch'], {
        input: '',
        timeoutMs: DOCTOR_TIMEOUT_MS,
      });
    } catch {
      return {
        status: 'blocked',
        reason: 'В окружении Silero нет модуля torch.',
        install: 'Переустановите голос кнопкой в разделе.',
      };
    }

    const models = await readInstalled();

    if (models.length === 0) {
      return {
        status: 'blocked',
        reason: 'Движок установлен, но модель Silero не скачана.',
        install: 'Выберите Silero в разделе и нажмите «Установить».',
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
    const models = await readInstalled();
    const state = await doctor();
    const ready = state.status === 'ready';

    // Диктор считается один раз: старая версия модели с теми же именами не
    // должна удваивать список, а говорить будет самая свежая — она первая.
    const byId = new Map<string, VoiceInfo>();

    for (const model of models) {
      for (const speaker of model.speakers) {
        if (!byId.has(speaker.id)) {
          byId.set(speaker.id, {
            id: speaker.id,
            name: `${speaker.name} (${speaker.timbre})`,
            language: model.language,
            available: ready,
            reason: ready ? '' : state.reason,
          });
        }
      }
    }

    return [...byId.values()];
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

    const models = await readInstalled();
    // Модели идут от новой к старой, поэтому первое совпадение — самая свежая
    // версия диктора.
    const chosen = models
      .flatMap((model) => model.speakers.map((speaker) => ({ model, speaker })))
      .find((item) => item.speaker.id === input.voiceRef)
      ?? (models[0]?.speakers[0] ? { model: models[0], speaker: models[0].speakers[0] } : null);

    if (!chosen) {
      throw new ShowcaseError('voice_unavailable', 'Ни один голос Silero не установлен.', 503);
    }

    const file = path.join(synthesisOptions.outputDir, `voice-${Date.now()}.wav`);

    await fs.mkdir(synthesisOptions.outputDir, { recursive: true, mode: 0o700 });

    const args = [
      SILERO_SYNTH_SCRIPT,
      '--model', path.join(options.modelsDir, chosen.model.id, chosen.model.file),
      '--speaker', chosen.speaker.id,
      '--out', file,
      '--rate', rateOf(input.direction.pace),
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
      sampleRate: facts.sampleRate ?? chosen.model.sampleRate,
      channels: facts.channels ?? 1,
      engineRequestId: null,
      ignoredDirections: unsupportedDirections(input.direction, own),
    };
  }

  return {
    id: 'silero',
    name: 'Silero (локально)',
    kind: 'local',
    capabilities,
    doctor,
    voices,
    synthesize,
  };
}
