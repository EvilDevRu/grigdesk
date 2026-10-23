import { fstatSync, writeSync } from 'node:fs';

export type BuildStepEvent = { type: 'start'; id: string }
  | {
    type: 'end';
    id: string;
    code: number;
  }
  | { type: 'hint'; id: 'select-server' };

/**
 * Внутренний канал включается только маркером и открытым дескриптором родителя.
 * Обычная сборка не пишет события ни в пользовательские потоки, ни в файлы.
 */
export function writeBuildStepEvent(event: BuildStepEvent): void {
  if (process.env.GRIGDESK_CTL_BUILD_OBSERVED !== '1') {
    return;
  }

  try {
    fstatSync(3);
    writeSync(3, `${event.type}\t${event.id}${event.type === 'end' ? `\t${event.code}` : ''}\n`);
  } catch {
    // Отсутствующий наблюдатель не меняет результат штатной сборки.
  }
}
