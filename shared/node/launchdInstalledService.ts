import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { canonicalJson } from '../lib/canonicalJson.ts';
import {
  assertInstallationPath, readInstallationJson, verifyInstallPublication,
} from './installedLayout.ts';
import type { InstallationReceipt } from './installedLayout.ts';
import { DARWIN_SERVICE_ENV, DARWIN_SERVICE_MARKER } from './darwinServiceRegistration.ts';
import type { DarwinServiceReceipt } from './darwinServiceRegistration.ts';
import { readDarwinProcessIdentity } from './processIdentity.ts';

const execute = promisify(execFile);
const libArgs = {
  timeout: 5_000,
  maxBuffer: 512 * 1024,
  env: { LC_ALL: 'C' },
};

interface Registration {
  receipt: DarwinServiceReceipt;
  argv: string[];
  env: Record<string, string>;
  domain: string;
  target: string;
}

export type DarwinServiceState = {
  registration: Registration;
  state: 'loaded' | 'unloaded' | 'no-domain';
  pid: number | null;
  startScheduled: boolean;
};

/**
 * Читает приватную запись и plist, затем сверяет полный argv и безопасную форму.
 * Неизвестный файл, чужой label или неверная команда закрывают управление.
 */
export async function readDarwinServiceRegistration(
  installation: InstallationReceipt,
): Promise<Registration> {
  const value = await readInstallationJson(installation.root, 'service.json') as DarwinServiceReceipt;
  const label = 'com.grigdesk.server.' + installation.installationId;

  if (!value || Object.keys(value).sort().join(',') !== 'format,installationId,label,plist,sha256,uid'
    || value.format !== 1 || value.uid !== installation.uid
    || value.installationId !== installation.installationId
    || value.label !== label || !/^[a-f0-9]{64}$/u.test(value.sha256) || !path.isAbsolute(value.plist)
    || path.basename(value.plist) !== label + '.plist' || await fs.realpath(value.plist) !== value.plist) {
    throw new Error('release_foreign_service');
  }

  const stat = await fs.lstat(value.plist);
  const key = {
    mode: 0o600,
    size: stat.size,
    sha256: value.sha256,
  };

  if (key.size > 64 * 1024) {
    throw new Error('release_foreign_service');
  }

  await verifyInstallPublication(value.plist, key);

  const { stdout } = await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', value.plist], libArgs);
  const document = JSON.parse(stdout) as Record<string, unknown>;
  const work = installation.root;
  const launcher = await assertInstallationPath(work, 'bin/grigdesk-server');
  const log = await assertInstallationPath(work, 'update/server.log');
  const logStat = await fs.lstat(log);
  const fields = 'ExitTimeOut,KeepAlive,Label,ProgramArguments,RunAtLoad,'
    + 'StandardErrorPath,StandardOutPath,WorkingDirectory';

  if (!document || Object.keys(document).sort().join(',') !== fields || document.Label !== label
    || document.WorkingDirectory !== work || document.StandardErrorPath !== log
    || document.StandardOutPath !== log || document.RunAtLoad !== false || document.KeepAlive !== false
    || document.ExitTimeOut !== 60 || !logStat.isFile() || logStat.nlink !== 1
    || (logStat.mode & 0o7777) !== 0o600) {
    throw new Error('release_foreign_service');
  }

  const argv = document.ProgramArguments;

  if (!Array.isArray(argv) || argv.length !== DARWIN_SERVICE_ENV.length + 4
    || argv[0] !== '/usr/bin/env' || argv[1] !== '-i'
    || argv.at(-2) !== '/bin/sh' || argv.at(-1) !== launcher
    || argv.some((item) => typeof item !== 'string' || /[\x00-\x1f\x7f]/u.test(item))) {
    throw new Error('release_foreign_service');
  }

  const env: Record<string, string> = {};

  for (const [index, name] of DARWIN_SERVICE_ENV.entries()) {
    const assignment: string = argv[index + 2];

    if (!assignment.startsWith(name + '=')) {
      throw new Error('release_foreign_service');
    }

    const setting = assignment.slice(name.length + 1);

    if (['HOME', 'TMPDIR', 'GRIGDESK_HOME'].includes(name) || name.startsWith('XDG_')) {
      if (!path.isAbsolute(setting) || path.resolve(setting) !== setting) {
        throw new Error('release_foreign_service');
      }
    }

    env[name] = setting;
  }

  if (env.PATH !== '/usr/bin:/bin:/usr/sbin:/sbin' || env.LANG !== 'en_US.UTF-8'
    || env.GRIGDESK_HOME !== installation.dataHome || env[DARWIN_SERVICE_MARKER] !== label) {
    throw new Error('release_foreign_service');
  }

  await verifyInstallPublication(value.plist, key);

  const domain = 'gui/' + installation.uid;

  return {
    receipt: value,
    argv,
    env,
    domain,
    target: domain + '/' + label,
  };
}

/**
 * Launchctl print декодируется только для известной зарегистрированной записи.
 * Раздел arguments и PID сверяются отдельно от дочерних секций окружения.
 * Запланированный spawn без PID отличается от неактивной службы.
 */
export function parseDarwinLoadedService(text: string, registration: Registration):
  Pick<DarwinServiceState, 'pid' | 'startScheduled'> {
  const lines = text.trimEnd().split('\n');
  const root = lines.shift();
  const fields = new Map<string, string>();
  const argumentsAt = lines.findIndex((line) => /^\targuments = \{$/u.test(line));
  const argumentsEnd = lines.findIndex((line, index) => index > argumentsAt && line === '\t}');

  if (root !== registration.target + ' = {' || lines.at(-1) !== '}'
    || argumentsAt < 0 || argumentsEnd <= argumentsAt
    || lines.filter((line) => /^\targuments = \{$/u.test(line)).length !== 1) {
    throw new Error('release_foreign_service');
  }

  const args = lines.slice(argumentsAt + 1, argumentsEnd).map((line) => line.slice(2));

  if (args.length !== registration.argv.length
    || args.some((arg, index) => arg !== registration.argv[index])) {
    throw new Error('release_foreign_service');
  }

  for (const line of lines) {
    const field = /^\t(path|program|state|pid) = (.+)$/u.exec(line);

    if (field) {
      if (fields.has(field[1]!)) {
        throw new Error('release_foreign_service');
      }

      fields.set(field[1]!, field[2]!);
    }
  }

  if (fields.get('path') !== registration.receipt.plist || fields.get('program') !== '/usr/bin/env') {
    throw new Error('release_foreign_service');
  }

  const state = fields.get('state') ?? '';
  const pid = fields.get('pid');

  if (state === 'running' && pid && /^[1-9][0-9]*$/u.test(pid)
    && Number.isSafeInteger(Number(pid)) && Number(pid) > 1) {
    return { pid: Number(pid), startScheduled: false };
  }

  if (!pid && ['not running', 'waiting', 'spawn scheduled', 'exited'].includes(state)) {
    return { pid: null, startScheduled: state === 'spawn scheduled' };
  }

  throw new Error('release_activity_unknown');
}

/**
 * Только доказанное отсутствие GUI domain разрешает manual. Ошибки
 * доступа, таймаут и непонятный ответ о label считаются неизвестными.
 */
export async function darwinInstalledService(installation: InstallationReceipt): Promise<DarwinServiceState> {
  const registration = await readDarwinServiceRegistration(installation);
  const result = await execute('/bin/launchctl', ['print', registration.target], libArgs)
    .then(({ stdout }) => ({ stdout, missing: false }), (error: unknown) => {
      const details = error as { code?: unknown; stderr?: string };
      const missing = details.code === 113 && /could not find (service|domain)/iu.test(details.stderr ?? '');

      if (!missing) {
        throw new Error('release_activity_unknown');
      }

      return { stdout: '', missing: true };
    });

  if (!result.missing) {
    return {
      registration,
      state: 'loaded',
      ...parseDarwinLoadedService(result.stdout, registration),
    };
  }

  const hasGui = await execute('/bin/launchctl', ['print', registration.domain], libArgs)
    .then(({ stdout }) => {
      if (!stdout.startsWith(registration.domain + ' = {')) {
        throw new Error('release_activity_unknown');
      }

      return true;
    }, (error: unknown) => {
      const details = error as { code?: unknown; stderr?: string };

      if (details.code === 113 && /could not find domain/iu.test(details.stderr ?? '')) {
        return false;
      }

      throw new Error('release_activity_unknown');
    });

  return {
    registration,
    state: hasGui ? 'unloaded' : 'no-domain',
    pid: null,
    startScheduled: false,
  };
}

/**
 * Старт загружает точный plist только в установленном GUI domain.
 * Перед kickstart повторно подтверждается фактическая зарегистрированная команда.
 */
export async function startDarwinInstalledService(installation: InstallationReceipt): Promise<boolean> {
  let state = await darwinInstalledService(installation);

  if (state.state === 'no-domain') {
    return false;
  }

  if (state.state === 'unloaded') {
    const { registration } = state;

    await execute('/bin/launchctl', ['bootstrap', registration.domain, registration.receipt.plist], libArgs);
    state = await darwinInstalledService(installation);
  }

  if (state.state !== 'loaded') {
    throw new Error('release_activity_unknown');
  }

  if (!state.pid && !state.startScheduled) {
    await execute('/bin/launchctl', ['kickstart', state.registration.target], libArgs);
  }

  return true;
}

/**
 * Bootout допускается лишь для полной сверки argv и прежней инкарнации PID.
 * После штатного update-drain владелец может уже завершиться самостоятельно.
 */
export async function stopDarwinInstalledService(
  installation: InstallationReceipt, expected: { pid: number; starttime: string } | null,
  registration?: DarwinServiceReceipt,
): Promise<void> {
  const owner = await darwinInstalledService(installation);

  if (owner.state !== 'loaded' || owner.startScheduled || owner.pid !== (expected?.pid ?? null)
    || registration && canonicalJson(owner.registration.receipt) !== canonicalJson(registration)) {
    throw new Error('release_server_owner_changed');
  }

  if (expected) {
    const maintenance = path.join(installation.root, 'update/maintenance');
    const proof = await readDarwinProcessIdentity(expected.pid, maintenance);

    if (proof.state !== 'alive' || proof.identity.starttime !== expected.starttime) {
      throw new Error('release_server_owner_changed');
    }
  }

  await execute('/bin/launchctl', ['bootout', owner.registration.target], {
    ...libArgs,
    timeout: 65_000,
  });

  if ((await darwinInstalledService(installation)).state !== 'unloaded') {
    throw new Error('release_server_drain_failed');
  }
}
