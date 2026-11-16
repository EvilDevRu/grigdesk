import { checkSpeechFacts, ensureActive, withAudioOutput } from '../audioFile.ts';
import { unreadableFragments, unsupportedDirections, validateSynthesis, VoiceError } from '../contract.ts';
import type { SynthesisResult, VoiceCapabilities, VoicePace } from '../contract.ts';
import { runWithStdin } from '../process.ts';
import type { RunProcess } from '../process.ts';

export type PythonScript = string | (() => Promise<string>);

interface FileSynthesisOptions {
  python: string;
  scriptPath: PythonScript;
  modelFile: string;
  outputFile: string;
  text: string;
  pace?: VoicePace | null;
  instruction?: string | null;
  spawn?: RunProcess;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PiperFileOptions extends FileSynthesisOptions {
  configFile: string;
}

export interface SileroFileOptions extends FileSynthesisOptions {
  speaker: string;
}

export const PIPER_CAPABILITIES: VoiceCapabilities = {
  languages: ['ru'],
  pace: true,
  stress: false,
  pause: false,
  tone: false,
  emphasis: false,
  maxChars: 2000,
  formats: ['wav'],
};

export const SILERO_CAPABILITIES: VoiceCapabilities = {
  languages: ['ru'],
  pace: true,
  stress: true,
  pause: false,
  tone: false,
  emphasis: false,
  maxChars: 2000,
  formats: ['wav'],
};

const LENGTH_SCALE: Record<VoicePace, string> = {
  slowest: '1.35',
  slow: '1.15',
  normal: '1',
  fast: '0.9',
  fastest: '0.8',
};

/**
 * Проверка контракта скрипта применяется и установщиком, и обычным адаптером.
 * Ленивая выдача ресурса происходит только после валидации пользовательского текста.
 */
async function resolveScript(script: PythonScript, signal?: AbortSignal): Promise<string> {
  ensureActive(signal);

  const file = typeof script === 'string' ? script : await script();

  ensureActive(signal);

  return file;
}

/**
 * Синтезирует Piper по явным staged или установленным путям, без поиска voice.json.
 * Срок и отмена завершают Python до удаления временного выхода и ресурса скрипта.
 */
export async function synthesizePiperFile(options: PiperFileOptions): Promise<SynthesisResult> {
  const prepared = validateSynthesis({
    text: options.text,
    voiceRef: 'irina',
    language: 'ru',
  }, {
    outputFile: options.outputFile,
    pace: options.pace,
    signal: options.signal,
  }, PIPER_CAPABILITIES);
  const script = await resolveScript(options.scriptPath, options.signal);
  const run = options.spawn ?? runWithStdin;
  const result = await withAudioOutput(options.outputFile, async (temporaryFile) => {
    const reply = await run(options.python, [
      script,
      '--model', options.modelFile,
      '--config', options.configFile,
      '--out', temporaryFile,
      '--length-scale', LENGTH_SCALE[options.pace ?? 'normal'],
    ], {
      input: prepared.canonicalText,
      timeoutMs: options.timeoutMs ?? 300000,
      signal: options.signal,
    });

    checkSpeechFacts(reply.stdout);
  }, options.signal);

  return {
    ...result,
    ignoredDirections: unsupportedDirections({
      pace: options.pace,
      stresses: prepared.stresses,
      instruction: options.instruction,
    }, PIPER_CAPABILITIES),
  };
}

/**
 * Вставки идут справа налево в координатах canonicalText и не сдвигают другие позиции.
 * SSML остаётся обязанностью скопированного Python; служебные токены не принимаются из текста.
 */
function sileroMarkup(
  text: string,
  stresses: Array<{ at: number; vowel: number }>,
): string {
  let result = text.replace(/[\uE000\uE001]/gu, ' ');
  const positions = stresses.map((stress) => stress.at + stress.vowel).sort((left, right) => right - left);

  for (const at of positions) {
    result = `${result.slice(0, at)}+${result.slice(at)}`;
  }

  return result;
}

/**
 * Приёмка и runtime Silero используют один контракт stdin/argv/facts на явных файлах.
 * Латиница и цифры отклоняются до извлечения ресурса и создания дочернего процесса.
 */
export async function synthesizeSileroFile(options: SileroFileOptions): Promise<SynthesisResult> {
  const prepared = validateSynthesis({
    text: options.text,
    voiceRef: options.speaker,
    language: 'ru',
  }, {
    outputFile: options.outputFile,
    pace: options.pace,
    signal: options.signal,
  }, SILERO_CAPABILITIES);
  const unreadable = unreadableFragments(prepared.canonicalText, ['latin', 'digits']);

  if (unreadable.length > 0) {
    throw new VoiceError(`Silero не читает: ${unreadable.join(', ')}.`, 2);
  }

  const script = await resolveScript(options.scriptPath, options.signal);
  const run = options.spawn ?? runWithStdin;
  const result = await withAudioOutput(options.outputFile, async (temporaryFile) => {
    const reply = await run(options.python, [
      script,
      '--model', options.modelFile,
      '--speaker', options.speaker,
      '--rate', options.pace ?? 'normal',
      '--out', temporaryFile,
    ], {
      input: sileroMarkup(prepared.canonicalText, prepared.stresses),
      timeoutMs: options.timeoutMs ?? 300000,
      signal: options.signal,
    });

    checkSpeechFacts(reply.stdout);
  }, options.signal);

  return {
    ...result,
    ignoredDirections: unsupportedDirections({
      pace: options.pace,
      stresses: prepared.stresses,
      instruction: options.instruction,
    }, SILERO_CAPABILITIES),
  };
}
