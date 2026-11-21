import fs from 'node:fs/promises';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const windowsBuildPattern = /^10\.0\.[0-9]+$/u;
const runners = ['windows-2025', 'windows-11-arm', 'physical'];
const probeKeys = [
  'format', 'runner', 'windowsBuild', 'arch', 'wsl2Available', 'bootId', 'uid',
  'flockOk', 'usernsOk', 'bwrapOk', 'seaOk', 'conptyOk', 'drvfsLock', 'ext4Lock',
].sort();
const lockKeys = ['holderReady', 'contenderExit', 'reacquiredExit'].sort();

export interface WslLockObservation {
  holderReady: boolean;
  contenderExit: number;
  reacquiredExit: number;
}

export interface WslProbeReport {
  format: 1;
  runner: string;
  windowsBuild: string;
  arch: 'x86_64' | 'aarch64';
  wsl2Available: boolean;
  bootId: string;
  uid: number;
  flockOk: boolean;
  usernsOk: boolean;
  bwrapOk: boolean;
  seaOk: boolean;
  conptyOk: boolean;
  drvfsLock: WslLockObservation;
  ext4Lock: WslLockObservation;
}

export interface WindowsSpikeVerdicts {
  wsl2: boolean;
  stateVolume: 'drvfs' | 'ext4';
  contained: boolean;
  conpty: boolean;
  sea: boolean;
  bootId: string;
  arch: string;
}

/**
 * Закрытый decoder наблюдения flock: holder обязан подтвердить READY,
 * contender — явный конфликт кодом 73, повтор после ухода holder — код 0.
 * Ошибка открытия, тайм-аут или отсутствие конфликта не дают положительного исхода.
 */
function decodeLock(raw: unknown): WslLockObservation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('windows_probe_invalid');
  }

  const value = raw as Record<string, unknown>;

  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(lockKeys)
    || typeof value.holderReady !== 'boolean'
    || typeof value.contenderExit !== 'number' || !Number.isInteger(value.contenderExit)
    || value.contenderExit < 0 || value.contenderExit > 255
    || typeof value.reacquiredExit !== 'number' || !Number.isInteger(value.reacquiredExit)
    || value.reacquiredExit < 0 || value.reacquiredExit > 255) {
    throw new Error('windows_probe_invalid');
  }

  return {
    holderReady: value.holderReady,
    contenderExit: value.contenderExit,
    reacquiredExit: value.reacquiredExit,
  };
}

/**
 * Принимает только полный отчёт WSL-пробы с точными ключами и типами:
 * boot_id UUID, arch из закрытого списка, непривилегированный uid и оба
 * наблюдения flock (drvfs и ext4-контроль). Неполный отчёт не даёт вердикта.
 */
export function decodeWslProbe(raw: unknown): WslProbeReport {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('windows_probe_invalid');
  }

  const value = raw as Record<string, unknown>;

  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(probeKeys)
    || value.format !== 1
    || typeof value.runner !== 'string' || !runners.includes(value.runner)
    || typeof value.windowsBuild !== 'string' || !windowsBuildPattern.test(value.windowsBuild)
    || (value.arch !== 'x86_64' && value.arch !== 'aarch64')
    || typeof value.wsl2Available !== 'boolean'
    || typeof value.bootId !== 'string' || !uuidPattern.test(value.bootId)
    || typeof value.uid !== 'number' || !Number.isSafeInteger(value.uid) || value.uid <= 0
    || typeof value.flockOk !== 'boolean'
    || typeof value.usernsOk !== 'boolean'
    || typeof value.bwrapOk !== 'boolean'
    || typeof value.seaOk !== 'boolean'
    || typeof value.conptyOk !== 'boolean') {
    throw new Error('windows_probe_invalid');
  }

  return {
    format: 1,
    runner: value.runner,
    windowsBuild: value.windowsBuild,
    arch: value.arch,
    wsl2Available: value.wsl2Available,
    bootId: value.bootId,
    uid: value.uid,
    flockOk: value.flockOk,
    usernsOk: value.usernsOk,
    bwrapOk: value.bwrapOk,
    seaOk: value.seaOk,
    conptyOk: value.conptyOk,
    drvfsLock: decodeLock(value.drvfsLock),
    ext4Lock: decodeLock(value.ext4Lock),
  };
}

/**
 * Положительный исход исключения двух процессов: holder READY, contender
 * получает явный отказ 73 на том же файле, после ухода holder повтор даёт 0.
 */
function lockExclusionHolds(observation: WslLockObservation): boolean {
  return observation.holderReady === true
    && observation.contenderExit === 73
    && observation.reacquiredExit === 0;
}

/**
 * Сводит отчёт к вердиктам моста: доступность WSL2, том state (drvfs только
 * при доказанном исключении, иначе ext4), contained по userns+bwrap, SEA и
 * ConPTY. Сломанный ext4-контроль или базовый flock останавливают мост целиком.
 */
export function resolveWindowsSpikeVerdicts(report: WslProbeReport): WindowsSpikeVerdicts {
  if (!report.flockOk) {
    throw new Error('windows_bridge_flock_invalid');
  }

  if (!lockExclusionHolds(report.ext4Lock)) {
    throw new Error('windows_bridge_ext4_invalid');
  }

  return {
    wsl2: report.wsl2Available,
    stateVolume: lockExclusionHolds(report.drvfsLock) ? 'drvfs' : 'ext4',
    contained: report.usernsOk && report.bwrapOk,
    conpty: report.conptyOk,
    sea: report.seaOk,
    bootId: report.bootId,
    arch: report.arch,
  };
}

/**
 * Записывает отчёт пробы и её вердикты одним JSON для журнала: внешний
 * потребитель читает только этот файл, а не пересказ наблюдений.
 */
export async function recordSpikeVerdicts(file: string, raw: unknown): Promise<WindowsSpikeVerdicts> {
  const report = decodeWslProbe(raw);
  const verdicts = resolveWindowsSpikeVerdicts(report);
  const record = {
    format: 1,
    report,
    verdicts,
  };

  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`);

  return verdicts;
}