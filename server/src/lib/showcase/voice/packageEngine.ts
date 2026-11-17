// Адаптер голосового пакета voice: раздел синтезирует через CLI bin/voice.
//
// Пакет — самостоятельный инструмент: он не читает серверные хранилища ключей и не
// зависит от сервера. Адаптер передаёт ключи облака через env дочернего процесса,
// а возможности и голоса берёт из JSON-команд пакета: каталог пакета — единственный
// источник правды о движках. Ударения из структуры возвращаются в текст знаком «+»:
// CLI разбирает их тем же общим парсером, что и раздел.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { NarrationStress } from '../../../../../shared/plugins/showcase/showcaseNarration.ts';
import { ShowcaseError } from '../errors.ts';
import type {
  SynthesisInput,
  SynthesisOptions,
  VoiceCandidate,
  VoiceCapabilities,
  VoiceDoctor,
  VoiceEngine,
  VoiceInfo,
} from './contract.ts';
import { unsupportedDirections } from './contract.ts';

export interface PackageEngineOptions {
  voiceBin: string;
  voiceDir: string;
  cloudEnv: () => Record<string, string>;
  // Поддельный executable тестов получает своё окружение (маркерные файлы).
  env?: NodeJS.ProcessEnv;
}

interface CliEngineSpec {
  adapterId: string;
  cliEngine: 'qwen' | 'piper' | 'silero';
  service: 'model-studio' | 'qwencloud-token' | null;
  kind: 'local' | 'cloud';
  name: string;
}

const SPECS: CliEngineSpec[] = [
  {
    adapterId: 'qwen-studio',
    cliEngine: 'qwen',
    service: 'model-studio',
    kind: 'cloud',
    name: 'Qwen (Model Studio)',
  },
  {
    adapterId: 'qwen-token',
    cliEngine: 'qwen',
    service: 'qwencloud-token',
    kind: 'cloud',
    name: 'Qwen (Token Plan)',
  },
  {
    adapterId: 'piper',
    cliEngine: 'piper',
    service: null,
    kind: 'local',
    name: 'Piper',
  },
  {
    adapterId: 'silero',
    cliEngine: 'silero',
    service: null,
    kind: 'local',
    name: 'Silero',
  },
];

const LIST_TTL_MS = 20_000;
const STDOUT_LIMIT = 1_048_576;
const STDERR_LIMIT = 65_536;

/**
 * Ударения структуры возвращаются в канонический текст знаком «+» перед ударной
 * гласной. Вставка идёт справа налево: позиции относятся к исходной строке, и левые
 * не сдвигаются правыми вставками.
 */
export function insertStresses(text: string, stresses: readonly NarrationStress[]): string {
  let result = text;
  const ordered = [...stresses].sort((left, right) => (
    (right.at + right.vowel) - (left.at + left.vowel)
  ));

  for (const stress of ordered) {
    const at = stress.at + stress.vowel;

    if (at < 0 || at > result.length) {
      continue;
    }

    result = `${result.slice(0, at)}+${result.slice(at)}`;
  }

  return result;
}

/**
 * Частота и каналы берутся из fmt-чанка готового WAV: сборке нужен PCM-профиль,
 * а верить словам поставщика о своём результате нельзя.
 */
export function parseWavHeader(buffer: Buffer): { sampleRate: number; channels: number } {
  if (
    buffer.length < 44
    || buffer.toString('ascii', 0, 4) !== 'RIFF'
    || buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new ShowcaseError('voice_failed', 'Движок вернул не WAV.', 502);
  }

  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);

    if (id === 'fmt ' && offset + 16 <= buffer.length) {
      return {
        channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
      };
    }

    offset += 8 + size + (size % 2);
  }

  throw new ShowcaseError('voice_failed', 'В WAV нет fmt-чанка.', 502);
}

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Один вызов CLI с ограничением хвостов, сроком и отменой. Отмена и срок убивают
 * свою группу: пакет сам завершает дочерний Python, но переживший родитель держал
 * бы ресурсы. Платный вызов не повторяется: повтор — решение человека.
 */
function runVoice(
  options: PackageEngineOptions,
  args: string[],
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ShowcaseError('voice_failed', 'Синтез отменён.', 499));

      return;
    }

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GRIGDESK_VOICE_DIR: options.voiceDir,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      HTTP_PROXY: process.env.HTTP_PROXY,
      NO_PROXY: process.env.NO_PROXY,
      ...(options.env ?? {}),
    };

    for (const [key, value] of Object.entries(options.cloudEnv())) {
      if (value) {
        env[key] = value;
      }
    }

    const child = spawn(options.voiceBin, args, {
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      killGroup();
      finish(new ShowcaseError('voice_failed', 'Истёк срок синтеза голосового движка.', 504));
    }, deadlineMs);

    const onAbort = () => {
      killGroup();
      finish(new ShowcaseError('voice_failed', 'Синтез отменён.', 499));
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    /**
     * Завершает только группу запущенного нами CLI и его потомков.
     * Эскалация нужна для движка, не ответившего на отмену.
     */
    function killGroup() {
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }

      setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // Группа уже завершилась — добивать нечего.
        }
      }, 2000).unref();
    }

    /**
     * Завершает promise однократно при гонке close, error и отмены.
     * Таймер и обработчик сигнала снимаются при любом исходе.
     */
    function finish(error: ShowcaseError | null, result?: CliResult) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);

      if (error) {
        reject(error);
      } else {
        resolve(result!);
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-STDOUT_LIMIT);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_LIMIT);
    });
    child.on('error', (error) => {
      finish(new ShowcaseError(
        'voice_failed',
        `Пакет voice не запускается: ${error.message}. Соберите его: npm --prefix voice run build.`,
        503,
      ));
    });
    child.on('close', (code) => {
      finish(null, {
        stdout,
        stderr,
        code: code ?? 1,
      });
    });
  });
}

/**
 * JSON-команда пакета: успех — одна JSON-строка в stdout, отказ — слова в stderr
 * и код 1/2. Код 2 — ошибка данных человека (текст, голос, лимит): он не повторяется
 * и не подменяется другим голосом.
 */
async function voiceJson<Value>(
  options: PackageEngineOptions,
  args: string[],
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<Value> {
  const result = await runVoice(options, [...args, '--json'], deadlineMs, signal);

  if (result.code !== 0) {
    const message = result.stderr.trim().split('\n').at(-1) ?? 'Движок voice отказал.';

    throw new ShowcaseError('voice_failed', message, result.code === 2 ? 409 : 502);
  }

  try {
    return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '') as Value;
  } catch {
    throw new ShowcaseError('voice_failed', 'Движок voice вернул ответ не по форме.', 502);
  }
}

interface CliModel {
  id: string;
  model: string;
  service: string | null;
  capabilities: {
    languages: string[];
    pace: boolean;
    stress: boolean;
    stressMode?: 'experimental';
    maxChars: number;
    formats: string[];
  };
}

interface CliEngineStatus {
  id: string;
  service: string | null;
  status: 'ready' | 'blocked';
  reason: string;
  install: string;
}

interface CliVoice {
  id: string;
  name: string;
  languages: string[];
  available: boolean;
  reason: string;
}

/**
 * Четыре адаптера пакета voice. Списки CLI кэшируются на 20 с: каталог не меняется
 * посреди выбора, а частый опрос готовности не должен запускать Python-пробы.
 * После установки кэш забывается сразу (forgetDoctor).
 */
export function createPackageEngines(options: PackageEngineOptions): VoiceEngine[] {
  // Кэш раздельный по паре (движок, сервис): реальный CLI отдаёт один сервис
  // Qwen на вызов, и общий кэш скрыл бы второй адаптер (находка F03).
  const modelsCache = new Map<string, { at: number; value: CliModel[] }>();
  const enginesCache = new Map<string, { at: number; value: CliEngineStatus[] }>();
  let versionCache = '';

  function cacheKey(spec: CliEngineSpec): string {
    return `${spec.cliEngine}:${spec.service ?? ''}`;
  }

  function serviceArgs(spec: CliEngineSpec): string[] {
    return spec.service ? ['--service', spec.service] : [];
  }

  /**
   * Каталог возможностей кэшируется отдельно для пары движок/сервис.
   * Холодный вызов читает CLI, прогретый не запускает второй процесс.
   */
  async function models(spec: CliEngineSpec): Promise<CliModel[]> {
    const key = cacheKey(spec);
    const cached = modelsCache.get(key);

    if (cached && Date.now() - cached.at < LIST_TTL_MS) {
      return cached.value;
    }

    const value = await voiceJson<CliModel[]>(options, ['models', ...serviceArgs(spec)], 30_000);

    modelsCache.set(key, { at: Date.now(), value });

    return value;
  }

  /**
   * Готовность сервиса читается отдельно от списка моделей.
   * Короткий кэш снижает число локальных проб при опросе интерфейса.
   */
  async function engineStatuses(spec: CliEngineSpec): Promise<CliEngineStatus[]> {
    const key = cacheKey(spec);
    const cached = enginesCache.get(key);

    if (cached && Date.now() - cached.at < LIST_TTL_MS) {
      return cached.value;
    }

    const value = await voiceJson<CliEngineStatus[]>(options, ['engines', ...serviceArgs(spec)], 120_000);

    enginesCache.set(key, { at: Date.now(), value });

    return value;
  }

  async function version(): Promise<string> {
    if (!versionCache) {
      const result = await runVoice(options, ['version'], 15_000);

      versionCache = result.stdout.trim() || 'voice unknown';
    }

    return versionCache;
  }

  return SPECS.map((spec) => {
    const engine: VoiceEngine = {
      id: spec.adapterId,
      name: spec.name,
      kind: spec.kind,

      /**
       * Синхронный контракт использует только прогретый каталог CLI.
       * Отсутствие каталога означает отказ вместо выдуманных возможностей.
       */
      capabilities(voiceRef: string | null): VoiceCapabilities {
        // Синхронный контракт: возможности берутся из прогретого кэша. Первый вызов
        // до прогрева — честный отказ, реестр покажет unknown, а не выдуманную мощь.
        const cached = modelsCache.get(cacheKey(spec))?.value ?? [];
        const entry = cached.find((item) => (
          item.id === spec.cliEngine && (item.service ?? null) === spec.service
        ));

        if (!entry) {
          throw new ShowcaseError('voice_failed', 'Возможности движка ещё не прочитаны.', 503);
        }

        return {
          languages: entry.capabilities.languages,
          tone: false,
          pace: entry.capabilities.pace,
          emphasis: false,
          pause: false,
          stress: entry.capabilities.stress,
          stressMode: entry.capabilities.stressMode,
          maxChars: entry.capabilities.maxChars,
          supportedFormats: entry.capabilities.formats,
          engineVersion: versionCache || 'voice unknown',
          modelRevision: entry.model,
          unreadable: spec.cliEngine === 'silero' ? ['latin', 'digits'] : [],
        };
      },

      /**
       * Показывает готовность выбранного сервиса и прогревает capabilities.
       * Отказ отдельного каталога не скрывает причину самого движка.
       */
      async doctor(): Promise<VoiceDoctor> {
        const statuses = await engineStatuses(spec);
        const entry = statuses.find((item) => (
          item.id === spec.cliEngine && (item.service ?? null) === spec.service
        ));

        // Заодно греем кэш возможностей: синхронный capabilities читает прогретое.
        await models(spec).catch(() => []);
        await version().catch(() => '');

        if (!entry) {
          return {
            status: 'unknown',
            reason: 'Движок не объявлен пакетом voice.',
            install: '',
          };
        }

        return {
          status: entry.status === 'ready' ? 'ready' : 'blocked',
          reason: entry.reason,
          install: entry.install,
        };
      },

      forgetDoctor() {
        modelsCache.delete(cacheKey(spec));
        enginesCache.delete(cacheKey(spec));
      },

      /**
       * Список дикторов принадлежит выбранному движку и сервису CLI.
       * Наружу выходит только описание, без серверного окружения.
       */
      async voices(): Promise<VoiceInfo[]> {
        const args = ['voices', '--engine', spec.cliEngine];

        if (spec.service) {
          args.push('--service', spec.service);
        }

        const listed = await voiceJson<CliVoice[]>(options, args, 120_000);

        return listed.map((voice) => ({
          id: voice.id,
          name: voice.name,
          language: voice.languages.includes('ru') ? 'ru' : voice.languages[0] ?? 'ru',
          available: voice.available,
          reason: voice.reason,
        }));
      },

      /**
       * Один вызов CLI создаёт кандидата WAV с явным голосом и темпом.
       * Реальные частота и каналы проверяются по файлу перед публикацией.
       */
      async synthesize(input: SynthesisInput, synthesisOptions: SynthesisOptions): Promise<VoiceCandidate> {
        // Возможности читаются до сборки аргументов: темп и предел зависят от движка.
        await models(spec);

        const capabilities = engine.capabilities(input.voiceRef);
        const text = insertStresses(input.canonicalText, input.direction.stresses);
        const outFile = path.join(synthesisOptions.outputDir, `voice-${randomUUID()}.wav`);
        const args = ['generate', '--engine', spec.cliEngine];

        if (spec.service) {
          args.push('--service', spec.service);
        }

        if (input.voiceRef) {
          args.push('--voice', input.voiceRef);
        }

        args.push('--text', text, '--out', outFile);

        if (input.direction.pace && input.direction.pace !== 'normal' && capabilities.pace) {
          args.push('--pace', input.direction.pace);
        }

        const result = await voiceJson<{
          file: string;
          ignoredDirections: string[];
          warnings?: string[];
        }>(options, args, synthesisOptions.deadlineMs, synthesisOptions.signal);
        const handle = await fs.open(result.file, 'r');
        const header = Buffer.alloc(4096);

        try {
          await handle.read(header, 0, header.length, 0);
        } finally {
          await handle.close();
        }

        const profile = parseWavHeader(header);

        return {
          temporaryFile: result.file,
          format: 'wav',
          sampleRate: profile.sampleRate,
          channels: profile.channels,
          engineRequestId: null,
          ignoredDirections: [
            ...result.ignoredDirections,
            ...unsupportedDirections(input.direction, capabilities),
            ...(result.warnings ?? []).map((warning) => `Предупреждение: ${warning}`),
          ],
        };
      },
    };

    return engine;
  });
}
