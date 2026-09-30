import type { GraphLoopProgress } from '../../../shared/factoryGraphContracts.ts';

/**
 * Счётчики реестра служат только представлению; пустое или повреждённое поле не равно нулю.
 * Нулевой круг допустим до первой передачи исполнителю, этап и потолок начинаются с единицы.
 */
function counter(value: string | undefined, minimum: number): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  const number = Number(value);

  return Number.isSafeInteger(number) && number >= minimum ? number : null;
}

/**
 * Читает уже готовую проекцию движка без дополнительного чтения журнала на каждом опросе.
 * Снятый признак режима не позволяет показать счётчики, оставшиеся от прошлой попытки.
 */
export function readLoopProgress(registry: Record<string, string>): GraphLoopProgress | null {
  if (registry.LOOP_MODE !== '1') {
    return null;
  }

  return {
    round: counter(registry.LOOP_ROUND, 0),
    stage: counter(registry.LOOP_STAGE, 1),
    maxRounds: counter(registry.LOOP_MAX_ROUNDS, 1),
  };
}
