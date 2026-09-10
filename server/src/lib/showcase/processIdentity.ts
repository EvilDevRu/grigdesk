// Живость отсоединённого процесса по снимку identity.
//
// Одного pid недостаточно: номер переиспользуется, и после перезагрузки его
// получает посторонний процесс — мёртвое задание выглядело бы вечно идущим.
// Поэтому сверяются ещё время старта и командная строка.
//
// Проверка нужна и заданиям записи, и установке голоса. Правило у них одно, и
// разъезжаться этим двум копиям нельзя: разное понимание живости означает, что
// в одном месте раздел ждёт покойника, а в другом убивает работающего.
import { readProcessIdentity } from '../speech/modelJobsProcess.ts';

export interface ProcessIdentity {
  pid: number | null;
  starttime: string | null;
  cmdline: string | null;
}

/**
 * Совпадает ли живой процесс с тем, который был запущен. Отсутствие pid означает
 * работу в самом сервере: после перезапуска такую работу честнее считать
 * оборванной, чем угадывать по чужому номеру.
 */
export function processAlive(expected: ProcessIdentity): boolean {
  if (!expected.pid) {
    return false;
  }

  const actual = readProcessIdentity(expected.pid) as ProcessIdentity | null;

  if (!actual) {
    return false;
  }

  if (expected.starttime && actual.starttime !== expected.starttime) {
    return false;
  }

  return !expected.cmdline || actual.cmdline === expected.cmdline;
}
