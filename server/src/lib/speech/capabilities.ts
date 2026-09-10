import { spawn } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SPEECH_MODEL_CATALOG, speechModel } from './catalog.ts';
import type { SpeechModel } from './catalog.ts';

export const SPEECH_LANGUAGES = Object.freeze(['ru', 'en', 'auto']);
export const CUDA_STATES = Object.freeze([
  'ready',
  'no_device',
  'missing_library',
  'probe_failed',
]);

export const CUDA_PROBE_PY = fileURLToPath(new URL('./cuda-probe.py', import.meta.url));
export const MODEL_CACHE_PROBE_PY = fileURLToPath(new URL('./model-cache-probe.py', import.meta.url));

// Что Python подтвердил про snapshot одной модели.
export interface VerifiedSnapshot {
  modelId?: string;
  snapshotPath?: string;
  cached?: boolean;
  reason?: string;
}

// Состояние модели в локальном кэше. `snapshotPath` неперечислим: он нужен runtime,
// но в публичный JSON не уходит.
export interface SpeechModelStatus {
  modelId: string;
  repo: string;
  revision: string;
  cached: boolean;
  sizeMb: number;
  reason?: string;
  readonly snapshotPath?: string;
}

// Итог CUDA-канарейки.
export interface CudaState {
  state: string;
  reason: string | null;
  device?: unknown;
}

// Результат буферизованного запуска диагностики.
export interface BufferedRun {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | null;
}

// Запуск процесса диагностики; целиком подменяется в тестах.
export type DiagnosticRunner = (
  command: string,
  args: string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxBuffer?: number;
    spawnProcess?: typeof spawn;
  },
) => Promise<BufferedRun>;

function directoryBytes(root: string): number {
  let total = 0;
  const pending: string[] = [root];
  while (pending.length > 0) {
    const current = String(pending.pop());
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      try {
        // stat следует за HF symlink в blobs и считает фактический вес файла.
        const stat = statSync(entryPath);
        if (stat.isFile()) total += stat.size;
      } catch {
        // Исчезнувший symlink не должен превращать частичный snapshot в ready.
      }
    }
  }
  return total;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/**
 * Node только считает размер snapshots, уже подтверждённых huggingface_hub в Python.
 * Простого наличия config.json/model.bin недостаточно для cached=true.
 */
export function inspectSpeechModelCache({
  mediaHfDir,
  verifiedSnapshots = [],
  catalog = SPEECH_MODEL_CATALOG,
}: {
  mediaHfDir?: string;
  verifiedSnapshots?: VerifiedSnapshot[];
  catalog?: Record<string, SpeechModel>;
} = {}): SpeechModelStatus[] {
  if (!mediaHfDir) throw new TypeError('mediaHfDir обязателен для проверки моделей');
  return Object.values(catalog).map((model) => {
    const verified = verifiedSnapshots.find((item) => item.modelId === model.modelId);
    const snapshot = verified?.snapshotPath;
    const cached = Boolean(
      verified?.cached
      && snapshot
      && isInside(mediaHfDir, snapshot)
      && existsSync(path.join(snapshot, 'model.bin'))
      && existsSync(path.join(snapshot, 'config.json'))
      && existsSync(path.join(snapshot, 'tokenizer.json')),
    );
    const bytes = cached ? directoryBytes(String(snapshot)) : 0;
    const status: SpeechModelStatus = {
      modelId: model.modelId,
      repo: model.repo,
      revision: model.revision,
      cached,
      sizeMb: Math.round((bytes / (1024 * 1024)) * 10) / 10,
      ...(verified?.reason && !cached ? { reason: verified.reason } : {}),
    };
    if (cached) {
      // Нужен runtime для pinned load, но путь не должен попасть в публичный JSON.
      Object.defineProperty(status, 'snapshotPath', {
        value: snapshot,
        enumerable: false,
        writable: false,
      });
    }
    return Object.freeze(status);
  });
}

const bufferedProcess: DiagnosticRunner = (command, args, {
  env,
  timeoutMs,
  maxBuffer = 1024 * 1024,
  spawnProcess = spawn,
} = {}) => {
  return new Promise<BufferedRun>((resolve) => {
    let child;
    try {
      child = spawnProcess(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: '', error: error as Error });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value: BufferedRun) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < maxBuffer) stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < maxBuffer) stderr += chunk;
    });
    child.once('error', (error) => finish({ status: null, stdout, stderr, error }));
    child.once('close', (status) => finish({ status, stdout, stderr, error: null }));
    const timer = Number(timeoutMs) > 0 ? setTimeout(() => {
      child.kill?.('SIGTERM');
      finish({
        status: null,
        stdout,
        stderr,
        error: new Error(`Процесс диагностики превысил ${timeoutMs} мс`),
      });
    }, timeoutMs) : null;
    timer?.unref?.();
  });
};

function normalizedCuda(
  value: { state?: unknown; reason?: unknown; device?: unknown } | null,
): CudaState {
  if (!value || !CUDA_STATES.includes(String(value.state))) {
    return { state: 'probe_failed', reason: 'CUDA probe вернул некорректный ответ' };
  }
  return {
    state: String(value.state),
    reason: value.reason ? String(value.reason) : null,
    ...(value.device != null ? { device: value.device } : {}),
  };
}

/** Асинхронный canary не блокирует event loop во время загрузки модели/инференса. */
export async function runCudaCanary({
  pythonPath,
  env,
  model = null,
  timeoutMs = 120_000,
  run = bufferedProcess,
  probePath = CUDA_PROBE_PY,
}: {
  pythonPath?: string;
  env?: NodeJS.ProcessEnv;
  model?: SpeechModelStatus | string | null;
  timeoutMs?: number;
  run?: DiagnosticRunner;
  probePath?: string;
} = {}): Promise<CudaState> {
  if (!pythonPath || !existsSync(pythonPath)) {
    return { state: 'probe_failed', reason: 'python media-venv не найден' };
  }
  const args = [probePath];
  const snapshotPath = typeof model === 'object' ? model?.snapshotPath : null;
  if (snapshotPath) {
    args.push('--model-path', snapshotPath);
  } else if (model) {
    const modelId = typeof model === 'string' ? model : model.modelId;
    const catalogModel = speechModel(modelId);
    if (catalogModel) {
      args.push(
        '--model-repo', catalogModel.repo,
        '--model-revision', catalogModel.revision,
      );
      for (const alias of catalogModel.aliases) args.push('--model-alias', alias);
    }
  }
  const result = await run(pythonPath, args, { env, timeoutMs });
  if (result.error) {
    return { state: 'probe_failed', reason: result.error.message };
  }
  try {
    return normalizedCuda(JSON.parse(result.stdout || '{}'));
  } catch {
    return {
      state: 'probe_failed',
      reason: (result.stderr || `CUDA probe завершился с кодом ${result.status}`).trim(),
    };
  }
}

/**
 * huggingface_hub сам разрешает собственный cache_dir и точную pinned revision;
 * Node получает только подтверждённые snapshot paths и считает их размер.
 */
export async function probeSpeechModelCache({
  pythonPath,
  mediaHfDir,
  env,
  catalog = SPEECH_MODEL_CATALOG,
  run = bufferedProcess,
  probePath = MODEL_CACHE_PROBE_PY,
}: {
  pythonPath?: string;
  mediaHfDir?: string;
  env?: NodeJS.ProcessEnv;
  catalog?: Record<string, SpeechModel>;
  run?: DiagnosticRunner;
  probePath?: string;
} = {}): Promise<SpeechModelStatus[]> {
  const empty = () => inspectSpeechModelCache({ mediaHfDir, verifiedSnapshots: [], catalog });
  if (!pythonPath || !existsSync(pythonPath)) return empty();
  const models = Object.values(catalog).map((model) => ({
    modelId: model.modelId,
    repo: model.repo,
    revision: model.revision,
    aliases: model.aliases || [],
  }));
  const result = await run(pythonPath, [probePath, '--models-json', JSON.stringify(models)], {
    env,
    timeoutMs: 30_000,
  });
  if (result.error) {
    throw new Error(`Не удалось проверить кэш speech-моделей: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || '').trim().slice(0, 500);
    throw new Error(detail
      ? `Проверка кэша speech-моделей завершилась с кодом ${result.status}: ${detail}`
      : `Проверка кэша speech-моделей завершилась с кодом ${result.status}`);
  }
  let payload: { models?: unknown };
  try {
    payload = JSON.parse(result.stdout || '');
  } catch (error) {
    throw new Error(
      `Проверка кэша speech-моделей вернула некорректный JSON: ${(error as Error).message}`,
    );
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.models)) {
    throw new Error('Проверка кэша speech-моделей вернула ответ без массива models');
  }
  return inspectSpeechModelCache({
    mediaHfDir,
    verifiedSnapshots: payload.models,
    catalog,
  });
}

export function residentUnavailable() {
  return Object.freeze({
    supported: false,
    loaded: false,
    model: null,
    device: null,
    memMb: null,
    unloadAtSec: null,
  });
}
