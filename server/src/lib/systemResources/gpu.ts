import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

import type { Gpu } from '../../../../shared/runtime/systemMetrics.ts';
import { directories, metricNumber, readText, realPath, resourcePorts } from './ports.ts';
import type { ResourcePorts, ResourcesOptions } from './ports.ts';
import { pciAddress } from './temperatures.ts';

export interface NvidiaGpu extends Gpu {
  pci?: string;
}

/**
 * Одна строка запроса соответствует UUID карты, неизвестные метрики опускаются.
 * MiB команды переводятся в ГБ без округления до отображения в интерфейсе.
 */
function parseNvidia(output: string): NvidiaGpu[] {
  const result: NvidiaGpu[] = [];

  for (const line of output.split('\n')) {
    const fields = line.split(',').map((field) => field.trim());
    const [id, pci, name, load, used, total, heat] = fields;

    if (fields.length !== 7 || !id || !name) {
      continue;
    }

    const percent = metricNumber(load);
    const memoryUsed = metricNumber(used);
    const memoryTotal = metricNumber(total);
    const celsius = metricNumber(heat);

    result.push({
      id,
      name,
      pci: pciAddress(pci ?? ''),
      ...(percent === undefined ? {} : { percent }),
      ...(memoryUsed === undefined ? {} : { memoryUsedGb: memoryUsed / 1024 }),
      ...(memoryTotal === undefined ? {} : { memoryTotalGb: memoryTotal / 1024 }),
      ...(celsius === undefined ? {} : { temperature: { celsius } }),
    });
  }

  return result;
}

export class NvidiaProbe {
  private readonly ports: ResourcePorts;
  private readonly publish: (gpus: NvidiaGpu[]) => void;
  private child: ChildProcess | undefined;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private disabled = false;
  private stopped = false;
  private killed = false;

  constructor(ports: ResourcePorts, publish: (gpus: NvidiaGpu[]) => void) {
    this.ports = ports;
    this.publish = publish;
  }

  /**
   * Слот принадлежит child до close, даже после ошибки или отправки SIGKILL.
   * Отсутствие команды отключает только NVIDIA, не файловые источники сборщика.
   */
  refresh(): void {
    if (this.child || this.disabled || this.stopped) {
      return;
    }

    let child: ChildProcess;

    try {
      child = this.ports.spawn('nvidia-smi', [
        '--query-gpu=uuid,pci.bus_id,name,utilization.gpu,memory.used,memory.total,temperature.gpu',
        '--format=csv,noheader,nounits',
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      this.disabled = (error as NodeJS.ErrnoException).code === 'ENOENT';

      return;
    }

    this.child = child;
    this.killed = false;

    let output = '';
    let bytes = 0;
    let failed = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;

      if (bytes > 128 * 1024) {
        failed = true;
        this.terminate();

        return;
      }

      output += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      failed = true;

      if (error.code === 'ENOENT') {
        this.disabled = true;
      }
    });
    child.on('close', (code) => {
      clearTimeout(this.timeout);
      this.timeout = undefined;
      this.child = undefined;

      if (!this.stopped && !failed && code === 0) {
        this.publish(parseNvidia(output));
      }
    });
    this.timeout = setTimeout(() => {
      failed = true;
      this.terminate();
    }, 2000);
    this.timeout.unref?.();
  }

  /**
   * Сигнал адресуется только процессу, созданному этим экземпляром.
   * Повторный stop или срок не отправляет второй сигнал уже завершающемуся child.
   */
  private terminate(): void {
    if (this.child && !this.killed) {
      this.killed = true;
      this.child.kill('SIGKILL');
    }
  }

  /**
   * Остановка запрещает новые команды и публикацию позднего close.
   * Таймер срока очищается независимо от того, успел ли завершиться child.
   */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timeout);
    this.terminate();
  }
}

/**
 * AMD читается только из ABI sysfs, без внешних команд и зависимости от NVIDIA.
 * Канонический PCI device объединяет несколько DRM-узлов одной видеокарты.
 */
export async function readAmdGpus(options: ResourcesOptions = {}): Promise<Gpu[]> {
  const ports = resourcePorts(options);
  const root = path.join(ports.sysRoot, 'class/drm');
  const result: Gpu[] = [];
  const seen = new Set<string>();

  for (const entry of await directories(ports, root)) {
    if (!/^card\d+$/.test(entry)) {
      continue;
    }

    const device = await realPath(ports, path.join(root, entry, 'device'));

    if (!device || seen.has(device) || await readText(ports, path.join(device, 'vendor')) !== '0x1002') {
      continue;
    }

    seen.add(device);

    const name = await readText(ports, path.join(device, 'product_name'));
    const [percent, used, total] = await Promise.all([
      'gpu_busy_percent', 'mem_info_vram_used', 'mem_info_vram_total',
    ].map(async (file) => metricNumber(await readText(ports, path.join(device, file)))));

    result.push({
      id: device,
      name: name || `AMD ${path.basename(device)}`,
      ...(percent === undefined ? {} : { percent }),
      ...(used === undefined ? {} : { memoryUsedGb: used / 1024 ** 3 }),
      ...(total === undefined ? {} : { memoryTotalGb: total / 1024 ** 3 }),
    });
  }

  return result;
}
