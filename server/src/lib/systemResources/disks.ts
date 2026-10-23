import path from 'node:path';

import type { Disk } from '../../../../shared/runtime/systemMetrics.ts';
import { readText, realPath, resourcePorts } from './ports.ts';
import type { ResourcePorts, ResourcesOptions } from './ports.ts';
import { nvmeControllerOf } from './temperatures.ts';

interface Mount {
  id: string;
  device: string;
  mountpoint: string;
  dataHome: boolean;
}

export interface DiskSample {
  disk: Disk;
  controller?: string;
}

const LOCAL_TYPES = new Set([
  'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'jfs', 'reiserfs', 'bcachefs',
  'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk',
]);

const unescapeMount = (value: string) => value.replace(/\\([0-7]{3})/g,
  (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));

const containsPath = (mountpoint: string, filename: string) =>
  filename === mountpoint || filename.startsWith(mountpoint === '/' ? '/' : `${mountpoint}/`);

/**
 * Устройство должно существовать и как block в dev, и в sysfs.
 * Псевдодиски и сетевые файловые системы отбрасываются до потенциально медленного statfs.
 */
async function mountDevice(ports: ResourcePorts, source: string): Promise<string | undefined> {
  const device = await realPath(ports, source);

  if (!device || !device.startsWith(`${ports.devRoot}/`)) {
    return undefined;
  }

  const name = path.basename(device);

  if (/^(loop|ram|zram)\d+/.test(name)) {
    return undefined;
  }

  try {
    const stat = await ports.fs.stat(device);

    return stat.isBlockDevice() ? await realPath(ports, path.join(ports.sysRoot, 'class/block', name))
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Повторы раздела сводятся к самому короткому маунту, отдельные разделы сохраняются.
 * Флаг данных вычисляется по всем маунтам до дедупликации и переносится представителю.
 */
export async function selectMounts(
  source: string,
  dataHome: string,
  ports: ResourcePorts,
): Promise<Mount[]> {
  const mounts: Mount[] = [];
  const dataPath = await realPath(ports, dataHome) ?? path.resolve(dataHome);
  let dataMount: Mount | undefined;
  let dataLength = -1;

  for (const line of source.split('\n')) {
    const [rawDevice, rawMount, type] = line.trim().split(/\s+/);

    if (!rawDevice || !rawMount || !type || !LOCAL_TYPES.has(type)) {
      continue;
    }

    const device = unescapeMount(rawDevice);
    const mountpoint = unescapeMount(rawMount);

    if (mountpoint === '/boot/efi') {
      continue;
    }

    const id = await mountDevice(ports, device);

    if (!id) {
      continue;
    }

    const mount = {
      id,
      device,
      mountpoint,
      dataHome: false,
    };
    const canonicalMount = await realPath(ports, mountpoint) ?? mountpoint;

    mounts.push(mount);

    if (containsPath(canonicalMount, dataPath) && canonicalMount.length > dataLength) {
      dataMount = mount;
      dataLength = canonicalMount.length;
    }
  }

  const groups = new Map<string, Mount>();

  for (const mount of mounts.sort((a, b) => a.mountpoint.length - b.mountpoint.length
    || a.mountpoint.localeCompare(b.mountpoint))) {
    if (!groups.has(mount.id)) {
      groups.set(mount.id, { ...mount, dataHome: mount.id === dataMount?.id });
    }
  }

  return [...groups.values()].sort((a, b) => a.mountpoint < b.mountpoint ? -1 : 1);
}

/**
 * Асинхронный обход заменяет снимок только после завершения всех разрешённых разделов.
 * Ошибка отдельной ФС не отменяет остальные; резерв не считается доступным местом.
 */
export async function readDisks(dataHome: string, options: ResourcesOptions = {}): Promise<DiskSample[]> {
  const ports = resourcePorts(options);
  const source = await readText(ports, path.join(ports.procRoot, 'mounts'));
  const mounts = await selectMounts(source ?? '', dataHome, ports);
  const samples = await Promise.all(mounts.map(async (mount): Promise<DiskSample | undefined> => {
    try {
      const stat = await ports.fs.statfs(mount.mountpoint);
      const total = Number(stat.blocks) * Number(stat.bsize);
      const used = (Number(stat.blocks) - Number(stat.bfree)) * Number(stat.bsize);
      const free = Number(stat.bavail) * Number(stat.bsize);

      if (total <= 0 || ![total, used, free].every(Number.isFinite)) {
        return undefined;
      }

      return {
        disk: {
          ...mount,
          totalGb: total / 1024 ** 3,
          usedGb: used / 1024 ** 3,
          freeGb: free / 1024 ** 3,
          percent: used / total * 100,
        },
        controller: await nvmeControllerOf(mount.id, ports),
      };
    } catch {
      return undefined;
    }
  }));

  return samples.filter((sample): sample is DiskSample => sample !== undefined);
}
