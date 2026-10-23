import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { decodeServerBinaryInfo, type ServerBinaryInfo } from '../runtime/serverBinary.ts';

const execute = promisify(execFile);
const hashPattern = /^[a-f0-9]{64}$/u;
const tokenPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;

export interface PreparedServerRuntime {
  packageId: string;
  root: string;
  node: string;
  engine: string;
  installationBin: string;
  preparationToken: string;
}

export interface ServerBinaryVerification {
  ok: true;
  verified: true;
  packageId: string;
  elfSha256: string;
  runtime: ServerBinaryInfo['runtime'];
  filesVerified: number;
  nativeBindingsVerified: number;
}

export interface ServerBinaryProbeOptions {
  signal?: AbortSignal;
  home?: string;
  expectPackageId?: string;
  timeoutMs?: number;
  run?: (file: string, args: string[], options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer: number;
    signal?: AbortSignal;
  }) => Promise<{ stdout: string; stderr?: string }>;
}

/**
 * Публичный отказ не включает stderr чужого executable и локальные секреты.
 * Форма результата проверяется независимо от успешного кода дочернего процесса.
 */
function invalidRuntime(): never {
  throw Object.assign(new Error('Некорректный ответ серверного ELF'), {
    code: 'server_runtime_invalid',
  });
}

/**
 * Закрытая схема не разрешает передать дополнительные пути или управляющие поля.
 * Значения декодируются отдельно после проверки точного состава объекта.
 */
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    invalidRuntime();
  }

  return value as Record<string, unknown>;
}

/**
 * Preparation связывает packageId с единственным физическим R и его Node/engine.
 * UUID и закрытая схема обязательны; путь с traversal не нормализуется молча.
 */
export function decodePreparedRuntime(value: unknown, packageId: string): PreparedServerRuntime {
  const result = exact(value, ['packageId', 'root', 'node', 'engine',
    'installationBin', 'preparationToken']);

  if (!hashPattern.test(packageId) || result.packageId !== packageId
    || Object.values(result).some((item) => typeof item !== 'string')) {
    invalidRuntime();
  }

  const prepared = result as unknown as PreparedServerRuntime;

  if (!path.isAbsolute(prepared.root) || path.normalize(prepared.root) !== prepared.root
    || path.basename(prepared.root) !== packageId
    || prepared.node !== path.join(prepared.root, 'runtime/node/bin/node')
    || prepared.engine !== path.join(prepared.root, 'engine/bin/factory')
    || !path.isAbsolute(prepared.installationBin)
    || path.normalize(prepared.installationBin) !== prepared.installationBin
    || !tokenPattern.test(prepared.preparationToken)) {
    invalidRuntime();
  }

  return prepared;
}

/**
 * Probe имеет ограниченные stdout, время и окружение без loader inputs вызывающего.
 * Metadata не вычисляет HOME; операции с кэшем получают только явный disposable D.
 */
async function runJson(binary: string, args: string[], options: ServerBinaryProbeOptions) {
  if (!path.isAbsolute(binary)) {
    invalidRuntime();
  }

  const result = await (options.run ?? execute)(binary, args, {
    cwd: '/',
    env: { PATH: '', ...(options.home ? { GRIGDESK_HOME: options.home } : {}) },
    timeout: options.timeoutMs ?? 30000,
    maxBuffer: 65536,
    signal: options.signal,
  });

  if (Buffer.byteLength(result.stdout) > 65536) {
    invalidRuntime();
  }

  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    invalidRuntime();
  }
}

/**
 * Только публичная metadata читается без prepare и без создания lease.
 * Самохеширование полного приватного manifest остаётся обязанностью launcher.
 */
export async function probeServerBinary(binary: string,
  options: ServerBinaryProbeOptions = {}): Promise<ServerBinaryInfo> {
  const value = await runJson(binary, ['--runtime-info', '--json'], options);
  const info = decodeServerBinaryInfo(value);

  if (options.expectPackageId && info.packageId !== options.expectPackageId) {
    throw Object.assign(new Error('Серверный пакет изменился'), { code: 'server_package_changed' });
  }

  return info;
}

/**
 * Подготовка закрепляет ожидаемый ELF до обращения к кэшу и выдаёт owner handle.
 * Потребитель обязан передать token launcher либо явно освободить preparation.
 */
export async function prepareServerBinary(binary: string,
  options: ServerBinaryProbeOptions & {
    home: string;
    expectPackageId: string;
  }): Promise<PreparedServerRuntime> {
  const value = await runJson(binary, ['--prepare', '--json', '--expect-package-id',
    options.expectPackageId], options);

  return decodePreparedRuntime(value, options.expectPackageId);
}

/**
 * Полная проверка вызывается на staged ELF с отдельной папкой данных.
 * Декодер требует фактический ELF SHA и положительные числа проверенных файлов/native.
 */
export async function verifyServerBinary(binary: string,
  options: ServerBinaryProbeOptions & { home: string }): Promise<ServerBinaryVerification> {
  const args = ['--verify', '--json'];

  if (options.expectPackageId) {
    args.push('--expect-package-id', options.expectPackageId);
  }

  const result = exact(await runJson(binary, args, options), ['ok', 'verified', 'packageId',
    'elfSha256', 'runtime', 'filesVerified', 'nativeBindingsVerified']);

  if (result.ok !== true || result.verified !== true
    || !hashPattern.test(String(result.packageId)) || !hashPattern.test(String(result.elfSha256))
    || !Number.isSafeInteger(result.filesVerified) || Number(result.filesVerified) < 1
    || result.nativeBindingsVerified !== 2
    || options.expectPackageId && result.packageId !== options.expectPackageId) {
    invalidRuntime();
  }

  const runtime = result.runtime as ServerBinaryInfo['runtime'];

  if (runtime?.node !== '24.21.0' || runtime.abi !== '137'
    || runtime.platform !== 'linux' || runtime.arch !== 'x64') {
    invalidRuntime();
  }

  return result as unknown as ServerBinaryVerification;
}

/**
 * Освобождение передаёт прежний packageId отдельным аргументом, без сверки текущего ELF.
 * Это сохраняет возможность закрыть preparation A после атомарной замены файла на B.
 */
export async function releaseServerPreparation(binary: string, options: ServerBinaryProbeOptions & {
  home: string;
  packageId: string;
  token: string;
}): Promise<void> {
  if (!hashPattern.test(options.packageId) || !tokenPattern.test(options.token)) {
    invalidRuntime();
  }

  const result = exact(await runJson(binary, ['--release-preparation', options.token,
    '--package-id', options.packageId, '--json'], options), ['ok']);

  if (result.ok !== true) {
    invalidRuntime();
  }
}
