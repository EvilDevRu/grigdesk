import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REQUIRED_CONTROLLERS = Object.freeze(['cpu', 'memory', 'pids']);

// Итог одной проверки предполётного гейта: годность плюс её подробности.
export interface PreflightCheck {
  ok: boolean;
  reason?: string;
  message?: string;
  [field: string]: unknown;
}

// Запуск внешней команды; целиком подменяется в тестах.
type PreflightRunner = (
  file: string,
  args: string[],
  options: { encoding: 'utf8'; timeout: number },
) => Promise<{ stdout: string; stderr?: string }>;

function check(ok: boolean, details: Record<string, unknown> = {}): PreflightCheck {
  return { ok, ...details };
}

async function inspectBubblewrap({
  bwrapBin = '/usr/bin/bwrap',
  busyboxBin = '/usr/bin/busybox',
  runner = execFileAsync as unknown as PreflightRunner,
}: {
  bwrapBin?: string;
  busyboxBin?: string;
  runner?: PreflightRunner;
} = {}): Promise<PreflightCheck> {
  try {
    const versionResult = await runner(bwrapBin, ['--version'], { encoding: 'utf8', timeout: 3_000 });
    const version = String(versionResult.stdout).trim().replace(/^bubblewrap\s+/, '');
    await runner(bwrapBin, [
      '--unshare-all',
      '--die-with-parent',
      '--new-session',
      '--dir', '/usr',
      '--dir', '/usr/bin',
      '--ro-bind', busyboxBin, '/usr/bin/busybox',
      '/usr/bin/busybox', 'true',
    ], { encoding: 'utf8', timeout: 3_000 });
    return check(true, { version, namespaces: ['user', 'mount', 'pid', 'ipc', 'uts', 'network'] });
  } catch (error) {
    return check(false, {
      reason: 'bubblewrap_probe_failed',
      message: (error as Error).message,
    });
  }
}

function cgroupPathFromProc(source: string): string {
  const entry = source.split('\n').find((line) => line.startsWith('0::'));
  if (!entry) throw new Error('unified cgroup entry не найден');
  const relative = entry.slice(3);
  const resolved = path.resolve('/sys/fs/cgroup', `.${relative}`);
  if (resolved !== '/sys/fs/cgroup' && !resolved.startsWith('/sys/fs/cgroup/')) {
    throw new Error('cgroup path вышел за /sys/fs/cgroup');
  }
  return resolved;
}

async function inspectCgroupV2({ readFile = fs.readFile, access = fs.access }: {
  readFile?: typeof fs.readFile;
  access?: typeof fs.access;
} = {}): Promise<PreflightCheck> {
  try {
    const proc = String(await readFile('/proc/self/cgroup', 'utf8'));
    const basePath = cgroupPathFromProc(proc);
    const controllers = String(await readFile(path.join(basePath, 'cgroup.controllers'), 'utf8'))
      .trim().split(/\s+/).filter(Boolean);
    const missingControllers = REQUIRED_CONTROLLERS.filter((name) => !controllers.includes(name));
    let writable = true;
    try {
      await access(basePath, fsConstants.W_OK);
    } catch {
      writable = false;
    }
    let killFile = true;
    try {
      await access(path.join(basePath, 'cgroup.kill'), fsConstants.W_OK);
    } catch {
      killFile = false;
    }
    const ok = writable && killFile && missingControllers.length === 0;
    return check(ok, {
      version: 2,
      basePath,
      controllers,
      missingControllers,
      writable,
      killFile,
      ...(!ok ? { reason: 'cgroup_delegation_insufficient' } : {}),
    });
  } catch (error) {
    return check(false, { reason: 'cgroup_v2_probe_failed', message: (error as Error).message });
  }
}

function systemdProperty(output: unknown, name: string): string {
  const line = String(output || '').split('\n').find((value) => value.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : '';
}

/**
 * На пользовательской машине GrigDesk обычно не владеет writable cgroup subtree,
 * зато user systemd умеет создать отдельный service-cgroup и применить лимиты до
 * exec. Проверяем именно фактические свойства уже запущенного transient unit.
 */
async function inspectSystemdResourceControl({
  systemdRunBin = '/usr/bin/systemd-run',
  systemctlBin = '/usr/bin/systemctl',
  runner = execFileAsync as unknown as PreflightRunner,
}: {
  systemdRunBin?: string;
  systemctlBin?: string;
  runner?: PreflightRunner;
} = {}): Promise<PreflightCheck> {
  const unit = `grigdesk-kimi-preflight-${randomUUID()}.service`;
  const args = [
    '--user', '--pipe', '--wait', '--collect', `--unit=${unit}`,
    '-p', 'CPUQuota=25%',
    '-p', 'MemoryMax=67108864',
    '-p', 'TasksMax=23',
    '-p', 'KillMode=control-group',
    '-p', 'RuntimeMaxSec=10s',
    systemctlBin, '--user', 'show', unit,
    '--property=ControlGroup',
    '--property=CPUQuotaPerSecUSec',
    '--property=MemoryMax',
    '--property=TasksMax',
    '--property=KillMode',
  ];
  try {
    const result = await runner(systemdRunBin, args, { encoding: 'utf8', timeout: 8_000 });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const controlGroup = systemdProperty(output, 'ControlGroup');
    const cpu = systemdProperty(output, 'CPUQuotaPerSecUSec');
    const memory = systemdProperty(output, 'MemoryMax');
    const tasks = systemdProperty(output, 'TasksMax');
    const killMode = systemdProperty(output, 'KillMode');
    const ok = controlGroup.startsWith('/')
      && cpu !== '' && cpu !== 'infinity'
      && memory === '67108864'
      && tasks === '23'
      && killMode === 'control-group';
    return check(ok, {
      mode: 'systemd-transient-service',
      controlGroup,
      cpuQuotaPerSec: cpu,
      memoryMax: memory,
      tasksMax: tasks,
      killMode,
      ...(!ok ? { reason: 'systemd_resource_limits_not_applied' } : {}),
    });
  } catch (error) {
    return check(false, {
      reason: 'systemd_resource_control_unavailable',
      message: (error as Error).message,
    });
  }
}

async function inspectEgressProxy({ socketPath, allowlistVersion }: {
  socketPath?: string;
  allowlistVersion?: unknown;
} = {}): Promise<PreflightCheck> {
  if (!socketPath || !allowlistVersion) {
    return check(false, { reason: 'egress_proxy_not_configured' });
  }
  try {
    const info = await fs.lstat(socketPath);
    if (!info.isSocket()) return check(false, { reason: 'egress_proxy_path_not_socket' });
    return check(true, { transport: 'unix', allowlistVersion });
  } catch (error) {
    return check(false, { reason: 'egress_proxy_unavailable', message: (error as Error).message });
  }
}

/**
 * Security gate намеренно собирает все причины NO-GO за один проход. Наличие
 * bwrap само по себе не понижает требования к cgroup или egress.
 */
export async function inspectKimiRuntimeHost(options: {
  bubblewrap?: Parameters<typeof inspectBubblewrap>[0];
  cgroup?: Parameters<typeof inspectCgroupV2>[0];
  systemd?: Parameters<typeof inspectSystemdResourceControl>[0];
  egress?: Parameters<typeof inspectEgressProxy>[0];
} = {}) {
  const platform = check(process.platform === 'linux', {
    platform: process.platform,
    ...(process.platform !== 'linux' ? { reason: 'linux_required' } : {}),
  });
  const [bubblewrap, directCgroup, systemdCgroup, egressProxy] = await Promise.all([
    inspectBubblewrap(options.bubblewrap),
    inspectCgroupV2(options.cgroup),
    inspectSystemdResourceControl(options.systemd),
    inspectEgressProxy(options.egress),
  ]);
  const cgroupV2 = directCgroup.ok
    ? { ...directCgroup, mode: 'delegated-subtree' }
    : (systemdCgroup.ok
      ? { ...systemdCgroup, directDelegation: directCgroup }
      : {
        ...directCgroup,
        alternatives: { systemdTransientService: systemdCgroup },
      });
  const checks = { platform, bubblewrap, cgroupV2, egressProxy };
  return {
    schemaVersion: 1,
    profile: 'kimi-contained-v1',
    decision: Object.values(checks).every((item) => item.ok) ? 'GO_CONTAINED_MVP' : 'NO_GO',
    checks,
  };
}

export {
  cgroupPathFromProc,
  inspectBubblewrap,
  inspectCgroupV2,
  inspectEgressProxy,
  inspectSystemdResourceControl,
};
