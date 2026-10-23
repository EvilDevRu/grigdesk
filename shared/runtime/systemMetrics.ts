export interface Temperature {
  celsius: number;
  maxCelsius?: number;
  critCelsius?: number;
}

export interface Gpu {
  id: string;
  name: string;
  percent?: number;
  memoryUsedGb?: number;
  memoryTotalGb?: number;
  temperature?: Temperature;
}

export interface Disk {
  id: string;
  device: string;
  mountpoint: string;
  totalGb: number;
  usedGb: number;
  freeGb: number;
  percent: number;
  dataHome: boolean;
  temperature?: Temperature;
}

export interface SystemMetrics {
  cpu: {
    percent: number;
    cores?: number;
    load1?: number;
    temperature?: Temperature;
  };
  mem?: {
    percent?: number;
    usedGb?: number;
    totalGb?: number;
    freeGb?: number;
    ramTotalGb?: number;
    ramUsedGb?: number;
    ramFreeGb?: number;
    ramPercent?: number;
    swapTotalGb?: number;
    swapUsedGb?: number;
    swapPercent?: number;
  };
  net?: {
    ip?: string;
    country?: string;
    countryCode?: string;
  } | null;
  gpus?: Gpu[];
  disks?: Disk[];
}
