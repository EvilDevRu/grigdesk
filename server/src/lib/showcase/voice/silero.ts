// Локальный нейросетевой голос: Silero (v5.5, русский).
//
// Третий адаптер появился по причине, которую слышно: Piper разборчив, но читает
// ровно, а Silero держит интонацию фразы и сам расставляет ударения. Работает на
// процессоре быстрее реального времени, видеокарта не нужна. Одна модель несёт
// несколько дикторов, поэтому голосом здесь называется диктор, а не файл.
//
// Ударения и паузы движок принимает разметкой: `+` перед гласной и `<break>` в
// SSML. Латиницу и цифры он не читает — латинское слово роняет разбор SSML, число
// молча выпадает, — поэтому такой текст отвергается до задания.
//
// Речь не покидает машину: ни ключей, ни запросов наружу синтез не делает.
// Скачивание модели и движка — отдельное задание установки; здесь модель только
// читается с диска.
//
// На задание озвучки поднимается один процесс с моделью (сеанс), реплики уходят
// в него по одной: подъём python с torch стоил дороже самого синтеза, а между
// заданиями процесс не живёт.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ShowcaseError } from '../errors.ts';
import { runWithStdin } from './process.ts';
import { startResident } from './resident.ts';
import type { ResidentProcess } from './resident.ts';
import { unsupportedDirections } from './contract.ts';
import type { SileroSpeaker } from './sileroCatalog.ts';
import type {
  SynthesisInput,
  SynthesisOptions,
  VoiceCandidate,
  VoiceCapabilities,
  VoiceDirection,
  VoiceDoctor,
  VoiceEngine,
  VoiceInfo,
  VoiceSession,
} from './contract.ts';

export const SILERO_SYNTH_SCRIPT = fileURLToPath(new URL('./sileroSynth.py', import.meta.url));

// Пауза едет в скрипт синтеза служебным токеном из символов частного диапазона
// Unicode: сам `<break>` ставить нельзя, потому что текст перед SSML экранируется.
// Из текста эти символы вычищаются заранее — подделать токен реплика не может.
export const PAUSE_TOKEN_START = '\uE000';
export const PAUSE_TOKEN_END = '\uE001';

// Дольше семи секунд пауза ролику не нужна, а движку — тем более.
const MAX_PAUSE_MS = 7000;

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

// Факты о готовом файле из ответа скрипта: длительность, частота, пик.
interface SpeechFacts {
  durationMs?: number;
  sampleRate?: number;
  channels?: number;
  peak?: number | null;
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
 * Разметка движка поверх канонического текста: `+` перед ударной гласной и токен
 * паузы в позиции указания. Вставки идут с конца, чтобы смещения оставались
 * верными — каждая вставка сдвигает всё правее себя. Акценты Silero не знает, и
 * их здесь нет: адаптер объявляет это в возможностях, а не теряет молча.
 */
export function sileroMarkup(text: string, direction: VoiceDirection): string {
  const safe = text.replace(/[\uE000\uE001]/g, ' ');
  const edits: { at: number; insert: string }[] = [];

  for (const stress of direction.stresses) {
    edits.push({ at: stress.at + stress.vowel, insert: '+' });
  }

  for (const pause of direction.pauses) {
    const ms = Math.min(Math.max(Math.round(pause.ms), 0), MAX_PAUSE_MS);

    if (ms > 0) {
      edits.push({ at: pause.at, insert: `${PAUSE_TOKEN_START}${ms}${PAUSE_TOKEN_END}` });
    }
  }

  let result = safe;

  for (const edit of edits.sort((left, right) => right.at - left.at)) {
    const at = Math.min(Math.max(edit.at, 0), safe.length);

    result = `${result.slice(0, at)}${edit.insert}${result.slice(at)}`;
  }

  return result;
}

/**
 * Темп в терминах движка: пять ступеней интерфейса — это пять ступеней prosody
 * rate SSML, которые Silero различает (замер 11.09.2026 на одной фразе: x-slow
 * 9,5 с, slow 6,0 с, medium 4,8 с, fast 3,9 с, x-fast 3,2 с). Скрипт синтеза
 * переводит имя ступени в разметку сам; числом темп здесь не выражается.
 */
function rateOf(pace: SynthesisInput['direction']['pace']): string {
  return pace ?? 'normal';
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
      pause: true,
      stress: true,
      maxChars: 3000,
      supportedFormats: ['wav'],
      engineVersion: installed[0] ? `silero-${installed[0].id}` : 'silero',
      modelRevision: null,
      unreadable: ['latin', 'digits'],
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

  function forgetDoctor(): void {
    cached = null;
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

  /**
   * Сеанс на задание: процесс с моделью поднимается при первой реплике и живёт до
   * закрытия. Модель одна — самая новая, — поэтому и процесс один; диктор и темп
   * уходят в каждом запросе, а не в аргументах.
   */
  async function openSession(): Promise<VoiceSession> {
    const state = await doctor();

    if (state.status !== 'ready') {
      throw new ShowcaseError('voice_unavailable', state.reason, 503);
    }

    const models = await readInstalled();
    const processes = new Map<string, ResidentProcess>();

    let counter = 0;

    function processOf(model: InstalledSileroModel): ResidentProcess {
      const own = processes.get(model.id);

      if (own) {
        return own;
      }

      const started = startResident(options.python, [
        SILERO_SYNTH_SCRIPT,
        '--serve',
        '--model', path.join(options.modelsDir, model.id, model.file),
        '--speaker', model.speakers[0]?.id ?? '',
      ]);

      processes.set(model.id, started);

      return started;
    }

    async function synthesizeOne(
      input: SynthesisInput,
      synthesisOptions: SynthesisOptions,
    ): Promise<VoiceCandidate> {
      const own = capabilities();

      if (input.canonicalText.length > own.maxChars) {
        throw new ShowcaseError(
          'text_too_long',
          `Реплика длиннее предела движка: ${input.canonicalText.length} из ${own.maxChars}.`,
          400,
        );
      }

      // Модели идут от новой к старой, поэтому первое совпадение — самая свежая
      // версия диктора.
      const chosen = models
        .flatMap((model) => model.speakers.map((speaker) => ({ model, speaker })))
        .find((item) => item.speaker.id === input.voiceRef)
        ?? (models[0]?.speakers[0] ? { model: models[0], speaker: models[0].speakers[0] } : null);

      if (!chosen) {
        throw new ShowcaseError('voice_unavailable', 'Ни один голос Silero не установлен.', 503);
      }

      counter += 1;

      const file = path.join(synthesisOptions.outputDir, `voice-${Date.now()}-${counter}.wav`);

      await fs.mkdir(synthesisOptions.outputDir, { recursive: true, mode: 0o700 });

      const reply = await processOf(chosen.model).request<SpeechFacts>(
        {
          items: [{
            text: sileroMarkup(input.canonicalText, input.direction),
            speaker: chosen.speaker.id,
            rate: rateOf(input.direction.pace),
            out: file,
          }],
        },
        { timeoutMs: synthesisOptions.deadlineMs, signal: synthesisOptions.signal },
      );

      if (reply.error !== undefined || !reply.results?.[0]) {
        throw new ShowcaseError(
          'voice_failed',
          `Silero: ${reply.error ?? 'ответ без фактов о файле'}`,
          500,
        );
      }

      const facts = reply.results[0];
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
      batch: null,
      async synthesize(inputs, synthesisOptions) {
        const candidates: VoiceCandidate[] = [];

        for (const input of inputs) {
          candidates.push(await synthesizeOne(input, synthesisOptions));
        }

        return candidates;
      },
      async close() {
        await Promise.all([...processes.values()].map((item) => item.close()));
      },
    };
  }

  // Одиночная реплика — образец голоса: сеанс на один запрос.
  async function synthesize(
    input: SynthesisInput,
    synthesisOptions: SynthesisOptions,
  ): Promise<VoiceCandidate> {
    const session = await openSession();

    try {
      const [candidate] = await session.synthesize([input], synthesisOptions);

      if (!candidate) {
        throw new ShowcaseError('voice_failed', 'Движок не вернул реплику.', 500);
      }

      return candidate;
    } finally {
      await session.close();
    }
  }

  return {
    id: 'silero',
    name: 'Silero (локально)',
    kind: 'local',
    capabilities,
    doctor,
    forgetDoctor,
    voices,
    synthesize,
    openSession,
  };
}
