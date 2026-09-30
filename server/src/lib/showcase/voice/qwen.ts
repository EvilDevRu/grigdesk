// Локальный нейросетевой голос: Qwen3-TTS (1.7B, CustomVoice) на видеокарте.
//
// Четвёртый адаптер появился по причине, которую слышно: Silero звучит дёргано и
// «роботизированно», и это свойство самой модели, а не сборки ролика. Qwen3-TTS —
// языковая модель речи под Apache-2.0 с русским среди десяти языков; она держит
// интонацию, но работает ТОЛЬКО на CUDA и занимает около пяти гигабайт видеопамяти
// на время синтеза. Видеокарту делят Whisper проверки речи (работает после выхода
// процесса синтеза) и другие программы: если они заняли всю память, синтез
// падает с OOM, и это называется словами.
//
// На задание озвучки поднимается один процесс с моделью (сеанс): подъём python
// с torch и чтение модели стоили дороже самого синтеза, а резидентный python с
// пятью гигабайтами видеопамяти между заданиями не живёт — карта свободна, как
// раньше. Цикл генерации упирается в процессор, а не в видеокарту, и батч из
// четырёх последовательностей стоит почти как одна (замер 11.09.2026: RTF 1,85 у
// одной против 0,54 у четырёх) — эту ёмкость скрипт тратит на КАНДИДАТОВ одной
// реплики: модель выбирает манеру речи заново на каждую реплику, и в файл уходит
// кандидат, ближайший к опорной записи диктора. Поэтому реплики идут в процесс по
// одной; протокол запроса несёт список, и батч сцен вернётся одной константой,
// если ёмкости хватит на оба. Речь не покидает машину.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ShowcaseError } from '../errors.ts';
import { runWithStdin, VoiceProcessError } from './process.ts';
import { startResident } from './resident.ts';
import type { ResidentProcess } from './resident.ts';
import { unsupportedDirections } from './contract.ts';
import type { QwenSpeaker } from './qwenCatalog.ts';
import type {
  SynthesisInput,
  SynthesisOptions,
  VoiceBatchLimit,
  VoiceCandidate,
  VoiceCapabilities,
  VoiceDirection,
  VoiceDoctor,
  VoiceEngine,
  VoiceInfo,
  VoicePace,
  VoiceSession,
} from './contract.ts';

export const QWEN_SYNTH_SCRIPT = fileURLToPath(new URL('./qwenSynth.py', import.meta.url));

// Проверка окружения импортирует torch — это секунды; результат живёт минуту,
// чтобы раздел не платил за него на каждом открытии.
const DOCTOR_CACHE_MS = 60_000;
const DOCTOR_TIMEOUT_MS = 90_000;

// Проверка без тяжёлых импортов: `import qwen_tts` тянет transformers на секунды,
// а наличие пакета видно и по его спецификации.
const DOCTOR_PROBE = 'import importlib.util, torch; '
  + "print(int(importlib.util.find_spec('qwen_tts') is not None), int(torch.cuda.is_available()))";

// Ниже этого пика файл считается тишиной. Порог грубый и ловит именно грубое:
// молчащий синтез, который в остальном выглядит как удачный.
const SILENCE_PEAK = 0.005;

// Темп указанием не управляется — замерено 11.09.2026 на одной фразе (97 знаков,
// диктор Vivian): без указания 6,16 с, «Говори медленнее.» 7,52 с, «Говори
// быстрее.» 7,20 с — «быстрее» вышло длиннее исходного. Поэтому темп честно
// попадает в список неприменённого, а фраза в указание не добавляется.
const PACE_SUPPORTED = false;

const PACE_PHRASES: Record<Exclude<VoicePace, 'normal'>, string> = {
  slowest: 'Говори очень медленно.',
  slow: 'Говори медленнее.',
  fast: 'Говори быстрее.',
  fastest: 'Говори очень быстро.',
};

// Коды выхода скрипта синтеза, у которых есть своё объяснение для человека.
const EXIT_OUT_OF_MEMORY = 3;
const EXIT_NO_CUDA = 4;

// Тот же отказ внутри сеанса приходит не кодом выхода, а ответом с кодом.
const REPLY_OUT_OF_MEMORY = 'oom';

// Батча сцен нет: ёмкость видеокарты уходит на кандидатов одной реплики (см.
// шапку), а запрос на несколько сцен лишь задержал бы ход и срок по каждой.
// Вернуть батч — одна константа вида `{ items: 4, chars: 600 }`: видеопамять
// растёт с длиной речи в батче (замер: четыре реплики по ~115 знаков — пик
// 5,3 ГБ из 8), не влезший по памяти батч сеанс дробит пополам.
const BATCH_LIMIT: VoiceBatchLimit | null = null;

// Факты о готовом файле из ответа скрипта: длительность, частота, пик.
interface SpeechFacts {
  durationMs?: number;
  sampleRate?: number;
  channels?: number;
  peak?: number | null;
}

interface ChosenVoice {
  model: InstalledQwenModel;
  speaker: QwenSpeaker;
}

// Реплика сеанса с выбранным диктором и именем будущего файла.
interface PlannedItem {
  input: SynthesisInput;
  chosen: ChosenVoice;
  file: string;
}

export interface QwenEngineOptions {
  // Python отдельного окружения синтеза. Пустая строка означает «ещё не
  // установлено» — это обычное состояние свежей установки, а не поломка.
  python: string;
  modelsDir: string;
}

export interface InstalledQwenModel {
  id: string;
  name: string;
  language: string;
  revision: string;
  sampleRate: number;
  speakers: QwenSpeaker[];
}

/**
 * Установленные модели, новые первыми. Источник правды — манифесты на диске, а не
 * каталог доступных для скачивания: список показывает то, что реально можно
 * произнести сейчас.
 */
export async function readInstalledQwenModels(modelsDir: string): Promise<InstalledQwenModel[]> {
  const entries = await fs.readdir(modelsDir, { withFileTypes: true }).catch(() => []);
  const models: InstalledQwenModel[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifestFile = path.join(modelsDir, entry.name, 'voice.json');
    const manifest = await fs.readFile(manifestFile, 'utf8').then(
      (text) => JSON.parse(text) as InstalledQwenModel,
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
 * Указание модели: тон и темп одной фразой на естественном языке — так модель
 * принимает манеру речи. Пустое указание не передаётся: голос звучит так, как
 * задумал автор модели.
 */
export function qwenInstruct(direction: VoiceDirection): string | null {
  const parts: string[] = [];
  const tone = direction.tone?.trim() ?? '';

  if (tone) {
    parts.push(tone.slice(0, 200));
  }

  if (PACE_SUPPORTED && direction.pace && direction.pace !== 'normal') {
    parts.push(PACE_PHRASES[direction.pace]);
  }

  return parts.length > 0 ? parts.join(' ') : null;
}

const OUT_OF_MEMORY = new ShowcaseError(
  'voice_failed',
  'Qwen3-TTS: не хватило видеопамяти — '
    + 'закройте программы, которые её занимают, и повторите.',
  503,
);

/**
 * Отказ скрипта синтеза — словами о причине, а не хвостом трассировки: нехватка
 * видеопамяти и невидимая видеокарта имеют свои коды выхода и своё действие.
 */
function explainFailure(error: unknown): never {
  if (error instanceof VoiceProcessError && error.exitCode === EXIT_OUT_OF_MEMORY) {
    throw OUT_OF_MEMORY;
  }

  if (error instanceof VoiceProcessError && error.exitCode === EXIT_NO_CUDA) {
    throw new ShowcaseError(
      'voice_unavailable',
      'Qwen3-TTS: видеокарта не видна — синтез работает только на CUDA.',
      503,
    );
  }

  throw error;
}

export function createQwenEngine(options: QwenEngineOptions): VoiceEngine {
  let cached: { at: number; doctor: VoiceDoctor } | null = null;

  // Последний прочитанный список моделей. Возможности отдаются синхронно, а версия
  // в них — версия самой свежей установленной модели: по ней старятся образцы и
  // звук сцен после обновления.
  let installed: InstalledQwenModel[] = [];

  async function readInstalled(): Promise<InstalledQwenModel[]> {
    installed = await readInstalledQwenModels(options.modelsDir);

    return installed;
  }

  function capabilities(): VoiceCapabilities {
    return {
      languages: ['ru'],
      tone: true,
      pace: PACE_SUPPORTED,
      emphasis: false,
      pause: false,
      // Знак `+` языковая модель речи может и прочитать буквально; без слуха это не
      // проверить, поэтому ударения честно объявлены неподдержанными.
      stress: false,
      // Одиночная реплика синтезируется медленнее реального времени (RTX 3070:
      // полторы секунды на секунду речи); в срок сцены 120 с укладывается около
      // тысячи знаков.
      maxChars: 1000,
      supportedFormats: ['wav'],
      // Суффикс версии — смена манеры синтеза (отбор кандидата по опорной записи):
      // образцы и звук сцен, синтезированные до него, старятся по хешу и
      // переозвучиваются опорным голосом.
      engineVersion: installed[0] ? `qwen-${installed[0].id}-anchored` : 'qwen-anchored',
      modelRevision: installed[0]?.revision ?? null,
    };
  }

  async function probe(): Promise<VoiceDoctor> {
    // Пути окружения строятся всегда, поэтому «не установлен» распознаётся по
    // отсутствию самого python, а не по пустой строке.
    const executable = options.python
      ? await fs.stat(options.python).then((info) => info.isFile(), () => false)
      : false;

    if (!executable) {
      return {
        status: 'blocked',
        reason: 'Голос Qwen3-TTS не установлен.',
        install: 'Установите его кнопкой в разделе: движок и модель скачаются один раз. '
          + 'Нужна видеокарта NVIDIA.',
      };
    }

    let probeOutput = '';

    try {
      const produced = await runWithStdin(options.python, ['-c', DOCTOR_PROBE], {
        input: '',
        timeoutMs: DOCTOR_TIMEOUT_MS,
      });

      probeOutput = produced.stdout.trim();
    } catch {
      return {
        status: 'blocked',
        reason: 'В окружении Qwen3-TTS нет модуля torch.',
        install: 'Переустановите голос кнопкой в разделе.',
      };
    }

    const [hasPackage, hasCuda] = probeOutput.split(/\s+/);

    if (hasPackage !== '1') {
      return {
        status: 'blocked',
        reason: 'В окружении Qwen3-TTS нет модуля qwen_tts.',
        install: 'Переустановите голос кнопкой в разделе.',
      };
    }

    if (hasCuda !== '1') {
      return {
        status: 'blocked',
        reason: 'Видеокарта не видна: Qwen3-TTS работает только на CUDA.',
        install: 'Проверьте драйвер NVIDIA (nvidia-smi) и перезапустите сервер.',
      };
    }

    const models = await readInstalled();

    if (models.length === 0) {
      return {
        status: 'blocked',
        reason: 'Движок установлен, но модель Qwen3-TTS не скачана.',
        install: 'Выберите Qwen3-TTS в разделе и нажмите «Установить».',
      };
    }

    return {
      status: 'ready',
      reason: 'Синтез идёт на видеокарте этой машины; текст сцен наружу не уходит.',
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
   * Диктор и модель для реплики: модели идут от новой к старой, поэтому первое
   * совпадение — самая свежая версия диктора; незнакомый диктор — первый у самой
   * новой модели.
   */
  function choose(models: InstalledQwenModel[], voiceRef: string | null): ChosenVoice {
    const chosen = models
      .flatMap((model) => model.speakers.map((speaker) => ({ model, speaker })))
      .find((item) => item.speaker.id === voiceRef)
      ?? (models[0]?.speakers[0] ? { model: models[0], speaker: models[0].speakers[0] } : null);

    if (!chosen) {
      throw new ShowcaseError('voice_unavailable', 'Ни один голос Qwen3-TTS не установлен.', 503);
    }

    return chosen;
  }

  /**
   * Сеанс на задание: процесс с моделью поднимается при первой реплике и живёт
   * до закрытия; на каждую установленную модель — свой процесс, хотя обычно она
   * одна. Несколько реплик одного вызова уходят одним запросом; не влезший в
   * видеопамять запрос дробится пополам, пока не влезет, и только одиночная
   * реплика отказывает словами.
   */
  async function openSession(): Promise<VoiceSession> {
    const state = await doctor();

    if (state.status !== 'ready') {
      throw new ShowcaseError('voice_unavailable', state.reason, 503);
    }

    const models = await readInstalled();
    const processes = new Map<string, ResidentProcess>();

    let counter = 0;

    function processOf(model: InstalledQwenModel): ResidentProcess {
      const own = processes.get(model.id);

      if (own) {
        return own;
      }

      const started = startResident(options.python, [
        QWEN_SYNTH_SCRIPT,
        '--serve',
        '--model-dir', path.join(options.modelsDir, model.id),
        '--speaker', model.speakers[0]?.id ?? '',
      ]);

      processes.set(model.id, started);

      return started;
    }

    // Один запрос к процессу за группу реплик одной модели. Ответ с нехваткой
    // памяти на нескольких репликах — повод разделить их, на одной — отказ.
    async function requestGroup(
      group: PlannedItem[],
      synthesisOptions: SynthesisOptions,
    ): Promise<SpeechFacts[]> {
      const head = group[0];

      if (!head) {
        return [];
      }

      const reply = await processOf(head.chosen.model).request<SpeechFacts>(
        {
          items: group.map((item) => ({
            text: item.input.canonicalText,
            instruct: qwenInstruct(item.input.direction),
            speaker: item.chosen.speaker.id,
            out: item.file,
          })),
        },
        {
          timeoutMs: synthesisOptions.deadlineMs * group.length,
          signal: synthesisOptions.signal,
        },
      ).catch(explainFailure);

      if (reply.code === REPLY_OUT_OF_MEMORY && group.length > 1) {
        const half = Math.ceil(group.length / 2);

        return [
          ...(await requestGroup(group.slice(0, half), synthesisOptions)),
          ...(await requestGroup(group.slice(half), synthesisOptions)),
        ];
      }

      if (reply.code === REPLY_OUT_OF_MEMORY) {
        throw OUT_OF_MEMORY;
      }

      if (reply.error !== undefined || (reply.results ?? []).length !== group.length) {
        throw new ShowcaseError(
          'voice_failed',
          `Qwen3-TTS: ${reply.error ?? 'ответ без фактов о файлах'}`,
          500,
        );
      }

      return reply.results as SpeechFacts[];
    }

    async function synthesize(
      inputs: SynthesisInput[],
      synthesisOptions: SynthesisOptions,
    ): Promise<VoiceCandidate[]> {
      const own = capabilities();

      for (const input of inputs) {
        if (input.canonicalText.length > own.maxChars) {
          throw new ShowcaseError(
            'text_too_long',
            `Реплика длиннее предела движка: ${input.canonicalText.length} из ${own.maxChars}.`,
            400,
          );
        }
      }

      await fs.mkdir(synthesisOptions.outputDir, { recursive: true, mode: 0o700 });

      const planned: PlannedItem[] = inputs.map((input) => {
        counter += 1;

        return {
          input,
          chosen: choose(models, input.voiceRef),
          file: path.join(synthesisOptions.outputDir, `voice-${Date.now()}-${counter}.wav`),
        };
      });
      // Реплики разных моделей идут разными запросами: процесс держит одну модель.
      const facts = new Map<number, SpeechFacts>();
      const modelIds = [...new Set(planned.map((item) => item.chosen.model.id))];

      for (const modelId of modelIds) {
        const group = planned
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => item.chosen.model.id === modelId);
        const results = await requestGroup(group.map(({ item }) => item), synthesisOptions);

        group.forEach(({ index }, position) => {
          const produced = results[position];

          if (produced) {
            facts.set(index, produced);
          }
        });
      }

      const candidates: VoiceCandidate[] = [];

      for (const [index, item] of planned.entries()) {
        const produced = facts.get(index) ?? {};
        const info = await fs.stat(item.file).catch(() => null);

        if (!info || info.size === 0) {
          throw new ShowcaseError('voice_failed', 'Движок не оставил файла с речью.', 500);
        }

        if (typeof produced.peak === 'number' && produced.peak < SILENCE_PEAK) {
          throw new ShowcaseError('voice_failed', 'Движок вернул тишину вместо речи.', 500);
        }

        candidates.push({
          temporaryFile: item.file,
          format: 'wav',
          sampleRate: produced.sampleRate ?? item.chosen.model.sampleRate,
          channels: produced.channels ?? 1,
          engineRequestId: null,
          ignoredDirections: unsupportedDirections(item.input.direction, own),
        });
      }

      return candidates;
    }

    return {
      batch: BATCH_LIMIT,
      synthesize,
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
    id: 'qwen',
    name: 'Qwen3-TTS (локально, видеокарта)',
    kind: 'local',
    capabilities,
    doctor,
    forgetDoctor,
    voices,
    synthesize,
    openSession,
  };
}
