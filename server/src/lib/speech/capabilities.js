import { spawn } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SPEECH_MODEL_CATALOG, speechModel } from './catalog.js';

export const SPEECH_LANGUAGES = Object.freeze(['ru', 'en', 'auto']);
export const CUDA_STATES = Object.freeze([
  'ready',
  'no_device',
  'missing_library',
  'probe_failed',
]);

export const CUDA_PROBE_PY = fileURLToPath(new URL('./cuda-probe.py', import.meta.url));
export const MODEL_CACHE_PROBE_PY = fileURLToPath(new URL('./model-cache-probe.py', import.meta.url));

function directoryBytes(root) {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
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

function isInside(root, candidate) {
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
} = {}) {
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
    const bytes = cached ? directoryBytes(snapshot) : 0;
    const status = {
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

function bufferedProcess(command, args, {
  env,
  timeoutMs,
  maxBuffer = 1024 * 1024,
  spawnProcess = spawn,
} = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: '', error });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
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
    const timer = timeoutMs > 0 ? setTimeout(() => {
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
}

function normalizedCuda(value) {
  if (!value || !CUDA_STATES.includes(value.state)) {
    return { state: 'probe_failed', reason: 'CUDA probe вернул некорректный ответ' };
  }
  return {
    state: value.state,
    reason: value.reason || null,
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
} = {}) {
  if (!pythonPath || !existsSync(pythonPath)) {
    return { state: 'probe_failed', reason: 'python media-venv не найден' };
  }
  const args = [probePath];
  if (model?.snapshotPath) {
    args.push('--model-path', model.snapshotPath);
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
} = {}) {
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
  let payload;
  try {
    payload = JSON.parse(result.stdout || '');
  } catch (error) {
    throw new Error(`Проверка кэша speech-моделей вернула некорректный JSON: ${error.message}`);
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
