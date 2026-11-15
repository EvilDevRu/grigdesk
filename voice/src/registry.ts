import { existsSync } from 'node:fs';
import path from 'node:path';

import type { VoiceConfig } from './config.ts';
import type { VoiceEngine } from './contract.ts';
import { createPiperEngine } from './engines/piper.ts';
import { createQwenEngine } from './engines/qwen.ts';
import { createQwenTokenEngine } from './engines/qwenToken.ts';
import { createSileroEngine } from './engines/silero.ts';
import type { RunProcess } from './process.ts';

interface RegistryIO {
  fetch: typeof fetch;
  spawn?: RunProcess;
  scriptPath(name: string): Promise<string>;
  signal?: AbortSignal;
}

/**
 * Реестр собирается синхронно, а ресурсы извлекаются лениво после валидации синтеза.
 * Окружения читаются только из voiceDir; каталог сервера и его ключи недоступны этому коду.
 */
export function buildEngines(config: VoiceConfig, io: RegistryIO): VoiceEngine[] {
  const piperRoot = path.join(config.voiceDir, 'engines', 'piper');
  const sileroRoot = path.join(config.voiceDir, 'engines', 'silero');
  const piperPython = path.join(piperRoot, 'venv', 'bin', 'python');
  const sileroPython = path.join(sileroRoot, 'venv', 'bin', 'python');
  const cloud = config.qwenService === 'qwencloud-token' ? createQwenTokenEngine : createQwenEngine;

  return [
    cloud({
      apiKey: config.qwenApiKey,
      baseUrl: config.qwenBaseUrl,
      fetch: io.fetch,
      signal: io.signal,
    }),
    createPiperEngine({
      voiceRoot: piperRoot,
      python: existsSync(piperPython) ? piperPython : null,
      scriptPath: () => io.scriptPath('piperSynth.py'),
      spawn: io.spawn,
      signal: io.signal,
    }),
    createSileroEngine({
      engineRoot: sileroRoot,
      python: existsSync(sileroPython) ? sileroPython : null,
      scriptPath: () => io.scriptPath('sileroSynth.py'),
      spawn: io.spawn,
      signal: io.signal,
    }),
  ];
}
