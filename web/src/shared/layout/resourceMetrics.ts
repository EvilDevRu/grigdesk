import type { SystemMetrics, Temperature } from '../../../../shared/runtime/systemMetrics.ts';

type TemperatureKind = 'cpu' | 'gpu' | 'nvme';

/**
 * Цвет нагрузки сохраняет прежние пороги CPU и общей памяти в шапке.
 * Отсутствующий процент остаётся нейтральным до получения показания.
 */
export function loadClass(percent: number | undefined): string {
  return percent! >= 85 ? 'lv-bad' : percent! >= 60 ? 'lv-warn' : 'lv-ok';
}

/**
 * Старый сервер может прислать только суммарную память вместе с подкачкой.
 * Прежние запасные формулы восстанавливают разбивку без изменения округления.
 */
export function memoryView(memory: SystemMetrics['mem']) {
  if (!memory) {
    return null;
  }

  const swapTotal = memory.swapTotalGb || 0;
  const swapUsed = memory.swapUsedGb || 0;
  const ramTotal = memory.ramTotalGb ?? +(memory.totalGb! - swapTotal).toFixed(1);
  const ramUsed = memory.ramUsedGb ?? +(memory.usedGb! - swapUsed).toFixed(1);

  return {
    ramTotal,
    ramUsed,
    ramFree: memory.ramFreeGb ?? +(ramTotal - ramUsed).toFixed(1),
    ramPercent: memory.ramPercent ?? (ramTotal ? Math.round((ramUsed / ramTotal) * 100) : 0),
    swapTotal,
    swapUsed,
    swapPercent: memory.swapPercent ?? (swapTotal ? Math.round((swapUsed / swapTotal) * 100) : 0),
  };
}

/**
 * Диск оценивается по доступным гигабайтам, а не доле занятого места.
 * Сравнение выполняется до округления подписи, границы 10 и 30 строгие.
 */
export function diskClass(freeGb: number): string {
  return freeGb < 10 ? 'lv-bad' : freeGb < 30 ? 'lv-warn' : 'lv-ok';
}

const usableLimit = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0 && value <= 150;

/**
 * Пределы канала приоритетнее запасных границ класса, заглушки отбрасываются.
 * Неполная пара не ставит красную границу ниже жёлтой; красный проверяется первым.
 */
export function temperatureClass(temperature: Temperature | undefined, kind: TemperatureKind): string {
  if (!temperature) {
    return '';
  }

  const fallbackWarn = kind === 'nvme' ? 60 : 80;
  const fallbackBad = kind === 'nvme' ? 70 : 90;
  const max = usableLimit(temperature.maxCelsius) ? temperature.maxCelsius : undefined;
  const crit = usableLimit(temperature.critCelsius) ? temperature.critCelsius : undefined;
  const warn = max ?? Math.min(fallbackWarn, crit ?? fallbackWarn);
  const bad = crit ?? Math.max(fallbackBad, max ?? fallbackBad);

  return temperature.celsius >= bad ? 'lv-bad' : temperature.celsius >= warn ? 'lv-warn' : 'lv-ok';
}

/**
 * Метка шапки предупреждает только о красном диске или температуре устройства.
 * Проценты CPU, памяти и GPU сами по себе не включают отдельную тревогу.
 */
export function resourcesAlarm(metrics: SystemMetrics | null | undefined): boolean {
  return temperatureClass(metrics?.cpu.temperature, 'cpu') === 'lv-bad'
    || (metrics?.gpus ?? []).some((gpu) => temperatureClass(gpu.temperature, 'gpu') === 'lv-bad')
    || (metrics?.disks ?? []).some((disk) => diskClass(disk.freeGb) === 'lv-bad'
      || temperatureClass(disk.temperature, 'nvme') === 'lv-bad');
}
