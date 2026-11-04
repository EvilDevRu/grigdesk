/**
 * Старый DTO сохранён отдельно от новых полей для барьера совместимости.
 * Все цифры синтетические, их источник — ответ управляемого API этой фикстуры.
 */
export function oldMetrics() {
  return {
    cpu: {
      percent: 42,
      cores: 4,
      load1: 1.23,
    },
    mem: {
      totalGb: 24,
      usedGb: 16,
      freeGb: 8,
      percent: 67,
      ramTotalGb: 16,
      ramUsedGb: 12,
      ramFreeGb: 4,
      ramPercent: 75,
      swapTotalGb: 8,
      swapUsedGb: 4,
      swapPercent: 50,
    },
    net: { ip: '192.0.2.1', countryCode: 'ZZ' },
  };
}

/**
 * Два раздела одного NVMe остаются разными строками, каждая со своей нагрузкой.
 * Разные температуры помогают заметить перестановку показаний между устройствами.
 */
export function extendedMetrics() {
  const metrics = oldMetrics();

  metrics.cpu.temperature = { celsius: 72.8 };
  metrics.gpus = [{
    id: 'gpu-one',
    name: 'Fixture RTX 3070',
    percent: 24,
    memoryUsedGb: 1.5,
    memoryTotalGb: 8,
    temperature: { celsius: 53 },
  }, {
    id: 'gpu-two',
    name: 'Fixture Radeon',
    percent: 37,
    memoryUsedGb: 2.25,
    memoryTotalGb: 16,
    temperature: { celsius: 61 },
  }];
  metrics.disks = [{
    id: 'disk-one',
    device: '/dev/nvme0n1p1',
    mountpoint: '/data/first',
    totalGb: 100,
    usedGb: 80,
    freeGb: 10,
    percent: 80,
    dataHome: true,
    temperature: {
      celsius: 41,
      maxCelsius: 79.85,
      critCelsius: 84.85,
    },
  }, {
    id: 'disk-two',
    device: '/dev/nvme0n1p2',
    mountpoint: '/data/second',
    totalGb: 234.5,
    usedGb: 180,
    freeGb: 54.5,
    percent: 180 / 234.5 * 100,
    dataHome: false,
    temperature: { celsius: 35 },
  }];

  return metrics;
}
