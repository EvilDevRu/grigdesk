import type { Gpu, Temperature } from '../../../../shared/runtime/systemMetrics.ts';
import { readDisks, type DiskSample } from './disks.ts';
import { NvidiaProbe, readAmdGpus, type NvidiaGpu } from './gpu.ts';
import { resourcePorts, type ResourcesOptions } from './ports.ts';
import { readTemperatures, type Temperatures } from './temperatures.ts';

export class SystemResources {
  private stopped = false;
  private temperatures: Temperatures = {
    nvme: new Map(),
    gpu: new Map(),
    pci: new Map(),
  };
  private amd: Gpu[] = [];
  private nvidia: NvidiaGpu[] = [];
  private disks: DiskSample[] = [];
  private readonly probe: NvidiaProbe;
  private readonly timers: ReturnType<typeof setInterval>[] = [];

  constructor(dataHome: string, options: ResourcesOptions = {}) {
    const ports = resourcePorts(options);

    this.probe = new NvidiaProbe(ports, (gpus) => {
      this.nvidia = gpus;
    });
    this.schedule(5000, async () => {
      const temperatures = await readTemperatures(ports);

      if (!this.stopped) {
        this.temperatures = temperatures;
      }
    });
    this.schedule(5000, async () => {
      const gpus = await readAmdGpus(ports);

      if (!this.stopped) {
        this.amd = gpus;
      }
    });
    this.schedule(5000, async () => this.probe.refresh());
    this.schedule(45000, async () => {
      const disks = await readDisks(dataHome, ports);

      if (!this.stopped) {
        this.disks = disks;
      }
    });
  }

  /**
   * У каждого источника собственная блокировка; зависший statfs не задерживает GPU.
   * Начальный проход фоновый, интервалы не удерживают сервер после закрытия.
   */
  private schedule(interval: number, refresh: () => Promise<void>): void {
    let busy = false;

    /**
     * Блокировка остаётся занятой до завершения текущего источника.
     * После остановки новые тики не начинают даже файловую подготовку.
     */
    const run = async () => {
      if (busy || this.stopped) {
        return;
      }

      busy = true;

      try {
        await refresh();
      } catch {
        // Необязательный источник сохраняет прошлый снимок при неожиданном отказе.
      } finally {
        busy = false;
      }
    };

    void run();

    const timer = setInterval(() => void run(), interval);

    timer.unref?.();
    this.timers.push(timer);
  }

  /**
   * Проекция соединяет кеши в памяти, не обращаясь к устройствам или файлам.
   * Температура NVMe свежая независимо от возраста снимка ёмкости раздела.
   */
  read() {
    const gpus: Gpu[] = this.nvidia.map(({ pci, ...gpu }) => {
      const limits = pci ? this.temperatures.pci.get(pci) : undefined;
      const temperature = gpu.temperature ? { ...limits, ...gpu.temperature } : limits;

      return { ...gpu, ...(temperature ? { temperature } : {}) };
    });

    for (const gpu of this.amd) {
      const temperature = this.temperatures.gpu.get(gpu.id);

      gpus.push({ ...gpu, ...(temperature ? { temperature } : {}) });
    }

    const disks = this.disks.map(({ disk, controller }) => {
      const temperature = controller ? this.temperatures.nvme.get(controller) : undefined;

      return { ...disk, ...(temperature ? { temperature } : {}) };
    });

    return {
      temperature: this.temperatures.cpu as Temperature | undefined,
      gpus,
      disks,
    };
  }

  /**
   * Владение таймерами и child заканчивается вместе с адаптером сервера.
   * Поздние ответы файловых проходов не могут изменить остановленный снимок.
   */
  stop(): void {
    this.stopped = true;

    for (const timer of this.timers) {
      clearInterval(timer);
    }

    this.probe.stop();
  }
}
