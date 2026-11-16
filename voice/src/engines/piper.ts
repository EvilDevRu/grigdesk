import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { combineSignals, ensureActive } from '../audioFile.ts';
import { validateSynthesis, VoiceError } from '../contract.ts';
import type { VoiceDoctor, VoiceEngine } from '../contract.ts';
import { PIPER_PACKAGE } from '../local/catalogs.ts';
import { PIPER_CAPABILITIES, synthesizePiperFile } from '../local/synthesize.ts';
import type { PythonScript } from '../local/synthesize.ts';
import { runWithStdin } from '../process.ts';
import type { RunProcess } from '../process.ts';

interface PiperOptions {
  voiceRoot: string;
  python: string | null;
  scriptPath: PythonScript;
  spawn?: RunProcess;
  signal?: AbortSignal;
}

interface InstalledPiper {
  id: string;
  name: string;
  language: string;
  timbre: string;
  modelFile: string;
  configFile: string;
}

/**
 * V1 устанавливает один закреплённый голос; reader не берёт пути за пределами его каталога.
 * Неполный или повреждённый манифест означает отсутствие принятой установки.
 */
async function readVoice(voiceRoot: string): Promise<InstalledPiper | null> {
  const directory = path.join(voiceRoot, 'voices', PIPER_PACKAGE.id);

  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(directory, 'voice.json'), 'utf8'));

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const value = parsed as Record<string, unknown>;

    if (value.id !== PIPER_PACKAGE.id || value.language !== 'ru'
      || typeof value.name !== 'string' || typeof value.timbre !== 'string'
      || typeof value.model !== 'string' || typeof value.config !== 'string'
      || typeof value.sampleRate !== 'number' || !Number.isFinite(value.sampleRate)
      || value.sampleRate <= 0) {
      return null;
    }

    for (const name of [value.model, value.config]) {
      if (!name || name === '.' || name === '..' || path.basename(name) !== name || name.includes('\\')) {
        return null;
      }
    }

    const modelFile = path.join(directory, value.model);
    const configFile = path.join(directory, value.config);
    const entries = await Promise.all([stat(modelFile), stat(configFile)]);

    if (entries.some((entry) => !entry.isFile() || entry.size === 0)) {
      return null;
    }

    return {
      id: PIPER_PACKAGE.id,
      name: value.name,
      language: 'ru',
      timbre: value.timbre,
      modelFile,
      configFile,
    };
  } catch {
    return null;
  }
}

/**
 * Адаптер читает только собственный voiceRoot и проверяет готовность Python отдельно от модели.
 * Пользовательские ошибки проверяются раньше probe, чтобы не запускать заведомо ненужный Python.
 */
export function createPiperEngine(options: PiperOptions): VoiceEngine {
  const run = options.spawn ?? runWithStdin;
  const install = 'выполните: voice install piper';
  let cached: { at: number; value: VoiceDoctor } | null = null;

  /**
   * Короткая проба не синтезирует речь и не обращается к сети.
   * Отмена остаётся отменой команды, а ошибка импорта становится blocked с действием.
   */
  async function probe(signal?: AbortSignal): Promise<VoiceDoctor> {
    ensureActive(signal);

    if (!options.python) {
      return {
        status: 'blocked',
        reason: 'локальный Piper не установлен',
        install,
      };
    }

    try {
      await access(options.python, constants.X_OK);
    } catch {
      return {
        status: 'blocked',
        reason: 'Python Piper не найден или не исполняемый',
        install,
      };
    }

    if (!await readVoice(options.voiceRoot)) {
      return {
        status: 'blocked',
        reason: 'голос Piper не установлен или повреждён',
        install,
      };
    }

    try {
      await run(options.python, ['-c', 'import piper'], {
        input: '',
        timeoutMs: 15000,
        signal,
      });
    } catch {
      ensureActive(signal);

      return {
        status: 'blocked',
        reason: 'в окружении нет рабочего модуля piper',
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
   * Кэш принадлежит экземпляру одноразовой команды и не переживает новую установку.
   * Сигнал проверяется даже при готовом снимке, чтобы Ctrl+C не был потерян.
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
    id: 'piper',
    name: 'Piper (локально)',
    kind: 'local',
    model: PIPER_PACKAGE.id,
    defaultVoice: PIPER_PACKAGE.id,
    capabilities: () => PIPER_CAPABILITIES,
    doctor: () => doctor(),
    /**
     * Список содержит только установленный голос; отсутствие модели не вызывает синтез.
     * Поле available отражает отдельную проверку окружения и показывает её причину.
     */
    async voices() {
      const voice = await readVoice(options.voiceRoot);

      if (!voice) {
        return [];
      }

      const state = await doctor();

      return [{
        id: voice.id,
        name: `${voice.name} (${voice.timbre})`,
        languages: [voice.language],
        available: state.status === 'ready',
        reason: state.status === 'ready' ? '' : state.reason,
      }];
    },
    /**
     * Повторная валидация raw runner нужна его независимому вызову установщиком.
     * Здесь те же проверки стоят до doctor, а модель выбирается без fallback на чужой голос.
     */
    async synthesize(input, synthesisOptions) {
      const signal = combineSignals(options.signal, synthesisOptions.signal);

      validateSynthesis(input, { ...synthesisOptions, signal }, PIPER_CAPABILITIES);

      if (input.voiceRef !== null && input.voiceRef !== PIPER_PACKAGE.id) {
        throw new VoiceError('Неизвестный голос Piper.', 2);
      }

      if (input.language !== null && input.language !== 'ru') {
        throw new VoiceError('Piper поддерживает только русский язык.', 2);
      }

      const state = await doctor(signal);

      if (state.status !== 'ready' || !options.python) {
        throw new VoiceError(state.reason);
      }

      const voice = await readVoice(options.voiceRoot);

      if (!voice) {
        throw new VoiceError('Голос Piper не установлен или повреждён.');
      }

      return synthesizePiperFile({
        python: options.python,
        scriptPath: options.scriptPath,
        modelFile: voice.modelFile,
        configFile: voice.configFile,
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
