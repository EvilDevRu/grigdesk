import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { combineSignals, ensureActive } from '../audioFile.ts';
import { unreadableFragments, validateSynthesis, VoiceError } from '../contract.ts';
import type { VoiceDoctor, VoiceEngine } from '../contract.ts';
import { SILERO_PACKAGE } from '../local/catalogs.ts';
import type { SileroSpeaker } from '../local/catalogs.ts';
import { SILERO_CAPABILITIES, synthesizeSileroFile } from '../local/synthesize.ts';
import type { PythonScript } from '../local/synthesize.ts';
import { runWithStdin } from '../process.ts';
import type { RunProcess } from '../process.ts';

interface SileroOptions {
  engineRoot: string;
  python: string | null;
  scriptPath: PythonScript;
  spawn?: RunProcess;
  signal?: AbortSignal;
}

interface InstalledSilero {
  modelFile: string;
  speakers: SileroSpeaker[];
}

/**
 * Reader принимает только согласованный манифест закреплённой модели v1.
 * Имя model-файла локально относительно пакета; отсутствующий файл не считается установкой.
 */
async function readModel(engineRoot: string): Promise<InstalledSilero | null> {
  const directory = path.join(engineRoot, 'models', SILERO_PACKAGE.id);

  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(directory, 'voice.json'), 'utf8'));

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const value = parsed as Record<string, unknown>;

    if (value.id !== SILERO_PACKAGE.id || value.language !== 'ru'
      || typeof value.file !== 'string' || !value.file || value.file === '.' || value.file === '..'
      || path.basename(value.file) !== value.file || value.file.includes('\\')
      || !Array.isArray(value.speakers) || value.speakers.length === 0
      || typeof value.sampleRate !== 'number' || !Number.isFinite(value.sampleRate)
      || value.sampleRate <= 0) {
      return null;
    }

    const speakers: SileroSpeaker[] = [];

    for (const entry of value.speakers) {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const speaker = entry as Record<string, unknown>;

      if (typeof speaker.id !== 'string' || typeof speaker.name !== 'string'
        || typeof speaker.timbre !== 'string'
        || !SILERO_PACKAGE.speakers.some((known) => known.id === speaker.id)
        || speakers.some((known) => known.id === speaker.id)) {
        return null;
      }

      speakers.push({
        id: speaker.id,
        name: speaker.name,
        timbre: speaker.timbre,
      });
    }

    const modelFile = path.join(directory, value.file);
    const info = await stat(modelFile);

    return info.isFile() && info.size > 0 ? { modelFile, speakers } : null;
  } catch {
    return null;
  }
}

/**
 * Silero применяет темп и ударения, а неподдерживаемые фрагменты отвергает до probe.
 * Наличие файла модели не заменяет проверку Python/torch в выбранном окружении.
 */
export function createSileroEngine(options: SileroOptions): VoiceEngine {
  const run = options.spawn ?? runWithStdin;
  const install = 'выполните: voice install silero';
  let cached: { at: number; value: VoiceDoctor } | null = null;

  /**
   * Импорт torch использует собственный срок и signal команды без загрузки модели.
   * Отсутствие зависимости возвращается как blocked; отмена не маскируется под поломку.
   */
  async function probe(signal?: AbortSignal): Promise<VoiceDoctor> {
    ensureActive(signal);

    if (!options.python) {
      return {
        status: 'blocked',
        reason: 'локальный Silero не установлен',
        install,
      };
    }

    try {
      await access(options.python, constants.X_OK);
    } catch {
      return {
        status: 'blocked',
        reason: 'Python Silero не найден или не исполняемый',
        install,
      };
    }

    if (!await readModel(options.engineRoot)) {
      return {
        status: 'blocked',
        reason: 'модель Silero не установлена или повреждена',
        install,
      };
    }

    try {
      await run(options.python, ['-c', 'import torch'], {
        input: '',
        timeoutMs: 90000,
        signal,
      });
    } catch {
      ensureActive(signal);

      return {
        status: 'blocked',
        reason: 'в окружении нет рабочего модуля torch',
        install,
      };
    }

    return {
      status: 'ready',
      reason: 'готов без сети и ключей',
      install: '',
    };
  }

  /**
   * Снимок короткоживущий и принадлежит конкретному экземпляру движка команды.
   * Новая команда после install строит новый экземпляр с новой готовностью.
   */
  async function doctor(signal = options.signal): Promise<VoiceDoctor> {
    ensureActive(signal);

    if (cached && Date.now() - cached.at < 20000) {
      return cached.value;
    }

    const value = await probe(signal);

    cached = { at: Date.now(), value };

    return value;
  }

  return {
    id: 'silero',
    name: 'Silero (локально)',
    kind: 'local',
    model: SILERO_PACKAGE.id,
    defaultVoice: 'xenia',
    capabilities: () => SILERO_CAPABILITIES,
    doctor: () => doctor(),
    /**
     * Дикторы берутся из принятого манифеста модели и сохраняют имена каталога.
     * При отсутствующей модели пустой список не запускает Python.
     */
    async voices() {
      const model = await readModel(options.engineRoot);

      if (!model) {
        return [];
      }

      const state = await doctor();

      return model.speakers.map((speaker) => ({
        id: speaker.id,
        name: `${speaker.name} (${speaker.timbre})`,
        languages: ['ru'],
        available: state.status === 'ready',
        reason: state.status === 'ready' ? '' : state.reason,
      }));
    },
    /**
     * Неизвестный диктор, неподдерживаемый текст и формат не должны запускать torch.
     * После проверки готовности raw runner получает точные пути принятой модели.
     */
    async synthesize(input, synthesisOptions) {
      const signal = combineSignals(options.signal, synthesisOptions.signal);
      const prepared = validateSynthesis(input, { ...synthesisOptions, signal }, SILERO_CAPABILITIES);
      const speaker = input.voiceRef ?? 'xenia';

      if (!SILERO_PACKAGE.speakers.some((known) => known.id === speaker)) {
        throw new VoiceError('Неизвестный голос Silero.', 2);
      }

      if (input.language !== null && input.language !== 'ru') {
        throw new VoiceError('Silero поддерживает только русский язык.', 2);
      }

      const unreadable = unreadableFragments(prepared.canonicalText, ['latin', 'digits']);

      if (unreadable.length > 0) {
        throw new VoiceError(`Silero не читает: ${unreadable.join(', ')}.`, 2);
      }

      const state = await doctor(signal);

      if (state.status !== 'ready' || !options.python) {
        throw new VoiceError(state.reason);
      }

      const model = await readModel(options.engineRoot);

      if (!model || !model.speakers.some((known) => known.id === speaker)) {
        throw new VoiceError('Голос Silero не установлен или повреждён.');
      }

      return synthesizeSileroFile({
        python: options.python,
        scriptPath: options.scriptPath,
        modelFile: model.modelFile,
        speaker,
        outputFile: synthesisOptions.outputFile,
        text: input.text,
        pace: synthesisOptions.pace,
        instruction: synthesisOptions.instruction,
        spawn: run,
        signal,
        timeoutMs: synthesisOptions.timeoutMs,
      });
    },
  };
}
