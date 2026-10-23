import path from 'node:path';

import type { Temperature } from '../../../../shared/runtime/systemMetrics.ts';
import { directories, metricNumber, readText, realPath, resourcePorts } from './ports.ts';
import type { ResourcePorts, ResourcesOptions } from './ports.ts';

export interface Temperatures {
  cpu?: Temperature;
  nvme: Map<string, Temperature>;
  gpu: Map<string, Temperature>;
  pci: Map<string, Temperature>;
}

/**
 * NVIDIA сообщает расширенный домен PCI, sysfs — обычный четырёхзначный.
 * Нормализация связывает пределы только с той же физической видеокартой.
 */
export function pciAddress(value: string): string | undefined {
  const match = value.match(/([\da-f]{4}):([\da-f]{2}:[\da-f]{2}\.[\da-f])$/i);

  return match ? `${match[1]}:${match[2]}`.toLowerCase() : undefined;
}

/**
 * Значение и пределы читаются у одного канала в миллиградусах.
 * Пропавшее или нечисловое значение не оставляет старую температуру в новом обходе.
 */
async function channelTemperature(ports: ResourcePorts, base: string): Promise<Temperature | undefined> {
  const values = await Promise.all(['input', 'max', 'crit'].map(async (suffix) =>
    metricNumber(await readText(ports, `${base}_${suffix}`))));
  const [input, max, crit] = values;

  if (input === undefined) {
    return undefined;
  }

  return {
    celsius: input / 1000,
    ...(max === undefined ? {} : { maxCelsius: max / 1000 }),
    ...(crit === undefined ? {} : { critCelsius: crit / 1000 }),
  };
}

/**
 * Белый список каналов исключает датчики платы, Wi-Fi и произвольные temp1.
 * Кеш хранит принадлежность GPU/NVMe, чтобы частота температуры не зависела от statfs.
 */
export async function readTemperatures(options: ResourcesOptions = {}): Promise<Temperatures> {
  const ports = resourcePorts(options);
  const result: Temperatures = {
    nvme: new Map(),
    gpu: new Map(),
    pci: new Map(),
  };
  const root = path.join(ports.sysRoot, 'class/hwmon');

  for (const entry of await directories(ports, root)) {
    const directory = path.join(root, entry);
    const driver = await readText(ports, path.join(directory, 'name'));

    if (!driver || !['k10temp', 'coretemp', 'nvme', 'amdgpu', 'nvidia'].includes(driver)) {
      continue;
    }

    const canonical = await realPath(ports, directory);
    const device = await realPath(ports, path.join(directory, 'device'))
      ?? canonical?.replace(/\/hwmon\/hwmon\d+$/, '');

    for (const filename of await directories(ports, directory)) {
      const channel = filename.match(/^(temp\d+)_input$/)?.[1];

      if (!channel) {
        continue;
      }

      const label = await readText(ports, path.join(directory, `${channel}_label`));
      const cpu = (driver === 'k10temp' && label === 'Tctl')
        || (driver === 'coretemp' && /^Package id \d+$/.test(label ?? ''));
      const nvme = driver === 'nvme' && label === 'Composite';
      const gpu = (driver === 'amdgpu' && label === 'edge')
        || (driver === 'nvidia' && channel === 'temp1');

      if (!cpu && !nvme && !gpu) {
        continue;
      }

      const temperature = await channelTemperature(ports, path.join(directory, channel));

      if (!temperature) {
        continue;
      }

      if (cpu && (!result.cpu || temperature.celsius > result.cpu.celsius)) {
        result.cpu = temperature;
      }

      if (device && nvme) {
        result.nvme.set(device, temperature);
      }

      if (device && gpu) {
        result.gpu.set(device, temperature);

        const pci = pciAddress(path.basename(device));

        if (pci) {
          result.pci.set(pci, temperature);
        }
      }
    }
  }

  return result;
}

/**
 * Раздел, namespace и mapper связываются с единственным контроллером NVMe.
 * Неоднозначный RAID или multipath сохраняет строку диска без чужой температуры.
 */
export async function nvmeControllerOf(
  block: string,
  ports: ResourcePorts,
  seen = new Set<string>(),
): Promise<string | undefined> {
  const canonical = await realPath(ports, block);

  if (!canonical || seen.has(canonical)) {
    return undefined;
  }

  seen.add(canonical);

  const controller = canonical.match(/^(.*\/nvme\d+)(?:\/|$)/)?.[1];

  if (controller) {
    return controller;
  }

  const subsystem = canonical.match(/^(.*\/nvme-subsystem\/[^/]+)/)?.[1];

  if (subsystem) {
    const controllers = await Promise.all((await directories(ports, subsystem))
      .filter((entry) => /^nvme\d+$/.test(entry))
      .map((entry) => realPath(ports, path.join(subsystem, entry))));
    const unique = new Set(controllers.filter((entry) => entry !== undefined));

    return unique.size === 1 ? [...unique][0] : undefined;
  }

  const slaves = path.join(canonical, 'slaves');
  const controllers = await Promise.all((await directories(ports, slaves))
    .map((entry) => nvmeControllerOf(path.join(slaves, entry), ports, new Set(seen))));
  const unique = new Set(controllers.filter((entry) => entry !== undefined));

  return unique.size === 1 ? [...unique][0] : undefined;
}
